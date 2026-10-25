"""Open and validate a nook-scan capture (contract §4.1-4.5)."""

import json
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image

from . import REPO, ScanError

MIN_FRAMES = 30
MIN_SPAN_M = 0.5
SCHEMA_PATH = REPO / "contract" / "capture.schema.json"
_JUNK = ("__MACOSX", ".DS_Store")


@dataclass
class Capture:
    root: Path
    transforms: dict
    meta: dict

    @property
    def frames(self) -> list[dict]:
        return self.transforms["frames"]

    def size(self, f: dict) -> tuple[int, int]:
        return int(f.get("w", self.transforms["w"])), int(f.get("h", self.transforms["h"]))

    def intrinsics(self, f: dict) -> tuple[float, float, float, float]:
        t = self.transforms
        return tuple(float(f.get(k, t[k])) for k in ("fl_x", "fl_y", "cx", "cy"))

    def poses(self) -> np.ndarray:
        return np.array([f["transform_matrix"] for f in self.frames], dtype=np.float64)


def open_capture(arg: str, workdir: Path) -> Path:
    """Return the capture folder for a folder or .zip argument (zips are extracted into workdir)."""
    p = Path(arg).expanduser()
    if not p.exists():
        raise ScanError(f"{arg} does not exist: pass the capture .zip (AirDropped from the app) or its unzipped folder")
    if p.is_dir():
        if (p / "transforms.json").is_file():
            return p
        subs = [d for d in p.iterdir() if d.is_dir() and (d / "transforms.json").is_file()]
        if len(subs) == 1:
            return subs[0]
        raise ScanError(f"{arg} has no transforms.json: pass the capture folder (scan-YYYYMMDD-HHMMSS) or its .zip")
    if not zipfile.is_zipfile(p):
        raise ScanError(f"{arg} is neither a folder nor a .zip: pass the capture .zip from the nook-scan app")
    try:
        with zipfile.ZipFile(p) as z:
            names = [n for n in z.namelist() if n.strip("/") and not any(part in _JUNK for part in n.split("/"))]
            for n in names:
                pp = PurePosixPath(n)
                if pp.is_absolute() or ".." in pp.parts or "\\" in n:
                    raise ScanError(f"{p.name} contains an unsafe path ({n}): re-share the capture from the nook-scan app")
            tops = {n.split("/")[0] for n in names}
            nested = all("/" in n.strip("/") or n.endswith("/") for n in names)
            if len(tops) != 1 or not nested:
                shown = ", ".join(sorted(tops)[:4]) + (", ..." if len(tops) > 4 else "")
                raise ScanError(f"{p.name} must contain a single top-level capture folder (scan-YYYYMMDD-HHMMSS/), "
                                f"found {len(tops)} top-level entries ({shown}): zip the folder itself, or share it again from the app")
            dest = workdir / "capture"
            dest.mkdir(parents=True)
            for n in names:
                z.extract(n, dest)
    except zipfile.BadZipFile:
        raise ScanError(f"{p.name} is a damaged zip: AirDrop the capture again")
    return dest / tops.pop()


def _load_json(root: Path, name: str) -> dict:
    path = root / name
    if not path.is_file():
        raise ScanError(f"capture has no {name}: pass a nook-scan capture folder (it holds transforms.json, meta.json and images/)")
    try:
        data = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError) as e:
        raise ScanError(f"cannot read {name}: {e}")
    except json.JSONDecodeError as e:
        raise ScanError(f"{name} is not valid JSON (line {e.lineno}): the capture is damaged, export it again from the app")
    if not isinstance(data, dict):
        raise ScanError(f"{name} must be a JSON object: the capture is damaged, export it again from the app")
    return data


def _schema_errors(transforms: dict, meta: dict) -> list[str]:
    try:
        import jsonschema
        schema = json.loads(SCHEMA_PATH.read_text())
    except (ImportError, OSError):
        return []
    errs = []
    v = jsonschema.Draft202012Validator(schema)
    for e in sorted(v.iter_errors({"transforms": transforms, "meta": meta}), key=lambda e: list(e.path))[:5]:
        parts = list(e.path)
        where = (f"{parts[0]}.json" if parts else "capture") + ("/" + "/".join(map(str, parts[1:])) if len(parts) > 1 else "")
        msg = e.message if len(e.message) < 120 else e.message[:117] + "..."
        errs.append(f"{where}: {msg}")
    return errs


