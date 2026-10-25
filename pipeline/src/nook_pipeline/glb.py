"""GLB normalization by editing the node graph only.

The scene roots are wrapped in two new nodes (orientation, then item-frame scale + translation), so meshes,
materials, textures and extensions pass through byte for byte. Bounds are measured with trimesh, the same
way evals/validate_library.py measures them.
"""
import base64
import copy
import json
import logging
import mimetypes
import re
import struct
import urllib.parse
from pathlib import Path

import numpy as np
import trimesh

from . import NookError
from .frames import quat_xyzw

logging.getLogger("trimesh").setLevel(logging.ERROR)

# §1 self-check tolerances (same as evals/validate_library.py)
DIM_TOL = 0.02     # fraction, per axis
CENTER_TOL = 0.01  # m, footprint center
FLOOR_TOL = 0.005  # m, min y

_JSON, _BIN = 0x4E4F534A, 0x004E4942
_UNSUPPORTED = {"KHR_draco_mesh_compression", "EXT_meshopt_compression"}


def read_glb(path: Path) -> tuple[dict, bytes | None]:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise NookError(f"{path} is not a GLB file (bad header)")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise NookError(f"{path} is glTF {version}; only glTF 2.0 is supported")
    doc, blob, off = None, None, 12
    end = min(length, len(data))
    while off + 8 <= end:
        size, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8 : off + 8 + size]
        off += 8 + size
        if kind == _JSON and doc is None:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == _BIN and blob is None:
            blob = bytes(chunk)
    if doc is None:
        raise NookError(f"{path} has no JSON chunk")
    return doc, blob


def write_glb(path: Path, doc: dict, blob: bytes | None) -> None:
    j = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    j += b" " * (-len(j) % 4)
    body = struct.pack("<II", len(j), _JSON) + j
    if blob is not None:
        b = blob + b"\0" * (-len(blob) % 4)
        body += struct.pack("<II", len(b), _BIN) + b
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body)


def _uri_bytes(uri: str, base: Path) -> bytes:
    if uri.startswith("data:"):
        head, _, payload = uri.partition(",")
        return base64.b64decode(payload) if head.endswith(";base64") else urllib.parse.unquote_to_bytes(payload)
    if re.match(r"^[a-z][a-z0-9+.-]*:", uri, re.I):
        raise NookError(f"the glTF links a remote file ({uri}); download it next to the .gltf first")
    p = base / urllib.parse.unquote(uri)
    if not p.is_file():
        raise NookError(f"the glTF links {uri}, but {p} doesn't exist; keep its files next to it")
    return p.read_bytes()


def load_model(path: Path) -> tuple[dict, bytes | None]:
    """Read a .glb or .gltf into (json, binary chunk), embedding any external buffers and image files."""
    try:
        if path.suffix.lower() == ".gltf":
            doc, blob = json.loads(path.read_text(encoding="utf-8")), None
        else:
            doc, blob = read_glb(path)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise NookError(f"{path} is not valid glTF JSON ({e})") from None
    if not str(doc.get("asset", {}).get("version", "")).startswith("2"):
        raise NookError(f"{path} is not glTF 2.0")
    bad = _UNSUPPORTED & set(doc.get("extensionsUsed", []))
    if bad:
        raise NookError(f"the model uses {', '.join(sorted(bad))}; re-export it without mesh compression")

    buffers = doc.get("buffers", [])
    externals = [im for im in doc.get("images", []) if im.get("uri") and not im["uri"].startswith("data:")]
    glb_only = len(buffers) == 1 and "uri" not in buffers[0] and blob is not None
    if glb_only and len(blob) < buffers[0].get("byteLength", 0):
        raise NookError(f"{path} is truncated (binary chunk is {len(blob)} of {buffers[0]['byteLength']} bytes)")
    if not externals and (not buffers or glb_only):
        return doc, blob  # already self-contained (the usual GLB)

    # Pack every buffer (and external image) into one binary chunk.
    out, starts = bytearray(), []
    for i, buf in enumerate(buffers):
        out += b"\0" * (-len(out) % 8)
        starts.append(len(out))
        if "uri" in buf:
            out += _uri_bytes(buf["uri"], path.parent)
        elif i == 0 and blob is not None:
            out += blob[: buf.get("byteLength", len(blob))]
        else:
            raise NookError(f"{path}: buffer {i} has no data")
    for view in doc.get("bufferViews", []):
        view["byteOffset"] = view.get("byteOffset", 0) + starts[view.get("buffer", 0)]
        view["buffer"] = 0
    for im in externals:
        data = _uri_bytes(im["uri"], path.parent)
        out += b"\0" * (-len(out) % 8)
        doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data)})
        out += data
        im["mimeType"] = im.get("mimeType") or mimetypes.guess_type(im["uri"])[0] or "image/png"
        im["bufferView"] = len(doc["bufferViews"]) - 1
        del im["uri"]
    doc["buffers"] = [{"byteLength": len(out)}]
    return doc, bytes(out)


