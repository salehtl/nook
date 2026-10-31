"""Write a copy of a capture zip with refined poses and seed points rebuilt at them, under a new folder name, so that any
trainer that reads captures uses them. Frames with no refined pose, or that moved past the pipeline's outlier guard, are
left out. refined_capture.py CAPTURE_DIR REFINED_DS OUT.zip NEW_NAME"""
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
refined = {}
for f in R:
    i = int(Path(f["file_path"]).stem)
    a0, b0 = np.array(T["frames"][i]["transform_matrix"]), np.array(f["transform_matrix"])
    deg = np.degrees(np.arccos(np.clip((np.trace(a0[:3, :3].T @ b0[:3, :3]) - 1) / 2, -1, 1)))
    if np.linalg.norm(a0[:3, 3] - b0[:3, 3]) > 1.0 or deg > 15:  # the pipeline's outlier guard
        print("dropped outlier", i, round(float(deg), 1), file=sys.stderr)
        continue
    refined[i] = f["transform_matrix"]
    T["frames"][i]["transform_matrix"] = f["transform_matrix"]
    cap.frames[i]["transform_matrix"] = f["transform_matrix"]
cap.transforms.pop("ply_file_path", None)
xyz, rgb, source = dataset.seed_points(cap, frames=sorted(refined))
# frames with no refined pose (the harness's guard frames) would disagree with the others: drop them
T["frames"] = [f for i, f in enumerate(T["frames"]) if i in refined]
keep = {f["file_path"] for f in T["frames"]} | {f.get("depth_file_path") for f in T["frames"]} | {f.get("hires_file_path") for f in T["frames"]}
meta = json.loads((cap_dir / "meta.json").read_text()) | {"frame_count": len(T["frames"])}
tmp = Path(out).with_suffix(".points.ply")
ply.write_points(tmp, xyz, rgb)
T["ply_file_path"] = "points.ply"
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for p in sorted(cap_dir.rglob("*")):
        rel = p.relative_to(cap_dir).as_posix()
        if p.is_file() and rel not in ("transforms.json", "points.ply", "meta.json") and (rel.count("/") == 0 or rel in keep):
            z.write(p, f"{name}/{rel}")
    z.writestr(f"{name}/transforms.json", json.dumps(T))
    z.writestr(f"{name}/meta.json", json.dumps(meta))
    z.write(tmp, f"{name}/points.ply")
tmp.unlink()
print(json.dumps({"out": out, "seeds": len(xyz), "source": source, "frames": len(T["frames"]), "bytes": os.path.getsize(out)}))
