"""Builds the hand-made fixtures in fixtures/ from fixtures/models/ plus generated shapes.

Run from the repo root:
  uv run --no-project --python 3.12 --with trimesh --with numpy --with pygltflib python -I fixtures/make_fixtures.py
"""
import json
from pathlib import Path

import numpy as np
import pygltflib
import trimesh

FIX = Path(__file__).resolve().parent
MODELS = FIX / "models"
LIB = FIX / "library"
BROKEN = FIX / "library-broken"
ROOM = FIX / "room"
CREATED = "2026-10-25T00:00:00Z"


def wrap_glb_normalized(src: Path, dst: Path) -> dict:
    """Put the model in the item frame by wrapping the scene roots in one transform node.

    Keeps the native size (scale 1) so materials and extensions are untouched. Returns dims_cm.
    """
    bounds = trimesh.load(src, force="scene").bounds
    (x0, y0, z0), (x1, y1, z1) = bounds
    tx, ty, tz = -(x0 + x1) / 2, -y0, -(z0 + z1) / 2
    gltf = pygltflib.GLTF2().load(str(src))
    scene = gltf.scenes[gltf.scene or 0]
    gltf.nodes.append(pygltflib.Node(name="nook_item_frame", children=list(scene.nodes),
                                     translation=[float(tx), float(ty), float(tz)]))
    scene.nodes = [len(gltf.nodes) - 1]
    dst.parent.mkdir(parents=True, exist_ok=True)
    gltf.save_binary(str(dst))
    return {"w": round((x1 - x0) * 100, 2), "d": round((z1 - z0) * 100, 2), "h": round((y1 - y0) * 100, 2)}


def box(extents, center, color):
    m = trimesh.creation.box(extents=extents)
    m.apply_translation(center)
    m.visual.vertex_colors = color
    return m


def write_splat_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray, scale_m: float = 0.015, opacity: float = 0.95):
    """Minimal 3DGS PLY: positions, DC color, opacity (logit), log-scales, identity rotations (w first)."""
    n = len(xyz)
    fields = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, len(fields)), dtype="<f4")
    data[:, 0:3] = xyz
    data[:, 6:9] = (rgb - 0.5) / 0.28209479177387814
    data[:, 9] = np.log(opacity / (1 - opacity))
    data[:, 10:13] = np.log(scale_m)
    data[:, 13] = 1.0
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
    header += "".join(f"property float {f}\n" for f in fields) + "end_header\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header.encode() + data.tobytes())


def main():
    # sheen-chair: real textured model (Khronos sample, CC-BY 4.0 Wayfair), native size.
    sheen_dims = wrap_glb_normalized(MODELS / "SheenChair.glb", LIB / "sheen-chair" / "model.glb")

    # test-cube: 50 x 40 x 60 cm (w x d x h). Front (+Z) half is red in both assets so orientation is visible.
    w, d, h = 0.5, 0.4, 0.6
    back = box([w, h, d / 2], [0, h / 2, -d / 4], [150, 150, 150, 255])
    front = box([w, h, d / 2], [0, h / 2, d / 4], [220, 40, 40, 255])
    (LIB / "test-cube").mkdir(parents=True, exist_ok=True)
    trimesh.Scene([back, front]).export(LIB / "test-cube" / "model.glb")
    rng = np.random.default_rng(7)
    xyz = rng.uniform([-w / 2, 0, -d / 2], [w / 2, h, d / 2], size=(6000, 3)).astype("<f4")
    rgb = np.where(xyz[:, 2:3] > 0, [0.86, 0.16, 0.16], [0.6, 0.6, 0.6])
    write_splat_ply(LIB / "test-cube" / "splat.ply", xyz, rgb)

    # arrow: un-normalized input for pipeline tests. Offset from origin; tip points to +X so yaw is testable.
    body = box([0.8, 0.3, 0.4], [-0.1 + 2.0, 0.15 + 1.0, 0.5], [90, 120, 200, 255])
    tip = box([0.2, 0.2, 0.2], [0.4 + 2.0, 0.15 + 1.0, 0.5], [240, 200, 40, 255])
    trimesh.Scene([body, tip]).export(MODELS / "arrow.glb")

    library = {
        "version": 1,
        "items": [
            {
                "id": "sheen-chair", "name": "Sheen Chair", "category": "chair", "dims_cm": sheen_dims,
                "assets": {"glb": "sheen-chair/model.glb", "splat": None, "thumb": None},
                "default_render": "glb",
                "source": {"engine": "fixture", "input": "fixtures/models/SheenChair.glb", "prompt": None,
                           "cost_usd": 0, "mock": False, "created": CREATED},
                "notes": "Khronos glTF sample asset (CC-BY 4.0, Wayfair).",
            },
            {
                "id": "test-cube", "name": "Test Cube", "category": "test", "dims_cm": {"w": 50, "d": 40, "h": 60},
                "assets": {"glb": "test-cube/model.glb", "splat": "test-cube/splat.ply", "thumb": None},
                "default_render": "splat",
                "source": {"engine": "fixture", "input": "generated", "prompt": None,
                           "cost_usd": 0, "mock": False, "created": CREATED},
                "notes": "Front (+Z) half is red.",
            },
        ],
    }
    (LIB / "library.json").write_text(json.dumps(library, indent=2) + "\n")

    broken = {
        "version": 1,
        "items": [
            dict(library["items"][0], assets={"glb": "../library/sheen-chair/model.glb", "splat": None, "thumb": None}),
            {
                "id": "missing-asset", "name": "Missing Asset", "category": "test", "dims_cm": {"w": 50, "d": 50, "h": 50},
                "assets": {"glb": "missing-asset/model.glb", "splat": None, "thumb": None},
                "default_render": "glb",
                "source": {"engine": "fixture", "input": "none", "prompt": None, "cost_usd": 0, "mock": False, "created": CREATED},
            },
        ],
    }
    BROKEN.mkdir(exist_ok=True)
    (BROKEN / "library.json").write_text(json.dumps(broken, indent=2) + "\n")

    ROOM.mkdir(exist_ok=True)
    (ROOM / "placeholder.json").write_text(json.dumps({"version": 1, "placeholder": {"w": 3.5, "d": 4, "h": 2.7}}, indent=2) + "\n")
    (ROOM / "splat.json").write_text(json.dumps({
        "version": 1, "splat": "fixtures/room/test.spz",
        "transform": {"position": [0, 0.6, 0], "quaternion": [1, 0, 0, 0], "scale": 1},
    }, indent=2) + "\n")

    print("sheen-chair dims_cm:", sheen_dims)


if __name__ == "__main__":
    main()
