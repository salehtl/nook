"""`nook-scan serve`: the processing server's jobs API (contract §5, §5.1). Python stdlib only.

Uploads stream to disk and are validated with the same code as `nook-scan check`, then kept as
<data-dir>/captures/<capture>.zip, so a room can be retrained from it later with other settings. One worker thread
trains queued jobs (uploads and retrains) in FIFO order, each as a `python -m nook_scan train ...` subprocess in its
own process group, and follows its `step X/Y` lines; with --gpu-lock it holds that file's flock while training.
Cancel and shutdown stop the whole group (nook-scan and gsplat). Job state lives in jobs.json.

Every POST and DELETE needs `X-Nook: 1` and an Origin that is absent or this server's own (§2.9).
"""

import fcntl
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata
from pathlib import Path
from urllib.parse import urlsplit

from . import ScanError, capture, gpu, settings, trainer

MAX_BODY = 4 * 1024 ** 3
CHUNK = 1 << 20
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
JOB_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
CAPTURE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")  # a kept capture's folder name, as the app makes it
RN = re.compile(r"-r(\d+)$")
TERMINAL = ("done", "failed", "cancelled")
RESTART_MSG = "server restarted during training: retrain from the planner"
MAX_JSON = 64 * 1024
LOCK_POLL_S = 1.0
SAVE_EVERY_S = 5.0
KILL_GRACE_S = 5.0
# Progress bands: preparing and building the trainer take the first few percent, the training steps most of it,
# cropping and writing the room the rest.
P_PREP, P_TRAIN_END, P_FINISH = 0.03, 0.95, 0.97
STEP = re.compile(r"\bstep (\d+)/(\d+)")
TOTAL = re.compile(r"training with .*: (\d+) steps")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def version() -> str:
    try:
        return metadata.version("nook-scan")
    except metadata.PackageNotFoundError:
        return os.environ.get("NOOK_VERSION", "unknown")  # the Nix package runs from source and sets this


