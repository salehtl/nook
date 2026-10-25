"""Check a nook library against contract/CONTRACT.md §1 and contract/library.schema.json.

Usage (from the repo root):
  uv run --no-project --python 3.12 --with trimesh --with numpy --with jsonschema \
      python -I evals/validate_library.py path/to/library.json

Prints one line per item and exits non-zero if anything fails.
"""
import json
import sys
from pathlib import Path

import jsonschema
import numpy as np
import trimesh

REPO = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((REPO / "contract" / "library.schema.json").read_text())

GLB_DIM_TOL = 0.02     # per axis
GLB_CENTER_TOL = 0.01  # m, footprint center
GLB_FLOOR_TOL = 0.005  # m, min y
SPLAT_H_TOL = 0.05
SPLAT_FLOOR_TOL = 0.03
SPLAT_CENTER_TOL = 0.05

PLY_TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
             "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
             "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
             "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4"}


def read_ply_xyz(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    header = raw[:end].decode("ascii").splitlines()
    if "format binary_little_endian 1.0" not in header:
        raise ValueError("splat PLY must be binary_little_endian")
    count, props, in_vertex = 0, [], False
    for line in header:
        parts = line.split()
        if parts[:2] == ["element", "vertex"]:
            count, in_vertex = int(parts[2]), True
        elif parts and parts[0] == "element":
            in_vertex = False
        elif in_vertex and parts[:1] == ["property"]:
            if parts[1] == "list":
                raise ValueError("list properties not supported in splat PLY")
            props.append((parts[2], PLY_TYPES[parts[1]]))
    names = [p[0] for p in props]
    for required in ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                     "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]:
        if required not in names:
            raise ValueError(f"splat PLY missing property {required}")
    data = np.frombuffer(raw, dtype=np.dtype(props), count=count, offset=end)
    if count == 0:
        raise ValueError("splat PLY has no vertices")
    return np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float64)


def check_glb(path: Path, dims_m: np.ndarray) -> list[str]:
    scene = trimesh.load(path, force="scene")
    if scene.is_empty:
        return ["GLB has no geometry"]
    (x0, y0, z0), (x1, y1, z1) = scene.bounds
    size = np.array([x1 - x0, y1 - y0, z1 - z0])
    errs = []
    err = np.abs(size - dims_m) / dims_m
    for axis, e, s, t in zip("whd", err, size, dims_m):
        if e > GLB_DIM_TOL:
            errs.append(f"GLB {axis} is {s * 100:.1f} cm, expected {t * 100:.1f} cm ({e:.1%} off, max {GLB_DIM_TOL:.0%})")
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if abs(cx) > GLB_CENTER_TOL or abs(cz) > GLB_CENTER_TOL:
        errs.append(f"GLB footprint center is ({cx:.3f}, {cz:.3f}) m, expected (0, 0)")
    if abs(y0) > GLB_FLOOR_TOL:
        errs.append(f"GLB min y is {y0:.3f} m, expected 0")
    return errs


def check_splat(path: Path, dims_m: np.ndarray) -> list[str]:
    xyz = read_ply_xyz(path)
    lo, hi = np.percentile(xyz, 1, axis=0), np.percentile(xyz, 99, axis=0)
    errs = []
    h, target = hi[1] - lo[1], dims_m[1]
    if abs(h - target) / target > SPLAT_H_TOL:
        errs.append(f"splat height (p1-p99) is {h * 100:.1f} cm, expected {target * 100:.1f} cm")
    if abs(lo[1]) > SPLAT_FLOOR_TOL:
        errs.append(f"splat floor (p1 y) is {lo[1]:.3f} m, expected 0")
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    if abs(cx) > SPLAT_CENTER_TOL or abs(cz) > SPLAT_CENTER_TOL:
        errs.append(f"splat footprint center is ({cx:.3f}, {cz:.3f}) m, expected (0, 0)")
    return errs


def validate(library_path: Path) -> int:
    try:
        lib = json.loads(library_path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        print(f"FAIL {library_path}: {e}")
        return 1
    failures = 0
    schema_errors = sorted(jsonschema.Draft202012Validator(SCHEMA).iter_errors(lib), key=lambda e: list(e.path))
    for e in schema_errors:
        print(f"FAIL schema at /{'/'.join(map(str, e.path))}: {e.message}")
    failures += len(schema_errors)
    if schema_errors:
        return failures

    base = library_path.parent
    ids = [it["id"] for it in lib["items"]]
    for dup in {i for i in ids if ids.count(i) > 1}:
        print(f"FAIL duplicate id {dup}")
        failures += 1

    for item in lib["items"]:
        dims_m = np.array([item["dims_cm"]["w"], item["dims_cm"]["h"], item["dims_cm"]["d"]]) / 100
        errs = []
        assets = item["assets"]
        for key in ["glb", "splat", "thumb"]:
            if assets.get(key) and not (base / assets[key]).is_file():
                errs.append(f"{key} asset missing: {assets[key]}")
        if not errs:
            try:
                errs += check_glb(base / assets["glb"], dims_m)
            except Exception as e:  # noqa: BLE001 - report any load failure as a check failure
                errs.append(f"GLB failed to load: {e}")
            if assets.get("splat"):
                try:
                    errs += check_splat(base / assets["splat"], dims_m)
                except Exception as e:  # noqa: BLE001
                    errs.append(f"splat failed to load: {e}")
        if item["default_render"] == "splat" and not assets.get("splat"):
            errs.append("default_render is splat but there is no splat asset")
        if errs:
            failures += 1
            print(f"FAIL {item['id']}: " + "; ".join(errs))
        else:
            print(f"ok   {item['id']}")
    print(f"{len(lib['items'])} items, {failures} failing")
    return failures


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(1 if validate(Path(sys.argv[1])) else 0)
