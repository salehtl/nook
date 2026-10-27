"""Reference mock of the nook-scan jobs API (contract §5): same routes, statuses and shapes, with simulated training.

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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 4 * 1024 ** 3
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
STEPS = 30000
lock = threading.Lock()
jobs: dict[str, dict] = {}
queue: list[str] = []
SECONDS = 6.0


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_job(capture: str, name: str) -> dict:
    jid = f"j-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
    return {"id": jid, "capture": capture, "name": name, "status": "queued", "stage": "waiting", "progress": 0.0,
            "step": 0, "total_steps": STEPS, "eta_s": None, "created": now(), "started": None, "finished": None,
            "message": "waiting for the GPU", "result": None}


def worker():
    while True:
        with lock:
            jid = next((j for j in queue if jobs[j]["status"] == "queued"), None)
            if jid:
                queue.remove(jid)
                job = jobs[jid]
                job.update(status="training", stage="preparing", started=now(), message="preparing images")
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

    def do_GET(self):
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
        self.err(404, "not found")

    def do_POST(self):
        p = self.path.split("?")[0]
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
            existing = next((j for j in jobs.values() if j["capture"] == capture and j["status"] not in ("failed", "cancelled")), None)
            if existing:
                return self.send(200, existing)
            j = new_job(capture, name)
            jobs[j["id"]] = j
            queue.append(j["id"])
            return self.send(202, j)


def main():
    global SECONDS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8798)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--seconds", type=float, default=6.0)
    a = ap.parse_args()
    SECONDS = a.seconds
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"mock nook-scan server on http://{a.host}:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
