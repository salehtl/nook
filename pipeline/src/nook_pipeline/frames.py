"""Engine output frames, and the rotations that bring them into the nook item frame.

The item frame is Y-up with the front facing +Z (see CLAUDE.md). Each engine's native frame is written below
as (up axis, front axis) in the engine's own coordinates. Normalization rotates up -> +Y and front -> +Z,
then applies --yaw.

SOURCE: fixtures/fal/NOTES.md, measured on a real capture (2026-10-25). The sam3d splat row is the GLB's frame:
the splat arrives in camera space and sam3d_splat_to_glb() maps it there first.
"""
import math

import numpy as np

ENGINE_FRAMES: dict[tuple[str, str], tuple[str, str]] = {
    # (engine, asset)      (up,   front)
    ("sam3d", "glb"):      ("+Y", "+Z"),
    ("sam3d", "splat"):    ("+Y", "+Z"),
    ("trellis2", "glb"):   ("+Y", "+Z"),
    ("glb", "glb"):        ("+Y", "+Z"),  # glTF is Y-up by spec; front +Z is the usual convention
}

_AXES = {
    "+X": (1, 0, 0), "-X": (-1, 0, 0),
    "+Y": (0, 1, 0), "-Y": (0, -1, 0),
    "+Z": (0, 0, 1), "-Z": (0, 0, -1),
}


# SAM 3D returns its GLB in a canonical object frame but its splat in the photo's camera space, posed by
# metadata[0] (rotation is a unit quaternion [w, x, y, z]). Measured on a real capture (2026-10-25): the splat
# lands on the GLB, median 1.6 cm apart, with p_glb = Rx(-90 deg) . R(q) . (p_scene - t) / s. Translation and
# scale are dropped here because normalization re-centers and re-scales anyway.
_RX_NEG_90 = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)


def quat_wxyz_matrix(q) -> np.ndarray:
    w, x, y, z = np.asarray(q, float) / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def sam3d_splat_to_glb(response: dict) -> np.ndarray:
    """Rotation taking a SAM 3D splat from camera space into its GLB's frame (identity if no pose is given)."""
    try:
        q = response["metadata"][0]["rotation"][0]
        if len(q) != 4:
            raise ValueError
    except (KeyError, IndexError, TypeError, ValueError):
        return np.eye(3)
    return _RX_NEG_90 @ quat_wxyz_matrix(q)


def frame_rotation(up: str, front: str) -> np.ndarray:
    """3x3 rotation taking `up` to +Y and `front` to +Z (right-handed, so up x front goes to +X)."""
    u, f = np.array(_AXES[up], float), np.array(_AXES[front], float)
    if abs(u @ f) > 1e-9:
        raise ValueError(f"engine frame up={up} front={front}: axes must be perpendicular")
    return np.stack([np.cross(u, f), u, f])


def yaw_rotation(deg: float) -> np.ndarray:
    """Rotation about +Y, counterclockwise seen from above (right-handed): yaw 90 turns +X into -Z."""
    a = math.radians(deg)
    c, s = round(math.cos(a), 12), round(math.sin(a), 12)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], float)


def orientation(engine: str, asset: str, yaw: float) -> np.ndarray:
    """The full rotation applied to an engine asset: engine default frame first, then --yaw."""
    return yaw_rotation(yaw) @ frame_rotation(*ENGINE_FRAMES[(engine, asset)])


def quat_xyzw(r: np.ndarray) -> list[float]:
    """Unit quaternion [x, y, z, w] (glTF order) for a 3x3 rotation matrix."""
    m = r
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w, x, y, z = (m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w, x, y, z = (m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w, x, y, z = (m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    return [float(v) for v in q]
