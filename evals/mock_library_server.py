"""Reference mock of the v4 library API (contract §2.8, §2.9): same routes, statuses and shapes, no pipeline, no fal.

The planner UI is built against this before the real routes exist. It owns /api/library*, /api/spend and /library/ (a
scratch copy of fixtures/library), and forwards every other request (the planner's static files, /room/, rooms, layouts,
render, /api/scan) to --upstream, normally `python3 planner/serve.py` (with --scan-api pointing at mock_scan_server.py).
With --room-dir (and --scan, the jobs server), GET /api/rooms from upstream gains the v4 fields (§2.7: roomplan_url,
capture, parent) when upstream doesn't send them yet. Adds finish after --seconds; the "model" is the uploaded .glb, or fixtures/models/SheenChair.glb for anything else.
Usage: python3 evals/mock_library_server.py --upstream http://127.0.0.1:8765 [--port 8799] [--seconds 2] [--cap 2]
"""
import argparse
import base64
import json
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PRICE = {"sam3d": 0.02, "trellis2": {512: 0.25, 1024: 0.30, 1536: 0.35}, "glb": 0.0}
MIME = {".glb": "model/gltf-binary", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".ply": "application/octet-stream"}
lock = threading.Lock()
jobs: dict[str, dict] = {}
A = argparse.Namespace()
LIB = Path()
spent = 0.0


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")[:64] or "item"


def read_lib() -> dict:
    p = LIB / "library.json"
    return json.loads(p.read_text()) if p.exists() else {"version": 1, "items": []}


def write_lib(d: dict) -> None:
    tmp = LIB / "library.json.tmp"
    tmp.write_text(json.dumps(d, indent=2) + "\n")
    tmp.replace(LIB / "library.json")


def trash() -> list[dict]:
    out = []
    for d in sorted((LIB / ".trash").glob("*/entry.json")):
        e = json.loads(d.read_text())
        out.append({"id": e["id"], "name": e["name"], "deleted": e.get("_deleted")})
    return out


def estimate(meta: dict) -> float:
    engine = meta.get("engine", "glb")
    price = PRICE[engine]
    return price.get(int(meta.get("resolution", 512)), 0.25) if isinstance(price, dict) else price


def check_meta(meta: dict, kind: str) -> str | None:
    if not isinstance(meta, dict) or not str(meta.get("name", "")).strip():
        return "name is required"
    dims = meta.get("dims_cm")
    if not isinstance(dims, dict) or not all(isinstance(dims.get(k), (int, float)) and dims[k] > 0 for k in "wdh"):
        return "dims_cm must be {w, d, h} in cm, all greater than 0"
    if "id" in meta and not SLUG.fullmatch(str(meta["id"])):
        return f"id must be a slug (lowercase letters, digits and dashes), got {meta['id']!r}"
    if kind == "image" and meta.get("engine", "sam3d") not in ("sam3d", "trellis2"):
        return f"engine must be sam3d or trellis2, got {meta.get('engine')!r}"
    if meta.get("mount", "floor") not in ("floor", "wall"):
        return "mount must be floor or wall"
    return None


