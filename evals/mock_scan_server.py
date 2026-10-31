"""Reference mock of the nook-scan jobs API (contract §5, §5.1): same routes, statuses and shapes, with simulated training.
v4: kept captures, retrain with settings and -rN naming, defaults, and the X-Nook / Origin check on mutations (§2.9).

The iOS app is built and tested against this before the real server exists; the real server must answer the same way.
Usage: python3 evals/mock_scan_server.py [--port 8798] [--seconds 6]   (stdlib only)
"""
import argparse
import io
import json
import re
import threading
import time
import uuid
import zipfile
from pathlib import Path
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 4 * 1024 ** 3
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
STEPS = 30000
lock = threading.Lock()
jobs: dict[str, dict] = {}
captures: dict[str, dict] = {}   # kept captures (§5.1): name -> {name, size_bytes, created, n_frames, roomplan}
SETTINGS = {  # §4.9.1: key -> (type, min, max)
    "steps": (int, 1000, 200_000), "train_max_splats": (int, 100_000, 4_000_000), "deliver_max_splats": (int, 100_000, 4_000_000),
    "max_image_size": (int, 640, 3840), "stills_max_size": (int, 640, 4032), "sh_degree": (int, 0, 3), "pose_opt": (bool, None, None), "colmap_poses": (bool, None, None),
    "holdout_every": (int, 0, 50),
}
RN = re.compile(r"-r(\d+)$")
queue: list[str] = []
SECONDS = 6.0
ROOM_DIR = None  # --room-dir: existing rooms count for -rN naming


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_job(capture: str, name: str, kind: str = "upload", parent: str | None = None, settings: dict | None = None) -> dict:
    jid = f"j-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
    steps = (settings or {}).get("steps", STEPS)
    return {"id": jid, "kind": kind, "capture": capture, "name": name, "parent": parent, "settings": settings,
            "status": "queued", "stage": "waiting", "progress": 0.0,
            "step": 0, "total_steps": steps, "eta_s": None, "created": now(), "started": None, "finished": None,
            "message": "waiting for the GPU", "result": None}


def defaults(cap: dict, holdout_every: int = 0) -> dict:
    n = cap["n_frames"] - (len(range(0, cap["n_frames"], holdout_every)) if holdout_every else 0)
    s = {"steps": min(30_000, max(20_000, 25 * n)), "train_max_splats": 1_500_000, "deliver_max_splats": 1_500_000,
         "max_image_size": 1920, "stills_max_size": 1920, "sh_degree": 3, "pose_opt": True, "colmap_poses": False, "holdout_every": holdout_every}
    return {"n_train": n, "settings": s, "eta_s": round(s["steps"] / 1000 * 75)}


def check_settings(given: dict) -> str | None:
    for k, v in given.items():
        if k not in SETTINGS:
            return f"unknown setting {k!r}: use one of {', '.join(SETTINGS)}"
        typ, lo, hi = SETTINGS[k]
        if typ is bool:
            if not isinstance(v, bool):
                return f"{k} must be true or false"
        elif isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi or (k == "holdout_every" and v == 1):
            return f"{k} must be a whole number from {lo} to {hi}" + (" (0 or at least 2)" if k == "holdout_every" else "")
    if given.get("deliver_max_splats", 0) > given.get("train_max_splats", 4_000_000):
        return "deliver_max_splats can't be more than train_max_splats"
    return None


def retrain_name(capture: str) -> tuple[str | None, str]:
    """(parent, new name) for a retrain of this capture: §5.1 naming. Call with the lock held."""
    done = sorted((j for j in jobs.values() if j["capture"] == capture and j["status"] == "done"), key=lambda j: j["finished"])
    upload = next((j for j in jobs.values() if j["kind"] == "upload" and j["capture"] == capture), None)
    parent = done[-1]["name"] if done else None  # never trained: no parent, the base is the upload's room name
    base = RN.sub("", parent or (upload["name"] if upload else capture))
    names = [j["name"] for j in jobs.values() if j["status"] not in ("failed", "cancelled")]
    if ROOM_DIR:  # rooms already on disk count too (§5.1)
        names += [p.name.split(".")[0] for p in Path(ROOM_DIR).glob("*.spz")] + [p.name.split(".")[0] for p in Path(ROOM_DIR).glob("*.ply")]
    taken = [int(m.group(1)) for n in names for m in [RN.search(n)] if m and RN.sub("", n) == base]
    suffix = f"-r{max(taken, default=0) + 1}"
    return parent, base[:64 - len(suffix)].rstrip("-") + suffix


