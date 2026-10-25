"""Builds SYNTHETIC fal responses in fixtures/fal/ so the pipeline can be built offline before a real capture.

The response shapes follow fal's documented schemas for fal-ai/sam-3/3d-objects and fal-ai/trellis-2.
The files are the Khronos SheenChair, offset and rescaled so normalization has real work to do.
A real capture replaces these (see fixtures/fal/NOTES.md).

Run from the repo root:
  uv run --no-project --python 3.12 --with trimesh --with numpy --with pygltflib python -I fixtures/make_fal_mock.py
"""
import json
import shutil
from pathlib import Path

import numpy as np
import pygltflib
import trimesh

FIX = Path(__file__).resolve().parent
FAL = FIX / "fal"
SRC = FIX / "models" / "SheenChair.glb"
INPUT = FIX.parent / "evals" / "golden" / "morris-chair.jpg"
MOCK_URL = "https://v3b.fal.media/files/mock"


def wrapped(dst: Path, scale: float, offset):
    gltf = pygltflib.GLTF2().load(str(SRC))
    scene = gltf.scenes[gltf.scene or 0]
    gltf.nodes.append(pygltflib.Node(name="mock_engine_frame", children=list(scene.nodes),
                                     translation=[float(v) for v in offset], scale=[scale] * 3))
    scene.nodes = [len(gltf.nodes) - 1]
    dst.parent.mkdir(parents=True, exist_ok=True)
    gltf.save_binary(str(dst))


def splat_from_mesh(glb: Path, dst: Path, n=20000):
    mesh = trimesh.load(glb, force="mesh")
    pts, _ = trimesh.sample.sample_surface(mesh, n, seed=3)
    fields = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, len(fields)), dtype="<f4")
    data[:, 0:3] = pts
    data[:, 6:9] = (np.array([0.55, 0.45, 0.38]) - 0.5) / 0.28209479177387814
    data[:, 9] = 3.0
    data[:, 10:13] = np.log(0.008)
    data[:, 13] = 1.0
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
    header += "".join(f"property float {f}\n" for f in fields) + "end_header\n"
    dst.write_bytes(header.encode() + data.tobytes())


def file_obj(name: str, path: Path, content_type: str):
    return {"url": f"{MOCK_URL}/{name}", "content_type": content_type, "file_name": name, "file_size": path.stat().st_size}


def main():
    shutil.rmtree(FAL, ignore_errors=True)

    sam = FAL / "sam-3-3d-objects"
    wrapped(sam / "files" / "scene.glb", 0.8, [0.3, 0.2, -0.1])
    splat_from_mesh(sam / "files" / "scene.glb", sam / "files" / "scene_splat.ply")
    shutil.copy(INPUT, sam / "input.jpg")
    (sam / "request.json").write_text(json.dumps(
        {"image_url": f"{MOCK_URL}/input.jpg", "prompt": "chair", "export_textured_glb": True}, indent=2) + "\n")
    (sam / "response.json").write_text(json.dumps({
        "gaussian_splat": file_obj("scene_splat.ply", sam / "files" / "scene_splat.ply", "application/octet-stream"),
        "model_glb": file_obj("scene.glb", sam / "files" / "scene.glb", "model/gltf-binary"),
        "metadata": [{"object_index": 0, "scale": [[0.8, 0.8, 0.8]], "rotation": [[1, 0, 0, 0]], "translation": [[0.3, 0.2, -0.1]]}],
        "individual_splats": None,
        "individual_glbs": None,
        "artifacts_zip": None,
    }, indent=2) + "\n")

    tre = FAL / "trellis-2"
    wrapped(tre / "files" / "trellis_model.glb", 1.3, [-0.2, -0.4, 0.5])
    shutil.copy(INPUT, tre / "input.jpg")
    (tre / "request.json").write_text(json.dumps({"image_url": f"{MOCK_URL}/input.jpg", "resolution": 512}, indent=2) + "\n")
    (tre / "response.json").write_text(json.dumps({
        "model_glb": file_obj("trellis_model.glb", tre / "files" / "trellis_model.glb", "model/gltf-binary"),
    }, indent=2) + "\n")

    (FAL / "NOTES.md").write_text("""# fal fixtures

**Status: SYNTHETIC.** These responses follow fal's documented response schemas, but the files are the Khronos
SheenChair, offset and rescaled (built by `fixtures/make_fal_mock.py`). They are good enough to build and test
plumbing and normalization offline. They say nothing about the real engines' coordinate frames.

## Engine frames (assumed until a real capture replaces this file)

| Engine | Up axis | Front | Units | Notes |
|---|---|---|---|---|
| sam3d `model_glb` | +Y | +Z | arbitrary | same frame as `gaussian_splat` |
| sam3d `gaussian_splat` | +Y | +Z | arbitrary | standard 3DGS PLY |
| trellis2 `model_glb` | +Y | +Z | arbitrary | |

The pipeline should keep each engine's default orientation in one obvious place (a small table or dict), so updating
it after the real capture is a one-line change.

## Mock layout

`<slug>/request.json` is the arguments sent, `<slug>/response.json` is the response verbatim, `<slug>/files/` holds
every file the response links (by URL basename), and `<slug>/input.*` is the image that was sent.
""")
    print("wrote", *sorted(str(p.relative_to(FIX)) for p in FAL.rglob("*") if p.is_file()), sep="\n  ")


if __name__ == "__main__":
    main()
