#!/usr/bin/env python3
"""nook planner server (stdlib only).

Serves the repo root as static files and a tiny JSON API for the room config and layouts.
See contract/CONTRACT.md section 2.1.

    python3 planner/serve.py [--port 8765] [--room-file room/room.json] [--layouts-dir layouts]

Relative --room-file / --layouts-dir paths are resolved against the repo root.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

REPO = Path(__file__).resolve().parent.parent
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PLACEHOLDER_ROOM = {"version": 1, "placeholder": {"w": 3.5, "d": 4, "h": 2.7}}
MAX_BODY = 32 * 1024 * 1024

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

    def __init__(self, *args, room_file: Path, layouts_dir: Path, **kwargs):
        self.room_file = room_file
        self.layouts_dir = layouts_dir
        super().__init__(*args, directory=str(REPO), **kwargs)

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
        return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "use GET or PUT")

    do_DELETE = do_POST

    # --- api -------------------------------------------------------------
    def handle_api_get(self, api: str):
        try:
            if api == "/api/room":
                return self.get_room()
            if api == "/api/layouts":
                return self.list_layouts()
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


def resolve(p: str) -> Path:
    path = Path(p).expanduser()
    return path if path.is_absolute() else (REPO / path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="nook planner server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--room-file", default="room/room.json")
    ap.add_argument("--layouts-dir", default="layouts")
    args = ap.parse_args(argv)

    handler = partial(Handler, room_file=resolve(args.room_file), layouts_dir=resolve(args.layouts_dir))
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"nook planner: http://{args.host}:{args.port}/planner/  (serving {REPO})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
