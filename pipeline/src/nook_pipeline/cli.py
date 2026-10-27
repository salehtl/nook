"""nook-add: photo, image URL, GLB or OBJ zip -> normalized item in the nook library (contract/CONTRACT.md §3)."""
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

from . import NookError, engines, glb, library, objzip, splat
from .frames import orientation, yaw_rotation

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DIMS = re.compile(r"^\s*(\d+(?:\.\d+)?|\.\d+)\s*[x×X]\s*(\d+(?:\.\d+)?|\.\d+)\s*[x×X]\s*(\d+(?:\.\d+)?|\.\d+)\s*$")
MODEL_EXT = {".glb", ".gltf", ".zip"}
USD_EXT = {".usdz", ".usd", ".usda", ".usdc"}
PIL_EXT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif", "BMP": ".bmp", "TIFF": ".tif", "HEIF": ".heic"}


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
    p.add_argument("input", metavar="INPUT", nargs="?",
                   help="image path or URL (sam3d, trellis2), or .glb/.gltf path or URL, or an OBJ .zip (glb)")
    p.add_argument("--name", help="human name, e.g. 'Strandmon wing chair' (required unless --rescale)")
    p.add_argument("--dims", help="W x D x H in cm, e.g. 75x80x95 (x or ×, spaces and decimals allowed)")
    p.add_argument("--id", help="slug; defaults to a slug of --name. An existing id is replaced")
    p.add_argument("--category", help="e.g. armchair")
    p.add_argument("--engine", choices=["sam3d", "trellis2", "glb"], default="sam3d")
    p.add_argument("--prompt", help="sam3d only: the object to extract; defaults to --category or 'furniture'")
    p.add_argument("--yaw", type=int, choices=[0, 90, 180, 270], default=0,
                   help="extra counterclockwise turn about +Y (seen from above) so the front faces +Z; "
                        "with --rescale, relative to the item's current orientation")
    p.add_argument("--resolution", type=int, choices=[512, 1024, 1536], help="trellis2 only (default 512)")
    p.add_argument("--library", help="library directory (default: <repo>/library)")
    p.add_argument("--notes", help="free text stored with the item")
    p.add_argument("--mount", choices=["floor", "wall"], help="where the planner places it by default (§2.10)")
    p.add_argument("--rescale", metavar="ID", help="refit an existing item from its normalized assets "
                   "(no INPUT, no model call, $0); takes --dims (default: keep) and --yaw (relative)")
    p.add_argument("--source-input", help="what to record as source.input (default: INPUT); planner/serve.py "
                   "passes the original file name or link of an upload")
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


def heif_support() -> None:
    """Let Pillow open HEIC/HEIF (iPhone photos) via pillow-heif."""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass


def check_image(path: Path) -> str:
    """Pillow's format name for a readable image, so a bad file fails before any paid call."""
    from PIL import Image

    heif_support()
    try:
        with Image.open(path) as im:
            im.verify()
            return im.format or ""
    except Exception as e:  # noqa: BLE001
        raise NookError(f"{path} isn't an image nook-add can read ({type(e).__name__}); use a JPEG, PNG, HEIC or WebP") from None


def make_thumb(image: Path, out: Path) -> None:
    """256 x 256 center-cropped JPEG."""
    from PIL import Image, ImageOps

    with Image.open(image) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        ImageOps.fit(im, (256, 256), Image.Resampling.LANCZOS).save(out, "JPEG", quality=88)


def say(msg: str) -> None:
    print(f"nook-add: {msg}", flush=True)


def library_dir(args) -> Path:
    lib_dir = Path(args.library).expanduser() if args.library else REPO / "library"
    if lib_dir.exists() and not lib_dir.is_dir():
        raise NookError(f"--library {lib_dir} exists but isn't a directory")
    return lib_dir


def mock_cost() -> bool:
    """NOOK_FAL_MOCK_COST=1 (evals only): mock runs record the engine's real price, to test the spend cap."""
    return os.environ.get("NOOK_FAL_MOCK_COST", "") not in ("", "0")


