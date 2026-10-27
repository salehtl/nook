#!/usr/bin/env python3
"""Stand-in for nook-gsplat (same CLI and output shape) so the jobs-server eval runs without a GPU.

    fake_gsplat.py DATA_DIR --out OUT.ply [--steps N] [--max-splats N] [--max-image-size N] [--sh-degree D]

Writes the dataset's seed points as a valid 3DGS PLY (capture world coordinates, like the real trainer), printing
`step X/Y  splats Nk ...` progress lines over FAKE_GSPLAT_SECONDS (default 1.5). Fails like the real one when
FAKE_GSPLAT_FAIL is set. Stdlib + numpy only.
"""
import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np

SH_DIMS = {0: 0, 1: 3, 2: 8, 3: 15}


def read_points(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    head = raw[:end].decode("ascii").splitlines()
    n = int(next(l for l in head if l.startswith("element vertex")).split()[2])
    types = {"float": "<f4", "uchar": "u1", "double": "<f8"}
    props = [(l.split()[2], types[l.split()[1]]) for l in head if l.startswith("property ")]
    return np.frombuffer(raw, dtype=np.dtype(props), count=n, offset=end)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("data")
    p.add_argument("--out", required=True)
    p.add_argument("--steps", type=int, default=20000)
    p.add_argument("--max-splats", type=int, default=1_200_000)
    p.add_argument("--max-image-size", type=int, default=1920)
    p.add_argument("--sh-degree", type=int, default=1)
    p.add_argument("--stills-max-size", type=int)   # v4 (§4.9.1): accepted, ignored
    p.add_argument("--pose-opt", action="store_true")
    a = p.parse_args()
    if os.environ.get("FAKE_GSPLAT_FAIL"):
        print("nook-gsplat: simulated failure", file=sys.stderr)
        sys.exit(1)
    seconds = float(os.environ.get("FAKE_GSPLAT_SECONDS", "1.5"))
    for i in range(1, 11):
        time.sleep(seconds / 10)
        print(f"step {a.steps * i // 10}/{a.steps}  splats 12k  loss 0.0500  (fake)", file=sys.stderr, flush=True)

    pts = read_points(Path(a.data) / "points.ply")[: a.max_splats]
    n, rest = len(pts), 3 * SH_DIMS[a.sh_degree]
    fields = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", *[f"f_rest_{k}" for k in range(rest)],
              "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    v = np.zeros((n, len(fields)), "<f4")
    v[:, 0], v[:, 1], v[:, 2] = pts["x"], pts["y"], pts["z"]
    for k, c in enumerate(("red", "green", "blue")):
        v[:, 6 + k] = (pts[c] / 255.0 - 0.5) / 0.28209479177387814 if c in pts.dtype.names else 0
    o = 9 + rest
    v[:, o] = 3.0                      # opacity logit
    v[:, o + 1:o + 4] = np.log(0.01)   # log scales
    v[:, o + 4] = 1.0                  # identity rotation (w first)
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n" + "".join(f"property float {f}\n" for f in fields) + "end_header\n"
    Path(a.out).write_bytes(header.encode() + v.tobytes())
    print('{"fake": true}')


if __name__ == "__main__":
    main()
