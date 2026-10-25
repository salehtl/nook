#!/usr/bin/env python3
"""nook planner server (stdlib only).

Serves the repo root as static files and a tiny JSON API for the room config, layouts and
"Render this view" (a paid fal image edit of a planner screenshot). See contract/CONTRACT.md §2.1 and §2.6.

    python3 planner/serve.py [--port 8765] [--room-file room/room.json] [--layouts-dir layouts]
                             [--renders-dir renders] [--costs-file library/costs.csv]

Relative paths are resolved against the repo root. FAL_KEY comes from the environment, else from
<repo>/.env (unless NOOK_NO_DOTENV=1). With NOOK_FAL_MOCK set, /api/render makes no network calls.
"""
import argparse
import base64
import binascii
import csv
import io
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

REPO = Path(__file__).resolve().parent.parent
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PLACEHOLDER_ROOM = {"version": 1, "placeholder": {"w": 3.5, "d": 4, "h": 2.7}}
MAX_BODY = 32 * 1024 * 1024

# --- render this view (contract §2.6) -------------------------------------------------------
RENDER_MODELS = {
    "kontext": {"endpoint": "fal-ai/flux-pro/kontext", "image_key": "image_url", "cost": lambda mp: 0.04},
    "nano-banana": {"endpoint": "fal-ai/nano-banana/edit", "image_key": "image_urls", "cost": lambda mp: 0.0398},
    "qwen": {"endpoint": "fal-ai/qwen-image-edit", "image_key": "image_url", "cost": lambda mp: round(0.03 * mp, 4)},
}
DEFAULT_RENDER_PROMPT = (
    "Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, "
    "room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, "
    "soft natural daylight, subtle contact shadows. Do not add, remove or move anything."
)
RENDER_NAME = re.compile(r"^render-\d{8}-\d{6}(-\d+)?$")
COSTS_HEADER = ["date", "id", "engine", "cost_usd", "mock", "input"]
FAL_TIMEOUT = 300
NO_KEY = "FAL_KEY not set: add FAL_KEY=... to nook/.env"
render_lock = threading.Lock()
reserved_names: set[str] = set()


def fal_mock() -> bool:
    return bool(os.environ.get("NOOK_FAL_MOCK"))


def fal_key() -> str | None:
    """FAL_KEY from the environment, else from <repo>/.env (unless NOOK_NO_DOTENV=1), same as the pipeline. Never logged."""
    if os.environ.get("FAL_KEY"):
        return os.environ["FAL_KEY"]
    if os.environ.get("NOOK_NO_DOTENV", "") not in ("", "0"):
        return None
    try:
        lines = (REPO / ".env").read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        key, sep, value = line.strip().removeprefix("export ").strip().partition("=")
        if sep and key.strip() == "FAL_KEY":
            value = value.strip().strip("'\"")
            if value:
                return value
    return None


def jpeg_size(data: bytes):
    """(width, height) from a JPEG's SOF marker, or None."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        length = (data[i + 2] << 8) | data[i + 3]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return (data[i + 7] << 8) | data[i + 8], (data[i + 5] << 8) | data[i + 6]
        i += 2 + length
    return None


def fmt_cost(cost: float) -> str:
    return f"{cost:.2f}" if round(cost, 2) == round(cost, 6) else f"{cost:.4f}"


def append_cost(path: Path, date: str, name: str, engine: str, cost: float, mock: bool, view: str) -> None:
    """One row in the shared costs.csv (same columns as the pipeline), written atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if not text.strip():
        text = ",".join(COSTS_HEADER) + "\n"
    elif not text.endswith("\n"):
        text += "\n"
    row = io.StringIO()
    csv.writer(row, lineterminator="\n").writerow([date, name, engine, fmt_cost(cost), "true" if mock else "false", view])
    atomic_write_bytes(path, (text + row.getvalue()).encode("utf-8"))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class FalError(Exception):
    pass


def fal_call(endpoint: str, args: dict, key: str) -> dict:
    req = urllib.request.Request(
        f"https://fal.run/{endpoint}", data=json.dumps(args).encode("utf-8"), method="POST",
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=FAL_TIMEOUT) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode("utf-8", "replace")
        raise FalError(f"fal {endpoint} returned HTTP {e.code}: {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FalError(f"could not reach fal ({endpoint}): {getattr(e, 'reason', e)}") from None
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise FalError(f"fal {endpoint} returned something that isn't JSON ({e})") from None


def download(url: str) -> bytes:
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "nook"}), timeout=120) as res:
        return res.read()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".spz": "application/octet-stream",
    ".ply": "application/octet-stream",
    ".splat": "application/octet-stream",
    ".ksplat": "application/octet-stream",
    ".sog": "application/octet-stream",
}


def atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME, "": "application/octet-stream"}

    def __init__(self, *args, room_file: Path, layouts_dir: Path, renders_dir: Path, costs_file: Path, **kwargs):
        self.room_file = room_file
        self.layouts_dir = layouts_dir
        self.renders_dir = renders_dir
        self.costs_file = costs_file
        super().__init__(*args, directory=str(REPO), **kwargs)

    def translate_path(self, path):
        # /renders/<file> is served from --renders-dir (which may live outside the repo root's renders/).
        p = unquote(urlsplit(path).path)
        if p.startswith("/renders/"):
            name = p[len("/renders/"):]
            if not name or "/" in name or "\\" in name or name.startswith("."):
                return str(self.renders_dir / ".missing")
            return str(self.renders_dir / name)
        return super().translate_path(path)

    # --- plumbing --------------------------------------------------------
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status: int, data) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ValueError("empty request body")
        if length > MAX_BODY:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"body is not valid JSON: {e}") from None

    def api_path(self):
        path = unquote(urlsplit(self.path).path)
        return path if path == "/api" or path.startswith("/api/") else None

    # --- static ----------------------------------------------------------
    def hidden(self) -> bool:
        """Never serve dotfiles/dirs (.env holds FAL_KEY, .git, .venv)."""
        parts = unquote(urlsplit(self.path).path).split("/")
        return any(p.startswith(".") and p not in ("", ".", "..") for p in parts)

    def do_GET(self):
        api = self.api_path()
        if api is not None:
            return self.handle_api_get(api)
        if urlsplit(self.path).path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/planner/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.hidden():
            return self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return super().do_HEAD() if self.command == "HEAD" else super().do_GET()

    do_HEAD = do_GET  # same routing; send_json and super().do_HEAD() skip the body

    def do_PUT(self):
        api = self.api_path()
        if api is None:
            return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "PUT is only supported under /api")
        try:
            if api == "/api/room":
                return self.put_room()
            m = re.fullmatch(r"/api/layouts/(.*)", api)
            if m:
                return self.put_layout(m.group(1))
            return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: PUT {api}")
        except Exception as e:  # keep the server alive and answer in JSON
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")

    def do_POST(self):
        api = self.api_path()
        if api == "/api/render":
            try:
                return self.post_render()
            except Exception as e:
                return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "use GET or PUT (POST only for /api/render)")

    def do_DELETE(self):
        return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "use GET or PUT")

    # --- api -------------------------------------------------------------
    def handle_api_get(self, api: str):
        try:
            if api == "/api/room":
                return self.get_room()
            if api == "/api/layouts":
                return self.list_layouts()
            if api == "/api/renders":
                return self.list_renders()
            m = re.fullmatch(r"/api/layouts/(.*)", api)
            if m:
                return self.get_layout(m.group(1))
            return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: GET {api}")
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")

    def get_room(self):
        if not self.room_file.exists():
            return self.send_json(HTTPStatus.OK, PLACEHOLDER_ROOM)
        try:
            data = json.loads(self.room_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"room file {self.room_file} is unreadable: {e}")
        return self.send_json(HTTPStatus.OK, data)

    def put_room(self):
        try:
            data = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(data, dict) or "version" not in data:
            return self.error_json(HTTPStatus.BAD_REQUEST, "room must be a JSON object with a 'version' field")
        atomic_write_json(self.room_file, data)
        return self.send_json(HTTPStatus.OK, {"ok": True})

    def list_layouts(self):
        names = []
        if self.layouts_dir.is_dir():
            names = sorted(p.stem for p in self.layouts_dir.glob("*.json") if SLUG.match(p.stem))
        return self.send_json(HTTPStatus.OK, {"layouts": names})

    def get_layout(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no layout named {name!r} (names are slugs: a-z, 0-9, -)")
        path = self.layouts_dir / f"{name}.json"
        if not path.is_file():
            return self.error_json(HTTPStatus.NOT_FOUND, f"no layout named {name!r}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"layout {name!r} is unreadable: {e}")
        return self.send_json(HTTPStatus.OK, data)

    def put_layout(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.BAD_REQUEST, f"layout name must be a slug (a-z, 0-9, -): {name!r}")
        try:
            data = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(data, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "layout must be a JSON object")
        atomic_write_json(self.layouts_dir / f"{name}.json", data)
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name})

    # --- render this view ------------------------------------------------
    def list_renders(self):
        renders = []
        if self.renders_dir.is_dir():
            for p in self.renders_dir.glob("render-*.json"):
                if not RENDER_NAME.match(p.stem):
                    continue
                try:
                    meta = json.loads(p.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(meta, dict):
                    renders.append(meta)
        renders.sort(key=lambda m: (str(m.get("created", "")), str(m.get("name", ""))), reverse=True)
        return self.send_json(HTTPStatus.OK, {"renders": renders, "mock": fal_mock()})

    def reserve_render_name(self, now: datetime) -> str:
        base = f"render-{now:%Y%m%d-%H%M%S}"
        with render_lock:
            n, name = 1, base
            while name in reserved_names or any(
                    (self.renders_dir / f"{name}{ext}").exists() for ext in (".jpg", "-input.jpg", ".json")):
                n += 1
                name = f"{base}-{n}"
            reserved_names.add(name)
        return name

    def post_render(self):
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(body, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
        image = body.get("image")
        m = re.fullmatch(r"data:image/jpe?g;base64,([A-Za-z0-9+/=\s]+)", image) if isinstance(image, str) else None
        data = None
        if m:
            try:
                data = base64.b64decode(re.sub(r"\s", "", m.group(1)), validate=True)
            except (binascii.Error, ValueError):
                data = None
        if not data or data[:3] != b"\xff\xd8\xff":
            return self.error_json(HTTPStatus.BAD_REQUEST, "image must be a JPEG data URI (data:image/jpeg;base64,...)")
        model = body.get("model") or "nano-banana"
        if model not in RENDER_MODELS:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"unknown model {model!r} (choose from {', '.join(RENDER_MODELS)})")
        prompt = body.get("prompt") or DEFAULT_RENDER_PROMPT
        if not isinstance(prompt, str):
            return self.error_json(HTTPStatus.BAD_REQUEST, "prompt must be a string")
        view = body.get("view") if isinstance(body.get("view"), str) else None
        layout = body.get("layout") if isinstance(body.get("layout"), str) else None
        spec = RENDER_MODELS[model]
        size = jpeg_size(data)
        megapixels = (size[0] * size[1] / 1e6) if size else 1.0
        mock = fal_mock()
        key = None if mock else fal_key()
        if not mock and not key:
            return self.error_json(HTTPStatus.SERVICE_UNAVAILABLE, NO_KEY)

        now = datetime.now(timezone.utc)
        name = self.reserve_render_name(now)
        cost = 0.0
        if mock:
            result = data  # mock: the "render" is the input, $0, no network
        else:
            data_uri = "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
            args = {spec["image_key"]: [data_uri] if spec["image_key"] == "image_urls" else data_uri,
                    "prompt": prompt, "output_format": "jpeg"}
            try:
                out = fal_call(spec["endpoint"], args, key)
            except FalError as e:
                return self.error_json(HTTPStatus.BAD_GATEWAY, str(e))
            # fal has returned, so the call is billed: record it even if the download below fails.
            cost = spec["cost"](megapixels)
            append_cost(self.costs_file, now.strftime("%Y-%m-%dT%H:%M:%SZ"), name, f"render:{model}", cost, False, view or "")
            images = out.get("images") if isinstance(out, dict) else None
            url = images[0].get("url") if isinstance(images, list) and images and isinstance(images[0], dict) else None
            if not url:
                return self.error_json(HTTPStatus.BAD_GATEWAY, f"fal {spec['endpoint']} returned no image (${fmt_cost(cost)} recorded)")
            try:
                result = download(url)
            except Exception as e:  # noqa: BLE001 - any download failure is a 502
                return self.error_json(HTTPStatus.BAD_GATEWAY, f"could not download the render ({e}); ${fmt_cost(cost)} recorded")
        meta = {
            "name": name,
            "url": f"/renders/{name}.jpg",
            "input_url": f"/renders/{name}-input.jpg",
            "model": model,
            "endpoint": spec["endpoint"],
            "cost_usd": cost,
            "mock": mock,
            "prompt": prompt,
            "created": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "view": view,
            "layout": layout,
            "width": size[0] if size else None,
            "height": size[1] if size else None,
        }
        atomic_write_bytes(self.renders_dir / f"{name}-input.jpg", data)
        atomic_write_bytes(self.renders_dir / f"{name}.jpg", result)
        atomic_write_json(self.renders_dir / f"{name}.json", meta)
        if mock:
            append_cost(self.costs_file, now.strftime("%Y-%m-%dT%H:%M:%SZ"), name, f"render:{model}", 0.0, True, view or "")
        with render_lock:
            reserved_names.discard(name)  # the files now hold the name; after a failure it stays reserved
        return self.send_json(HTTPStatus.OK, meta)


def resolve(p: str) -> Path:
    path = Path(p).expanduser()
    return path if path.is_absolute() else (REPO / path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="nook planner server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--room-file", default="room/room.json")
    ap.add_argument("--layouts-dir", default="layouts")
    ap.add_argument("--renders-dir", default="renders")
    ap.add_argument("--costs-file", default="library/costs.csv")
    args = ap.parse_args(argv)

    handler = partial(Handler, room_file=resolve(args.room_file), layouts_dir=resolve(args.layouts_dir),
                      renders_dir=resolve(args.renders_dir), costs_file=resolve(args.costs_file))
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"nook planner: http://{args.host}:{args.port}/planner/  (serving {REPO})", flush=True)
    if fal_mock():
        print("nook planner: NOOK_FAL_MOCK is set, so Render makes no fal calls and costs $0", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
