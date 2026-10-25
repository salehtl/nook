"""fal engines (contract §3.2) and the NOOK_FAL_MOCK replay (§3.3)."""
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from . import NookError

ENDPOINTS = {"sam3d": "fal-ai/sam-3/3d-objects", "trellis2": "fal-ai/trellis-2"}
TRELLIS_COST = {512: 0.25, 1024: 0.30, 1536: 0.35}


def cost_usd(engine: str, resolution: int) -> float:
    return {"sam3d": 0.02, "trellis2": TRELLIS_COST.get(resolution, 0.0), "glb": 0.0}[engine]


def arguments(engine: str, image_url: str, prompt: str, resolution: int) -> dict:
    if engine == "sam3d":
        return {"image_url": image_url, "prompt": prompt, "export_textured_glb": True}
    return {"image_url": image_url, "resolution": resolution}


def mock_slug(endpoint: str) -> str:
    """fal-ai/sam-3/3d-objects -> sam-3-3d-objects, fal-ai/trellis-2 -> trellis-2."""
    return endpoint.removeprefix("fal-ai/").replace("/", "-")


def url_basename(url: str) -> str:
    return Path(urllib.parse.unquote(urllib.parse.urlparse(url).path)).name or "download"


def download(url: str, dest: Path) -> Path:
    """Plain HTTP(S) download (live mode only)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nook-add/0.1"})
        with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception as e:  # noqa: BLE001
        raise NookError(f"download failed for {url} ({type(e).__name__}: {e})") from None
    return dest


class MockFal:
    """Replays <dir>/<slug>/response.json and copies <dir>/<slug>/files/<basename>. Never touches the network."""

    mock = True
    charged = False

    def __init__(self, root: Path):
        self.root = root
        self.slug = None

    def upload(self, path: Path) -> str:
        return f"https://mock.fal.invalid/uploads/{urllib.parse.quote(path.name)}"

    def call(self, endpoint: str, args: dict) -> dict:
        self.slug = mock_slug(endpoint)
        resp = self.root / self.slug / "response.json"
        if not resp.is_file():
            raise NookError(f"NOOK_FAL_MOCK: no recorded response at {resp}")
        try:
            return json.loads(resp.read_text())
        except json.JSONDecodeError as e:
            raise NookError(f"NOOK_FAL_MOCK: {resp} is not valid JSON ({e})") from None

    def fetch(self, url: str, dest_dir: Path) -> Path:
        files = self.root / self.slug / "files"
        src = files / Path(urllib.parse.urlparse(url).path).name  # as fixtures/capture_fal.py saves it
        if not src.is_file():
            src = files / url_basename(url)  # percent-decoded spelling
        if not src.is_file():
            raise NookError(f"NOOK_FAL_MOCK: the response links {url}, but {src} doesn't exist")
        return Path(shutil.copy2(src, dest_dir / src.name))


class LiveFal:
    """Real fal calls via fal_client (reads FAL_KEY from the environment)."""

    mock = False
    charged = False  # set once a call has returned, i.e. once it has been paid for

    def __init__(self):
        import fal_client  # imported lazily so mock runs never load it

        self.fal = fal_client

    def upload(self, path: Path) -> str:
        try:
            return self.fal.upload_file(path)
        except Exception as e:  # noqa: BLE001
            raise NookError(f"fal upload of {path} failed ({type(e).__name__}: {e}); check FAL_KEY and your credit") from None

    def call(self, endpoint: str, args: dict) -> dict:
        def on_update(status):
            for log in getattr(status, "logs", None) or []:
                print(f"  fal: {log.get('message', log) if isinstance(log, dict) else log}", flush=True)

        try:
            return self.fal.subscribe(endpoint, arguments=args, with_logs=True, on_queue_update=on_update)
        except Exception as e:  # noqa: BLE001
            msg = str(e).replace("\n", " ")
            raise NookError(f"fal call to {endpoint} failed ({type(e).__name__}: {msg})") from None

    def fetch(self, url: str, dest_dir: Path) -> Path:
        return download(url, dest_dir / url_basename(url))


def _file_url(resp: dict, key: str, list_key: str | None = None) -> str | None:
    """URL of resp[key], else of the first of resp[list_key]."""
    obj = resp.get(key)
    if isinstance(obj, dict) and obj.get("url"):
        return obj["url"]
    items = resp.get(list_key) if list_key else None
    if isinstance(items, list) and items and isinstance(items[0], dict) and items[0].get("url"):
        return items[0]["url"]
    return None


def run(fal, engine: str, image: Path, prompt: str, resolution: int, raw_dir: Path) -> dict:
    """Run an image engine. Returns {"glb": Path, "splat": Path | None} inside raw_dir (untouched outputs)."""
    endpoint = ENDPOINTS[engine]
    raw_dir.mkdir(parents=True, exist_ok=True)
    image_url = fal.upload(image)
    args = arguments(engine, image_url, prompt, resolution)
    print(f"nook-add: calling {endpoint}{' (mock)' if fal.mock else ''} with {json.dumps(args)}", flush=True)
    resp = fal.call(endpoint, args)
    fal.charged = True
    if not isinstance(resp, dict):
        raise NookError(f"{endpoint} returned {type(resp).__name__}, expected a JSON object")
    (raw_dir / "response.json").write_text(json.dumps(resp, indent=2) + "\n")
    (raw_dir / "request.json").write_text(json.dumps(args, indent=2) + "\n")

    if engine == "sam3d":
        glb_url = _file_url(resp, "model_glb", "individual_glbs")
        splat_url = _file_url(resp, "gaussian_splat", "individual_splats")
    else:
        glb_url, splat_url = _file_url(resp, "model_glb"), None
    if not glb_url:
        raise NookError(f"{endpoint} returned no model_glb (live runs keep the response in <library>/_failed/)")
    out = {"glb": fal.fetch(glb_url, raw_dir), "splat": None}
    if splat_url:
        out["splat"] = fal.fetch(splat_url, raw_dir)
    elif engine == "sam3d":
        print("nook-add: warning: sam3d returned no gaussian_splat; the item will be GLB only", file=sys.stdout)
    return out


def load_fal_key(repo: Path) -> bool:
    """FAL_KEY from the environment, else from <repo>/.env (unless NOOK_NO_DOTENV=1). Never printed."""
    if os.environ.get("FAL_KEY"):
        return True
    if os.environ.get("NOOK_NO_DOTENV", "") not in ("", "0"):
        return False
    env = repo / ".env"
    try:
        lines = env.read_text().splitlines()
    except OSError:
        return False
    for line in lines:
        line = line.strip().removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        if sep and key.strip() == "FAL_KEY":
            value = value.strip().strip("'\"")
            if value:
                os.environ["FAL_KEY"] = value
                return True
    return False
