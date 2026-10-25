"""Print facts about a GLB as one JSON line: image count, material count, bounds, vertex centroid.

Usage: uv run --no-project --python 3.12 --with trimesh --with numpy --with pygltflib python -I evals/glb_info.py model.glb
"""
import json
import sys

import numpy as np
import pygltflib
import trimesh

path = sys.argv[1]
gltf = pygltflib.GLTF2().load(path)
scene = trimesh.load(path, force="scene")
verts = np.concatenate([g.vertices for g in scene.dump()]) if not scene.is_empty else np.zeros((1, 3))
print(json.dumps({
    "images": len(gltf.images or []),
    "materials": len(gltf.materials or []),
    "bounds": scene.bounds.tolist() if not scene.is_empty else None,
    "centroid": verts.mean(axis=0).tolist(),
}))
