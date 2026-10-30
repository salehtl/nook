"""Choose the fixed novel views a harness renders for humans: seated (1.15 m above the floor) and standing (1.6 m).
Positions come from the training camera path (even steps along it, dropped to the height), looking level along the
camera's yaw. Run it once per dataset and keep the file, so that every run is seen from the same places.

make_views.py DATA_DIR OUT.json --floor-y Y [--count 8] [--fov 60] [--width 1920] [--height 1440]

Each view: {"name", "transform_matrix" (OpenGL c2w: +X right, +Y up, -Z forward), "fov_x_deg", "w", "h"}."""
import argparse, json
from pathlib import Path
import numpy as np

HEIGHTS = {"seated": 1.15, "standing": 1.6}
MIN_LEVEL = 0.3  # the forward vector's horizontal length below which a camera looks too steeply to have a usable yaw


def camera_path(data):
    """The training cameras' 4x4 c2w matrices in capture order, without stills (they are off the walking path)."""
    data = Path(data)
    name = "transforms.json" if (data / "transforms.json").exists() else "transforms_val.json"
    frames = [f for f in json.loads((data / name).read_text())["frames"] if not f.get("still")]
    if not frames:
        raise SystemExit(f"make_views: no frames in {data / name}")
    frames.sort(key=lambda f: (f.get("timestamp") is None, f.get("timestamp") or 0, f["file_path"]))
    return np.array([f["transform_matrix"] for f in frames], dtype=float)


def level_c2w(position, forward):
    f = np.array([forward[0], 0.0, forward[2]])
    f /= np.linalg.norm(f)
    up = np.array([0.0, 1.0, 0.0])
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = np.cross(f, up), up, -f, position
    return m


def make_views(data, floor_y, count=8, fov=60.0, w=1920, h=1440):
    path = camera_path(data)
    pos = path[:, :3, 3]
    along = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pos[:, [0, 2]], axis=0), axis=1))])
    views = []
    for k in range(count):
        i = int(np.searchsorted(along, along[-1] * (k + 0.5) / count))
        i = min(i, len(path) - 1)
        # A camera looking at the floor or ceiling has no yaw to speak of: take the next one along the path that has.
        for j in list(range(i, len(path))) + list(range(i - 1, -1, -1)):
            forward = -path[j, :3, 2]
            if np.hypot(forward[0], forward[2]) >= MIN_LEVEL:
                break
        else:
            raise SystemExit("make_views: no camera in the path looks anywhere near level")
        for label, height in HEIGHTS.items():
            p = np.array([pos[i, 0], floor_y + height, pos[i, 2]])
            views.append({"name": f"{label}-{k:02d}", "transform_matrix": np.round(level_c2w(p, forward), 6).tolist(),
                          "fov_x_deg": fov, "w": w, "h": h})
    return views


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("data"); p.add_argument("out")
    p.add_argument("--floor-y", type=float, required=True)
    p.add_argument("--count", type=int, default=8, help="views at each height")
    p.add_argument("--fov", type=float, default=60.0, help="horizontal field of view, degrees")
    p.add_argument("--width", type=int, default=1920); p.add_argument("--height", type=int, default=1440)
    a = p.parse_args()
    views = make_views(a.data, a.floor_y, a.count, a.fov, a.width, a.height)
    Path(a.out).write_text(json.dumps({"floor_y": a.floor_y, "views": views}, indent=1) + "\n")
    print(json.dumps({"views": len(views), "out": a.out}))