def measure(path: Path) -> np.ndarray:
    """Axis-aligned bounds [[x0,y0,z0],[x1,y1,z1]] in meters, as evals/validate_library.py computes them."""
    try:
        scene = trimesh.load(str(path), force="scene")
    except Exception as e:  # noqa: BLE001 - any loader failure becomes one actionable line
        detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        raise NookError(f"couldn't read the model's geometry ({detail}); the file may be corrupt") from None
    if scene.is_empty or scene.bounds is None:
        raise NookError("the model has no mesh geometry")
    return np.asarray(scene.bounds, float)


def errors_pct(bounds: np.ndarray, dims_m: np.ndarray) -> dict:
    """Per-axis size error in percent; dims_m is (w, h, d) i.e. (X, Y, Z)."""
    size = bounds[1] - bounds[0]
    e = np.abs(size - dims_m) / dims_m * 100
    return {"w": round(float(e[0]), 3), "d": round(float(e[2]), 3), "h": round(float(e[1]), 3)}


def self_check(bounds: np.ndarray, dims_m: np.ndarray) -> None:
    (x0, y0, z0), (x1, y1, z1) = bounds
    size = bounds[1] - bounds[0]
    for axis, s, t in zip("whd", size, dims_m):
        if abs(s - t) / t > DIM_TOL:
            raise NookError(f"self-check failed: GLB {axis} is {s * 100:.1f} cm, expected {t * 100:.1f} cm "
                            f"({abs(s - t) / t:.1%} off, max {DIM_TOL:.0%})")
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if abs(cx) > CENTER_TOL or abs(cz) > CENTER_TOL:
        raise NookError(f"self-check failed: GLB footprint center is ({cx:.3f}, {cz:.3f}) m, "
                        f"max {CENTER_TOL * 100:.0f} cm from the origin")
    if abs(y0) > FLOOR_TOL:
        raise NookError(f"self-check failed: GLB min y is {y0:.3f} m, max {FLOOR_TOL * 100:.1f} cm from 0")


def normalize(src: Path, rotation: np.ndarray, dims_m: np.ndarray, out: Path) -> dict:
    """Write `out` in the item frame: rotated, footprint centered, on the floor, scaled per axis to dims_m (w, h, d).

    Returns the per-axis fit error in percent. Raises NookError if the written file fails the §1 checks.
    """
    doc, blob = load_model(src)
    doc = copy.deepcopy(doc)
    nodes = doc.setdefault("nodes", [])
    scenes = doc.setdefault("scenes", [])
    if not scenes:
        children = {c for n in nodes for c in n.get("children", [])}
        scenes.append({"nodes": [i for i in range(len(nodes)) if i not in children]})
    scene = scenes[doc.setdefault("scene", 0)]

    nodes.append({"name": "nook_orientation", "rotation": quat_xyzw(rotation), "children": list(scene.get("nodes", []))})
    frame = {"name": "nook_item_frame", "children": [len(nodes) - 1]}
    nodes.append(frame)
    scene["nodes"] = [len(nodes) - 1]

    write_glb(out, doc, blob)
    lo, hi = measure(out)
    size = hi - lo
    for axis, s in zip("XYZ", size):
        if s < 1e-6:
            raise NookError(f"the model is flat along {axis} (size 0), so it can't be scaled to --dims")
    k = dims_m / size
    center = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    frame["scale"] = [float(v) for v in k]
    frame["translation"] = [float(v) for v in -k * center]
    write_glb(out, doc, blob)

    bounds = measure(out)
    self_check(bounds, dims_m)
    return errors_pct(bounds, dims_m)
