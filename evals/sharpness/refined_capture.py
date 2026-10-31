"""Write a copy of a capture zip with refined poses and seed points rebuilt at them, under a new folder name, so that any
trainer that reads captures uses them. refined_capture.py CAPTURE_DIR REFINED_DS OUT.zip NEW_NAME"""
import json, os, sys, zipfile
from pathlib import Path
import numpy as np
sys.path.insert(0, os.environ.get("NOOK_SCAN_SRC", str(Path(__file__).resolve().parents[2] / "scan/src")))
from nook_scan import capture, dataset, ply

cap_dir, ds, out, name = sys.argv[1:5]
cap_dir, ds = Path(cap_dir), Path(ds) / "data"
cap = capture.load(capture.open_capture(str(cap_dir), Path(out).parent))
T = json.loads((cap_dir / "transforms.json").read_text())
R = json.loads((ds / "transforms.json").read_text())["frames"] + json.loads((ds / "transforms_val.json").read_text())["frames"]
for f in R:
    i = int(Path(f["file_path"]).stem)
    T["frames"][i]["transform_matrix"] = f["transform_matrix"]
    cap.frames[i]["transform_matrix"] = f["transform_matrix"]
cap.transforms.pop("ply_file_path", None)
xyz, rgb, source = dataset.seed_points(cap, frames=list(range(len(cap.frames))))
tmp = Path(out).with_suffix(".points.ply")
ply.write_points(tmp, xyz, rgb)
T["ply_file_path"] = "points.ply"
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for p in sorted(cap_dir.rglob("*")):
        rel = p.relative_to(cap_dir).as_posix()
        if p.is_file() and rel not in ("transforms.json", "points.ply"):
            z.write(p, f"{name}/{rel}")
    z.writestr(f"{name}/transforms.json", json.dumps(T))
    z.write(tmp, f"{name}/points.ply")
tmp.unlink()
print(json.dumps({"out": out, "seeds": len(xyz), "source": source, "frames": len(T["frames"]), "bytes": os.path.getsize(out)}))
