"""nook-add: photo, image URL or GLB -> normalized item in the nook library (contract/CONTRACT.md §3)."""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import traceback
import unicodedata
import urllib.parse
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import NookError, engines, glb, library, splat
from .frames import orientation

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DIMS = re.compile(r"^\s*(\d+(?:\.\d+)?|\.\d+)\s*[x×X]\s*(\d+(?:\.\d+)?|\.\d+)\s*[x×X]\s*(\d+(?:\.\d+)?|\.\d+)\s*$")
MODEL_EXT = {".glb", ".gltf"}
USD_EXT = {".usdz", ".usd", ".usda", ".usdc"}
PIL_EXT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif", "BMP": ".bmp", "TIFF": ".tif"}


def repo_root() -> Path:
    """The nook checkout: the directory holding pipeline/pyproject.toml (works for editable and venv installs)."""
    for p in Path(__file__).resolve().parents:
        if (p / "pipeline" / "pyproject.toml").is_file():
            return p
    return Path.cwd()


REPO = repo_root()


class Parser(argparse.ArgumentParser):
    def error(self, message):  # one actionable line instead of usage + error
        raise NookError(f"{message} (see nook-add --help)")


def build_parser() -> Parser:
    p = Parser(prog="nook-add", description="Add a piece of furniture to the nook library at real-world size.")
    p.add_argument("input", metavar="INPUT", help="image path or URL (sam3d, trellis2), or .glb/.gltf path or URL (glb)")
    p.add_argument("--name", required=True, help="human name, e.g. 'Strandmon wing chair'")
    p.add_argument("--dims", help="W x D x H in cm, e.g. 75x80x95 (x or ×, spaces and decimals allowed)")
    p.add_argument("--id", help="slug; defaults to a slug of --name. An existing id is replaced")
    p.add_argument("--category", help="e.g. armchair")
    p.add_argument("--engine", choices=["sam3d", "trellis2", "glb"], default="sam3d")
    p.add_argument("--prompt", help="sam3d only: the object to extract; defaults to --category or 'furniture'")
    p.add_argument("--yaw", type=int, choices=[0, 90, 180, 270], default=0,
                   help="extra counterclockwise turn about +Y (seen from above) so the front faces +Z")
    p.add_argument("--resolution", type=int, choices=[512, 1024, 1536], help="trellis2 only (default 512)")
    p.add_argument("--library", help="library directory (default: <repo>/library)")
    p.add_argument("--notes", help="free text stored with the item")
    return p


def parse_dims(text: str | None) -> tuple[float, float, float]:
    if text is None:
        raise NookError("--dims is required: W x D x H in cm, e.g. --dims 75x80x95")
    m = DIMS.match(text)
    if not m:
        raise NookError(f"--dims must look like 75x80x95 (cm), got '{text}'")
    w, d, h = (float(v) for v in m.groups())
    if min(w, d, h) <= 0:
        raise NookError(f"--dims values must all be greater than 0 cm, got '{text}'")
    return w, d, h


def slugify(text: str) -> str:
    ascii_ = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_).strip("-")[:64].rstrip("-")


def num(v: float) -> float | int:
    return int(v) if float(v).is_integer() else v


def resolve_mock_dir() -> Path | None:
    value = os.environ.get("NOOK_FAL_MOCK")
    if not value:
        return None
    p = Path(value).expanduser()
    for candidate in ([p] if p.is_absolute() else [Path.cwd() / p, REPO / p]):
        if candidate.is_dir():
            return candidate
    raise NookError(f"NOOK_FAL_MOCK={value} is not a directory (expected e.g. fixtures/fal)")


def check_image(path: Path) -> str:
    """Pillow's format name for a readable image, so a bad file fails before any paid call."""
    from PIL import Image

    try:
        with Image.open(path) as im:
            im.verify()
            return im.format or ""
    except Exception as e:  # noqa: BLE001
        raise NookError(f"{path} isn't an image nook-add can read ({type(e).__name__}); use a JPEG, PNG or WebP") from None


def make_thumb(image: Path, out: Path) -> None:
    """256 x 256 center-cropped JPEG."""
    from PIL import Image, ImageOps

    with Image.open(image) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        ImageOps.fit(im, (256, 256), Image.Resampling.LANCZOS).save(out, "JPEG", quality=88)


def say(msg: str) -> None:
    print(f"nook-add: {msg}", flush=True)


