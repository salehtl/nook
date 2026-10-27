"""Check a nook-scan capture (folder or .zip) against contract/CONTRACT.md §4.5 and contract/capture.schema.json.

Usage (from the repo root): evals/py evals/validate_capture.py <capture-dir|capture.zip> [--min-frames 30]
Prints one summary line, or FAIL lines, and exits non-zero on any failure.
"""
import json
import sys
import tempfile
import zipfile
from pathlib import Path

import jsonschema
import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((REPO / "contract" / "capture.schema.json").read_text())


def open_capture(arg: str) -> Path:
    p = Path(arg)
    if p.is_dir():
        return p
    if p.suffix == ".zip" and p.is_file():
        tmp = Path(tempfile.mkdtemp(prefix="nook-capture-"))
        with zipfile.ZipFile(p) as z:
            tops = {n.split("/")[0] for n in z.namelist() if n.strip("/")}
            if len(tops) != 1:
                raise ValueError(f"zip must contain exactly one top-level folder, found {sorted(tops)[:5]}")
            z.extractall(tmp)
        return tmp / tops.pop()
    raise ValueError(f"{arg} is not a capture folder or .zip")


def validate(root: Path, min_frames: int) -> list[str]:
    errs = []
    try:
        transforms = json.loads((root / "transforms.json").read_text())
        meta = json.loads((root / "meta.json").read_text())
    except (OSError, json.JSONDecodeError) as e:
        return [f"cannot read transforms.json/meta.json: {e}"]
    schema = dict(SCHEMA)
    for e in sorted(jsonschema.Draft202012Validator(schema).iter_errors({"transforms": transforms, "meta": meta}), key=lambda e: list(e.path))[:10]:
        errs.append(f"schema at /{'/'.join(map(str, e.path))}: {e.message[:200]}")
    if errs:
        return errs
    frames = transforms["frames"]
    if meta["frame_count"] != len(frames):
        errs.append(f"meta.frame_count is {meta['frame_count']} but transforms.json has {len(frames)} frames")
    if len(frames) < min_frames:
        errs.append(f"only {len(frames)} frames, need at least {min_frames}")

    def inside(rel: str) -> Path | None:
        p = (root / rel).resolve()
        return p if root.resolve() in p.parents and p.is_file() else None

    positions = []
    for i, f in enumerate(frames):
        tag = f"frame {i} ({f['file_path']})"
        img = inside(f["file_path"])
        if not img:
            errs.append(f"{tag}: image missing or outside the capture")
        else:
            with Image.open(img) as im:
                w, h = f.get("w", transforms["w"]), f.get("h", transforms["h"])
                if im.size != (w, h):
                    errs.append(f"{tag}: image is {im.size[0]}x{im.size[1]}, transforms say {w}x{h}")
        if f.get("depth_file_path"):
            d = inside(f["depth_file_path"])
            if not d:
                errs.append(f"{tag}: depth missing or outside the capture")
            else:
                with Image.open(d) as dm:
                    if dm.mode not in ("I;16", "I;16B", "I"):
                        errs.append(f"{tag}: depth must be a 16-bit grayscale PNG, got mode {dm.mode}")
        m = np.array(f["transform_matrix"], dtype=float)
        if not np.all(np.isfinite(m)):
            errs.append(f"{tag}: transform_matrix is not finite")
            continue
        r = m[:3, :3]
        if np.abs(r.T @ r - np.eye(3)).max() > 1e-3 or abs(np.linalg.det(r) - 1) > 1e-3:
            errs.append(f"{tag}: rotation is not orthonormal (det {np.linalg.det(r):.4f})")
        if np.abs(m[3] - [0, 0, 0, 1]).max() > 1e-6:
            errs.append(f"{tag}: bottom row must be [0,0,0,1], got {m[3].tolist()}")
        positions.append(m[:3, 3])
        if len(errs) > 20:
            errs.append("... stopping after 20 errors")
            return errs
    if transforms.get("ply_file_path") and not inside(transforms["ply_file_path"]):
        errs.append(f"ply_file_path {transforms['ply_file_path']} missing or outside the capture")
    if meta.get("roomplan") is not None:
        errs += validate_roomplan(root, meta["roomplan"])
    if positions:
        span = float(np.linalg.norm(np.ptp(np.array(positions), axis=0)))
        if span < 0.5:
            errs.append(f"camera positions span only {span:.2f} m (need >= 0.5 m: walk around while scanning)")
    return errs


def validate_roomplan(root: Path, info: dict) -> list[str]:
    """Contract §4.12: roomplan.json present, schema-valid, matrices finite and rigid, the frame stated as meta says."""
    p = root / "roomplan.json"
    if not p.is_file():
        return ["meta.roomplan is set but roomplan.json is missing"]
    try:
        rp = json.loads(p.read_text())
        jsonschema.validate(rp, json.loads((Path(__file__).parent.parent / "contract/roomplan.schema.json").read_text()))
    except (ValueError, jsonschema.ValidationError) as e:
        return [f"roomplan.json: {str(e).splitlines()[0]}"]
    errs = []
    if info.get("sessions") == "separate" and "world_from_roomplan" not in rp:
        errs.append("roomplan.json: sessions is separate, so world_from_roomplan is required")
    if info.get("sessions") == "shared" and "world_from_roomplan" in rp:
        errs.append("roomplan.json: sessions is shared, so world_from_roomplan must be absent")
    mats = [("world_from_roomplan", rp["world_from_roomplan"])] if "world_from_roomplan" in rp else []
    mats += [(e["id"], e["transform"]) for k in ("walls", "floors", "doors", "windows", "openings", "objects") for e in rp.get(k, [])]
    for tag, m in mats:
        m = np.array(m, dtype=float)
        r = m[:3, :3]
        if not np.isfinite(m).all() or np.abs(r.T @ r - np.eye(3)).max() > 1e-3 or abs(np.linalg.det(r) - 1) > 1e-3:
            errs.append(f"roomplan.json {tag}: transform must be finite with an orthonormal rotation")
    return errs


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    min_frames = 30
    if "--min-frames" in args:
        i = args.index("--min-frames")
        min_frames = int(args[i + 1])
        del args[i:i + 2]
    try:
        root = open_capture(args[0])
    except (ValueError, zipfile.BadZipFile) as e:
        print(f"FAIL {e}")
        sys.exit(1)
    errs = validate(root, min_frames)
    for e in errs:
        print(f"FAIL {e}")
    if errs:
        sys.exit(1)
    t = json.loads((root / "transforms.json").read_text())
    meta = json.loads((root / "meta.json").read_text())
    pos = np.array([np.array(f["transform_matrix"])[:3, 3] for f in t["frames"]])
    print(f"ok   {root.name}: {len(t['frames'])} frames {t['w']}x{t['h']}, lidar={meta['lidar']}, "
          f"depth={sum(1 for f in t['frames'] if f.get('depth_file_path'))}, span {np.linalg.norm(np.ptp(pos, axis=0)):.2f} m, floor_y={meta.get('floor_y')}")


if __name__ == "__main__":
    main()
