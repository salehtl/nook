"""Prepare the fixed dataset for the scoreboard: production dataset.prepare, but held-out frames are whole stretches of
the walk, because a frame's neighbours are only about 4 cm away. Each stretch is scored; a few guard frames at each of
its ends are left out of training and not scored. The choice depends only on the frame count, so it never changes.

prep2.py CAPTURE_DIR OUT_DIR [--stretches 8] [--length 12] [--guard 3] [--seeds shipped|auto]
  shipped: seeds as the deployed trainer reads them (points.ply); auto: dataset.seed_points as it is now"""
import argparse, inspect, json, shutil, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(__import__("os").environ.get("NOOK_SCAN_SRC", str(Path(__file__).resolve().parents[2] / "scan/src"))))
from nook_scan import capture, dataset, ply

p = argparse.ArgumentParser()
p.add_argument("cap"); p.add_argument("out")
p.add_argument("--stretches", type=int, default=8)
p.add_argument("--length", type=int, default=12)
p.add_argument("--guard", type=int, default=3)
p.add_argument("--seeds", default="shipped", choices=["shipped", "auto"])
a = p.parse_args()
out = Path(a.out)
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
cap = capture.load(capture.open_capture(a.cap, out))
n = len(cap.frames)
starts = [round((k + 0.5) * n / a.stretches - a.length / 2) for k in range(a.stretches)]
scored = {i: k for k, s in enumerate(starts) for i in range(s, s + a.length)}
left_out = {i for s in starts for i in range(s - a.guard, s + a.length + a.guard)}
train = [i for i in range(n) if i not in left_out]
dataset.is_held_out = lambda i, _every: i in left_out  # prepare asks this per frame
if a.seeds == "shipped":
    xyz, rgb = ply.read_points(cap.root / cap.transforms["ply_file_path"])
    rgb = rgb if rgb is not None else np.full((len(xyz), 3), 128, np.uint8)
    seeds = (xyz, rgb, "points.ply")
elif "frames" in inspect.signature(dataset.seed_points).parameters:
    seeds = dataset.seed_points(cap, frames=train)
else:
    sys.exit("--seeds auto needs the rebuilt seed_points")
far, far_rgb = dataset.far_points(cap, train, 10.0)
if len(far):
    seeds = (np.concatenate([seeds[0], far]), np.concatenate([seeds[1], far_rgb]), seeds[2])
prep = dataset.prepare(cap, out, 1, 1920, seeds=seeds)
val = json.loads((out / "data/transforms_val.json").read_text())
val["frames"] = [f | {"stretch": scored[int(Path(f["file_path"]).stem)]} for f in val["frames"]
                 if int(Path(f["file_path"]).stem) in scored]
(out / "data/transforms_val.json").write_text(json.dumps(val))
print(json.dumps({"train": prep.n_train, "scored": len(val["frames"]), "guard": prep.n_eval - len(val["frames"]),
                  "stills": prep.stills, "seeds": len(prep.seeds), "source": seeds[2], "starts": starts}))
