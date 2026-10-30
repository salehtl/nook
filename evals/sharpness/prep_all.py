"""Prepare a dataset that trains on every frame (for a delivered room), with an empty held-out list.
prep_all.py CAPTURE_DIR OUT_DIR"""
import json, os, shutil, sys
from pathlib import Path
sys.path.insert(0, os.environ.get("NOOK_SCAN_SRC", str(Path(__file__).resolve().parents[2] / "scan/src")))
from nook_scan import capture, dataset

cap_dir, out = sys.argv[1:3]
out = Path(out)
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
cap = capture.load(capture.open_capture(cap_dir, out))
prep = dataset.prepare(cap, out, 0, 1920)
t = json.loads((out / "data/transforms.json").read_text())
(out / "data/transforms_val.json").write_text(json.dumps(t | {"frames": []}))
print(json.dumps({"train": prep.n_train, "stills": prep.stills, "seeds": len(prep.seeds), "source": prep.seed_source}))
