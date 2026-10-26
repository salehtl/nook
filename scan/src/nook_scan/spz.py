"""Write Niantic's compact SPZ splat format (github.com/nianticlabs/spz, MIT), which Spark loads directly.

A room PLY of ~1.5M splats is hundreds of MB; SPZ quantizes each splat to ~20 bytes (plus SH) and gzips the lot,
so the planner (and a phone over the tailnet) loads a fraction of it. Version 2 of the format: the widely supported
one (3-byte rotations); the reference encoder's quantization, verbatim in spirit:

  positions  24-bit signed fixed point, 12 fractional bits (~0.25 mm), little-endian
  alphas     sigmoid(opacity) * 255
  colors     f_dc * (0.15 * 255) + 127.5
  scales     (log scale + 10) * 16
  rotations  quaternion (x, y, z, w) normalised, w made positive, x/y/z * 127.5 + 127.5
  sh         per splat, coefficient-major with RGB interleaved; round(x * 128) + 128, snapped to 2^(8-bits)
             buckets: 5 bits for degree 1, 4 bits for higher degrees
"""
import gzip
import struct
from pathlib import Path

import numpy as np

MAGIC = 0x5053474E
VERSION = 2
FRACTIONAL_BITS = 12
COLOR_SCALE = 0.15
SH_DIMS = {0: 0, 1: 3, 2: 8, 3: 15}


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def _sh_bucket(x: np.ndarray, bits: int) -> np.ndarray:
    q = np.round(x * 128.0) + 128.0
    bucket = 1 << (8 - bits)
    q = np.floor((q + bucket // 2) / bucket) * bucket
    return np.clip(q, 0, 255).astype(np.uint8)


def write_spz(path: Path, v: np.ndarray) -> None:
    """Write splats `v` (a structured array with the 3DGS PLY fields, contract §1) as SPZ v2."""
    n = len(v)
    rest = sorted((f for f in v.dtype.names if f.startswith("f_rest_")), key=lambda f: int(f[7:]))
    dim = len(rest) // 3
    degree = next((d for d, k in SH_DIMS.items() if k == dim), None)
    if degree is None:
        raise ValueError(f"{len(rest)} f_rest coefficients is not a whole SH degree")

    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float64)
    fixed = np.round(xyz * (1 << FRACTIONAL_BITS)).astype(np.int64)
    if np.abs(fixed).max(initial=0) >= 1 << 23:
        raise ValueError("splat positions exceed SPZ's ±2048 m range")
    fixed &= 0xFFFFFF
    positions = np.stack([fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=2).astype(np.uint8)

    alphas = _u8(255.0 / (1.0 + np.exp(-v["opacity"].astype(np.float64))))
    dc = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1).astype(np.float64)
    colors = _u8(dc * (COLOR_SCALE * 255.0) + 0.5 * 255.0)
    scales = _u8((np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=1).astype(np.float64) + 10.0) * 16.0)

    # PLY stores (w, x, y, z) as rot_0..rot_3; SPZ works in (x, y, z, w).
    q = np.stack([v["rot_1"], v["rot_2"], v["rot_3"], v["rot_0"]], axis=1).astype(np.float64)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    q *= np.where(q[:, 3:4] < 0, -127.5, 127.5)
    rotations = _u8(q[:, :3] + 127.5)

    parts = [positions.reshape(n, 9), alphas.reshape(n, 1), colors, scales, rotations]
    if dim:
        # PLY f_rest is channel-major (all R coefficients, then G, then B); SPZ wants coefficient-major RGB.
        sh = np.stack([v[f] for f in rest], axis=1).astype(np.float64).reshape(n, 3, dim).transpose(0, 2, 1)
        packed = np.empty((n, dim, 3), np.uint8)
        packed[:, :3] = _sh_bucket(sh[:, :3], 5)
        if dim > 3:
            packed[:, 3:] = _sh_bucket(sh[:, 3:], 4)
        parts.append(packed.reshape(n, dim * 3))

    header = struct.pack("<IIIBBBB", MAGIC, VERSION, n, degree, FRACTIONAL_BITS, 0, 0)
    # Arrays are stored attribute by attribute (all positions, then all alphas, ...), not per splat.
    body = b"".join(p.tobytes() for p in parts)
    path.write_bytes(gzip.compress(header + body, compresslevel=9))
