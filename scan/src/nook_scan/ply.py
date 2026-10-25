"""Minimal PLY I/O: seed point clouds (x y z + uchar rgb, binary or ascii) and 3DGS splat files."""

from pathlib import Path

import numpy as np

from . import ScanError

_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
    "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
}

# Standard 3DGS PLY property order (contract §1), f_rest_* inserted when present.
SH_REST = [f"f_rest_{i}" for i in range(45)]


def read_vertices(path: Path) -> np.ndarray:
    """Read the `vertex` element of a PLY as a structured array. Other elements must come after it."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        raise ScanError(f"cannot read {path}: {e.strerror}")
    end = raw.find(b"end_header")
    if not raw.startswith(b"ply") or end < 0:
        raise ScanError(f"{path.name} is not a PLY file")
    nl = raw.index(b"\n", end) + 1
    header = raw[:nl].decode("ascii", "replace").splitlines()
    fmt, count, props, in_vertex, seen_vertex = None, 0, [], False, False
    for line in header:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                count, seen_vertex = int(parts[2]), True
            elif not seen_vertex:
                raise ScanError(f"{path.name}: unsupported PLY layout (vertex must be the first element)")
        elif parts[0] == "property" and in_vertex:
            if parts[1] == "list":
                raise ScanError(f"{path.name}: unsupported PLY (list property in vertex)")
            if parts[1] not in _TYPES:
                raise ScanError(f"{path.name}: unsupported PLY property type {parts[1]}")
            props.append((parts[2], _TYPES[parts[1]]))
    if not seen_vertex or not props:
        raise ScanError(f"{path.name}: PLY has no vertex element")
    if fmt == "binary_little_endian":
        dt = np.dtype([(n, "<" + t) for n, t in props])
    elif fmt == "binary_big_endian":
        dt = np.dtype([(n, ">" + t) for n, t in props])
    elif fmt == "ascii":
        dt = np.dtype([(n, t) for n, t in props])
        try:
            rows = np.loadtxt(raw[nl:].decode("ascii").splitlines()[:count], ndmin=2)
        except ValueError:
            raise ScanError(f"{path.name}: malformed ascii PLY")
        if rows.shape[0] != count or rows.shape[1] < len(props):
            raise ScanError(f"{path.name}: ascii PLY has fewer rows than its header says")
        out = np.zeros(count, dt)
        for i, (n, _) in enumerate(props):
            out[n] = rows[:, i]
        return out
    else:
        raise ScanError(f"{path.name}: unknown PLY format {fmt}")
    if len(raw) - nl < count * dt.itemsize:
        raise ScanError(f"{path.name}: PLY is truncated")
    return np.frombuffer(raw, dtype=dt, count=count, offset=nl).copy()


def read_points(path: Path) -> tuple[np.ndarray, np.ndarray | None]:
    """Seed points: (N,3) float positions and (N,3) uint8 colors (or None)."""
    v = read_vertices(path)
    names = v.dtype.names
    if not {"x", "y", "z"} <= set(names):
        raise ScanError(f"{path.name}: PLY has no x/y/z")
    xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)
    rgb = None
    for keys in (("red", "green", "blue"), ("r", "g", "b")):
        if set(keys) <= set(names):
            c = np.stack([v[k] for k in keys], 1)
            rgb = (np.clip(c, 0, 1) * 255 if c.dtype.kind == "f" else np.clip(c, 0, 255)).astype(np.uint8)
            break
    ok = np.isfinite(xyz).all(1)
    return xyz[ok], (rgb[ok] if rgb is not None else None)


def write_points(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    n = len(xyz)
    d = np.zeros(n, [("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")])
    d["x"], d["y"], d["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    d["red"], d["green"], d["blue"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    head = ("ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
            + "".join(f"property float {k}\n" for k in "xyz")
            + "".join(f"property uchar {k}\n" for k in ("red", "green", "blue")) + "end_header\n")
    Path(path).write_bytes(head.encode() + d.tobytes())


def splat_columns(names) -> list[str]:
    rest = [k for k in SH_REST if k in names]
    return ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", *rest, "opacity",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def write_splats(path: Path, v: np.ndarray) -> None:
    """Write a standard 3DGS PLY (binary little endian, float32, Inria property order)."""
    cols = splat_columns(v.dtype.names)
    out = np.zeros(len(v), [(c, "<f4") for c in cols])
    for c in cols:
        out[c] = v[c]
    head = ("ply\nformat binary_little_endian 1.0\ncomment nook-scan room splat, capture world coordinates (Y up, meters)\n"
            f"element vertex {len(v)}\n" + "".join(f"property float {c}\n" for c in cols) + "end_header\n")
    Path(path).write_bytes(head.encode() + out.tobytes())
