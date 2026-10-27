#!/usr/bin/env python3
"""nook planner server (stdlib only).

Serves the repo root as static files and a tiny JSON API for the room config, the rooms (every scan in the room
dir, each with its own config, thumbnail and layouts), layouts, "Render this view" (a paid fal image edit of a
planner screenshot) and the furniture library (adds through `nook-add`, edits, trash and restore). Every request
needs a loopback Host (or one given with --allowed-host), every mutation needs `X-Nook: 1` and a same-origin (or
absent) Origin, and paid calls stay under a daily spend cap.
See contract/CONTRACT.md §2.1, §2.6, §2.7, §2.8 and §2.9.

    python3 planner/serve.py [--port 8765] [--room-dir room] [--room-file <room-dir>/room.json] [--layouts-dir layouts]
                             [--renders-dir renders] [--library-dir library] [--costs-file <library-dir>/costs.csv]
                             [--nook-add "uv run --project pipeline nook-add"] [--daily-spend-usd 2] [--scan-api URL]
                             [--allowed-host NAME ...]

Relative paths are resolved against the repo root. FAL_KEY comes from the environment, else from
<repo>/.env (unless NOOK_NO_DOTENV=1). With NOOK_FAL_MOCK set, /api/render makes no network calls (and nook-add
replays recorded responses). NOOK_FETCH_ALLOW=<host>:<port> (evals only) lets the URL fetcher reach that one address.
"""
import argparse
import contextlib
import fcntl
import http.client
import base64
import binascii
import csv
import io
import ipaddress
import json
import os
import posixpath
import queue
import re
import secrets
import shlex
import socket
import ssl
import stat
import subprocess
import sys
import shutil
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

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


@contextlib.contextmanager
def costs_locked(path: Path):
    """costs.csv.lock (flock) next to costs.csv: the small lock nook-add's cost rows take too (§2.9), never the
    library lock, so a render never waits for a running nook-add."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def append_cost(path: Path, date: str, name: str, engine: str, cost: float, mock: bool, view: str) -> None:
    """One row in the shared costs.csv (same columns as the pipeline), written atomically under costs.csv.lock."""
    with costs_locked(path):
        _append_cost(path, date, name, engine, cost, mock, view)


def _append_cost(path: Path, date: str, name: str, engine: str, cost: float, mock: bool, view: str) -> None:
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


# --- library API (contract §2.8) and money (§2.9) ------------------------------------------------------------
MAX_MODEL = 200 * 1024 * 1024
MAX_IMAGE = 20 * 1024 * 1024
MAX_DRAIN = 256 * 1024 * 1024  # an early error reads (and drops) a body up to this, so the client sees the answer
ENGINE_PRICE = {"sam3d": lambda res: 0.02, "trellis2": lambda res: {512: 0.25, 1024: 0.30, 1536: 0.35}[res],
                "glb": lambda res: 0.0}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
ZIP_ALLOWED = {".obj", ".mtl", ".png", ".jpg", ".jpeg"}
ZIP_MAX_ENTRIES = 1000
ZIP_MAX_UNPACKED = 500 * 1024 * 1024
LIBRARY_ASSET = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}/(model\.glb|splat\.ply|thumb\.jpg|source\.[A-Za-z0-9]{1,8})$")
NOOK_ADD_TIMEOUT = 3600
LOCK_WAIT = 60  # s a library edit waits for a running nook-add before answering 503
FORGED = "cross-site request refused"
LOOPBACK = ("127.0.0.1", "localhost", "[::1]")
UNKNOWN_HOST = "unknown host name: add it with --allowed-host"
DEFAULT_NOOK_ADD = "uv run --project pipeline nook-add"


def host_name(host: str) -> str:
    """A Host header's name without its port, lowercased (`[::1]:8765` -> `[::1]`)."""
    host = host.strip().lower()
    if host.startswith("["):
        return host.split("]")[0] + "]"
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def clean_path(raw: str) -> str | None:
    """A request path without its query, percent-decoded, with `.`, `..` and repeated slashes resolved (§2.9 Paths),
    so every rule about what is served sees one spelling. Keeps a trailing slash. None for a path that can't name a
    file (a NUL or a backslash)."""
    p = unquote(raw.split("?", 1)[0].split("#", 1)[0])
    if "\x00" in p or "\\" in p:
        return None
    clean = posixpath.normpath("/" + p.lstrip("/"))  # a leading "/" means ".." can't climb above the root
    clean = "/" + clean.lstrip("/")  # normpath keeps a leading "//"
    if p.endswith("/") and clean != "/":
        clean += "/"
    return clean


def mock_cost() -> bool:
    """NOOK_FAL_MOCK_COST=1 (evals only): mock calls count at their real price, so the cap can be tested for $0."""
    return os.environ.get("NOOK_FAL_MOCK_COST", "") not in ("", "0")


def counts_against_cap() -> bool:
    """Live calls count; mock calls count for nothing unless NOOK_FAL_MOCK_COST=1."""
    return not fal_mock() or mock_cost()


def slugify(text: str) -> str:
    """Same as nook-add's default id (pipeline/src/nook_pipeline/cli.py)."""
    ascii_ = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_).strip("-")[:64].rstrip("-")


