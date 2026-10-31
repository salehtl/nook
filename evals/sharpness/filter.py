"""Derive a dataset from a prepared one by dropping training frames. Images are symlinked; transforms_val.json is kept.
filter.py SRC_DIR DST_DIR BLUR_JSON [--drop-pass3] [--min-rel R] [--max-blur-px P] [--near-still K]
--near-still K drops video frames within K frames of a still along the walk, keeping every still."""
import argparse, json, math, os, shutil
from pathlib import Path
import numpy as np
p = argparse.ArgumentParser()
p.add_argument("src"); p.add_argument("dst"); p.add_argument("blur")
p.add_argument("--drop-pass3", action="store_true")
p.add_argument("--min-rel", type=float, default=0)
p.add_argument("--max-blur-px", type=float, default=1e9)
p.add_argument("--near-still", type=int, default=0)
a = p.parse_args()
src, dst = Path(a.src) / "data", Path(a.dst) / "data"
if dst.parent.exists():
    shutil.rmtree(dst.parent)
(dst / "images").mkdir(parents=True)
blur = {r["i"]: r for r in json.loads(Path(a.blur).read_text())}
keys = sorted(blur); lv = np.array([blur[i]["lap_video"] for i in keys])
rel = {i: blur[i]["lap_video"] / np.median(lv[max(0, k - 7):k + 8]) for k, i in enumerate(keys)}
t = json.loads((src / "transforms.json").read_text())
keep = []
stills = {int(Path(f["file_path"]).stem) for f in t["frames"] if f.get("still")}
for f in t["frames"]:
    i = int(Path(f["file_path"]).stem); b = blur[i]
    if a.near_still and not f.get("still") and any(i + d in stills for d in range(-a.near_still, a.near_still + 1)):
        continue
    bpx = math.radians(b["deg_s"]) * 1360 * 0.01
    if (a.drop_pass3 and b["pass"] == 3) or rel[i] < a.min_rel or bpx > a.max_blur_px:
        continue
    keep.append(f)
for f in os.listdir(src / "images"):
    os.symlink((src / "images" / f).resolve(), dst / "images" / f)
for f in ("points.ply", "transforms_val.json"):
    shutil.copy(src / f, dst / f)
t["frames"] = keep
(dst / "transforms.json").write_text(json.dumps(t))
print(f"kept {len(keep)} of {len(json.loads((src / 'transforms.json').read_text())['frames'])} training frames")
