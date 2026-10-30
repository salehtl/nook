"""Derive a dataset whose seed points come from the depth maps at another dataset's refined poses, so that seeds and
cameras agree. Images and transforms stay the refined dataset's.
reseed.py CAPTURE_DIR REFINED_DS DST_DS"""
import json, os, shutil, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, os.environ.get("NOOK_SCAN_SRC", str(Path(__file__).resolve().parents[2] / "scan/src")))
from nook_scan import capture, dataset, ply

cap_dir, src, dst = sys.argv[1:4]
src, dst = Path(src) / "data", Path(dst) / "data"
if dst.parent.exists():
    shutil.rmtree(dst.parent)
dst.mkdir(parents=True)
cap = capture.load(capture.open_capture(cap_dir, dst.parent))
T = json.loads((src / "transforms.json").read_text())
V = json.loads((src / "transforms_val.json").read_text())
train = []
for f in T["frames"] + V["frames"]:
    cap.frames[int(Path(f["file_path"]).stem)]["transform_matrix"] = f["transform_matrix"]
for f in T["frames"]:
    train.append(int(Path(f["file_path"]).stem))
cap.transforms.pop("ply_file_path", None)  # points.ply is at the old poses: always rebuild from depth at the refined ones
xyz, rgb, source = dataset.seed_points(cap, frames=train)
far, far_rgb = dataset.far_points(cap, train, 10.0)
xyz, rgb = np.concatenate([xyz, far]), np.concatenate([rgb, far_rgb])
ply.write_points(dst / "points.ply", xyz, rgb)
os.symlink((src / "images").resolve(), dst / "images")
for n in ("transforms.json", "transforms_val.json"):
    shutil.copy(src / n, dst / n)
print(json.dumps({"seeds": len(xyz), "source": source, "train": len(train)}))