def num_text(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def check_dims(dims) -> dict:
    if not isinstance(dims, dict) or not all(
            isinstance(dims.get(k), (int, float)) and not isinstance(dims.get(k), bool) and dims[k] > 0 for k in "wdh"):
        raise ValueError('dims_cm is required: {"w": ..., "d": ..., "h": ...} in cm, all greater than 0')
    return {k: dims[k] for k in "wdh"}


def check_meta(meta, kind: str) -> dict:
    """The validated meta of an add (§2.8), with id and engine filled in. ValueError: one actionable sentence."""
    if not isinstance(meta, dict):
        raise ValueError("the meta must be a JSON object with at least name and dims_cm")
    name = meta.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name is required, e.g. \"Reading chair\"")
    out = {"name": name.strip(), "dims_cm": check_dims(meta.get("dims_cm"))}
    item_id = meta.get("id")
    if item_id is None or item_id == "":
        item_id = slugify(name)
        if not SLUG.match(item_id):
            raise ValueError(f"can't make an id from the name {name!r}: add an id like \"reading-chair\"")
    elif not isinstance(item_id, str) or not SLUG.match(item_id):
        raise ValueError(f"id must be a slug (lowercase letters, digits and dashes, up to 64), got {item_id!r}")
    out["id"] = item_id
    for key in ("category", "prompt"):
        v = meta.get(key)
        if v is not None and not isinstance(v, str):
            raise ValueError(f"{key} must be text")
        out[key] = v.strip() if isinstance(v, str) and v.strip() else None
    mount = meta.get("mount")
    if mount not in (None, "floor", "wall"):
        raise ValueError(f"mount must be floor or wall, got {mount!r}")
    out["mount"] = mount
    yaw = meta.get("yaw", 0)
    if yaw in (None, ""):
        yaw = 0
    if isinstance(yaw, bool) or yaw not in (0, 90, 180, 270):
        raise ValueError(f"yaw must be 0, 90, 180 or 270 (degrees), got {yaw!r}")
    out["yaw"] = int(yaw)
    if kind == "model":
        out["engine"] = "glb"  # forced for models
    else:
        engine = meta.get("engine") or "sam3d"
        if engine not in ("sam3d", "trellis2"):
            raise ValueError(f"engine must be sam3d or trellis2 for an image, got {engine!r}")
        out["engine"] = engine
    res = meta.get("resolution")
    if res in (None, ""):
        res = 512
    if isinstance(res, bool) or res not in (512, 1024, 1536):
        raise ValueError(f"resolution must be 512, 1024 or 1536, got {res!r}")
    out["resolution"] = int(res)
    out["estimate"] = ENGINE_PRICE[out["engine"]](out["resolution"])
    return out


