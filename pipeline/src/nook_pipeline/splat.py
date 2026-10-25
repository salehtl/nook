"""3DGS splat PLY normalization: rotate, center the footprint, put it on the floor, scale uniformly to height.

Positions are measured on the 1st-99th percentile (to ignore floaters), as contract §1 and
evals/validate_library.py do.
"""
from pathlib import Path

import numpy as np

from . import NookError
from .frames import quat_xyzw

# §1 self-check tolerances (same as evals/validate_library.py)
H_TOL = 0.05        # fraction
FLOOR_TOL = 0.03    # m, p1 y
CENTER_TOL = 0.05   # m, p1-p99 footprint center

_TYPES = {"float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
          "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
          "ushort": "u2", "uint16": "u2", "short": "i2", "int16": "i2",
          "uint": "u4", "uint32": "u4", "int": "i4", "int32": "i4"}
_PLY_NAMES = {"f4": "float", "f8": "double", "u1": "uchar", "i1": "char",
              "u2": "ushort", "i2": "short", "u4": "uint", "i4": "int"}
_REQUIRED = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def read_ply(path: Path) -> np.ndarray:
    """The vertex element of a binary 3DGS PLY as a structured array."""
    raw = path.read_bytes()
    marker = raw.find(b"end_header")
    if not raw.startswith(b"ply") or marker < 0:
        raise NookError(f"{path} is not a PLY file")
    end = raw.index(b"\n", marker) + 1
    lines = raw[:end].decode("ascii", "replace").splitlines()
    fmt = next((ln.split()[1] for ln in lines if ln.startswith("format ")), "")
    if fmt not in ("binary_little_endian", "binary_big_endian"):
        raise NookError(f"{path} is a {fmt or 'unknown'} PLY; only binary PLY splats are supported")
    order = "<" if fmt == "binary_little_endian" else ">"
    count, props, in_vertex = 0, [], False
    for ln in lines:
        parts = ln.split()
        if parts[:1] == ["element"]:
            if in_vertex:
                break  # the vertex element is all we need
            if parts[1] != "vertex":
                raise NookError(f"{path}: the vertex element must come first")
            in_vertex, count = True, int(parts[2])
        elif in_vertex and parts[:1] == ["property"]:
            if parts[1] == "list" or parts[1] not in _TYPES:
                raise NookError(f"{path}: unsupported PLY property '{ln.strip()}'")
            props.append((parts[2], order + _TYPES[parts[1]]))
    missing = [p for p in _REQUIRED if p not in [n for n, _ in props]]
    if missing:
        raise NookError(f"{path} isn't a 3DGS splat (missing {', '.join(missing)})")
    if count == 0:
        raise NookError(f"{path} has no splats")
    dtype = np.dtype(props)
    if len(raw) - end < count * dtype.itemsize:
        raise NookError(f"{path} is truncated")
    return np.frombuffer(raw, dtype=dtype, count=count, offset=end).copy()


def write_ply(path: Path, data: np.ndarray) -> None:
    """Write a binary little-endian PLY with one vertex element."""
    fields = [(n, data.dtype[n].str[1:]) for n in data.dtype.names]
    out = np.empty(len(data), dtype=[(n, "<" + t) for n, t in fields])
    for n, _ in fields:
        out[n] = data[n]
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(out)}\n"
    header += "".join(f"property {_PLY_NAMES[t]} {n}\n" for n, t in fields) + "end_header\n"
    path.write_bytes(header.encode("ascii") + out.tobytes())


def _xyz(data: np.ndarray) -> np.ndarray:
    return np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float64)


def _robust_bounds(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return np.percentile(xyz, 1, axis=0), np.percentile(xyz, 99, axis=0)


def _quat_wxyz(r: np.ndarray) -> np.ndarray:
    x, y, z, w = quat_xyzw(r)
    return np.array([w, x, y, z])


def _qmul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product of quaternion a (4,) with an array b (n, 4), both w-first."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b.T
    return np.stack([aw * bw - ax * bx - ay * by - az * bz,
                     aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw], axis=1)


def errors_pct(xyz: np.ndarray, dims_m: np.ndarray) -> dict:
    lo, hi = _robust_bounds(xyz)
    e = np.abs((hi - lo) - dims_m) / dims_m * 100
    return {"w": round(float(e[0]), 3), "d": round(float(e[2]), 3), "h": round(float(e[1]), 3)}


def self_check(xyz: np.ndarray, dims_m: np.ndarray) -> None:
    lo, hi = _robust_bounds(xyz)
    h, target = hi[1] - lo[1], dims_m[1]
    if abs(h - target) / target > H_TOL:
        raise NookError(f"self-check failed: splat height (p1-p99) is {h * 100:.1f} cm, expected "
                        f"{target * 100:.1f} cm ({abs(h - target) / target:.1%} off, max {H_TOL:.0%})")
    if abs(lo[1]) > FLOOR_TOL:
        raise NookError(f"self-check failed: splat floor (p1 y) is {lo[1]:.3f} m, max {FLOOR_TOL * 100:.0f} cm from 0")
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    if abs(cx) > CENTER_TOL or abs(cz) > CENTER_TOL:
        raise NookError(f"self-check failed: splat footprint center is ({cx:.3f}, {cz:.3f}) m, "
                        f"max {CENTER_TOL * 100:.0f} cm from the origin")


def normalize(src: Path, rotation: np.ndarray, dims_m: np.ndarray, out: Path) -> tuple[dict, list[str]]:
    """Write `out` in the item frame, uniformly scaled so the p1-p99 height equals dims_m[1] (dims_m is w, h, d).

    Returns (per-axis fit error in percent, notes). Raises NookError if the written file fails the §1 checks.
    """
    data = read_ply(src)
    notes = []
    xyz = _xyz(data) @ rotation.T
    if not np.allclose(rotation, np.eye(3)):
        if all(n in data.dtype.names for n in ("nx", "ny", "nz")):
            nrm = np.stack([data["nx"], data["ny"], data["nz"]], axis=1).astype(np.float64) @ rotation.T
            data["nx"], data["ny"], data["nz"] = nrm.T
        q = np.stack([data[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float64)
        q = _qmul(_quat_wxyz(rotation), q)
        for i in range(4):
            data[f"rot_{i}"] = q[:, i]
        rest = [n for n in data.dtype.names if n.startswith("f_rest_")]
        if rest:
            # Rotating higher-order SH bands isn't implemented: drop them (contract §1 allows it).
            keep = [n for n in data.dtype.names if n not in rest]
            packed = np.empty(len(data), dtype=[(n, data.dtype[n]) for n in keep])
            for n in keep:
                packed[n] = data[n]
            data = packed
            notes.append(f"dropped {len(rest)} f_rest_* SH coefficients (view-dependent color) after rotating")

    lo, hi = _robust_bounds(xyz)
    height = hi[1] - lo[1]
    if height < 1e-6:
        raise NookError("the splat has no height (p1-p99), so it can't be scaled to --dims")
    s = dims_m[1] / height
    center = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    xyz = (xyz - center) * s
    data["x"], data["y"], data["z"] = xyz.T
    for i in range(3):
        data[f"scale_{i}"] = data[f"scale_{i}"] + np.log(s)  # scales are stored as log(sigma)
    write_ply(out, data)

    written = _xyz(read_ply(out))
    self_check(written, dims_m)
    return errors_pct(written, dims_m), notes
