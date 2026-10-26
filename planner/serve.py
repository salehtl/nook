#!/usr/bin/env python3
"""nook planner server (stdlib only).

Serves the repo root as static files and a tiny JSON API for the room config, the rooms (every scan in the room
dir, each with its own config, thumbnail and layouts), layouts and "Render this view" (a paid fal image edit of a
planner screenshot). See contract/CONTRACT.md §2.1, §2.6 and §2.7.

    python3 planner/serve.py [--port 8765] [--room-dir room] [--room-file <room-dir>/room.json] [--layouts-dir layouts]
                             [--renders-dir renders] [--costs-file library/costs.csv]

Relative paths are resolved against the repo root. FAL_KEY comes from the environment, else from
<repo>/.env (unless NOOK_NO_DOTENV=1). With NOOK_FAL_MOCK set, /api/render makes no network calls.
"""
import argparse
import http.client
import base64
import binascii
import csv
import io
import json
import os
import re
import sys
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urlsplit

REPO = Path(__file__).resolve().parent.parent
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PLACEHOLDER_ROOM = {"version": 1, "placeholder": {"w": 3.5, "d": 4, "h": 2.7}}
MAX_BODY = 32 * 1024 * 1024
SCAN_EXTS = (".spz", ".ply")  # a room's scan; .spz wins when both exist (contract §2.7)
MAX_THUMB = 2 * 1024 * 1024
rooms_lock = threading.RLock()  # room-dir writes (adoption, save, thumbnail, delete) one at a time

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


# --- rooms (contract §2.7) ----------------------------------------------------------------------
def iso_utc(t: float | None = None) -> str:
    dt = datetime.fromtimestamp(t, timezone.utc) if t is not None else datetime.now(timezone.utc)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def read_json_file(path: Path):
    """The parsed file, or None when it is missing or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def splat_stem(config) -> str | None:
    """The basename stem of a config's `splat` (room/scan-1.spz -> scan-1): how room.json and layouts name a room."""
    splat = config.get("splat") if isinstance(config, dict) else None
    if not isinstance(splat, str) or not splat:
        return None
    return PurePosixPath(urlsplit(splat).path).stem or None


def splat_url(scan: Path, room_dir: Path) -> str:
    """Same rule as the trainer (scan/src/nook_scan/room.py): relative to the repo root, or to room-dir's parent
    when room-dir is outside the repo."""
    scan = scan.resolve()
    base = REPO if REPO in scan.parents else room_dir.resolve().parent
    return scan.relative_to(base).as_posix()