def zip_problem(path: Path) -> str | None:
    """The first broken §2.8 zip rule, or None. Same rules as the pipeline (pipeline/src/nook_pipeline/objzip.py)."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
    except (zipfile.BadZipFile, OSError) as e:
        return f"that isn't a readable zip ({e})"
    if len(infos) > ZIP_MAX_ENTRIES:
        return f"the zip has {len(infos)} entries, at most {ZIP_MAX_ENTRIES} are allowed"
    total, objs = 0, 0
    for info in infos:
        name = info.filename
        if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":") or "\\" in name:
            return f"the zip holds an absolute path ({name}): zip the folder's contents instead"
        if ".." in PurePosixPath(name).parts:
            return f"the zip holds a path that climbs out of it ({name}): re-zip the folder"
        if stat.S_ISLNK(info.external_attr >> 16):
            return f"the zip holds a link ({name}): zip the real files instead"
        if info.is_dir() or name.startswith("__MACOSX/") or PurePosixPath(name).name == ".DS_Store":
            continue
        ext = PurePosixPath(name).suffix.lower()
        if ext not in ZIP_ALLOWED:
            return f"the zip holds {name}: only .obj, .mtl, .png, .jpg and .jpeg files are allowed"
        objs += ext == ".obj"
        total += info.file_size
    if total > ZIP_MAX_UNPACKED:
        return f"the zip unpacks to {total / 1e6:.0f} MB, at most 500 MB is allowed"
    if objs != 1:
        return f"the zip must hold exactly one .obj with its .mtl and textures (found {objs})"
    return None


def image_kind(head: bytes) -> str | None:
    """jpeg, png, webp or heic from the first bytes, else None."""
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heis", b"heim"):
        return "heic"
    return None


# --- URL fetches (§2.9): the server downloads the image itself, to a pinned, checked address ------------------
FETCH_TIMEOUT = 20
FETCH_MAX = 20 * 1024 * 1024
FETCH_REDIRECTS = 3
PRIVATE = "that address is on a private network"
WEB_PAGE = "that's a web page: paste the image's own link (right-click the image, Copy Image Address)"
BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10",
    "224.0.0.0/4", "240.0.0.0/4", "::1/128", "::/128", "fd7a:115c:a1e0::/48", "fc00::/7", "fe80::/10", "ff00::/8")]
NAT64 = ipaddress.ip_network("64:ff9b::/96")
IMAGE_SUFFIX = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                "image/heic": ".heic", "image/heif": ".heif"}


class FetchError(Exception):
    pass


def address_blocked(addr: str) -> bool:
    """True for loopback, private, link-local, CGNAT/tailnet, ULA, multicast and reserved addresses, in any v4-in-v6 form."""
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return True
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif int(ip) < 2 ** 32:  # ::a.b.c.d (IPv4-compatible), and :: / ::1
            ip = ipaddress.IPv4Address(int(ip))
        elif ip in NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
    return ip.is_multicast or any(ip in n for n in BLOCKED_NETS if n.version == ip.version)


def fetch_allowed(host: str, port: int) -> bool:
    """NOOK_FETCH_ALLOW=<host>:<port> (evals only) exempts exactly that host and port."""
    allow = os.environ.get("NOOK_FETCH_ALLOW", "")
    ahost, sep, aport = allow.rpartition(":")
    return bool(sep) and aport.isdigit() and int(aport) == port and ahost.strip("[]").lower() == host.lower()


class _Pinned:
    """Connects to the address checked at resolve time, never re-resolving the host. abort() cuts the connection
    from another thread (the 20 s watchdog), even after http.client has handed the socket to the response."""

    def _open(self):
        self.raw = socket.create_connection((self._ip, self.port), self.timeout)
        return self.raw.dup()

    def abort(self):
        raw = getattr(self, "raw", None)
        if raw is not None:
            try:
                raw.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        super().close()
        raw = getattr(self, "raw", None)
        if raw is not None:
            raw.close()


class _PinnedHTTP(_Pinned, http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = self._open()


class _PinnedHTTPS(_Pinned, http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        self.sock = self._context.wrap_socket(self._open(), server_hostname=self.host)


def fetch_image(url: str, dest_dir: Path) -> Path:
    """Download an image link to dest_dir (§2.9). Raises FetchError with one sentence for the user."""
    deadline = time.monotonic() + FETCH_TIMEOUT
    left = lambda: max(0.1, deadline - time.monotonic())
    for _hop in range(FETCH_REDIRECTS + 1):
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https"):
            raise FetchError("only http and https links work: paste the image's web address")
        host = parts.hostname
        if not host:
            raise FetchError("that link has no host name")
        try:
            port = parts.port or (443 if scheme == "https" else 80)
        except ValueError:
            raise FetchError("that link's port isn't a number") from None
        try:
            addrs = [ai[4][0] for ai in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
        except (socket.gaierror, UnicodeError, OSError):
            raise FetchError(f"couldn't find {host}: check the link") from None
        if not addrs or (not fetch_allowed(host, port) and any(address_blocked(a) for a in addrs)):
            raise FetchError(PRIVATE)
        conn_cls = _PinnedHTTPS if scheme == "https" else _PinnedHTTP
        conn = conn_cls(host, port, addrs[0], left())
        watchdog = threading.Timer(left(), conn.abort)
        watchdog.daemon = True
        watchdog.start()
        try:
            target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            conn.request("GET", target, headers={"User-Agent": "nook (image fetch)", "Accept": "image/*"})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location")
                if not location:
                    raise FetchError(f"the link redirects (HTTP {resp.status}) without saying where")
                url = urljoin(url, location)
                continue
            if resp.status != 200:
                raise FetchError(f"the link answered HTTP {resp.status}: check it opens the image in a browser")
            ctype = (resp.getheader("Content-Type") or "").split(";")[0].strip().lower()
            if ctype in ("text/html", "application/xhtml+xml"):
                raise FetchError(WEB_PAGE)
            if not ctype.startswith("image/"):
                raise FetchError(f"that link isn't an image (it's {ctype or 'untyped'}): paste the image's own link")
            length = resp.getheader("Content-Length")
            if length and length.isdigit() and int(length) > FETCH_MAX:
                raise FetchError("that image is over 20 MB: use a smaller one")
            dest = dest_dir / f"download{IMAGE_SUFFIX.get(ctype, '.img')}"
            got = 0
            with open(dest, "wb") as f:
                while True:
                    if time.monotonic() > deadline:
                        raise FetchError("the image took more than 20 s to download: try another link")
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    got += len(chunk)
                    if got > FETCH_MAX:
                        raise FetchError("that image is over 20 MB: use a smaller one")
                    f.write(chunk)
            if not got:
                raise FetchError("the link returned an empty file")
            return dest
        except (OSError, http.client.HTTPException) as e:  # timeouts, the watchdog's abort, TLS, refused...
            if isinstance(e, TimeoutError) or time.monotonic() > deadline:
                raise FetchError("the image took more than 20 s to download: try another link") from None
            if isinstance(e, ssl.SSLError):
                raise FetchError(f"couldn't connect securely to {host} ({e.reason or e})") from None
            raise FetchError(f"couldn't download from {host} ({type(e).__name__}): check the link") from None
        finally:
            watchdog.cancel()
            conn.close()
    raise FetchError(f"the link redirects more than {FETCH_REDIRECTS} times: paste the image's own link")


class Busy(Exception):
    pass


class LibraryService:
    """The library's one queue of nook-add jobs, its writes under <library>/.lock, and the daily spend cap."""

    def __init__(self, lib_dir: Path, costs_file: Path, nook_add: list[str], cap_usd: float):
        self.dir = lib_dir
        self.costs_file = costs_file
        self.nook_add = nook_add
        self.cap = cap_usd
        self.mutex = threading.Lock()        # jobs and reservations (in-process state)
        self.write_lock = threading.Lock()   # this process's library writes, with the flock below for other processes
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.private: dict[str, dict] = {}   # job id -> {cmd, cleanup}
        self.reserved: dict[str, float] = {}
        self.queue: queue.Queue = queue.Queue()
        threading.Thread(target=self.worker, name="nook-library-jobs", daemon=True).start()

    # --- lock and files -------------------------------------------------------------------------------------
    @contextlib.contextmanager
    def locked(self, wait: float | None = LOCK_WAIT):
        """<library>/.lock (flock), the same lock nook-add holds for a whole run. Raises Busy after `wait` s
        (None: wait as long as it takes, for writes that must not be lost, like a billed call's cost row)."""
        deadline = time.monotonic() + (wait if wait is not None else 1e12)
        if not self.write_lock.acquire(timeout=wait if wait is not None else -1):
            raise Busy()
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            with open(self.dir / ".lock", "a+") as f:
                while True:
                    try:
                        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() > deadline:
                            raise Busy() from None
                        time.sleep(0.2)
                try:
                    yield
                finally:
                    fcntl.flock(f, fcntl.LOCK_UN)
        finally:
            self.write_lock.release()

    def read(self) -> dict:
        data = read_json_file(self.dir / "library.json")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return {"version": 1, "items": []}
        return data

    def write(self, data: dict) -> None:
        """library.json, atomically, in nook-add's format. Call under locked()."""
        text = json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        atomic_write_bytes(self.dir / "library.json", text.encode("utf-8"))

    def item(self, item_id: str, data: dict | None = None) -> dict | None:
        data = self.read() if data is None else data
        return next((i for i in data["items"] if isinstance(i, dict) and i.get("id") == item_id), None)

    def trash(self) -> list[dict]:
        """[{id, name, deleted, dir}] of every trashed copy, newest first."""
        out = []
        root = self.dir / ".trash"
        if root.is_dir():
            for d in root.iterdir():
                meta = read_json_file(d / "entry.json") if d.is_dir() else None
                if isinstance(meta, dict) and isinstance(meta.get("entry"), dict):
                    out.append({"id": meta["entry"].get("id"), "name": meta["entry"].get("name"),
                                "deleted": meta.get("deleted"), "dir": d})
        out.sort(key=lambda t: (str(t["deleted"]), t["dir"].name), reverse=True)
        return out

    # --- spend cap ------------------------------------------------------------------------------------------
    def spent(self, day: str) -> float:
        """Today's (UTC) total in costs.csv."""
        total = 0.0
        try:
            with open(self.costs_file, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if (row.get("date") or "").startswith(day):
                        try:
                            total += float(row.get("cost_usd") or 0)
                        except ValueError:
                            pass
        except OSError:
            pass
        return round(total, 6)

    def _expire_held(self, day: str) -> None:
        """Drop reservations held for an earlier day (a timed-out paid job's, see hold_for_today). Call under mutex."""
        for key in [k for k in self.reserved if k.startswith("held:") and k.split(":")[1] != day]:
            del self.reserved[key]

    def spend(self) -> dict:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            self._expire_held(day)
            reserved = round(sum(self.reserved.values()), 6)
        return {"day": day, "spent_usd": self.spent(day), "reserved_usd": reserved, "cap_usd": self.cap}

    def reserve(self, key: str, amount: float) -> dict | None:
        """Reserve `amount` against today's cap. None when it fits, else the 402 body. Atomic for this server."""
        if amount <= 0:
            return None
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            self._expire_held(day)
            spent = self.spent(day)
            used = spent + sum(self.reserved.values())
            if used + amount > self.cap + 1e-9:
                return {"error": f"today's fal budget (${self.cap:.2f}) is used up: ${used:.2f} spent",
                        "spent_usd": spent, "cap_usd": self.cap}
            self.reserved[key] = amount
        return None

    def release(self, key: str) -> None:
        with self.mutex:
            self.reserved.pop(key, None)

    def hold_for_today(self, key: str) -> float:
        """Keep `key`'s reservation until the end of the UTC day instead of releasing it (a paid job killed at its
        timeout may still have been charged, §2.9). Returns the amount held."""
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            amount = self.reserved.pop(key, 0.0)
            if amount > 0:
                self.reserved[f"held:{day}:{key}"] = amount
        return amount

    # --- jobs -----------------------------------------------------------------------------------------------
    def new_job(self, kind: str, item_id: str, engine: str, estimate: float, cmd: list[str], cleanup: Path | None,
                reserve: float = 0.0, message: str = "waiting for the queue"):
        """Queue a nook-add run. Returns (job, None), or (None, 402 body) when the cap refuses it."""
        now = datetime.now(timezone.utc)
        job_id = f"l-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        refused = self.reserve(job_id, reserve)
        if refused:
            return None, refused
        job = {"id": job_id, "kind": kind, "item_id": item_id, "status": "queued", "engine": engine,
               "cost_usd_estimate": estimate, "cost_usd": None, "mock": fal_mock(), "created": iso_utc(),
               "started": None, "finished": None, "message": message, "item": None}
        with self.mutex:
            self.jobs[job_id] = job
            self.order.append(job_id)
            self.private[job_id] = {"cmd": cmd, "cleanup": cleanup}
            snapshot = dict(job)
        self.queue.put(job_id)
        return snapshot, None

    def list_jobs(self) -> list[dict]:
        with self.mutex:
            return [dict(self.jobs[j]) for j in reversed(self.order)]

    def get_job(self, job_id: str) -> dict | None:
        with self.mutex:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id: str, **fields) -> None:
        with self.mutex:
            self.jobs[job_id].update(fields)

    def worker(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self.run(job_id)
            except Exception as e:  # noqa: BLE001 - one bad job never stops the queue
                self.update(job_id, status="failed", finished=iso_utc(), message=f"the server failed to run nook-add ({type(e).__name__}: {e})")
            finally:
                self.release(job_id)
                with self.mutex:
                    extra = self.private.pop(job_id, {})
                if extra.get("cleanup"):
                    shutil.rmtree(extra["cleanup"], ignore_errors=True)

    def run(self, job_id: str) -> None:
        with self.mutex:
            cmd = self.private[job_id]["cmd"]
            job = self.jobs[job_id]
            kind, item_id = job["kind"], job["item_id"]
        self.update(job_id, status="running", started=iso_utc(),
                    message=f"refitting {item_id}" if kind == "rescale" else f"making {item_id} ({job['engine']})")
        try:
            proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=NOOK_ADD_TIMEOUT,
                                  stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            return self.update(job_id, status="failed", finished=iso_utc(),
                               message=f"nook-add isn't installed here ({cmd[0]} not found): set --nook-add")
        except subprocess.TimeoutExpired:
            message = f"nook-add ran for more than {NOOK_ADD_TIMEOUT // 60} minutes and was stopped"
            held = self.hold_for_today(job_id)
            if held > 0:
                message += (f"; fal may have charged for it, so its ${fmt_cost(held)} estimate stays reserved "
                            "against today's (UTC) budget")
            return self.update(job_id, status="failed", finished=iso_utc(), message=message)
        out_lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        if proc.returncode != 0:
            err = [ln.strip() for ln in proc.stderr.splitlines() if ln.strip()]
            mine = [ln for ln in err if ln.startswith("nook-add:")]
            message = (mine or err or [f"nook-add exited with code {proc.returncode}"])[-1]
            return self.update(job_id, status="failed", finished=iso_utc(), message=message)
        try:
            summary = json.loads(out_lines[-1])
        except (IndexError, json.JSONDecodeError):
            return self.update(job_id, status="failed", finished=iso_utc(),
                               message="nook-add finished without its JSON summary line")
        replaced = next((ln for ln in out_lines if "replaced existing item" in ln), None)
        if kind == "rescale":
            message = f"refit {item_id} ($0)"
        elif replaced:
            message = replaced.removeprefix("nook-add: ")
        else:
            message = f"added {item_id}"
        self.update(job_id, status="done", finished=iso_utc(), message=message, item=self.item(item_id),
                    cost_usd=summary.get("cost_usd", 0), mock=bool(summary.get("mock", fal_mock())))


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
                 room_dir: Path | None = None, library_dir: Path | None = None, scan_api: str | None = None,
                 library: "LibraryService | None" = None, allowed_hosts: tuple[str, ...] = (), **kwargs):
        self.room_file = room_file
        self.hosts = {*LOOPBACK, *(host_name(h) for h in allowed_hosts)}  # §2.9 Host names
        self.room_dir = room_dir or (REPO / "room")  # where the rooms live (served as /room/)
        self.layouts_dir = layouts_dir
        self.renders_dir = renders_dir
        self.costs_file = costs_file
        self.library_dir = library_dir or (REPO / "library")
        if library is None:  # main() always passes one; this is for embedding the handler elsewhere
            library = LibraryService(self.library_dir, costs_file, shlex.split(DEFAULT_NOOK_ADD), 2.0)
        self.library = library
        # Writable data outside the code (on kakapo the code is in the read-only Nix store).
        self.mounts = {"/room/": room_dir, "/library/": self.library_dir}
        self.scan_api = scan_api
        self.body_done = False
        super().__init__(*args, directory=str(REPO), **kwargs)

    def translate_path(self, path):
        # Every rule below sees the normalized path (§2.9 Paths), so /./library/costs.csv is the same 404 as
        # /library/costs.csv. Nothing hidden (.env holds FAL_KEY, .git, .lock, .trash) is served under any spelling.
        p = clean_path(path)
        if p is None or any(x.startswith(".") for x in p.split("/")):
            return str(REPO / ".missing")
        if p.startswith("/renders/"):
            name = p[len("/renders/"):]
            if not name or "/" in name or "\\" in name or name.startswith("."):
                return str(self.renders_dir / ".missing")
            return str(self.renders_dir / name)
        if p.startswith("/library/"):
            # Item assets and library.json only: never raw/, .trash/, .lock, costs.csv or a listing (§2.8).
            rel = p[len("/library/"):]
            if rel != "library.json" and not LIBRARY_ASSET.match(rel):
                return str(self.library_dir / ".missing")
        for prefix, base in self.mounts.items():
            if base is not None and p.startswith(prefix):
                return str(base.joinpath(*[x for x in p[len(prefix):].split("/") if x]))
        return str(REPO.joinpath(*[x for x in p.split("/") if x]))

    def list_directory(self, path):
        """No directory listings anywhere (they'd show library/_inbox, raw/ and the like): a folder is a 404."""
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    # --- /api/scan/* -> nook-scan jobs server (contract §2.1 --scan-api, §5) ---------------------
    def is_scan(self) -> bool:
        path = unquote(urlsplit(self.path).path)
        return bool(self.scan_api) and (path == "/api/scan" or path.startswith("/api/scan/"))

    def proxy_scan(self):
        """Stream the request to the jobs server and its answer back (uploads are hundreds of MB)."""
        target = urlsplit(self.scan_api)
        length = self.headers.get("Content-Length")
        if self.chunked():  # only Content-Length bodies are forwarded; never leave a chunked one unread on the connection
            self.close_connection = True
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: send the body with its length")
        if self.command == "POST" and length is None and urlsplit(self.path).path.rstrip("/").endswith("/captures"):
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: upload the zip as a file")
        try:
            left = int(length or 0)
        except ValueError:
            self.close_connection = True
            return self.error_json(HTTPStatus.BAD_REQUEST, "Content-Length is not a number")
        conn = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=600)
        try:
            # A loopback Host, whatever this request's: the jobs server only answers loopback names (§2.9 Host names).
            conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", f"127.0.0.1:{target.port or 80}")
            # X-Nook goes through (§5.1, the jobs server checks it too); Origin was checked here and stays here.
            for h in ("Content-Type", "Content-Length", "X-Nook-Name", "X-Nook", "Accept"):
                if self.headers.get(h) is not None:
                    conn.putheader(h, self.headers[h])
            conn.endheaders()
            self.body_done = True
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                left -= len(chunk)
                conn.send(chunk)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            if left > 0:  # the rest of the body is still on the connection: don't read it as the next request
                self.close_connection = True
            return self.error_json(HTTPStatus.BAD_GATEWAY, f"the nook-scan jobs server at {self.scan_api} isn't answering ({e})")
        if left > 0:
            self.close_connection = True
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
        if (clean_path(self.path) or "").startswith(("/library/", "/api/library")):
            self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def parse_request(self):
        self.body_done = False  # one handler serves every request on a keep-alive connection
        if not super().parse_request():
            return False
        if host_name(self.headers.get("Host") or "") in self.hosts:
            return True
        self.error_json(HTTPStatus.FORBIDDEN, UNKNOWN_HOST)  # §2.9 Host names (DNS rebinding), before anything else
        return False

    def chunked(self) -> bool:
        return "chunked" in (self.headers.get("Transfer-Encoding") or "").lower()

    def discard_body(self) -> None:
        """Read and drop an unread request body, so an early error reaches the client instead of a reset."""
        if self.body_done or self.command in ("GET", "HEAD"):
            return
        self.body_done = True
        try:
            if self.chunked():
                total = 0
                while True:
                    size = int(self.rfile.readline(1024).split(b";")[0].strip() or b"0", 16)
                    if size == 0:
                        while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                            pass
                        return
                    total += size
                    if total > MAX_DRAIN:
                        break
                    self.rfile.read(size + 2)
                self.close_connection = True
                return
            left = int(self.headers.get("Content-Length") or 0)
            if left > MAX_DRAIN:
                self.close_connection = True
                return
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                left -= len(chunk)
        except (ValueError, OSError):
            self.close_connection = True

    def forged(self) -> bool:
        """§2.9: a mutation needs X-Nook: 1 and an Origin that's absent or this page's own. Answers 403 itself."""
        origin = self.headers.get("Origin")
        host = self.headers.get("Host") or ""
        own = (f"http://{host}", f"https://{host}")
        if self.headers.get("X-Nook") == "1" and (origin is None or (host and origin in own)):
            return False
        self.error_json(HTTPStatus.FORBIDDEN, FORGED)
        return True

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status: int, data) -> None:
        self.discard_body()
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
        self.body_done = True
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"body is not valid JSON: {e}") from None

    def api_path(self):
        path = unquote(urlsplit(self.path).path)
        return path if path == "/api" or path.startswith("/api/") else None

    # --- static ----------------------------------------------------------
    def hidden(self) -> bool:
        """Never serve dotfiles/dirs (.env holds FAL_KEY, .git, .venv), however the path is spelled."""
        p = clean_path(self.path)
        return p is None or any(x.startswith(".") for x in p.split("/"))

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
        if self.forged():
            return
        if self.is_scan():
            return self.proxy_scan()
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
        if self.forged():
            return
        if self.is_scan():
            return self.proxy_scan()
        api = self.api_path()
        try:
            if api == "/api/render":
                return self.post_render()
            if api == "/api/library/items":
                return self.post_library_upload()
            if api == "/api/library/items/from-url":
                return self.post_library_from_url()
            m = re.fullmatch(r"/api/library/items/([^/]*)/restore", api or "")
            if m:
                return self.restore_library_item(m.group(1))
        except Busy:
            return self.library_busy()
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: POST {api or urlsplit(self.path).path}")

    def do_PATCH(self):
        if self.forged():
            return
        if self.is_scan():
            return self.proxy_scan()
        api = self.api_path()
        try:
            m = re.fullmatch(r"/api/library/items/([^/]*)", api or "")
            if m:
                return self.patch_library_item(m.group(1))
        except Busy:
            return self.library_busy()
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: PATCH {api or urlsplit(self.path).path}")

    def do_DELETE(self):
        if self.forged():
            return
        if self.is_scan():
            return self.proxy_scan()
        api = self.api_path()
        try:
            m = re.fullmatch(r"/api/library/items/([^/]*)", api or "")
            if m:
                return self.delete_library_item(m.group(1))
            m = re.fullmatch(r"/api/rooms/([^/]*)", api or "")
            if m:
                return self.delete_room(m.group(1))
            m = re.fullmatch(r"/api/layouts/(.*)", api or "")
            if m and self.room_query() is not None:
                return self.delete_room_layout(m.group(1))
            if m:
                return self.error_json(HTTPStatus.BAD_REQUEST, "only a room's layouts can be deleted: add ?room=<name>")
        except Busy:
            return self.library_busy()
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: DELETE {api or urlsplit(self.path).path}")

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
            if api == "/api/library":
                return self.get_library()
            if api == "/api/library/jobs":
                return self.send_json(HTTPStatus.OK, {"jobs": self.library.list_jobs()})
            m = re.fullmatch(r"/api/library/jobs/([^/]*)", api)
            if m:
                job = self.library.get_job(m.group(1))
                return self.send_json(HTTPStatus.OK, job) if job else self.error_json(
                    HTTPStatus.NOT_FOUND, f"no library job {m.group(1)!r}: GET /api/library/jobs lists them")
            if api == "/api/spend":
                return self.send_json(HTTPStatus.OK, self.library.spend())
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

    def room_captures(self) -> dict[str, str]:
        """{room: kept capture} from the jobs API (§5.1 GET /api/scan/captures); {} without --scan-api or an answer."""
        if not self.scan_api:
            return {}
        try:
            port = urlsplit(self.scan_api).port or 80
            req = urllib.request.Request(self.scan_api.rstrip("/") + "/api/scan/captures", headers={"Host": f"127.0.0.1:{port}"})
            with urllib.request.urlopen(req, timeout=3) as res:
                captures = json.loads(res.read().decode("utf-8")).get("captures") or []
        except (OSError, ValueError, AttributeError):
            return {}
        out = {}
        for c in captures:  # newest first: the newest capture wins a room listed twice
            if isinstance(c, dict) and isinstance(c.get("name"), str):
                for room in c.get("rooms") or []:
                    if isinstance(room, str):
                        out.setdefault(room, c["name"])
        return out

    def list_rooms(self):
        captures = self.room_captures()
        with rooms_lock:
            scans = list_scans(self.room_dir)
            current = self.current_room(scans)
            rooms = []
            for name, scan in scans.items():
                config = self.room_config(name, scan, current)
                st = scan.stat()
                title = config.get("title")
                parent = config.get("parent")
                rooms.append({
                    "name": name, "title": title if isinstance(title, str) and title else None,
                    "splat": config["splat"], "created": iso_utc(st.st_mtime), "size_bytes": st.st_size,
                    "thumb_url": f"/room/{name}.jpg" if (self.room_dir / f"{name}.jpg").is_file() else None,
                    "aligned": bool(config.get("saved")), "layouts": len(self.room_layouts(name)),
                    "current": name == current,
                    "roomplan_url": f"/room/{name}.roomplan.json" if (self.room_dir / f"{name}.roomplan.json").is_file() else None,
                    "capture": captures.get(name),
                    "parent": parent if isinstance(parent, str) and SLUG.match(parent) else None,
                    "_mtime": st.st_mtime,
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

    # --- library (contract §2.8) ------------------------------------------------------------------
    def library_busy(self):
        return self.error_json(HTTPStatus.SERVICE_UNAVAILABLE,
                               "the library is busy with another change (a nook-add run): try again in a minute")

    def get_library(self):
        data = self.library.read()
        trash = [{k: t[k] for k in ("id", "name", "deleted")} for t in self.library.trash()]
        return self.send_json(HTTPStatus.OK, dict(data, trash=trash))

    def add_command(self, src: Path, meta: dict, label: str) -> list[str]:
        # Every value as --opt=<v> and the input as an absolute path, so a name like "-Shelf" is never read as a flag.
        cmd = [*self.library.nook_add, str(src.resolve()), f"--name={meta['name']}", f"--id={meta['id']}",
               "--dims=" + "x".join(num_text(meta["dims_cm"][k]) for k in "wdh"), f"--engine={meta['engine']}",
               f"--library={self.library_dir.resolve()}", f"--source-input={label}"]
        if meta["category"]:
            cmd += [f"--category={meta['category']}"]
        if meta["mount"]:
            cmd += [f"--mount={meta['mount']}"]
        if meta["yaw"]:
            cmd += [f"--yaw={meta['yaw']}"]
        if meta["engine"] == "sam3d" and meta["prompt"]:
            cmd += [f"--prompt={meta['prompt']}"]
        if meta["engine"] == "trellis2":
            cmd += [f"--resolution={meta['resolution']}"]
        return cmd

    def queue_add(self, src: Path, tmp: Path, meta: dict, label: str, reserved_key: str | None = None):
        """202 {job, cost_usd_estimate}, or 402 when the cap refuses it. The job owns (and removes) tmp."""
        exists = self.library.item(meta["id"]) is not None
        message = f"waiting for the queue; replaces the existing {meta['id']}" if exists else "waiting for the queue"
        reserve = meta["estimate"] if counts_against_cap() else 0.0
        if reserved_key:  # already reserved before the download: hand it over to the job
            self.library.release(reserved_key)
        job, refused = self.library.new_job("add", meta["id"], meta["engine"], meta["estimate"],
                                            self.add_command(src, meta, label), tmp, reserve, message)
        if refused:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job, "cost_usd_estimate": meta["estimate"]})

    def post_library_upload(self):
        kind = (self.headers.get("X-Nook-Kind") or "").strip().lower()
        if kind not in ("model", "image"):
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Nook-Kind must be model or image")
        filename = PurePosixPath((self.headers.get("X-Nook-Filename") or "").replace("\\", "/")).name
        if not filename:
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Nook-Filename is required (the file's name, e.g. chair.glb)")
        try:
            meta = json.loads(base64.b64decode(self.headers.get("X-Nook-Meta") or "", validate=True).decode("utf-8"))
        except (binascii.Error, ValueError, UnicodeDecodeError):
            meta = None
        if not isinstance(meta, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Nook-Meta must be base64 of a JSON object with name and dims_cm")
        ext = PurePosixPath(filename).suffix.lower()
        if kind == "model":
            if ext in (".usdz", ".usd", ".usda", ".usdc", ".reality"):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"{ext} isn't supported: convert to GLB first (e.g. Reality Converter or Blender)")
            if ext == ".gltf":
                return self.error_json(HTTPStatus.BAD_REQUEST, "a .gltf needs its side files: convert it to .glb first, or zip an .obj with its .mtl and textures")
            if ext not in (".glb", ".zip"):
                return self.error_json(HTTPStatus.BAD_REQUEST, "a model must be a .glb, or a .zip holding one .obj with its .mtl and textures")
        elif ext not in IMAGE_EXTS:
            return self.error_json(HTTPStatus.BAD_REQUEST, "a photo must be a JPEG, PNG, HEIC or WebP file")
        try:
            meta = check_meta(meta, kind)
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        length = self.headers.get("Content-Length")
        if self.chunked() or length is None or not length.strip().isdigit():
            self.close_connection = True
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: send the file as the request body")
        length = int(length)
        limit = MAX_MODEL if kind == "model" else MAX_IMAGE
        if length > limit:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                                   f"that file is {length / 1e6:.0f} MB: {'models' if kind == 'model' else 'photos'} can be at most {limit // (1024 * 1024)} MB")
        if length == 0:
            return self.error_json(HTTPStatus.BAD_REQUEST, "the file is empty")
        tmp = Path(tempfile.mkdtemp(prefix="nook-upload-"))  # private, never under a served path
        try:
            src = tmp / f"upload{ext}"
            with open(src, "wb") as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            self.body_done = True
            if left > 0:
                raise ValueError("the upload stopped before the end: try again")
            with open(src, "rb") as f:
                head = f.read(16)
            if kind == "image" and image_kind(head) is None:
                raise ValueError("that file isn't a JPEG, PNG, HEIC or WebP image")
            if ext == ".glb" and head[:4] != b"glTF":
                raise ValueError("that file isn't a GLB (binary glTF): export it again as .glb")
            if ext == ".zip":
                problem = zip_problem(src)
                if problem:
                    raise ValueError(problem)
        except ValueError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return self.queue_add(src, tmp, meta, filename)

    def post_library_from_url(self):
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        url = body.get("image_url") if isinstance(body, dict) else None
        if not isinstance(url, str) or not url.strip():
            return self.error_json(HTTPStatus.BAD_REQUEST, 'the body must be JSON like {"image_url": "https://...", "name": ..., "dims_cm": {...}}')
        url = url.strip()
        try:
            meta = check_meta({k: v for k, v in body.items() if k != "image_url"}, "image")
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        key = f"fetch-{secrets.token_hex(4)}"  # hold the estimate while downloading, so the cap is checked first
        refused = self.library.reserve(key, meta["estimate"] if counts_against_cap() else 0.0)
        if refused:
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        tmp = Path(tempfile.mkdtemp(prefix="nook-fetch-"))
        try:
            src = fetch_image(url, tmp)
            with open(src, "rb") as f:
                if image_kind(f.read(16)) is None:
                    raise FetchError("that link isn't a JPEG, PNG, HEIC or WebP image")
        except FetchError as e:
            self.library.release(key)
            shutil.rmtree(tmp, ignore_errors=True)
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        except BaseException:
            self.library.release(key)
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return self.queue_add(src, tmp, meta, url, reserved_key=key)

    def patch_library_item(self, item_id: str):
        try:
            patch = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(patch, dict) or not patch:
            return self.error_json(HTTPStatus.BAD_REQUEST, "the body must be a JSON object with any of name, category, mount, yaw, default_render, dims_cm")
        unknown = sorted(set(patch) - {"name", "category", "mount", "yaw", "default_render", "dims_cm"})
        if unknown:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"{', '.join(unknown)} can't be edited: use name, category, mount, yaw, default_render or dims_cm")
        with self.library.locked():
            data = self.library.read()
            item = self.library.item(item_id, data) if SLUG.match(item_id) else None
            if item is None:
                return self.error_json(HTTPStatus.NOT_FOUND, f"no library item {item_id!r}: GET /api/library lists them")
            try:
                if "name" in patch and (not isinstance(patch["name"], str) or not patch["name"].strip()):
                    raise ValueError("name must be non-empty text")
                if "category" in patch and patch["category"] is not None and not isinstance(patch["category"], str):
                    raise ValueError("category must be text or null")
                if "mount" in patch and patch["mount"] not in ("floor", "wall"):
                    raise ValueError("mount must be floor or wall")
                if "default_render" in patch:
                    if patch["default_render"] not in ("glb", "splat"):
                        raise ValueError("default_render must be glb or splat")
                    if not (item.get("assets") or {}).get(patch["default_render"]):
                        raise ValueError(f"this item has no {patch['default_render']} asset, so it can't be its default render")
                yaw = patch.get("yaw", 0) or 0
                if isinstance(yaw, bool) or yaw not in (0, 90, 180, 270):
                    raise ValueError("yaw must be 0, 90, 180 or 270 (degrees, relative to now)")
                dims = check_dims(patch["dims_cm"]) if "dims_cm" in patch else None
            except ValueError as e:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
            changed = False
            for key in ("name", "category", "mount", "default_render"):
                if key in patch:
                    value = patch[key].strip() if isinstance(patch[key], str) else patch[key]
                    changed |= item.get(key) != value
                    item[key] = value
            if changed:
                self.library.write(data)
        refit = int(yaw) != 0 or (dims is not None and {k: float(v) for k, v in dims.items()} !=
                                  {k: float((item.get("dims_cm") or {}).get(k, 0)) for k in "wdh"})
        if not refit:
            return self.send_json(HTTPStatus.OK, item)
        cmd = [*self.library.nook_add, f"--rescale={item_id}", f"--library={self.library_dir.resolve()}"]
        if dims is not None:
            cmd += ["--dims=" + "x".join(num_text(dims[k]) for k in "wdh")]
        if yaw:
            cmd += [f"--yaw={int(yaw)}"]
        job, _ = self.library.new_job("rescale", item_id, "glb", 0.0, cmd, None)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job})

    def delete_library_item(self, item_id: str):
        with self.library.locked():
            data = self.library.read()
            item = self.library.item(item_id, data) if SLUG.match(item_id) else None
            if item is None:
                return self.error_json(HTTPStatus.NOT_FOUND, f"no library item {item_id!r}: GET /api/library lists them")
            base = f"{item_id}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
            trash, n = self.library_dir / ".trash" / base, 1
            while trash.exists():
                n += 1
                trash = self.library_dir / ".trash" / f"{base}-{n}"
            trash.mkdir(parents=True)
            folder = self.library_dir / item_id
            if folder.is_dir():
                shutil.move(str(folder), str(trash / item_id))
            atomic_write_json(trash / "entry.json", {"deleted": iso_utc(), "entry": item})
            data["items"] = [i for i in data["items"] if not (isinstance(i, dict) and i.get("id") == item_id)]
            self.library.write(data)
        return self.send_json(HTTPStatus.OK, {"ok": True, "trash": trash.relative_to(self.library_dir).as_posix()})

    def restore_library_item(self, item_id: str):
        if not SLUG.match(item_id):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no trashed item {item_id!r}")
        with self.library.locked():
            data = self.library.read()
            if self.library.item(item_id, data) is not None or (self.library_dir / item_id).exists():
                return self.error_json(HTTPStatus.CONFLICT, f"an item {item_id!r} exists again: remove it (or rename the new one) first")
            copies = [t for t in self.library.trash() if t["id"] == item_id]
            if not copies:
                return self.error_json(HTTPStatus.NOT_FOUND, f"{item_id!r} isn't in the library's trash")
            trash = copies[0]["dir"]
            entry = read_json_file(trash / "entry.json")["entry"]
            if (trash / item_id).is_dir():
                shutil.move(str(trash / item_id), str(self.library_dir / item_id))
            data["items"].append(entry)
            self.library.write(data)
            shutil.rmtree(trash, ignore_errors=True)
        return self.send_json(HTTPStatus.OK, entry)

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

        price = spec["cost"](megapixels)
        now = datetime.now(timezone.utc)
        name = self.reserve_render_name(now)
        refused = self.library.reserve(name, price if counts_against_cap() else 0.0)  # §2.9 spend cap
        if refused:
            with render_lock:
                reserved_names.discard(name)
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        try:
            return self.render(body, data, model, prompt, view, layout, spec, size, price, mock, key, now, name)
        finally:
            self.library.release(name)

    def render(self, body, data, model, prompt, view, layout, spec, size, price, mock, key, now, name):
        cost = price if mock and mock_cost() else 0.0
        if mock:
            result = data  # mock: the "render" is the input, $0 (or its real price with NOOK_FAL_MOCK_COST=1), no network
        else:
            data_uri = "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
            args = {spec["image_key"]: [data_uri] if spec["image_key"] == "image_urls" else data_uri,
                    "prompt": prompt, "output_format": "jpeg"}
            try:
                out = fal_call(spec["endpoint"], args, key)
            except FalError as e:
                return self.error_json(HTTPStatus.BAD_GATEWAY, str(e))
            # fal has returned, so the call is billed: record it even if the download below fails.
            cost = price
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
            append_cost(self.costs_file, now.strftime("%Y-%m-%dT%H:%M:%SZ"), name, f"render:{model}", cost, True, view or "")
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
    ap.add_argument("--costs-file", default=None,
                    help="default: <library-dir>/costs.csv, where nook-add writes; with --library-dir it must be that file")
    ap.add_argument("--nook-add", default=DEFAULT_NOOK_ADD,
                    help=f"the command that adds furniture, run with --library <library-dir> (default: {DEFAULT_NOOK_ADD})")
    ap.add_argument("--allowed-host", action="append", default=[], metavar="NAME",
                    help="also answer requests with this Host name, e.g. nook.example.com (repeatable; loopback names always work)")
    ap.add_argument("--daily-spend-usd", type=float, default=2.0,
                    help="cap on paid fal calls (library adds and renders) per UTC day, in USD (default 2)")
    args = ap.parse_args(argv)
    if args.daily_spend_usd < 0:
        ap.error("--daily-spend-usd can't be negative")

    room_dir = resolve(args.room_dir) if args.room_dir else None
    room_file = resolve(args.room_file) if args.room_file else (room_dir or resolve("room")) / "room.json"
    library_dir = resolve(args.library_dir or "library")
    costs_file = resolve(args.costs_file) if args.costs_file else library_dir / "costs.csv"
    # nook-add always writes <library-dir>/costs.csv, so the cap would miss its rows if this read another file.
    # (Without --library-dir, a separate --costs-file is allowed: evals keep renders' rows out of the repo's library.)
    if args.library_dir and costs_file.resolve() != (library_dir / "costs.csv").resolve():
        sys.exit(f"nook planner: --costs-file {costs_file} isn't {library_dir / 'costs.csv'}, where nook-add writes "
                 "its costs: drop --costs-file (it defaults to <library-dir>/costs.csv)")
    library = LibraryService(library_dir, costs_file, shlex.split(args.nook_add), args.daily_spend_usd)
    handler = partial(Handler, room_file=room_file, layouts_dir=resolve(args.layouts_dir),
                      renders_dir=resolve(args.renders_dir), costs_file=costs_file, room_dir=room_dir,
                      library_dir=library_dir, scan_api=args.scan_api, library=library,
                      allowed_hosts=tuple(args.allowed_host))
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