def run_job(job: dict, src: Path | None, meta: dict) -> None:
    global spent
    time.sleep(A.seconds)
    with lock:
        job.update(status="running", started=now(), message="making the model")
    time.sleep(A.seconds / 2)
    with lock:
        lib = read_lib()
        iid = job["item_id"]
        d = LIB / iid
        if job["kind"] == "add":
            replaced = any(i["id"] == iid for i in lib["items"])
            d.mkdir(parents=True, exist_ok=True)
            glb = src if src and src.suffix == ".glb" else REPO / "fixtures/models/SheenChair.glb"
            shutil.copyfile(glb, d / "model.glb")
            item = {"id": iid, "name": meta["name"], "category": meta.get("category"), "dims_cm": meta["dims_cm"],
                    "assets": {"glb": f"{iid}/model.glb", "splat": None, "thumb": None}, "default_render": "glb",
                    "source": {"engine": job["engine"], "input": job.get("input", "upload"), "prompt": meta.get("prompt"),
                               "cost_usd": 0, "mock": True, "created": now()}}
            if meta.get("mount"):
                item["mount"] = meta["mount"]
            lib["items"] = [i for i in lib["items"] if i["id"] != iid] + [item]
            msg = f"replaced {iid}" if replaced else f"added {iid}"
        else:  # rescale
            item = next(i for i in lib["items"] if i["id"] == iid)
            item["dims_cm"] = meta.get("dims_cm", item["dims_cm"])
            msg = f"refitted {iid}"
        write_lib(lib)
        job.update(status="done", finished=now(), message=msg, item=item, cost_usd=0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status: int, data, headers: dict | None = None) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def err(self, status: int, msg: str, **extra) -> None:
        self.send(status, {"error": msg, **extra})

    def mine(self) -> bool:
        p = self.path.split("?")[0]
        return p.startswith("/api/library") or p == "/api/spend" or p.startswith("/library/")

    def guarded(self) -> bool:
        origin = self.headers.get("Origin")
        own = {f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"}
        if self.headers.get("X-Nook") == "1" and (origin is None or origin in own):
            return True
        self.err(403, "cross-site request refused")
        return False

    def v4_rooms(self, data: bytes) -> bytes:
        """Fill in §2.7 v4 room fields upstream doesn't know yet (mock only)."""
        try:
            d = json.loads(data)
        except ValueError:
            return data
        caps = {}
        if A.scan:
            try:
                for c in json.load(urllib.request.urlopen(A.scan.rstrip("/") + "/api/scan/captures", timeout=5))["captures"]:
                    for r in c["rooms"]:
                        caps[r] = c["name"]
            except (OSError, ValueError, KeyError):
                pass
        rd = Path(A.room_dir)
        for r in d.get("rooms", []):
            if "roomplan_url" not in r:
                r["roomplan_url"] = f"/room/{r['name']}.roomplan.json" if (rd / f"{r['name']}.roomplan.json").exists() else None
            if "capture" not in r:
                r["capture"] = caps.get(r["name"])
            if "parent" not in r:
                cfg = rd / f"{r['name']}.room.json"
                r["parent"] = json.loads(cfg.read_text()).get("parent") if cfg.exists() else None
        return json.dumps(d).encode()

    def forward(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(A.upstream + self.path, data=body, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() != "connection"})  # Host kept: upstream checks Origin against it
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            resp = e
        except OSError as e:
            return self.err(502, f"upstream {A.upstream} unreachable: {e}")
        data = resp.read()
        if A.room_dir and self.command == "GET" and self.path.split("?")[0] == "/api/rooms" and resp.status == 200:
            data = self.v4_rooms(data)
        self.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.mine():
            return self.forward()
        p = self.path.split("?")[0]
        if p == "/api/library":
            with lock:
                return self.send(200, read_lib() | {"trash": trash()})
        if p == "/api/library/jobs":
            with lock:
                return self.send(200, {"jobs": sorted(jobs.values(), key=lambda j: j["created"], reverse=True)})
        m = re.fullmatch(r"/api/library/jobs/([A-Za-z0-9-]+)", p)
        if m:
            with lock:
                j = jobs.get(m.group(1))
            return self.send(200, j) if j else self.err(404, f"no job {m.group(1)}")
        if p == "/api/spend":
            return self.send(200, {"day": now()[:10], "spent_usd": spent, "reserved_usd": 0, "cap_usd": A.cap})
        rel = p[len("/library/"):]
        parts = rel.split("/")
        f = (LIB / rel).resolve()
        if (any(x.startswith(".") or x == "raw" for x in parts) or rel == "costs.csv" or not f.is_file()
                or LIB.resolve() not in f.parents):
            return self.err(404, "not found")
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def add(self, kind: str, meta: dict, src: Path | None, input_name: str) -> None:
        global spent
        if kind == "model":
            meta["engine"] = "glb"
        meta.setdefault("engine", "sam3d")
        problem = check_meta(meta, kind)
        if problem:
            return self.err(400, problem)
        est = estimate(meta)
        if est and spent + est > A.cap + 1e-9:
            return self.err(402, f"today's fal budget (${A.cap:.2f}) is used up: ${spent:.2f} spent", spent_usd=spent, cap_usd=A.cap)
        jid = f"l-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
        job = {"id": jid, "kind": "add", "item_id": meta.get("id") or slugify(meta["name"]), "status": "queued",
               "engine": meta["engine"], "cost_usd_estimate": est, "cost_usd": None, "mock": True, "created": now(),
               "started": None, "finished": None, "message": "waiting", "item": None, "input": input_name}
        with lock:
            jobs[jid] = job
        threading.Thread(target=run_job, args=(job, src, meta), daemon=True).start()
        self.send(202, {"job": job, "cost_usd_estimate": est})

    def do_POST(self):
        if not self.mine():
            return self.forward()
        if not self.guarded():
            return
        p = self.path.split("?")[0]
        if p == "/api/library/items":
            if self.headers.get("Content-Length") is None:
                return self.err(411, "Content-Length is required: send the file as the body")
            n = int(self.headers["Content-Length"])
            kind = self.headers.get("X-Nook-Kind")
            name = Path(self.headers.get("X-Nook-Filename") or "upload").name
            if kind not in ("model", "image"):
                return self.err(400, "X-Nook-Kind must be model or image")
            if n > (200 if kind == "model" else 20) * 1024 ** 2:
                return self.err(413, f"too big: {'models' if kind == 'model' else 'images'} can be at most {200 if kind == 'model' else 20} MB")
            try:
                meta = json.loads(base64.b64decode(self.headers.get("X-Nook-Meta") or ""))
            except ValueError:
                return self.err(400, "X-Nook-Meta must be base64 of a JSON object with name and dims_cm")
            ext = Path(name).suffix.lower()
            if kind == "model" and ext not in (".glb", ".zip"):
                return self.err(400, "models must be a .glb, or a .zip with an .obj, its .mtl and textures: convert to GLB first")
            tmp = Path(tempfile.mkdtemp(prefix="nook-mocklib-")) / f"upload{ext}"
            tmp.write_bytes(self.rfile.read(n))
            return self.add(kind, meta, tmp, name)
        if p == "/api/library/items/from-url":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                url = body.pop("image_url")
            except (ValueError, KeyError, AttributeError):
                return self.err(400, 'body must be JSON like {"image_url": "https://...", "name": ..., "dims_cm": ...}')
            if not str(url).startswith(("http://", "https://")):
                return self.err(400, "only http and https links work")
            return self.add("image", body, None, url)
        m = re.fullmatch(r"/api/library/items/([a-z0-9-]+)/restore", p)
        if m:
            iid = m.group(1)
            with lock:
                lib = read_lib()
                if any(i["id"] == iid for i in lib["items"]):
                    return self.err(409, f"an item {iid} exists again: remove or rename it first")
                cands = sorted((LIB / ".trash").glob(f"{iid}-*/entry.json"))
                if not cands:
                    return self.err(404, f"{iid} isn't in the trash")
                t = cands[-1].parent
                entry = json.loads((t / "entry.json").read_text())
                entry.pop("_deleted", None)
                shutil.move(str(t / iid), str(LIB / iid))
                shutil.rmtree(t)
                lib["items"].append(entry)
                write_lib(lib)
            return self.send(200, entry)
        self.err(404, "not found")

    def do_PATCH(self):
        if not self.guarded():
            return
        m = re.fullmatch(r"/api/library/items/([a-z0-9-]+)", self.path.split("?")[0])
        if not m:
            return self.err(404, "not found")
        try:
            patch = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            assert isinstance(patch, dict)
        except (ValueError, AssertionError):
            return self.err(400, "body must be a JSON object")
        with lock:
            lib = read_lib()
            item = next((i for i in lib["items"] if i["id"] == m.group(1)), None)
            if not item:
                return self.err(404, f"no item {m.group(1)}")
            if patch.get("default_render") == "splat" and not item["assets"].get("splat"):
                return self.err(400, "this item has no splat: default_render can only be glb")
            for k in ("name", "category", "mount", "default_render"):
                if k in patch:
                    item[k] = patch[k]
            write_lib(lib)
        if "dims_cm" in patch or "yaw" in patch:
            jid = f"l-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
            job = {"id": jid, "kind": "rescale", "item_id": item["id"], "status": "queued", "engine": "glb",
                   "cost_usd_estimate": 0, "cost_usd": None, "mock": True, "created": now(), "started": None,
                   "finished": None, "message": "waiting", "item": None}
            with lock:
                jobs[jid] = job
            threading.Thread(target=run_job, args=(job, None, patch), daemon=True).start()
            return self.send(202, {"job": job})
        self.send(200, item)

    def do_PUT(self):
        if not self.mine():
            return self.forward()
        self.err(405, "the library is changed through POST, PATCH and DELETE")

    def do_DELETE(self):
        if not self.mine():
            return self.forward()
        if not self.guarded():
            return
        m = re.fullmatch(r"/api/library/items/([a-z0-9-]+)", self.path.split("?")[0])
        if not m:
            return self.err(404, "not found")
        iid = m.group(1)
        with lock:
            lib = read_lib()
            entry = next((i for i in lib["items"] if i["id"] == iid), None)
            if not entry:
                return self.err(404, f"no item {iid}")
            t = LIB / ".trash" / f"{iid}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S%f')}"
            t.mkdir(parents=True)
            if (LIB / iid).exists():
                shutil.move(str(LIB / iid), str(t / iid))
            (t / "entry.json").write_text(json.dumps(entry | {"_deleted": now()}))
            lib["items"] = [i for i in lib["items"] if i["id"] != iid]
            write_lib(lib)
        self.send(200, {"ok": True})


def main():
    global A, LIB
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True, help="the planner server for everything that isn't the library")
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--seconds", type=float, default=2.0)
    ap.add_argument("--cap", type=float, default=2.0, help="the daily spend cap shown by /api/spend (mock adds cost $0)")
    ap.add_argument("--room-dir", help="the upstream's room dir, to fill in v4 room fields (§2.7)")
    ap.add_argument("--scan", help="the jobs server (mock_scan_server.py), for each room's kept capture")
    ap.add_argument("--library", help="library folder to serve (default: a scratch copy of fixtures/library)")
    A = ap.parse_args()
    A.upstream = A.upstream.rstrip("/")
    if A.library:
        LIB = Path(A.library).resolve()
    else:
        LIB = Path(tempfile.mkdtemp(prefix="nook-mocklib-lib-")) / "library"
        shutil.copytree(REPO / "fixtures/library", LIB)
    srv = ThreadingHTTPServer((A.host, A.port), Handler)
    print(f"mock library server on http://{A.host}:{A.port} (library {LIB}, everything else from {A.upstream})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