def run(argv: list[str] | None) -> None:
    args = build_parser().parse_args(argv)
    if args.rescale is not None:
        return rescale(args)

    # --- validate everything before any work, so bad input never touches the library ---------------------
    if args.input is None:
        raise NookError("INPUT is required: an image path or URL, a .glb, or an OBJ .zip (or use --rescale ID)")
    if args.name is None:
        raise NookError("--name is required, e.g. --name 'Reading chair'")
    w, d, h = parse_dims(args.dims)
    name = args.name.strip()
    if not name:
        raise NookError("--name can't be empty")
    if args.id is not None:
        item_id = args.id
        if not SLUG.fullmatch(item_id):
            raise NookError(f"--id must be a slug like 'reading-chair' (a-z, 0-9, '-', max 64), got '{item_id}'")
    else:
        item_id = slugify(name)
        if not SLUG.fullmatch(item_id):
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
        raise NookError(f"--engine glb needs a .glb, .gltf or OBJ .zip INPUT, got '{raw_input}'")
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

    if suffix == ".zip" and local is not None:
        objzip.check(local)  # refuse a bad zip before taking the lock or writing anything

    lib_dir = library_dir(args)
    with library.locked(lib_dir):  # the whole run (§2.8 "one writer")
        add(args, lib_dir, name, item_id, (w, d, h), engine, image_engine, resolution, prompt, raw_input, is_url,
            local, mock_dir)


def add(args, lib_dir: Path, name: str, item_id: str, dims: tuple, engine: str, image_engine: bool, resolution: int,
        prompt: str, raw_input: str, is_url: bool, local: Path | None, mock_dir: Path | None) -> None:
    w, d, h = dims
    data = library.load(lib_dir)
    source_input = args.source_input or raw_input

    # --- build the item in a staging dir; it only moves into the library after the self-check passes --------
    mock = mock_dir is not None
    cost = engines.cost_usd(engine, resolution) if (not mock or mock_cost()) else 0.0
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
        if ext == ".zip":
            local = objzip.to_glb(local, staging / "unzipped", staging / "converted.glb")
            ext = ".glb"
        if image_engine and fmt == "HEIF":
            # The engines and the thumbnail get a JPEG of the photo; source.heic keeps the original.
            from PIL import Image, ImageOps

            with Image.open(local) as im:
                ImageOps.exif_transpose(im).convert("RGB").save(staging / "converted.jpg", "JPEG", quality=92)
            local = staging / "converted.jpg"

        model_src, splat_src, splat_to_glb = local, None, np.eye(3)
        if image_engine:
            fal = engines.MockFal(mock_dir) if mock else engines.LiveFal()
            say(f"{engine}{' (mock, $0)' if mock else f' (${cost:.2f})'}: {raw_input}")
            outputs = engines.run(fal, engine, local, prompt, resolution, staging / "raw")
            model_src, splat_src, splat_to_glb = outputs["glb"], outputs["splat"], outputs["splat_to_glb"]
        elif ext == ".gltf":
            say("note: a .gltf input is packed into a single GLB; source.gltf is kept without its side files")

        dims_m = np.array([w, h, d]) / 100  # X, Y, Z
        glb_fit = glb.normalize(model_src, orientation(engine, "glb", args.yaw), dims_m, staging / "model.glb")
        say(f"model.glb fit to {num(w)} x {num(d)} x {num(h)} cm (error % w/d/h: "
            f"{glb_fit['w']}/{glb_fit['d']}/{glb_fit['h']})")
        splat_fit = None
        if splat_src:
            splat_fit, notes = splat.normalize(splat_src, orientation(engine, "splat", args.yaw) @ splat_to_glb,
                                               dims_m, staging / "splat.ply")
            for n in notes:
                say(f"note: {n}")
            say(f"splat.ply scaled uniformly to h = {num(h)} cm (error % w/d/h: "
                f"{splat_fit['w']}/{splat_fit['d']}/{splat_fit['h']})")
        thumb = image_engine
        if thumb:
            make_thumb(local, staging / "thumb.jpg")
        for scratch in ("download", "unzipped", "converted.glb", "converted.jpg"):
            if (staging / scratch).is_dir():
                shutil.rmtree(staging / scratch)
            elif (staging / scratch).exists():
                (staging / scratch).unlink()

        # --- commit: item dir, then library.json, then costs.csv ------------------------------------------
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lib_dir.mkdir(parents=True, exist_ok=True)
        item_dir = lib_dir / item_id
        if item_dir.exists():
            # Re-running on this item's own raw output (e.g. to fix --yaw): keep those raw files.
            old_raw = item_dir / "raw"
            if old_raw.is_dir() and not (staging / "raw").exists() and item_dir.resolve() in Path(raw_input).resolve().parents:
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
                "input": source_input,
                "prompt": prompt if engine == "sam3d" else None,
                "cost_usd": cost,
                "mock": mock,
                "created": created,
            },
            "fit": {"glb_error_pct": glb_fit, "splat_error_pct": splat_fit},
            "notes": args.notes,
        }
        if args.mount:
            entry["mount"] = args.mount
        if library.upsert(lib_dir, data, entry):
            say(f"replaced existing item '{item_id}' in {lib_dir / 'library.json'}")
        else:
            say(f"added '{item_id}' to {lib_dir / 'library.json'}")
        library.append_cost(lib_dir, created, item_id, engine, cost, mock, source_input)
    except Exception as e:
        if fal is None or fal.mock or not fal.charged or committed:
            raise
        # A live call was paid for: record the cost, and keep its outputs for a free `--engine glb` retry.
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lib_dir.mkdir(parents=True, exist_ok=True)
        library.append_cost(lib_dir, stamp, item_id, engine, cost, mock, source_input)
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


