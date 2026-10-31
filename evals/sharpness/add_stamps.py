"""Add timestamp and exposure_duration from the capture to a prepared dataset's transforms (in place)."""
import json, sys
from pathlib import Path
cap = json.loads(Path(sys.argv[1], "transforms.json").read_text())["frames"]
for ds in sys.argv[2:]:
    for fn in ("transforms.json", "transforms_val.json"):
        p = Path(ds, "data", fn); t = json.loads(p.read_text())
        for f in t["frames"]:
            src = cap[int(Path(f["file_path"]).stem)]
            f["timestamp"] = src["timestamp"]; f["exposure_duration"] = src.get("exposure_duration", 0.01)
        p.write_text(json.dumps(t))
    print("stamped", ds)
