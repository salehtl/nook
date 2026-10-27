"""RoomPlan pass-through (contract §4.12, §4.9.1): a capture's roomplan.json and roomplan.usdz, moved into the capture
world frame, for the room dir as <name>.roomplan.json / <name>.roomplan.usdz.

`separate` sessions carry `world_from_roomplan`; it's applied here so readers never need it. roomplan.json gets each
element's transform premultiplied (and loses the key). roomplan.usdz is RoomPlan's own export, which nothing parses:
it's wrapped, not rewritten, in a new package whose root layer holds the same matrix on an Xform above a reference
to the original root layer. `shared` sessions are already in the capture frame and are copied as they are. The room
transform is not applied: the planner applies it, as it does to the splat.
"""

import io
import json
import struct
import zipfile
from pathlib import Path

import numpy as np

from .capture import ROOMPLAN_KINDS

ALIGN = 64  # USDZ: every file's data starts on a 64-byte boundary, stored uncompressed


def files(root: Path, meta: dict) -> dict[str, bytes]:
    """{"roomplan.json": bytes, "roomplan.usdz": bytes} for a capture with meta.roomplan (only the files it has),
    else {}. The capture has been validated (§4.12), so the matrices are sane."""
    if meta.get("roomplan") is None or not (root / "roomplan.json").is_file():
        return {}
    rp = json.loads((root / "roomplan.json").read_text())
    w = rp.pop("world_from_roomplan", None)
    out = {}
    if w is not None:
        w = np.array(w, dtype=np.float64)
        for kind in ROOMPLAN_KINDS:
            for el in rp.get(kind) or []:
                el["transform"] = [[round(float(x), 6) + 0.0 for x in row] for row in w @ np.array(el["transform"], dtype=np.float64)]
    out["roomplan.json"] = (json.dumps(rp, indent=1) + "\n").encode()
    usdz = root / "roomplan.usdz"
    if usdz.is_file():
        out["roomplan.usdz"] = usdz.read_bytes() if w is None else wrap_usdz(usdz.read_bytes(), w)
    return out


def _aligned_extra(offset: int, name: str) -> bytes:
    """A padding extra field so that a local file header at `offset` is followed by data on an ALIGN boundary."""
    pad = (-(offset + 30 + len(name.encode()))) % ALIGN
    if pad == 0:
        return b""
    if pad < 4:  # an extra field is at least its 4-byte header
        pad += ALIGN
    return struct.pack("<HH", 0x1986, pad - 4) + b"\0" * (pad - 4)


def wrap_usdz(original: bytes, world_from_roomplan: np.ndarray) -> bytes:
    """A USDZ whose root layer places the original package's root layer under world_from_roomplan. USD matrices act on
    row vectors (translation in the last row), so the stored matrix is the transpose of the contract's column-vector
    one. RoomPlan exports meters, Y up, as ARKit does."""
    with zipfile.ZipFile(io.BytesIO(original)) as z:
        entries = [(i.filename, z.read(i)) for i in z.infolist() if not i.is_dir()]
    if not entries:
        return original
    inner = entries[0][0]  # USDZ: the first file is the root layer
    rows = ", ".join("(" + ", ".join(f"{float(x):.9g}" for x in col) + ")" for col in world_from_roomplan.T)
    root_layer = f'''#usda 1.0
(
    defaultPrim = "nook_world"
    metersPerUnit = 1
    upAxis = "Y"
    doc = "nook-scan: RoomPlan's export placed in the capture world frame (world_from_roomplan, contract 4.12)"
)

def Xform "nook_world"
{{
    matrix4d xformOp:transform = ( {rows} )
    uniform token[] xformOpOrder = ["xformOp:transform"]

    def "roomplan" (
        prepend references = @./{inner}@
    )
    {{
    }}
}}
'''.encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
        for name, data in [("nook_world.usda", root_layer), *entries]:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.extra = _aligned_extra(buf.tell(), name)
            out.writestr(info, data)
    return buf.getvalue()