def run(argv: list[str] | None) -> None:
    args = build_parser().parse_args(argv)

    # --- validate everything before any work, so bad input never touches the library ---------------------
    w, d, h = parse_dims(args.dims)
    name = args.name.strip()
    if not name:
        raise NookError("--name can't be empty")
    if args.id is not None:
        item_id = args.id
        if not SLUG.match(item_id):
            raise NookError(f"--id must be a slug like 'reading-chair' (a-z, 0-9, '-', max 64), got '{item_id}'")
    else:
        item_id = slugify(name)
        if not SLUG.match(item_id):
            raise NookError(f"can't make an id from --name '{name}'; pass --id reading-chair or similar")

    engine = args.engine
    image_engine = engine in engines.ENDPOINTS
    resolution = args.resolution or 512
    prompt = args.prompt or args.category or "furniture"
    if args.resolution and engine != "trellis2":
        say(f"note: --resolution only applies to trellis2; ignored for {engine}")
    if args.prompt and engine != "sam3d":
        say(f"note: --prompt only applies to sam3d; ignored for {engine}")

    raw_input = args.input
    is_url = bool(re.match(r"^https?://", raw_input, re.I))
    suffix = Path(urllib.parse.urlparse(raw_input).path if is_url else raw_input).suffix.lower()
    if suffix in USD_EXT:
        raise NookError(f"{suffix} isn't supported: convert to GLB first (e.g. Reality Converter or Blender), "
                        "then use --engine glb")
    if engine == "glb" and suffix not in MODEL_EXT and not (is_url and not suffix):
        raise NookError(f"--engine glb needs a .glb or .gltf INPUT, got '{raw_input}'")
    if image_engine and suffix in MODEL_EXT:
        raise NookError(f"INPUT is a 3D model ({suffix}); use --engine glb")

    mock_dir = resolve_mock_dir()
    local = None
    if is_url:
        if mock_dir:
            raise NookError("NOOK_FAL_MOCK is set, so nook-add makes no network requests: "
                            "download INPUT to a local file and pass its path")
    else:
        local = Path(raw_input).expanduser()
        if not local.is_file():
            raise NookError(f"INPUT not found: {raw_input}")
        if image_engine:
            check_image(local)

    if image_engine and not mock_dir and not engines.load_fal_key(REPO):
        raise NookError(f"FAL_KEY not set: add FAL_KEY=... to {REPO / '.env'} "
                        "(or set NOOK_FAL_MOCK=fixtures/fal for a free dry run)")

    lib_dir = Path(args.library).expanduser() if args.library else REPO / "library"
    if lib_dir.exists() and not lib_dir.is_dir():
        raise NookError(f"--library {lib_dir} exists but isn't a directory")
    data = library.load(lib_dir)

    # --- build the item in a staging dir; it only moves into the library after the self-check passes --------
    mock = mock_dir is not None
    cost = 0.0 if mock else engines.cost_usd(engine, resolution)
    staging = Path(tempfile.mkdtemp(prefix=f"nook-add-{item_id}-"))
    fal, committed = None, False
    try:
        if is_url:
            dl = staging / "download"
            dl.mkdir()
            local = engines.download(raw_input, dl / engines.url_basename(raw_input))
        ext = local.suffix.lower()
        if image_engine:
            fmt = check_image(local)
            ext = ext or PIL_EXT.get(fmt, ".img")
        elif not ext:
            ext = ".glb" if local.read_bytes()[:4] == b"glTF" else ".gltf"
        source_name = f"source{ext}"
        shutil.copy2(local, staging / source_name)

        model_src, splat_src = local, None
        if image_engine:
            fal = engines.MockFal(mock_dir) if mock else engines.LiveFal()
            say(f"{engine}{' (mock, $0)' if mock else f' (${cost:.2f})'}: {raw_input}")
            outputs = engines.run(fal, engine, local, prompt, resolution, staging / "raw")
            model_src, splat_src = outputs["glb"], outputs["splat"]
        elif ext == ".gltf":
            say("note: a .gltf input is packed into a single GLB; source.gltf is kept without its side files")

        dims_m = np.array([w, h, d]) / 100  # X, Y, Z
        glb_fit = glb.normalize(model_src, orientation(engine, "glb", args.yaw), dims_m, staging / "model.glb")
        say(f"model.glb fit to {num(w)} x {num(d)} x {num(h)} cm (error % w/d/h: "
            f"{glb_fit['w']}/{glb_fit['d']}/{glb_fit['h']})")
        splat_fit = None
        if splat_src:
            splat_fit, notes = splat.normalize(splat_src, orientation(engine, "splat", args.yaw), dims_m,
                                               staging / "splat.ply")
            for n in notes:
                say(f"note: {n}")
            say(f"splat.ply scaled uniformly to h = {num(h)} cm (error % w/d/h: "
                f"{splat_fit['w']}/{splat_fit['d']}/{splat_fit['h']})")
        thumb = image_engine
        if thumb:
            make_thumb(local, staging / "thumb.jpg")
        if (staging / "download").exists():
            shutil.rmtree(staging / "download")

        # --- commit: item dir, then library.json, then costs.csv ------------------------------------------
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lib_dir.mkdir(parents=True, exist_ok=True)
        item_dir = lib_dir / item_id
        if item_dir.exists():
            # Re-running on this item's own raw output (e.g. to fix --yaw): keep those raw files.
            old_raw = item_dir / "raw"
            if old_raw.is_dir() and not (staging / "raw").exists() and item_dir.resolve() in local.resolve().parents:
                shutil.move(str(old_raw), str(staging / "raw"))
            shutil.rmtree(item_dir)
        shutil.move(str(staging), str(item_dir))
        committed = True

        entry = {
            "id": item_id,
            "name": name,
            "category": args.category,
            "dims_cm": {"w": num(w), "d": num(d), "h": num(h)},
            "assets": {
                "glb": f"{item_id}/model.glb",
                "splat": f"{item_id}/splat.ply" if splat_src else None,
                "thumb": f"{item_id}/thumb.jpg" if thumb else None,
            },
            "default_render": "splat" if splat_src else "glb",
            "source": {
                "engine": engine,
                "input": raw_input,
                "prompt": prompt if engine == "sam3d" else None,
                "cost_usd": cost,
                "mock": mock,
                "created": created,
            },
            "fit": {"glb_error_pct": glb_fit, "splat_error_pct": splat_fit},
            "notes": args.notes,
        }
        if library.upsert(lib_dir, data, entry):
            say(f"replaced existing item '{item_id}' in {lib_dir / 'library.json'}")
        else:
            say(f"added '{item_id}' to {lib_dir / 'library.json'}")
        library.append_cost(lib_dir, created, item_id, engine, cost, mock, raw_input)
    except Exception as e:
        if fal is None or fal.mock or not fal.charged or committed:
            raise
        # A live call was paid for: record the cost, and keep its outputs for a free `--engine glb` retry.
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lib_dir.mkdir(parents=True, exist_ok=True)
        library.append_cost(lib_dir, stamp, item_id, engine, cost, mock, raw_input)
        kept = lib_dir / "_failed" / f"{item_id}-{stamp.replace(':', '')}"
        kept.parent.mkdir(exist_ok=True)
        shutil.move(str(staging), str(kept))
        msg = str(e) if isinstance(e, NookError) else f"unexpected error ({type(e).__name__}: {e})"
        raise NookError(f"{msg} (${cost:.2f} recorded in costs.csv; engine outputs kept in {kept / 'raw'})") from None
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    paths = {
        "library": str(lib_dir / "library.json"),
        "item": str(item_dir),
        "glb": str(item_dir / "model.glb"),
        "splat": str(item_dir / "splat.ply") if splat_src else None,
        "thumb": str(item_dir / "thumb.jpg") if thumb else None,
        "source": str(item_dir / source_name),
        "raw": str(item_dir / "raw") if (item_dir / "raw").is_dir() else None,
        "costs": str(lib_dir / "costs.csv"),
    }
    print(json.dumps({"id": item_id, "engine": engine, "cost_usd": cost, "mock": mock, "paths": paths,
                      "fit": {"glb_error_pct": glb_fit, "splat_error_pct": splat_fit}}), flush=True)


def main(argv: list[str] | None = None) -> None:
    warnings.filterwarnings("ignore")
    try:
        run(argv)
    except NookError as e:
        print(f"nook-add: {' '.join(str(e).split())}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("nook-add: interrupted", file=sys.stderr)
        sys.exit(130)
    except Exception as e:  # noqa: BLE001 - never a traceback unless asked for
        if os.environ.get("NOOK_DEBUG"):
            traceback.print_exc()
        msg = " ".join(f"{type(e).__name__}: {e}".split())
        print(f"nook-add: unexpected error ({msg}); re-run with NOOK_DEBUG=1 for a traceback", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