def validate(root: Path) -> tuple[Capture | None, list[str]]:
    """Check §4.5. Returns the capture and a list of problems (most actionable first)."""
    transforms = _load_json(root, "transforms.json")
    meta = _load_json(root, "meta.json")
    frames = transforms.get("frames")
    if not isinstance(frames, list):
        return None, ["transforms.json has no frames list: the capture is damaged, export it again from the app"]
    if len(frames) < MIN_FRAMES:
        return None, [f"only {len(frames)} frames (need at least {MIN_FRAMES}): scan again, moving slowly around the whole room"]
    errs = _schema_errors(transforms, meta)
    if errs:
        return None, [e + ": the capture does not match the nook-scan format (update the app, or export again)" for e in errs]
    if meta["frame_count"] != len(frames):
        errs.append(f"meta.json frame_count is {meta['frame_count']} but transforms.json has {len(frames)} frames: the capture is incomplete, export it again")
    cap = Capture(root, transforms, meta)
    base = root.resolve()

    def inside(rel: str) -> Path | None:
        p = (root / rel).resolve()
        return p if base in p.parents and p.is_file() else None

    positions = []
    for i, f in enumerate(frames):
        tag = f"frame {i} ({f['file_path']})"
        img = inside(f["file_path"])
        if not img:
            errs.append(f"{tag}: image file is missing: the capture is incomplete, AirDrop or unzip it again")
        else:
            try:
                with Image.open(img) as im:
                    im.load()  # decode fully: a truncated JPEG would otherwise only fail inside the trainer
                    if im.size != cap.size(f):
                        w, h = cap.size(f)
                        errs.append(f"{tag}: image is {im.size[0]}x{im.size[1]} but transforms.json says {w}x{h}: the capture is inconsistent, export it again")
            except Exception:
                errs.append(f"{tag}: image is not a readable JPEG: the capture is damaged, export it again")
        if f.get("depth_file_path"):
            d = inside(f["depth_file_path"])
            if not d:
                errs.append(f"{tag}: depth file {f['depth_file_path']} is missing: the capture is incomplete, AirDrop or unzip it again")
            else:
                try:
                    with Image.open(d) as dm:
                        if dm.mode not in ("I;16", "I;16B", "I;16L", "I"):
                            errs.append(f"{tag}: depth must be a 16-bit grayscale PNG (got mode {dm.mode}): update the capture app")
                except Exception:
                    errs.append(f"{tag}: depth PNG is not readable: the capture is damaged, export it again")
        m = np.array(f["transform_matrix"], dtype=float)
        if not np.all(np.isfinite(m)):
            errs.append(f"{tag}: transform_matrix has NaN/inf values: this pose is corrupt, scan again (or delete the frame)")
            continue
        r = m[:3, :3]
        if np.abs(r.T @ r - np.eye(3)).max() > 1e-3 or abs(np.linalg.det(r) - 1) > 1e-3:
            errs.append(f"{tag}: transform_matrix rotation is not orthonormal (det {np.linalg.det(r):.4f}): the pose is corrupt, scan again")
        if np.abs(m[3] - [0, 0, 0, 1]).max() > 1e-6:
            errs.append(f"{tag}: transform_matrix bottom row must be [0,0,0,1]: the pose is corrupt, scan again")
        positions.append(m[:3, 3])
    if transforms.get("ply_file_path") and not inside(transforms["ply_file_path"]):
        errs.append(f"seed points {transforms['ply_file_path']} are missing: the capture is incomplete, AirDrop or unzip it again")
    if positions:
        span = float(np.linalg.norm(np.ptp(np.array(positions), axis=0)))
        if span < MIN_SPAN_M:
            errs.insert(0, f"camera positions span only {span:.2f} m (need at least {MIN_SPAN_M} m): walk around the room while scanning, don't stand still")
    return cap, errs


def load(root: Path) -> Capture:
    """Validate and return the capture, or raise one actionable ScanError."""
    cap, errs = validate(root)
    if errs:
        more = f" (+{len(errs) - 1} more problems; `nook-scan check` lists them)" if len(errs) > 1 else ""
        raise ScanError(errs[0] + more)
    return cap