def rescale(args) -> None:
    """--rescale ID: refit an existing item's normalized assets to new dims and/or a relative yaw. No engine, $0."""
    item_id = args.rescale
    if not SLUG.fullmatch(item_id):
        raise NookError(f"--rescale needs an item id (a slug like 'reading-chair'), got '{item_id}'")
    if args.input is not None:
        raise NookError("--rescale refits the item's own assets: drop INPUT (to replace the model, add it again)")
    new_dims = parse_dims(args.dims) if args.dims is not None else None
    lib_dir = library_dir(args)
    if not (lib_dir / "library.json").is_file():
        raise NookError(f"no library at {lib_dir}: --rescale only works on an existing item")
    with library.locked(lib_dir):
        data = library.load(lib_dir)
        entry = next((it for it in data["items"] if isinstance(it, dict) and it.get("id") == item_id), None)
        if entry is None:
            raise NookError(f"no item '{item_id}' in {lib_dir / 'library.json'}: check the id (nook-add --rescale ID)")
        try:
            dc = entry["dims_cm"]
            w, d, h = (float(dc[k]) for k in ("w", "d", "h"))
        except (KeyError, TypeError, ValueError):
            raise NookError(f"item '{item_id}' has no valid dims_cm; pass --dims WxDxH") from None
        if new_dims is not None:
            w, d, h = new_dims
        assets = entry.get("assets") or {}
        glb_src = lib_dir / str(assets.get("glb") or f"{item_id}/model.glb")
        splat_src = lib_dir / assets["splat"] if assets.get("splat") else None
        if not glb_src.is_file():
            raise NookError(f"item '{item_id}' has no model file at {glb_src}; add it again instead")
        if splat_src is not None and not splat_src.is_file():
            raise NookError(f"item '{item_id}' lists a splat at {splat_src} that isn't there; add it again instead")

        rotation = yaw_rotation(args.yaw)  # assets are already in the item frame: only the relative turn is left
        dims_m = np.array([w, h, d]) / 100
        staging = Path(tempfile.mkdtemp(prefix=f"nook-rescale-{item_id}-"))
        try:
            glb_fit = glb.normalize(glb_src, rotation, dims_m, staging / "model.glb")
            say(f"model.glb refit to {num(w)} x {num(d)} x {num(h)} cm, yaw +{args.yaw} "
                f"(error % w/d/h: {glb_fit['w']}/{glb_fit['d']}/{glb_fit['h']})")
            splat_fit = None
            if splat_src is not None:
                splat_fit, notes = splat.normalize(splat_src, rotation, dims_m, staging / "splat.ply")
                for n in notes:
                    say(f"note: {n}")
            # Commit: every file passed its self-check, so replace them in place.
            os.replace(staging / "model.glb", glb_src)
            if splat_src is not None:
                os.replace(staging / "splat.ply", splat_src)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        entry["dims_cm"] = {"w": num(w), "d": num(d), "h": num(h)}
        entry["fit"] = {"glb_error_pct": glb_fit, "splat_error_pct": splat_fit}
        library.upsert(lib_dir, data, entry)
        say(f"refit '{item_id}' in {lib_dir / 'library.json'} ($0, no cost row)")

    item_dir = glb_src.parent
    paths = {
        "library": str(lib_dir / "library.json"),
        "item": str(item_dir),
        "glb": str(glb_src),
        "splat": str(splat_src) if splat_src else None,
        "thumb": str(lib_dir / assets["thumb"]) if assets.get("thumb") else None,
        "source": None,
        "raw": str(item_dir / "raw") if (item_dir / "raw").is_dir() else None,
        "costs": str(lib_dir / "costs.csv"),
    }
    print(json.dumps({"id": item_id, "engine": "rescale", "cost_usd": 0, "mock": resolve_mock_dir() is not None,
                      "paths": paths, "fit": {"glb_error_pct": glb_fit, "splat_error_pct": splat_fit}}), flush=True)


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
