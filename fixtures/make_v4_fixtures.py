"""v4 fixtures (main loop): a hand-made RoomPlan shell (§4.12) and an OBJ zip for `nook-add --engine glb` (§3.1).

fixtures/roomplan/roomplan.json is HAND-MADE, not from a phone: a 3.5 × 4.0 m room, 2.7 m high, floor at y = -1.32 in the
capture world (shared session, so no world_from_roomplan), one door, one window, one table. Replace it with a real
CapturedRoom export once the v4 RoomPlan spike (0b) has run on a phone; roomplan-separate.json is the same room in a
RoomPlan frame turned 30° and moved, with the world_from_roomplan that undoes it.
fixtures/models/cube-obj.zip is a 1 m textured cube: cube.obj + cube.mtl + tex.png.
Usage: python3 fixtures/make_v4_fixtures.py   (stdlib only; deterministic)
"""
import io
import json
import math
import struct
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).parent
FLOOR, W, D, H = -1.32, 3.5, 4.0, 2.7


def mat(yaw_deg=0.0, t=(0.0, 0.0, 0.0)):
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    return [[round(c, 6), 0, round(s, 6), t[0]], [0, 1, 0, t[1]], [round(-s, 6), 0, round(c, 6), t[2]], [0, 0, 0, 1]]


def mul(a, b):
    return [[round(sum(a[i][k] * b[k][j] for k in range(4)), 6) for j in range(4)] for i in range(4)]


def room():
    cy = FLOOR + H / 2
    walls = [
        {"id": "wall-n", "dimensions": [W, H, 0], "transform": mat(0, (0, cy, -D / 2)), "confidence": "high"},
        {"id": "wall-s", "dimensions": [W, H, 0], "transform": mat(180, (0, cy, D / 2)), "confidence": "high"},
        {"id": "wall-e", "dimensions": [D, H, 0], "transform": mat(-90, (W / 2, cy, 0)), "confidence": "high"},
        {"id": "wall-w", "dimensions": [D, H, 0], "transform": mat(90, (-W / 2, cy, 0)), "confidence": "medium"},
    ]
    floor = [{"id": "floor-0", "dimensions": [W, D, 0], "transform": [[1, 0, 0, 0], [0, 0, 1, FLOOR], [0, -1, 0, 0], [0, 0, 0, 1]],
              "confidence": "high"}]
    doors = [{"id": "door-0", "parent": "wall-s", "dimensions": [0.9, 2.05, 0], "transform": mat(180, (1.0, FLOOR + 1.025, D / 2)),
              "confidence": "high"}]
    windows = [{"id": "window-0", "parent": "wall-n", "dimensions": [1.4, 1.3, 0], "transform": mat(0, (-0.3, FLOOR + 1.55, -D / 2)),
                "confidence": "high"}]
    objects = [{"id": "object-0", "category": "table", "dimensions": [1.2, 0.75, 0.7], "transform": mat(0, (0.4, FLOOR + 0.375, -0.8)),
                "confidence": "medium"}]
    return {"version": 1, "walls": walls, "floors": floor, "doors": doors, "windows": windows, "openings": [], "objects": objects}


def separate(r):
    # The same room seen from a RoomPlan session whose frame is the world turned 30° about Y and shifted.
    world_from_rp = mat(30, (0.5, -0.2, 1.0))
    c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
    rot_t = [[c, 0, -s], [0, 1, 0], [s, 0, c]]  # inverse rotation
    t = [0.5, -0.2, 1.0]
    inv_t = [-sum(rot_t[i][k] * t[k] for k in range(3)) for i in range(3)]
    rp_from_world = [[*(round(v, 6) for v in rot_t[i]), round(inv_t[i], 6)] for i in range(3)] + [[0, 0, 0, 1]]
    out = json.loads(json.dumps(r))
    for k in ("walls", "floors", "doors", "windows", "openings", "objects"):
        for e in out[k]:
            e["transform"] = mul(rp_from_world, e["transform"])
    out["world_from_roomplan"] = world_from_rp
    return out


def png(w=8, h=8):
    raw = b"".join(b"\0" + b"".join(bytes((200 if (x + y) % 2 else 40, 120, 40)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def cube_zip():
    v = [(x, y, z) for x in (-0.5, 0.5) for y in (0.0, 1.0) for z in (-0.5, 0.5)]
    faces = [(1, 3, 7, 5), (2, 6, 8, 4), (1, 5, 6, 2), (3, 4, 8, 7), (5, 7, 8, 6), (1, 2, 4, 3)]
    obj = ["mtllib cube.mtl", *(f"v {x} {y} {z}" for x, y, z in v), "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "usemtl wood"]
    obj += [f"f {a}/1 {b}/2 {c}/3 {d}/4" for a, b, c, d in faces]
    mtl = "newmtl wood\nKd 1 1 1\nmap_Kd tex.png\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in (("cube/cube.obj", "\n".join(obj) + "\n"), ("cube/cube.mtl", mtl), ("cube/tex.png", png())):
            info = zipfile.ZipInfo(name, (2026, 10, 27, 0, 0, 0))
            z.writestr(info, data)
    return buf.getvalue()


if __name__ == "__main__":
    r = room()
    (HERE / "roomplan").mkdir(exist_ok=True)
    (HERE / "roomplan" / "roomplan.json").write_text(json.dumps(r, indent=1) + "\n")
    (HERE / "roomplan" / "roomplan-separate.json").write_text(json.dumps(separate(r), indent=1) + "\n")
    (HERE / "models" / "cube-obj.zip").write_bytes(cube_zip())
    print("wrote fixtures/roomplan/roomplan.json, roomplan-separate.json, fixtures/models/cube-obj.zip")
