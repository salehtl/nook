"""Prepare a production-identical dataset (nook_scan.dataset) and keep it. Usage:
prep.py CAPTURE_DIR OUT_DIR [--holdout 10] [--max-image-size 1920] [--stills-max-size N] [--no-stills]"""
import argparse, json, shutil, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path.home() / "nook-exp/src/scan/src"))
from nook_scan import capture, dataset

p = argparse.ArgumentParser()
p.add_argument("cap"); p.add_argument("out")
p.add_argument("--holdout", type=int, default=10)
p.add_argument("--max-image-size", type=int, default=1920)
p.add_argument("--stills-max-size", type=int)
p.add_argument("--no-stills", action="store_true")
a = p.parse_args()
out = Path(a.out)
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
cap = capture.load(capture.open_capture(a.cap, out))
if a.no_stills:
    for f in cap.frames:
        f.pop("hires_file_path", None)
seeds = dataset.seed_points(cap)
train = [i for i in range(len(cap.frames)) if not dataset.is_held_out(i, a.holdout)]
far, far_rgb = dataset.far_points(cap, train, 10.0)
if len(far):
    seeds = (np.concatenate([seeds[0], far]), np.concatenate([seeds[1], far_rgb]), seeds[2])
prep = dataset.prepare(cap, out, a.holdout, a.max_image_size, seeds=seeds, stills_max_size=a.stills_max_size)
print(json.dumps({"train": prep.n_train, "held": prep.n_eval, "stills": prep.stills, "seeds": len(prep.seeds)}))