def worker():
    while True:
        with lock:
            jid = next((j for j in queue if jobs[j]["status"] == "queued"), None)
            if jid:
                queue.remove(jid)
                job = jobs[jid]
                job.update(status="training", stage="preparing", started=now(), message="preparing images")
                cap = captures.get(job["capture"])
                if cap:  # settings: what actually ran (§5.1)
                    job["settings"] = {**defaults(cap)["settings"], **(job["settings"] or {})}
                    job["total_steps"] = job["settings"]["steps"]
        if not jid:
            time.sleep(0.2)
            continue
        t0 = time.time()
        while True:
            time.sleep(0.25)
            with lock:
                if job["status"] == "cancelled":
                    break
                f = min(1.0, (time.time() - t0) / SECONDS)
                job["progress"] = round(f, 3)
                job["step"] = int(f * STEPS)
                job["stage"] = "training" if f < 0.95 else "finishing"
                job["eta_s"] = round(SECONDS * (1 - f), 1)
                job["message"] = f"training: step {job['step']}/{STEPS}"
                if f >= 1.0:
                    job.update(status="done", stage="done", progress=1.0, eta_s=0, finished=now(), message="room ready")
                    job["result"] = {"name": job["name"], "ply": f"room/{job['name']}.ply", "room_json": "room/room.json",
                                     "splats": 123456, "floor_y": -1.35, "steps": STEPS, "seconds": SECONDS,
                                     "trainer": "mock", "psnr": None, "room_url": f"/planner/?room={job['name']}",
                                     "ply_url": f"/room/{job['name']}.ply"}
                    break


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status: int, data) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def err(self, status: int, msg: str) -> None:
        self.send(status, {"error": msg})

    def guarded(self) -> bool:
        """§2.9: a mutation needs X-Nook: 1 and an Origin that is absent or this server's own. Sends the 403 when not."""
        if not self.known_host():
            return False
        origin = self.headers.get("Origin")
        own = {f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"}
        if self.headers.get("X-Nook") == "1" and (origin is None or origin in own):
            return True
        self.err(403, "cross-site request refused")
        return False

    def known_host(self) -> bool:
        """§2.9 Host names: loopback only in the mock. Sends the 403 when not."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0] if not (self.headers.get("Host") or "").startswith("[") \
            else (self.headers.get("Host") or "").split("]")[0] + "]"
        if host in ("127.0.0.1", "localhost", "[::1]"):
            return True
        self.err(403, "unknown host name: add it with --allowed-host")
        return False

    def do_GET(self):
        if not self.known_host():
            return
        p = self.path.split("?")[0]
        if p == "/api/scan/health":
            with lock:
                busy = any(j["status"] == "training" for j in jobs.values())
                return self.send(200, {"ok": True, "version": "mock", "trainer": "mock", "gpu": "Mock GPU",
                                       "busy": busy, "queued": sum(j["status"] == "queued" for j in jobs.values())})
        if p == "/api/scan/jobs":
            with lock:
                return self.send(200, {"jobs": sorted(jobs.values(), key=lambda j: j["created"], reverse=True)})
        m = re.fullmatch(r"/api/scan/jobs/([A-Za-z0-9-]+)", p)
        if m:
            with lock:
                j = jobs.get(m.group(1))
                return self.send(200, j) if j else self.err(404, f"no job {m.group(1)}")
        if p == "/api/scan/captures":
            with lock:
                out = [{k: c[k] for k in ("name", "size_bytes", "created", "roomplan")} |
                       {"rooms": [j["name"] for j in jobs.values() if j["capture"] == c["name"] and j["status"] == "done"]}
                       for c in captures.values()]
            return self.send(200, {"captures": sorted(out, key=lambda c: c["created"], reverse=True)})
        m = re.fullmatch(r"/api/scan/captures/([a-z0-9-]+)/defaults", p)
        if m:
            with lock:
                c = captures.get(m.group(1))
                return self.send(200, defaults(c)) if c else self.err(404, f"no kept capture {m.group(1)}")
        self.err(404, "not found")

    def do_DELETE(self):
        if not self.guarded():
            return
        m = re.fullmatch(r"/api/scan/captures/([a-z0-9-]+)", self.path.split("?")[0])
        if not m:
            return self.err(404, "not found")
        with lock:
            name = m.group(1)
            if name not in captures:
                return self.err(404, f"no kept capture {name}")
            if any(j["capture"] == name and j["status"] in ("queued", "training") for j in jobs.values()):
                return self.err(409, "a job for this capture is still queued or training: cancel it first")
            del captures[name]
        self.send(200, {"ok": True})

    def do_POST(self):
        if not self.guarded():
            return
        p = self.path.split("?")[0]
        m = re.fullmatch(r"/api/scan/captures/([a-z0-9-]+)/retrain", p)
        if m:
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                assert isinstance(body, dict) and isinstance(body.get("settings", {}), dict)
            except (ValueError, AssertionError):
                return self.err(400, 'body must be JSON like {"settings": {"steps": 60000}}')
            problem = check_settings(body.get("settings", {}))
            if problem:
                return self.err(400, problem)
            with lock:
                if m.group(1) not in captures:
                    return self.err(404, f"no kept capture {m.group(1)}: upload it again to retrain")
                parent, name = retrain_name(m.group(1))
                j = new_job(m.group(1), name, "retrain", parent, body.get("settings") or None)
                if body.get("title"):
                    j["title"] = str(body["title"])
                jobs[j["id"]] = j
                queue.append(j["id"])
                return self.send(202, j)
        m = re.fullmatch(r"/api/scan/jobs/([A-Za-z0-9-]+)/cancel", p)
        if m:
            with lock:
                j = jobs.get(m.group(1))
                if not j:
                    return self.err(404, f"no job {m.group(1)}")
                if j["status"] in ("done", "failed", "cancelled"):
                    return self.err(409, f"job is already {j['status']}")
                j.update(status="cancelled", stage="done", finished=now(), message="cancelled")
                return self.send(200, j)
        if p != "/api/scan/captures":
            return self.err(404, "not found")
        length = self.headers.get("Content-Length")
        if length is None:
            return self.err(411, "Content-Length is required: upload the zip as a file")
        n = int(length)
        if n > MAX_BODY:
            return self.err(413, "capture is larger than 4 GB")
        data = self.rfile.read(n)
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
            names = [x for x in z.namelist() if x.strip("/") and not x.startswith("__MACOSX")]
            tops = {x.split("/")[0] for x in names}
            if len(tops) != 1 or f"{next(iter(tops))}/transforms.json" not in names:
                raise ValueError
        except (zipfile.BadZipFile, ValueError, StopIteration):
            return self.err(400, "not a nook-scan capture zip (one top-level scan-… folder with transforms.json): share it again from the app")
        capture = tops.pop()
        name = self.headers.get("X-Nook-Name") or re.sub(r"[^a-z0-9-]", "-", capture.lower())[:64]
        if not SLUG.fullmatch(name):
            return self.err(400, f"X-Nook-Name must be a slug, got {name!r}")
        with lock:
            n_frames = len(json.loads(z.read(f"{capture}/transforms.json")).get("frames", []))
            captures[capture] = {"name": capture, "size_bytes": n, "created": now(), "n_frames": n_frames,
                                 "roomplan": f"{capture}/roomplan.json" in names}  # always kept, even on a dedupe hit (§5.1)
            existing = next((j for j in jobs.values() if j["kind"] == "upload" and j["capture"] == capture
                             and j["status"] not in ("failed", "cancelled")), None)
            if existing:
                return self.send(200, existing)
            j = new_job(capture, name)
            jobs[j["id"]] = j
            queue.append(j["id"])
            return self.send(202, j)


def main():
    global SECONDS, ROOM_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8798)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--room-dir", help="the room dir the planner serves; rooms there count for retrain naming")
    a = ap.parse_args()
    SECONDS, ROOM_DIR = a.seconds, a.room_dir
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"mock nook-scan server on http://{a.host}:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