def list_scans(room_dir: Path) -> dict[str, Path]:
    """{name: scan file} for every slug-named .spz/.ply in room-dir (dotfiles and .trash ignored)."""
    scans: dict[str, Path] = {}
    if not room_dir.is_dir():
        return scans
    for p in room_dir.iterdir():
        if p.name.startswith(".") or p.suffix not in SCAN_EXTS or not SLUG.match(p.stem) or not p.is_file():
            continue
        if p.stem not in scans or p.suffix == ".spz":
            scans[p.stem] = p
    return scans


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
    ".webmanifest": "application/manifest+json",
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

    def __init__(self, *args, room_file: Path, layouts_dir: Path, renders_dir: Path, costs_file: Path,
                 room_dir: Path | None = None, library_dir: Path | None = None, scan_api: str | None = None, **kwargs):
        self.room_file = room_file
        self.room_dir = room_dir or (REPO / "room")  # where the rooms live (served as /room/)
        self.layouts_dir = layouts_dir
        self.renders_dir = renders_dir
        self.costs_file = costs_file
        # Writable data outside the code (on kakapo the code is in the read-only Nix store).
        self.mounts = {"/room/": room_dir, "/library/": library_dir}
        self.scan_api = scan_api
        super().__init__(*args, directory=str(REPO), **kwargs)

    def translate_path(self, path):
        # /renders/<file> is served from --renders-dir (which may live outside the repo root's renders/).
        p = unquote(urlsplit(path).path)
        if p.startswith("/renders/"):
            name = p[len("/renders/"):]
            if not name or "/" in name or "\\" in name or name.startswith("."):
                return str(self.renders_dir / ".missing")
            return str(self.renders_dir / name)
        for prefix, base in self.mounts.items():
            if base is not None and p.startswith(prefix):
                parts = [x for x in p[len(prefix):].split("/") if x]
                if any(x.startswith(".") or "\\" in x for x in parts):
                    return str(base / ".missing")
                return str(base.joinpath(*parts))
        return super().translate_path(path)

    # --- /api/scan/* -> nook-scan jobs server (contract §2.1 --scan-api, §5) ---------------------
    def is_scan(self) -> bool:
        path = unquote(urlsplit(self.path).path)
        return bool(self.scan_api) and (path == "/api/scan" or path.startswith("/api/scan/"))

    def proxy_scan(self):
        """Stream the request to the jobs server and its answer back (uploads are hundreds of MB)."""
        target = urlsplit(self.scan_api)
        length = self.headers.get("Content-Length")
        if self.command == "POST" and length is None and urlsplit(self.path).path.rstrip("/").endswith("/captures"):
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: upload the zip as a file")
        conn = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=600)
        try:
            conn.putrequest(self.command, self.path, skip_accept_encoding=True)
            for h in ("Content-Type", "Content-Length", "X-Nook-Name", "Accept"):
                if self.headers.get(h) is not None:
                    conn.putheader(h, self.headers[h])
            conn.endheaders()
            left = int(length or 0)
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                conn.send(chunk)
                left -= len(chunk)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            return self.error_json(HTTPStatus.BAD_GATEWAY, f"the nook-scan jobs server at {self.scan_api} isn't answering ({e})")
        self.send_response(resp.status)
        for h in ("Content-Type", "Content-Length"):
            if resp.getheader(h) is not None:
                self.send_header(h, resp.getheader(h))
        self.end_headers()
        while chunk := resp.read(1 << 16):
            self.wfile.write(chunk)
        conn.close()

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
        if self.is_scan():
            return self.proxy_scan()
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
            m = re.fullmatch(r"/api/rooms/([^/]*)/thumb", api)
            if m:
                return self.put_room_thumb(m.group(1))
            m = re.fullmatch(r"/api/rooms/([^/]*)", api)
            if m:
                return self.put_room_config(m.group(1))
            m = re.fullmatch(r"/api/layouts/(.*)", api)
            if m:
                return self.put_room_layout(m.group(1)) if self.room_query() is not None else self.put_layout(m.group(1))
            return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: PUT {api}")
        except Exception as e:  # keep the server alive and answer in JSON
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")

    def do_POST(self):
        if self.is_scan():
            return self.proxy_scan()
        api = self.api_path()
        if api == "/api/render":
            try:
                return self.post_render()
            except Exception as e:
                return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "use GET or PUT (POST only for /api/render)")

    def do_DELETE(self):
        api = self.api_path()
        try:
            m = re.fullmatch(r"/api/rooms/([^/]*)", api or "")
            if m:
                return self.delete_room(m.group(1))
            m = re.fullmatch(r"/api/layouts/(.*)", api or "")
            if m and self.room_query() is not None:
                return self.delete_room_layout(m.group(1))
            if m:
                return self.error_json(HTTPStatus.BAD_REQUEST, "only a room's layouts can be deleted: add ?room=<name>")
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "use GET or PUT")

    # --- api -------------------------------------------------------------
    def handle_api_get(self, api: str):
        try:
            if api == "/api/room":
                return self.get_room()
            if api == "/api/layouts":
                return self.list_room_layouts() if self.room_query() is not None else self.list_layouts()
            if api == "/api/renders":
                return self.list_renders()
            if api == "/api/rooms":
                return self.list_rooms()
            m = re.fullmatch(r"/api/rooms/([^/]*)", api)
            if m:
                return self.get_room_config(m.group(1))
            m = re.fullmatch(r"/api/layouts/(.*)", api)
            if m:
                return self.get_room_layout(m.group(1)) if self.room_query() is not None else self.get_layout(m.group(1))
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
        with rooms_lock:
            atomic_write_json(self.room_file, data)
            name = splat_stem(data)
            if name and name in list_scans(self.room_dir):  # keep that room's own config in step (§2.7)
                atomic_write_json(self.room_dir / f"{name}.room.json", data)
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

    # --- rooms (contract §2.7) ---------------------------------------------
    def room_query(self) -> str | None:
        """The ?room=<name> of this request, or None when there is none."""
        values = parse_qs(urlsplit(self.path).query).get("room")
        return values[0] if values else None

    def current_room(self, scans: dict[str, Path]) -> str | None:
        """The room room.json points at (matched by the basename stem of its splat), or None."""
        name = splat_stem(read_json_file(self.room_file))
        return name if name in scans else None

    def room_config(self, name: str, scan: Path, current: str | None) -> dict:
        """<name>.room.json; else room.json when it points at this room (adopted: copied to <name>.room.json);
        else the identity config. `splat` is always the room's scan. Call with rooms_lock held."""
        own = self.room_dir / f"{name}.room.json"
        config = read_json_file(own)
        if not isinstance(config, dict):
            config = None
            if name == current:
                legacy = read_json_file(self.room_file)
                if isinstance(legacy, dict):
                    config = dict(legacy, splat=splat_url(scan, self.room_dir))
                    atomic_write_json(own, config)
        if config is None:
            config = {"version": 1}
        config["splat"] = splat_url(scan, self.room_dir)
        return config

    def room_layouts(self, name: str) -> list[dict]:
        """The room's layouts plus the v1 layouts made for its scan (legacy), as {name, items, updated, legacy}."""
        found: dict[str, dict] = {}

        def add(path: Path, legacy: bool, data=None):
            data = read_json_file(path) if data is None else data
            items = data.get("items") if isinstance(data, dict) else None
            found[path.stem] = {"name": path.stem, "items": len(items) if isinstance(items, list) else 0,
                                "updated": iso_utc(path.stat().st_mtime), "legacy": legacy}

        own = self.layouts_dir / name
        if own.is_dir():
            for p in own.glob("*.json"):
                if SLUG.match(p.stem) and p.is_file():
                    add(p, False)
        if self.layouts_dir.is_dir():
            for p in self.layouts_dir.glob("*.json"):
                if not SLUG.match(p.stem) or p.stem in found or not p.is_file():
                    continue
                data = read_json_file(p)
                if isinstance(data, dict) and splat_stem(data.get("room")) == name:
                    add(p, True, data)
        return [found[k] for k in sorted(found)]

    def find_room(self, name: str):
        """(scans, scan) for a known room, or (scans, None)."""
        scans = list_scans(self.room_dir)
        return scans, scans.get(name) if SLUG.match(name) else None

    def no_room(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no room named {name!r} (room names are slugs: a-z, 0-9, -)")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no room named {name!r}: GET /api/rooms lists the rooms in {self.room_dir}")

    def list_rooms(self):
        with rooms_lock:
            scans = list_scans(self.room_dir)
            current = self.current_room(scans)
            rooms = []
            for name, scan in scans.items():
                config = self.room_config(name, scan, current)
                st = scan.stat()
                title = config.get("title")
                rooms.append({
                    "name": name, "title": title if isinstance(title, str) and title else None,
                    "splat": config["splat"], "created": iso_utc(st.st_mtime), "size_bytes": st.st_size,
                    "thumb_url": f"/room/{name}.jpg" if (self.room_dir / f"{name}.jpg").is_file() else None,
                    "aligned": bool(config.get("saved")), "layouts": len(self.room_layouts(name)),
                    "current": name == current, "_mtime": st.st_mtime,
                })
        rooms.sort(key=lambda r: (-r.pop("_mtime"), r["name"]))
        return self.send_json(HTTPStatus.OK, {"rooms": rooms, "current": current})

    def get_room_config(self, name: str):
        with rooms_lock:
            scans, scan = self.find_room(name)
            if scan is None:
                return self.no_room(name)
            return self.send_json(HTTPStatus.OK, self.room_config(name, scan, self.current_room(scans)))

    def put_room_config(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.BAD_REQUEST, f"room name must be a slug (a-z, 0-9, -): {name!r}")
        try:
            data = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(data, dict) or "version" not in data:
            return self.error_json(HTTPStatus.BAD_REQUEST, "room must be a JSON object with a 'version' field")
        with rooms_lock:
            scans, scan = self.find_room(name)
            if scan is None:
                return self.no_room(name)
            current = self.current_room(scans)
            # A rename (only `title` differs) keeps the old `saved` time, so it doesn't mark the room aligned.
            before = self.room_config(name, scan, current)
            same = lambda c: {k: v for k, v in c.items() if k not in ("title", "saved", "splat")}
            saved = before.get("saved") if same(data) == same(before) else iso_utc()
            config = dict(data, splat=splat_url(scan, self.room_dir), saved=saved)
            atomic_write_json(self.room_dir / f"{name}.room.json", config)
            if name == current:
                atomic_write_json(self.room_file, config)
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name, "saved": config["saved"], "current": name == current})

    def put_room_thumb(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.BAD_REQUEST, f"room name must be a slug (a-z, 0-9, -): {name!r}")
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        image = body.get("image") if isinstance(body, dict) else None
        m = re.fullmatch(r"data:image/jpe?g;base64,([A-Za-z0-9+/=\s]+)", image) if isinstance(image, str) else None
        data = None
        if m:
            try:
                data = base64.b64decode(re.sub(r"\s", "", m.group(1)), validate=True)
            except (binascii.Error, ValueError):
                data = None
        if not data or data[:3] != b"\xff\xd8\xff":
            return self.error_json(HTTPStatus.BAD_REQUEST, "image must be a JPEG data URI (data:image/jpeg;base64,...)")
        if len(data) > MAX_THUMB:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "thumbnail is over 2 MB: send a smaller JPEG")
        with rooms_lock:
            _, scan = self.find_room(name)
            if scan is None:
                return self.no_room(name)
            atomic_write_bytes(self.room_dir / f"{name}.jpg", data)
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name, "thumb_url": f"/room/{name}.jpg"})

    def delete_room(self, name: str):
        with rooms_lock:
            scans, scan = self.find_room(name)
            if scan is None:
                return self.no_room(name)
            current = self.current_room(scans)
            self.room_config(name, scan, current)  # adopt room.json first, so its alignment goes to the trash too
            base = f"{name}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
            trash, n = self.room_dir / ".trash" / base, 1
            while trash.exists():
                n += 1
                trash = self.room_dir / ".trash" / f"{base}-{n}"
            trash.mkdir(parents=True)
            for p in sorted(self.room_dir.glob(f"{name}.*")):  # scan(s), <name>.room.json, <name>.jpg
                if p.is_file():
                    shutil.move(str(p), str(trash / p.name))
            layouts = self.layouts_dir / name
            if layouts.is_dir():
                shutil.move(str(layouts), str(trash / "layouts"))
            if name == current:
                left = list_scans(self.room_dir)
                if left:
                    newest = max(left, key=lambda k: (left[k].stat().st_mtime, k))
                    atomic_write_json(self.room_file, self.room_config(newest, left[newest], None))
                elif self.room_file.exists():
                    shutil.move(str(self.room_file), str(trash / "room.json"))  # kept, never removed
        return self.send_json(HTTPStatus.OK, {"ok": True, "trash": trash.relative_to(self.room_dir).as_posix()})

    def layout_room(self):
        """(room name, None) for a known ?room=, else (None, error already sent)."""
        name = self.room_query()
        if not SLUG.match(name):
            self.error_json(HTTPStatus.BAD_REQUEST, f"room name must be a slug (a-z, 0-9, -): {name!r}")
            return None
        if self.find_room(name)[1] is None:
            self.no_room(name)
            return None
        return name

    def list_room_layouts(self):
        room = self.layout_room()
        if room is None:
            return
        details = self.room_layouts(room)
        return self.send_json(HTTPStatus.OK, {"layouts": [d["name"] for d in details], "details": details})

    def get_room_layout(self, name: str):
        room = self.layout_room()
        if room is None:
            return
        path = self.layouts_dir / room / f"{name}.json"
        if not SLUG.match(name) or not path.is_file():
            return self.get_layout(name)  # v1 fallback (and its 404s)
        data = read_json_file(path)
        if data is None:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"layout {name!r} of room {room!r} is unreadable: fix or delete it")
        return self.send_json(HTTPStatus.OK, data)

    def put_room_layout(self, name: str):
        room = self.layout_room()
        if room is None:
            return
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.BAD_REQUEST, f"layout name must be a slug (a-z, 0-9, -): {name!r}")
        try:
            data = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(data, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "layout must be a JSON object")
        atomic_write_json(self.layouts_dir / room / f"{name}.json", dict(data, room_name=room))
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name, "room": room})

    def delete_room_layout(self, name: str):
        room = self.layout_room()
        if room is None:
            return
        path = self.layouts_dir / room / f"{name}.json"
        if not SLUG.match(name) or not path.is_file():
            return self.error_json(HTTPStatus.NOT_FOUND, f"room {room!r} has no layout named {name!r} (v1 layouts aren't deleted)")
        path.unlink()
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name, "room": room})

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
    ap.add_argument("--room-file", default=None, help="default: <room-dir>/room.json")
    ap.add_argument("--room-dir", default=None, help="serve /room/ from here (default: the repo's room/)")
    ap.add_argument("--library-dir", default=None, help="serve /library/ from here (default: the repo's library/)")
    ap.add_argument("--scan-api", default=None, help="proxy /api/scan/* to this nook-scan jobs server, e.g. http://127.0.0.1:8095")
    ap.add_argument("--layouts-dir", default="layouts")
    ap.add_argument("--renders-dir", default="renders")
    ap.add_argument("--costs-file", default="library/costs.csv")
    args = ap.parse_args(argv)

    room_dir = resolve(args.room_dir) if args.room_dir else None
    room_file = resolve(args.room_file) if args.room_file else (room_dir or resolve("room")) / "room.json"
    handler = partial(Handler, room_file=room_file, layouts_dir=resolve(args.layouts_dir),
                      renders_dir=resolve(args.renders_dir), costs_file=resolve(args.costs_file), room_dir=room_dir,
                      library_dir=resolve(args.library_dir) if args.library_dir else None, scan_api=args.scan_api)
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
