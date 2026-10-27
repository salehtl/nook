"""room.json (contract room.schema.json): point the planner at the new splat and put the floor at y = 0."""

import json
import math
import os
from pathlib import Path

import numpy as np

from . import REPO, ScanError

MAX_VIEWPOINTS = 24
MIN_EYE_M = 1.0            # viewpoints sit at least this far above the floor (contract §4.9)
PITCH_RANGE = (-40, 20)    # degrees; preferred, so the planner doesn't open looking at the floor or the ceiling


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


def _quat(r: np.ndarray) -> list[float]:
    """Rotation matrix -> [x, y, z, w]."""
    tr = r[0, 0] + r[1, 1] + r[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s]
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = [0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = [(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s]
    q = np.array(q) / np.linalg.norm(q)
    return [round(float(v), 6) + 0.0 for v in (q if q[3] >= 0 else -q)]


def viewpoint(c2w: np.ndarray, intrinsics: tuple[float, float, float, float], size: tuple[int, int], floor_y: float) -> dict:
    """One capture pose as a planner viewpoint, in room coordinates (the room transform only lifts y by -floor_y).

    The camera keeps its position and the direction it looks (-Z, OpenGL/three.js convention) but is turned upright:
    ARKit poses are in sensor orientation, so a phone held in portrait has its camera +Y lying sideways, and the
    planner would open on a room rotated by 90 degrees. fov_y_deg is the field of view along the image axis that was
    closest to world up, so the planner frames what the phone saw.
    """
    r = c2w[:3, :3]
    fwd = -r[:, 2] / np.linalg.norm(r[:, 2])
    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(fwd, up)
    if np.linalg.norm(right) < 1e-6:            # looking straight up or down: keep the camera's own x as right
        right = r[:, 0]
    right /= np.linalg.norm(right)
    cam_up = np.cross(right, fwd)
    upright = np.stack([right, cam_up, -fwd], axis=1)
    fx, fy, _, _ = intrinsics
    w, h = size
    portrait = abs(r[:, 0] @ up) > abs(r[:, 1] @ up)   # the image's x axis was the one pointing up or down
    fov = 2 * math.degrees(math.atan(w / 2 / fx)) if portrait else 2 * math.degrees(math.atan(h / 2 / fy))
    p = c2w[:3, 3]
    return {"position": [round(float(p[0]), 4) + 0.0, round(float(p[1] - floor_y), 4) + 0.0, round(float(p[2]), 4) + 0.0],
            "quaternion": _quat(upright), "fov_y_deg": round(fov, 2)}


def pick_viewpoints(poses: np.ndarray, floor_y: float, n: int = MAX_VIEWPOINTS) -> list[int]:
    """Indices of up to n frames at least MIN_EYE_M above the floor, spread evenly along the walking path.
    Frames that look roughly level are preferred when there are enough of them."""
    pos = poses[:, :3, 3]
    high = np.nonzero(pos[:, 1] - floor_y >= MIN_EYE_M)[0]
    if not len(high):
        return []
    fwd = -poses[:, :3, 2]
    pitch = np.degrees(np.arcsin(np.clip(fwd[:, 1] / np.linalg.norm(fwd, axis=1), -1, 1)))
    level = high[(pitch[high] >= PITCH_RANGE[0]) & (pitch[high] <= PITCH_RANGE[1])]
    cand = level if len(level) >= min(n, len(high)) else high
    # Arc length along the whole path (in capture order), so the picks spread over the walk, not over time.
    steps = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(pos, axis=0), axis=1))]
    s = steps[cand]
    if len(cand) <= n:
        return [int(i) for i in cand]
    targets = np.linspace(s[0], s[-1], n)
    picked = []
    for t in targets:
        order = np.argsort(np.abs(s - t))
        k = next(int(cand[j]) for j in order if int(cand[j]) not in picked)
        picked.append(k)
    return sorted(picked)


def _qmul(a, b) -> np.ndarray:
    """Hamilton product of [x, y, z, w] quaternions."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def _qrot(q, v) -> np.ndarray:
    u, w = np.asarray(q[:3], float), float(q[3])
    v = np.asarray(v, float)
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def in_room(vp: dict, transform: dict) -> dict:
    """A viewpoint in capture world coordinates moved into room coordinates by a room transform (position, quaternion,
    scale), as the planner places the splat."""
    q = np.asarray(transform["quaternion"], float)
    q /= np.linalg.norm(q)
    p = float(transform["scale"]) * _qrot(q, vp["position"]) + np.asarray(transform["position"], float)
    r = _qmul(q, vp["quaternion"])
    r = r / np.linalg.norm(r) * (1 if r[3] >= 0 else -1)
    return {"position": [round(float(x), 4) + 0.0 for x in p], "quaternion": [round(float(x), 6) + 0.0 for x in r],
            "fov_y_deg": vp["fov_y_deg"]}


def viewpoints(cap, floor_y: float, transform: dict | None = None) -> list[dict]:
    """Up to MAX_VIEWPOINTS planner viewpoints. Without `transform`, the room is the capture lifted by -floor_y (a new
    scan); with one (a retrain keeping its parent's alignment), each pose is moved by it."""
    poses = cap.poses()
    picks = pick_viewpoints(poses, floor_y)
    if transform is None:
        return [viewpoint(poses[i], cap.intrinsics(cap.frames[i]), cap.size(cap.frames[i]), floor_y) for i in picks]
    return [in_room(viewpoint(poses[i], cap.intrinsics(cap.frames[i]), cap.size(cap.frames[i]), 0.0), transform) for i in picks]


def read_config(room_dir: Path, name: str) -> dict:
    """A room's config, first match wins (contract §2.7): <name>.room.json; room.json when its splat is this room's;
    else {}."""
    own = room_dir / f"{name}.room.json"
    for path in (own, room_dir / "room.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and (path == own or Path(str(data.get("splat") or "")).stem == name):
            return data
    return {}


def updated(existing: dict, ply: Path, room_dir: Path, floor_y: float, views: list[dict] | None = None) -> dict:
    room = dict(existing)
    for key in ("title", "saved"):  # the previous room's name and save time (contract §2.7), not this scan's
        room.pop(key, None)
    room["version"] = 1
    room["splat"] = splat_url(ply, room_dir)
    room["transform"] = {"position": [0, round(-floor_y, 4) + 0.0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}
    room["viewpoints"] = views or None   # replaces the previous scan's viewpoints; null when none qualified
    return room


def retrained(parent_cfg: dict, parent: str | None, ply: Path, room_dir: Path, floor_y: float, title: str | None) -> dict:
    """The config of a retrained room (contract §5.1): its parent's transform and look, and `saved` (it's the same
    capture, so the same world frame, already aligned), with `parent` and `title` set. Viewpoints are the caller's."""
    room = {"version": 1, "splat": splat_url(ply, room_dir)}
    room["transform"] = parent_cfg.get("transform") or {"position": [0, round(-floor_y, 4) + 0.0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}
    for key in ("look", "saved"):
        if parent_cfg.get(key) is not None:
            room[key] = parent_cfg[key]
    room["parent"] = parent
    if title:
        room["title"] = title
    return room


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)
