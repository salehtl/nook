"""OBJ zips (contract §2.8 zip rules, §3.1 v4): one .obj with its .mtl and textures, converted to a GLB.

The rules are checked before anything is extracted, and a zip that breaks any of them is refused as a whole:
only .obj .mtl .png .jpg .jpeg files, no absolute paths, no '..', no links, at most 1,000 entries and 500 MB
unpacked, exactly one .obj. macOS's __MACOSX/ and .DS_Store entries are skipped, never extracted.
"""
import logging
import stat
import zipfile
from pathlib import Path, PurePosixPath

from . import NookError

ALLOWED = {".obj", ".mtl", ".png", ".jpg", ".jpeg"}
MAX_ENTRIES = 1000
MAX_UNPACKED = 500 * 1024 * 1024

logging.getLogger("trimesh").setLevel(logging.ERROR)


def _skipped(name: str) -> bool:
    return name.startswith("__MACOSX/") or PurePosixPath(name).name == ".DS_Store"


def check(path: Path) -> list[zipfile.ZipInfo]:
    """The entries to extract, after checking every rule. Raises NookError naming the first broken one."""
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise NookError(f"{path.name} isn't a readable zip ({e})") from None
    with z:
        infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        raise NookError(f"the zip has {len(infos)} entries, at most {MAX_ENTRIES} are allowed")
    keep, total = [], 0
    for info in infos:
        name = info.filename
        if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":") or "\\" in name:
            raise NookError(f"the zip holds an absolute or Windows path ({name}): zip the folder's contents instead")
        if ".." in PurePosixPath(name).parts:
            raise NookError(f"the zip holds a path that climbs out of it ({name}): re-zip the folder")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise NookError(f"the zip holds a link ({name}): zip the real files instead")
        if info.is_dir() or _skipped(name):
            continue
        if PurePosixPath(name).suffix.lower() not in ALLOWED:
            raise NookError(f"the zip holds {name}: only .obj, .mtl, .png, .jpg and .jpeg files are allowed")
        total += info.file_size
        keep.append(info)
    if total > MAX_UNPACKED:
        raise NookError(f"the zip unpacks to {total / 1e6:.0f} MB, at most {MAX_UNPACKED // (1024 * 1024)} MB is allowed")
    objs = [i for i in keep if i.filename.lower().endswith(".obj")]
    if len(objs) != 1:
        raise NookError(f"the zip must hold exactly one .obj (with its .mtl and textures), found {len(objs)}")
    return keep


def extract(path: Path, dest: Path) -> Path:
    """Extract an OBJ zip that passes check() into dest; returns the .obj path."""
    keep = check(path)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    obj = None
    with zipfile.ZipFile(path) as z:
        for info in keep:
            out = (dest / info.filename).resolve()
            if root not in out.parents:  # belt and braces after check()
                raise NookError(f"the zip entry {info.filename} would land outside the folder")
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(out, "wb") as f:
                left = info.file_size + 1
                while chunk := src.read(min(1 << 20, left)):
                    left -= len(chunk)
                    if left <= 0:
                        raise NookError(f"the zip entry {info.filename} is bigger than it says")
                    f.write(chunk)
            if out.suffix.lower() == ".obj":
                obj = out
    return obj


def to_glb(path: Path, work: Path, out: Path) -> Path:
    """Convert an OBJ zip to a GLB at `out` (materials and textures kept)."""
    import trimesh

    obj = extract(path, work)
    try:
        scene = trimesh.load(str(obj), force="scene")
    except Exception as e:  # noqa: BLE001
        raise NookError(f"couldn't read {obj.name} ({type(e).__name__}: {e}); export the OBJ again") from None
    if scene.is_empty:
        raise NookError(f"{obj.name} has no mesh geometry")
    try:
        out.write_bytes(scene.export(file_type="glb"))
    except Exception as e:  # noqa: BLE001
        raise NookError(f"couldn't convert {obj.name} to GLB ({type(e).__name__}: {e})") from None
    return out
