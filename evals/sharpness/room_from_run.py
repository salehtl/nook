"""Make a planner room from a trained run, so a run can be seen in a local planner. Crops as the pipeline does, prunes, writes
<name>.spz, .ply and .room.json in ROOM_DIR, copying another room's config. room_from_run.py SPLAT.ply DATA_DIR ROOM_DIR NAME BASE_ROOM TITLE"""
import json, os, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, os.environ.get("NOOK_SCAN_SRC", str(Path(__file__).resolve().parents[2] / "scan/src")))
from nook_scan import post, ply, spz, gpu

splat, data, rooms, name, base, title = sys.argv[1:7]
rooms = Path(rooms)
T = json.loads((Path(data) / "transforms.json").read_text())["frames"]
cams = np.array([np.array(f["transform_matrix"])[:3, 3] for f in T])
seeds, _ = ply.read_points(Path(data) / "points.ply")
lo, hi = np.percentile(cams, 0, axis=0) - 8, np.percentile(cams, 100, axis=0) + 8  # the window seeds sit 10 m out
seeds = seeds[np.all((seeds > lo) & (seeds < hi), axis=1)]
full, stats = post.crop(Path(splat), seeds, cams)
v = post.prune(full, gpu.DELIVER_MAX_SPLATS)
ply.write_splats(rooms / f"{name}.ply", v)
spz.write_spz(rooms / f"{name}.spz", v)
c = json.loads((rooms / f"{base}.room.json").read_text())
c["splat"] = c["splat"].replace(base, name)
c["title"] = title
(rooms / f"{name}.room.json").write_text(json.dumps(c, indent=2))
print(json.dumps({"name": name, "delivered": len(v), "kept": stats["kept"], "outside": stats["outside"], "transparent": stats["transparent"], "spz_mb": os.path.getsize(rooms / f"{name}.spz") // 2**20}))