class Server:
    def __init__(self, args):
        self.data = Path(args.data_dir).expanduser().resolve()
        self.room_dir = Path(args.room_dir).expanduser().resolve()
        self.uploads, self.logs = self.data / "uploads", self.data / "logs"
        self.captures = self.data / "captures"  # kept uploads, one per capture (§5.1)
        self.work = self.data / "work"  # trainers' TMPDIR: only this server's jobs use it, so startup can sweep it
        for d in (self.uploads, self.logs, self.captures, self.work):
            d.mkdir(parents=True, exist_ok=True)
        self.state_path = self.data / "jobs.json"
        self.quality = args.quality or "high"
        # Server-wide overrides (evals use tiny step counts): every run gets them unless a retrain sets its own.
        self.overrides = {k: v for k, v in (("steps", args.steps), ("train_max_splats", args.max_splats)) if v is not None}
        self.gpu_lock = Path(args.gpu_lock).expanduser() if getattr(args, "gpu_lock", None) else None
        if self.gpu_lock:
            self.gpu_lock.parent.mkdir(parents=True, exist_ok=True)
            self.gpu_lock.touch(exist_ok=True)
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.jobs: dict[str, dict] = {}
        self.running: str | None = None
        self.proc: subprocess.Popen | None = None
        self.stopping = False
        self.last_save = 0.0
        self.peeks: dict[tuple, dict] = {}  # kept capture (path, size, mtime) -> capture.peek()
        self.trainer = trainer.NAME
        self.gpu = gpu.info()["name"]
        self._load()

    # --- state -------------------------------------------------------------------------------------------------
    def _load(self) -> None:
        if self.state_path.exists():
            try:
                jobs = json.loads(self.state_path.read_text())["jobs"]
                self.jobs = {j["id"]: j for j in jobs}
            except (OSError, ValueError, KeyError, TypeError) as e:
                bad = self.state_path.with_name(f"jobs.json.bad-{int(time.time())}")
                self.state_path.replace(bad)
                print(f"nook-scan serve: {self.state_path} was unreadable ({e}); moved it to {bad.name} and started empty", file=sys.stderr)
        for j in self.jobs.values():
            for k, v in (("kind", "upload"), ("parent", None), ("settings", None)):  # jobs.json from before v4
                j.setdefault(k, v)
            legacy = self.uploads / f"{j['id']}.zip"  # v3 kept a queued job's upload under its job id
            if legacy.is_file():
                os.replace(legacy, self.capture_path(j["capture"]))
            if j["status"] == "training":
                j.update(status="failed", stage="done", eta_s=None, finished=now(), message=RESTART_MSG)
            elif j["status"] == "queued" and not self.capture_path(j["capture"]).is_file():
                j.update(status="failed", stage="done", finished=now(), message="the capture is gone from the server: upload it again")
        self._save()
        self._sweep()

    def _sweep(self) -> None:
        """Remove leftovers from a previous run: partial uploads (.incoming-*), v3 uploads and trainer work dirs (in
        <data>/work) that a restart or a SIGKILL skipped cleaning. Runs at startup, before any job, so nothing is in use."""
        leftovers = list(self.uploads.glob(".incoming-*")) + list(self.uploads.glob("*.zip")) + list(self.work.iterdir()) \
            + list(self.captures.glob(".*.tmp-*"))
        for p in leftovers:
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        if leftovers:
            print(f"nook-scan serve: removed {len(leftovers)} leftover upload/work files from a previous run", file=sys.stderr)

    def _save(self) -> None:
        """Atomically write jobs.json. Callers hold the lock (or run before the threads start)."""
        tmp = self.state_path.with_name(f".jobs.json.tmp-{os.getpid()}")
        tmp.write_text(json.dumps({"version": 1, "jobs": list(self.jobs.values())}, indent=1))
        os.replace(tmp, self.state_path)
        self.last_save = time.time()

    def capture_path(self, name: str) -> Path:
        return self.captures / f"{name}.zip"

    def snapshot(self, jid: str) -> dict | None:
        with self.lock:
            j = self.jobs.get(jid)
            return dict(j) if j else None

    def health(self) -> dict:
        with self.lock:
            return {"ok": True, "version": version(), "trainer": self.trainer, "gpu": self.gpu,
                    "busy": self.running is not None, "queued": sum(j["status"] == "queued" for j in self.jobs.values())}

    def listing(self) -> list[dict]:
        with self.lock:
            return [dict(j) for j in reversed(list(self.jobs.values()))]  # insertion order is creation order

    # --- uploads -----------------------------------------------------------------------------------------------
    def find_active(self, capture_name: str) -> dict | None:
        """The upload job a re-upload of this capture dedupes to (§5: uploads only, not retrains)."""
        return next((j for j in self.jobs.values() if j["kind"] == "upload" and j["capture"] == capture_name
                     and j["status"] not in ("failed", "cancelled")), None)

    def _new_id(self) -> str:
        jid = f"j-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        while jid in self.jobs:
            jid = f"j-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        return jid

    def _add(self, capture_name: str, name: str, kind: str, parent: str | None, requested: dict | None, title: str | None) -> dict:
        """Queue a job. Callers hold the lock. `settings` is what was asked for until the job starts, then what runs."""
        steps = (requested or {}).get("steps") or self.overrides.get("steps") or self._steps_estimate(capture_name, kind)
        job = {"id": self._new_id(), "kind": kind, "capture": capture_name, "name": name, "parent": parent,
               "settings": requested or None, "status": "queued", "stage": "waiting",
               "progress": 0.0, "step": 0, "total_steps": steps, "eta_s": None,
               "created": now(), "started": None, "finished": None, "message": "waiting for the GPU", "result": None}
        if title:
            job["title"] = title
        self.jobs[job["id"]] = job
        self._save()
        self.wake.notify_all()
        return job

    def _steps_estimate(self, capture_name: str, kind: str) -> int:
        try:
            return self.resolve(capture_name, kind, {})["steps"]
        except ScanError:
            return settings.STEPS_MIN

    def create(self, zip_path: Path, capture_name: str, name: str) -> tuple[int, dict]:
        with self.lock:
            existing = self.find_active(capture_name)
            if existing:
                zip_path.unlink(missing_ok=True)
                return 200, dict(existing)
            # Kept from now on (§5.1); a re-upload of a kept capture replaces its zip. A job already training from the
            # old one keeps reading it: it's the same capture, and the old file stays open until the trainer is done.
            os.replace(zip_path, self.capture_path(capture_name))
            return 202, dict(self._add(capture_name, name, "upload", None, None, None))

    # --- kept captures and retraining (§5.1) ---------------------------------------------------------------------
    def peek(self, name: str) -> dict | None:
        """capture.peek() of a kept capture, cached by size and mtime (reading a big zip's directory isn't free)."""
        path = self.capture_path(name)
        try:
            st = path.stat()
        except OSError:
            return None
        key = (name, st.st_size, st.st_mtime_ns)
        if key not in self.peeks:
            try:
                info = capture.peek(path)
            except ScanError:
                info = {"name": name, "frames": 0, "stills": 0, "roomplan": False}
            self.peeks[key] = dict(info, size_bytes=st.st_size, created=datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        return self.peeks[key]

    def kept(self) -> list[dict]:
        names = [p.name[:-4] for p in self.captures.glob("*.zip") if not p.name.startswith(".")]
        with self.lock:
            rooms = {n: [j["name"] for j in self.jobs.values() if j["capture"] == n and j["status"] == "done"] for n in names}
        out = []
        for n in names:
            info = self.peek(n)
            if info:
                out.append({"name": n, "size_bytes": info["size_bytes"], "created": info["created"], "rooms": rooms[n],
                            "roomplan": bool(info["roomplan"])})
        return sorted(out, key=lambda c: c["created"], reverse=True)

    def resolve(self, capture_name: str, kind: str, requested: dict | None) -> dict:
        """The settings a job runs with: uploads use the server's --quality, retrains the scaled defaults (what
        /defaults shows); then the server's overrides, then the retrain's own settings."""
        info = self.peek(capture_name)
        if not info:
            raise ScanError(f"the capture {capture_name} is gone from the server: upload it again")
        quality = self.quality if kind == "upload" else "high"
        return settings.resolve(info["frames"], quality, {**self.overrides, **(requested or {})})

    def defaults(self, capture_name: str) -> tuple[int, dict]:
        info = self.peek(capture_name)
        if not info:
            return 404, {"error": f"no kept capture {capture_name}: upload it again to retrain"}
        return 200, settings.summary(info["frames"], "high", {**self.overrides, "holdout_every": 0})

    def _taken(self, base: str) -> list[int]:
        """N of every room named <base>-rN, on disk or in a job that isn't failed or cancelled. A truncated base
        counts too, so a long name keeps counting (callers hold the lock)."""
        def number(name: str) -> int | None:
            m = RN.search(name)
            if m and RN.sub("", name) == base[:64 - len(m[0])].rstrip("-"):
                return int(m[1])
            return None
        names = [j["name"] for j in self.jobs.values() if j["status"] not in ("failed", "cancelled")]
        if self.room_dir.is_dir():
            names += [p.name.split(".")[0] for p in self.room_dir.iterdir() if p.suffix in (".spz", ".ply", ".json")]
        return [n for n in map(number, names) if n is not None]

    def retrain(self, capture_name: str, body: dict) -> tuple[int, dict]:
        given = body.get("settings") or {}
        title = body.get("title")
        if not isinstance(given, dict):
            return 400, {"error": 'settings must be an object, e.g. {"settings": {"steps": 60000}}'}
        if title is not None and (not isinstance(title, str) or len(title) > 120):
            return 400, {"error": "title must be text of at most 120 characters"}
        if problem := settings.check(given):
            return 400, {"error": problem}
        if not self.peek(capture_name):
            return 404, {"error": f"no kept capture {capture_name}: upload it again to retrain"}
        resolved = self.resolve(capture_name, "retrain", given)
        if resolved["deliver_max_splats"] > resolved["train_max_splats"]:
            return 400, {"error": f"deliver_max_splats ({resolved['deliver_max_splats']:,}) can't be more than train_max_splats "
                                  f"({resolved['train_max_splats']:,}): lower it or raise train_max_splats"}
        with self.lock:
            # Parent: the newest room trained from this capture. Without one (its upload failed or was cancelled),
            # the base is that upload's name.
            done = sorted((j for j in self.jobs.values() if j["capture"] == capture_name and j["status"] == "done"),
                          key=lambda j: j["finished"] or "")
            parent = done[-1]["name"] if done else None
            uploads = [j for j in self.jobs.values() if j["capture"] == capture_name and j["kind"] == "upload"]
            base = RN.sub("", parent or (uploads[-1]["name"] if uploads else _slug(capture_name)))
            suffix = f"-r{max(self._taken(base), default=0) + 1}"
            name = base[:64 - len(suffix)].rstrip("-") + suffix
            return 202, dict(self._add(capture_name, name, "retrain", parent, given, title.strip() if title else None))

    def delete_capture(self, capture_name: str) -> tuple[int, dict]:
        with self.lock:
            if not self.capture_path(capture_name).is_file():
                return 404, {"error": f"no kept capture {capture_name}: list them with GET /api/scan/captures"}
            if any(j["capture"] == capture_name and j["status"] in ("queued", "training") for j in self.jobs.values()):
                return 409, {"error": f"a job for {capture_name} is still queued or training: cancel it first"}
            self.capture_path(capture_name).unlink(missing_ok=True)  # its rooms stay
            return 200, {"ok": True}

    # --- cancel and shutdown -----------------------------------------------------------------------------------
    def cancel(self, jid: str) -> tuple[int, dict]:
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return 404, {"error": f"no job {jid}: list jobs with GET /api/scan/jobs"}
            if j["status"] in TERMINAL:
                return 409, {"error": f"job {jid} is already {j['status']}: nothing to cancel"}
            j.update(status="cancelled", stage="done", eta_s=None, finished=now(), message="cancelled")
            self._save()
            if self.running == jid and self.proc:
                self._kill(self.proc)
            return 200, dict(j)

    @staticmethod
    def _kill(proc: subprocess.Popen, wait: bool = False) -> None:
        """SIGTERM the trainer's process group (nook-scan and gsplat), then SIGKILL whatever is left after a grace period."""
        def signal_group(sig):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

        def reap():
            try:
                proc.wait(KILL_GRACE_S)
            except subprocess.TimeoutExpired:
                pass
            signal_group(signal.SIGKILL)  # gsplat may outlive its parent; the group still names it

        signal_group(signal.SIGTERM)
        if wait:
            reap()
        else:
            threading.Thread(target=reap, daemon=True).start()

    def shutdown(self, *_):
        """On SIGTERM/SIGINT: stop the trainer and exit. A job that was training stays `training` in jobs.json and
        becomes failed with RESTART_MSG on the next start, as the contract says."""
        with self.lock:
            self.stopping = True
            proc = self.proc
        if proc:
            self._kill(proc, wait=True)
        os._exit(0)

    # --- the worker --------------------------------------------------------------------------------------------
    def _acquire_gpu(self):
        """With --gpu-lock: wait for its flock (an eval or another GPU user may hold it) and return the open file.
        Polls, so shutdown isn't blocked; the head of the queue says it's waiting. None when stopping."""
        if not self.gpu_lock:
            return open(os.devnull)
        f = open(self.gpu_lock, "a")
        told = False
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return f
            except BlockingIOError:
                pass
            with self.lock:
                if self.stopping:
                    f.close()
                    return None
                head = next((j for j in self.jobs.values() if j["status"] == "queued"), None)
                if head is None:  # cancelled while waiting
                    f.close()
                    return open(os.devnull)
                if not told:
                    head["message"] = "waiting for the GPU: another run is using it"
                    told = True
            time.sleep(LOCK_POLL_S)

    def worker(self) -> None:
        while True:
            with self.lock:
                while not self.stopping and not any(j["status"] == "queued" for j in self.jobs.values()):
                    self.wake.wait()
                if self.stopping:
                    return
            gpu_file = self._acquire_gpu()
            if gpu_file is None:
                return
            try:
                with self.lock:
                    job = next((j for j in self.jobs.values() if j["status"] == "queued"), None)  # FIFO: oldest first
                    if job is None or self.stopping:
                        continue
                    job.update(status="training", stage="preparing", started=now(), message="preparing: checking the capture")
                    self.running = job["id"]
                    self._save()
                try:
                    self.run(job)
                except Exception as e:  # noqa: BLE001 - a broken job must not take the queue down
                    with self.lock:
                        if job["status"] == "training" and not self.stopping:
                            msg = str(e) if isinstance(e, ScanError) else f"the server could not run the trainer ({type(e).__name__}: {e})"
                            job.update(status="failed", stage="done", eta_s=None, finished=now(), message=msg)
                            self._save()
                finally:
                    with self.lock:
                        self.running, self.proc = None, None
            finally:
                gpu_file.close()  # releases the flock

    def run(self, job: dict) -> None:
        jid = job["id"]
        log_path = self.logs / f"{jid}.log"
        resolved = self.resolve(job["capture"], job["kind"], job["settings"])
        with self.lock:
            job["settings"] = resolved  # what runs (§5.1); replaced by the trainer's own record when it's done
            job["total_steps"] = resolved["steps"]
        cmd = [sys.executable, "-m", "nook_scan", "train", str(self.capture_path(job["capture"])), "--name", job["name"],
               "--room-dir", str(self.room_dir), "--quality", self.quality if job["kind"] == "upload" else "high",
               *settings.as_flags(resolved), "--progress-every", "2"]
        if job["kind"] == "retrain":
            cmd += ["--keep-current"] + (["--parent", job["parent"]] if job["parent"] else []) \
                + (["--title", job["title"]] if job.get("title") else [])
        # PYTHONPATH: the child must import the same nook_scan as this process, even when a wrapper script (e.g. Nix's)
        # put it on sys.path without telling the environment.
        env = dict(os.environ, PYTHONUNBUFFERED="1", NOOK_SCAN_TRAIN_LOG=str(self.logs / f"{jid}-train.log"),
                   PYTHONPATH=os.pathsep.join(p for p in sys.path if p), TMPDIR=str(self.work))
        with self.lock:
            if job["status"] != "training" or self.stopping:
                return
            self.proc = proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                                text=True, errors="replace", bufsize=1, env=env, start_new_session=True)
        result, error, t_train = None, None, None
        with open(log_path, "w") as log:
            log.write("$ " + " ".join(cmd) + "\n")
            for line in proc.stdout:
                log.write(line)
                log.flush()
                line = line.strip()
                if line.startswith("{"):
                    try:
                        result = json.loads(line)
                    except ValueError:
                        pass
                    continue
                if line.startswith(("nook-scan: error:", "nook-scan: unexpected error", "nook-scan: interrupted")):
                    error = line.removeprefix("nook-scan: ").removeprefix("error: ")
                    continue
                text = line.removeprefix("nook-scan:").strip()
                with self.lock:
                    if job["status"] != "training":
                        continue
                    upd = {}
                    if m := TOTAL.search(text):
                        upd = {"stage": "training", "total_steps": int(m[1]), "message": "training: starting"}
                        t_train = time.time()
                    elif m := STEP.search(text):
                        step, total = int(m[1]), int(m[2])
                        t_train = t_train or time.time()
                        el = time.time() - t_train
                        eta = round(el / step * (total - step) + 10) if step and el > 0 else None
                        upd = {"stage": "training", "step": step, "total_steps": total, "eta_s": eta,
                               "progress": P_PREP + (P_TRAIN_END - P_PREP) * min(1.0, step / total),
                               "message": f"training: step {step}/{total}"}
                    elif text.startswith("building"):
                        upd = {"stage": "building trainer", "message": "building the trainer (first run on this machine only, ~10 min)"}
                    elif text.startswith("finishing"):
                        upd = {"stage": "finishing", "progress": P_FINISH, "eta_s": 10, "message": text.removeprefix("finishing: ")}
                    elif text.startswith(("preparing", "photometric")):
                        upd = {"stage": "preparing", "progress": 0.01, "message": text.removeprefix("preparing: ")}
                    if upd:
                        if "progress" in upd:
                            upd["progress"] = round(max(job["progress"], upd["progress"]), 4)
                        job.update(upd)
                        if time.time() - self.last_save > SAVE_EVERY_S:
                            self._save()
        rc = proc.wait()
        with self.lock:
            if job["status"] != "training" or self.stopping:  # cancelled, or the server is going down
                return
            if rc == 0 and result:
                result = dict(result, room_url=f"/planner/?room={job['name']}", ply_url=f"/room/{job['name']}.ply", spz_url=f"/room/{job['name']}.spz")
                if isinstance(result.get("settings"), dict):
                    job["settings"] = result["settings"]
                job.update(status="done", stage="done", progress=1.0, step=result.get("steps", job["total_steps"]),
                           total_steps=result.get("steps", job["total_steps"]), eta_s=0, finished=now(),
                           message="room ready", result=result)
            else:
                job.update(status="failed", stage="done", eta_s=None, finished=now(),
                           message=error or f"the trainer exited with code {rc}: see {log_path}")
            self._save()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # so clients that send `Expect: 100-continue` get an answer before the body
    timeout = 120  # seconds of silence before a stalled upload is dropped (its partial file is removed)
    server_version = "nook-scan"
    app: Server

    def log_message(self, fmt, *args):
        sys.stderr.write(f"nook-scan serve: {self.address_string()} {fmt % args}\n")

    def send(self, status: int, data) -> None:
        body = (json.dumps(data) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def err(self, status: int, msg: str, close: bool = False) -> None:
        if close:
            self.close_connection = True
        self.send(status, {"error": msg})

    def _length_problem(self) -> tuple[int, str] | None:
        cl = self.headers.get("Content-Length")
        if cl is None:
            return 411, "Content-Length is required: upload the capture zip as a file, not a stream"
        try:
            n = int(cl)
        except ValueError:
            return 400, "Content-Length is not a number"
        if n < 0:
            return 400, "Content-Length is negative"
        if n > MAX_BODY:
            return 413, "the capture is larger than 4 GB: scan with fewer frames"
        return None

    def _forged(self) -> bool:
        """§2.9: a mutation needs `X-Nook: 1` and an Origin that's absent or this server's own (http(s):// + Host)."""
        origin, host = self.headers.get("Origin"), self.headers.get("Host", "")
        return not (self.headers.get("X-Nook") == "1" and (origin is None or origin in (f"http://{host}", f"https://{host}")))

    def handle_expect_100(self):
        path = urlsplit(self.path).path
        if self.command in ("POST", "DELETE") and self._forged():
            self.err(403, "cross-site request refused", close=True)
            return False
        if self.command == "POST" and path == "/api/scan/captures" and (p := self._length_problem()):
            self.err(*p, close=True)
            return False
        return super().handle_expect_100()

    def _refuse_forged(self) -> bool:
        if not self._forged():
            return False
        self._drain()
        self.err(403, "cross-site request refused")
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/scan/health":
            return self.send(200, self.app.health())
        if path == "/api/scan/jobs":
            return self.send(200, {"jobs": self.app.listing()})
        if path == "/api/scan/captures":
            return self.send(200, {"captures": self.app.kept()})
        m = re.fullmatch(r"/api/scan/jobs/([^/]+)", path)
        if m and JOB_ID.fullmatch(m[1]):
            j = self.app.snapshot(m[1])
            return self.send(200, j) if j else self.err(404, f"no job {m[1]}: list jobs with GET /api/scan/jobs")
        m = re.fullmatch(r"/api/scan/captures/([^/]+)/defaults", path)
        if m and CAPTURE.fullmatch(m[1]):
            return self.send(*self.app.defaults(m[1]))
        self.err(404, "not found: the API lives under /api/scan (health, captures, jobs)")

    def do_POST(self):
        if self._refuse_forged():
            return
        path = urlsplit(self.path).path
        if path == "/api/scan/captures":
            return self.upload()
        m = re.fullmatch(r"/api/scan/jobs/([^/]+)/cancel", path)
        if m and JOB_ID.fullmatch(m[1]):
            self._drain()
            return self.send(*self.app.cancel(m[1]))
        m = re.fullmatch(r"/api/scan/captures/([^/]+)/retrain", path)
        if m and CAPTURE.fullmatch(m[1]):
            body = self._json()
            if body is None:
                return self.err(400, 'the body must be JSON like {"settings": {"steps": 60000}, "title": "Sharper"}')
            return self.send(*self.app.retrain(m[1], body))
        self._drain()
        self.err(404, "not found: the API lives under /api/scan (health, captures, jobs)")

    def do_DELETE(self):
        if self._refuse_forged():
            return
        self._drain()
        m = re.fullmatch(r"/api/scan/captures/([^/]+)", urlsplit(self.path).path)
        if m and CAPTURE.fullmatch(m[1]):
            return self.send(*self.app.delete_capture(m[1]))
        self.err(404, "not found: DELETE works on /api/scan/captures/<name>")

    def _json(self) -> dict | None:
        """A small JSON object body ({} when empty), or None when it isn't one."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n > MAX_JSON:
            self._drain()
            return None
        try:
            data = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _drain(self) -> None:
        """Read and discard a request body we don't need, so the connection stays usable."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > 16 * CHUNK:
            self.close_connection = True
            return
        while n > 0:
            chunk = self.rfile.read(min(CHUNK, n))
            if not chunk:
                break
            n -= len(chunk)

    def upload(self):
        if p := self._length_problem():
            return self.err(*p, close=True)
        n = int(self.headers["Content-Length"])
        name = self.headers.get("X-Nook-Name")
        if name is not None and not SLUG.fullmatch(name):
            self._drain()
            return self.err(400, f"X-Nook-Name must be a slug (lowercase letters, digits and dashes, e.g. reading-room), got {name!r}")
        inbox = Path(tempfile.mkdtemp(prefix=".incoming-", dir=self.app.uploads))
        try:
            zip_path = inbox / "capture.zip"
            left = n
            with open(zip_path, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(CHUNK, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                return self.err(400, f"the upload stopped after {n - left} of {n} bytes: send the capture again", close=True)
            capture_name = _top_folder(zip_path)
            if capture_name:
                with self.app.lock:
                    existing = self.app.find_active(capture_name)
                    existing = dict(existing) if existing else None
                if existing:  # idempotent re-upload: no need to validate it again
                    return self.send(200, existing)
            capture_name, problem = _validate(zip_path, inbox)
            if problem:
                return self.err(400, problem)
            if not CAPTURE.fullmatch(capture_name):
                return self.err(400, f"the capture folder {capture_name!r} needs a plain name (letters, digits, dots and dashes, "
                                     "like scan-20261026-093654): share it again from the app")
            name = name or _slug(capture_name)
            return self.send(*self.app.create(zip_path, capture_name, name))
        finally:
            shutil.rmtree(inbox, ignore_errors=True)


def _slug(capture_name: str) -> str:
    """The default room name for a capture folder."""
    name = re.sub(r"[^a-z0-9-]+", "-", capture_name.lower()).strip("-")[:64].strip("-")
    return name if SLUG.fullmatch(name) else "scan"


def _top_folder(zip_path: Path) -> str | None:
    """The capture folder name from the zip's directory, cheaply (no extraction). None if it isn't a sane capture zip."""
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = [n for n in z.namelist() if n.strip("/") and not n.startswith(("__MACOSX", ".DS_Store"))]
    except (zipfile.BadZipFile, OSError, EOFError):
        return None
    tops = {n.split("/")[0] for n in names}
    return tops.pop() if len(tops) == 1 else None


def _validate(zip_path: Path, inbox: Path) -> tuple[str, str | None]:
    """Run the `nook-scan check` validation on the uploaded zip. Returns (capture folder name, problem or None)."""
    work = inbox / "check"
    try:
        root = capture.open_capture(str(zip_path), work)
        cap, errs = capture.validate(root)
    except ScanError as e:
        return "", _server_wording(str(e))
    except Exception as e:  # noqa: BLE001 - a malformed upload is the client's problem, not a server crash
        return "", f"the upload is not a readable nook-scan capture ({type(e).__name__}): share it again from the app"
    if errs:
        more = f" (+{len(errs) - 1} more problems)" if len(errs) > 1 else ""
        return root.name, _server_wording(errs[0] + more)
    return root.name, None


def _server_wording(msg: str) -> str:
    return msg.replace("AirDrop or unzip it again", "send it again").replace("AirDrop the capture again", "send the capture again") \
              .replace("(AirDropped from the app)", "from the app")


def main(args) -> int:
    try:
        app = Server(args)
    except ScanError as e:
        print(f"nook-scan: error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"nook-scan: error: cannot use --data-dir {args.data_dir} ({e.strerror}): pick a writable folder", file=sys.stderr)
        return 1
    Handler.app = app
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"nook-scan: error: cannot listen on {args.host}:{args.port} ({e.strerror}): is another server running? pick another --port", file=sys.stderr)
        return 1
    httpd.daemon_threads = True
    signal.signal(signal.SIGTERM, app.shutdown)
    signal.signal(signal.SIGINT, app.shutdown)
    threading.Thread(target=app.worker, daemon=True, name="gpu-worker").start()
    print(f"nook-scan serve {version()}: http://{args.host}:{args.port}/api/scan (trainer {app.trainer}, gpu {app.gpu}, "
          f"data {app.data}, rooms {app.room_dir}{f', gpu lock {app.gpu_lock}' if app.gpu_lock else ''})", flush=True)
    httpd.serve_forever()
    return 0
