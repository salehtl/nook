"""room.json (contract room.schema.json): point the planner at the new splat and put the floor at y = 0."""

import json
import os
from pathlib import Path

from . import REPO, ScanError


def read_existing(room_dir: Path) -> dict:
    """Load the current room.json (or {}), failing early if it can't be kept intact."""
    path = room_dir / "room.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ScanError(f"{path} exists but is not valid JSON ({e}): fix or delete it, then re-run")
    if not isinstance(data, dict):
        raise ScanError(f"{path} is not a JSON object: fix or delete it, then re-run")
    return data


def splat_url(ply: Path, room_dir: Path) -> str:
    """Path of the PLY relative to the repo root, or to room-dir's parent when room-dir is outside the repo."""
    ply = ply.resolve()
    base = REPO if REPO in ply.parents else room_dir.resolve().parent
    return ply.relative_to(base).as_posix()


def updated(existing: dict, ply: Path, room_dir: Path, floor_y: float) -> dict:
    room = dict(existing)
    room["version"] = 1
    room["splat"] = splat_url(ply, room_dir)
    room["transform"] = {"position": [0, round(-floor_y, 4) + 0.0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}
    return room


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)
