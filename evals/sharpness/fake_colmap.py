#!/usr/bin/env python3
"""Stand-in for the COLMAP commands nook_scan.colmap runs, for scan_checks.py: no features, no solving. Each bundle
adjustment moves the whole world by a similarity and each camera by up to 2 cm, as a real one does.

FAKE_COLMAP_OUTLIER=<image name>: that camera also moves 6 m and turns 50 degrees.
FAKE_COLMAP_BREAK=1: half of the cameras do that, and more.
FAKE_COLMAP_DROP=<image name>: that camera is not in the result.
FAKE_COLMAP_FAIL=<command>: that command fails.
FAKE_COLMAP_HANG=<file>: feature_extractor writes its pid there and sleeps."""
import math
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scan" / "src"))
from nook_scan.colmap import matrix_from_quat, quat_from_matrix  # noqa: E402


def turn(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def feature_extractor(a: dict) -> None:
    if os.environ.get("FAKE_COLMAP_HANG"):
        Path(os.environ["FAKE_COLMAP_HANG"]).write_text(str(os.getpid()))
        time.sleep(600)
    con = sqlite3.connect(a["database_path"])
    con.execute("create table cameras (camera_id integer primary key, model, width, height, params, prior_focal_length)")
    con.execute("create table images (image_id integer primary key, name, camera_id)")
    for i, n in enumerate(Path(a["image_list_path"]).read_text().split(), 1):
        if not (Path(a["image_path"]) / n).is_file():
            sys.exit(f"E20261031 00:00:00.000 1 fake.cc:1] no image {n}")
        con.execute("insert into cameras values (?, 0, 0, 0, x'', 0)", (i,))
        con.execute("insert into images values (?, ?, ?)", (i, n, i))
    con.commit()


def bundle_adjuster(a: dict) -> None:
    src, dst = Path(a["input_path"]), Path(a["output_path"])
    shutil.copytree(src, dst, dirs_exist_ok=True)
    rng = np.random.default_rng(0)
    out, R, s, t = [], turn(5.0), 1.02, np.array([0.3, -0.2, 0.1])
    lines = (src / "images.txt").read_text().splitlines()
    for k, l in enumerate(lines[::2]):
        f = l.split()
        w, x, y, z, tx, ty, tz = map(float, f[1:8])
        Rcw, tcw = matrix_from_quat(w, x, y, z), np.array([tx, ty, tz])
        C = -Rcw.T @ tcw + rng.uniform(-0.02 / math.sqrt(3), 0.02 / math.sqrt(3), 3)
        Rwc = Rcw.T
        if f[9] == os.environ.get("FAKE_COLMAP_OUTLIER") or (os.environ.get("FAKE_COLMAP_BREAK") and k % 3):
            C, Rwc = C + [6.0, 0, 0], turn(50.0) @ Rwc
        if f[9] == os.environ.get("FAKE_COLMAP_DROP"):
            continue
        Rwc, C = R @ Rwc, s * R @ C + t
        q = quat_from_matrix(Rwc.T)
        c = -Rwc.T @ C
        out.append(f"{f[0]} {q[0]} {q[1]} {q[2]} {q[3]} {c[0]} {c[1]} {c[2]} {f[8]} {f[9]}\n\n")
    (dst / "images.txt").write_text("".join(out))
    print("I20261031 00:00:00.000 1 fake.cc:1]   Final cost : 0.5 [px]", file=sys.stderr)


def main() -> None:
    cmd = sys.argv[1]
    a = {k.lstrip("-"): v for k, v in zip(sys.argv[2::2], sys.argv[3::2])}
    if cmd == os.environ.get("FAKE_COLMAP_FAIL"):
        print("I20261031 00:00:00.000 1 fake.cc:1] working", file=sys.stderr)
        print("E20261031 00:00:00.000 1 fake.cc:1] fake failure", file=sys.stderr)
        sys.exit(3)
    if cmd == "feature_extractor":
        feature_extractor(a)
    elif cmd == "point_triangulator":
        shutil.copytree(a["input_path"], a["output_path"], dirs_exist_ok=True)
    elif cmd == "bundle_adjuster":
        bundle_adjuster(a)
    elif cmd != "matches_importer" and cmd != "model_converter":
        sys.exit(f"fake_colmap: unknown command {cmd}")


main()
