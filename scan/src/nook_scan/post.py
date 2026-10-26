"""Post-process a trained splat: crop floaters and transparent splats, estimate the floor."""

import numpy as np
from PIL import Image

from . import ScanError
from .ply import read_vertices

MIN_ALPHA = 1 / 255      # splats fainter than one 8-bit step are dropped
MARGIN_M = 0.3           # slack around the captured volume
REQUIRED = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def captured_bounds(seeds: np.ndarray, cams: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Robust box around what was captured: seed points (0.5-99.5 percentile) and camera positions, plus a margin."""
    lo, hi = cams.min(0), cams.max(0)
    if len(seeds) >= 100:
        lo = np.minimum(lo, np.percentile(seeds, 0.5, axis=0))
        hi = np.maximum(hi, np.percentile(seeds, 99.5, axis=0))
    else:  # no seeds: cameras look outward at walls a few meters away
        lo, hi = lo - 2.0, hi + 2.0
    margin = max(MARGIN_M, 0.05 * float(np.linalg.norm(hi - lo)))
    return lo - margin, hi + margin


def seen_through_openings(xyz: np.ndarray, cap, frames: list[int], min_frames: int = 2) -> np.ndarray:
    """For points outside the room box: True where at least `min_frames` capture frames saw them through an opening,
    i.e. the point projects into the image onto a pixel where LiDAR found nothing (or something farther away).
    That is the view out of a window. Points behind walls project onto nearer LiDAR depth in every frame."""
    hits = np.zeros(len(xyz), int)
    for i in frames:
        f = cap.frames[i]
        if not f.get("depth_file_path"):
            continue
        w, h = cap.size(f)
        fx, fy, cx, cy = cap.intrinsics(f)
        m = np.asarray(f["transform_matrix"], dtype=np.float64)
        c = (xyz - m[:3, 3]) @ m[:3, :3]
        z = -c[:, 2]
        ok = z > 0.1
        u = fx * c[:, 0] / np.where(ok, z, 1) + cx
        v = cy - fy * c[:, 1] / np.where(ok, z, 1)
        ok &= (u >= 0) & (u < w) & (v >= 0) & (v < h)
        with Image.open(cap.root / f["depth_file_path"]) as dm:
            depth = np.asarray(dm, dtype=np.float64) / 1000.0
        dh, dw = depth.shape
        d = depth[np.clip((v * dh / h).astype(int), 0, dh - 1), np.clip((u * dw / w).astype(int), 0, dw - 1)]
        hits += ok & ((d == 0) | (d > 0.9 * z))
    return hits >= min_frames


def crop(path, seeds: np.ndarray, cams: np.ndarray, cap=None, frames: list[int] | None = None) -> tuple[np.ndarray, dict]:
    """Drop splats outside the captured volume and near-transparent ones.

    The captured volume is the room box (seeds and cameras) plus, when the capture has LiDAR depth, whatever the
    cameras saw through its windows: on the first real scan, keeping those splats was worth 0.4 dB on held-out views
    that look outside (contract §4.9 Q1), and they are not floaters.
    """
    v = read_vertices(path)
    missing = [k for k in REQUIRED if k not in v.dtype.names]
    if missing:
        raise ScanError(f"trained PLY lacks {', '.join(missing)}: the trainer output is not a 3DGS splat (see the Brush log)")
    xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)
    lo, hi = captured_bounds(seeds, cams)
    finite = np.all([np.isfinite(v[k]) for k in v.dtype.names], axis=0)
    inside = np.all((xyz >= lo) & (xyz <= hi), axis=1)
    window = np.zeros(len(v), bool)
    if cap is not None and frames:
        out = np.nonzero(finite & ~inside)[0]
        window[out] = seen_through_openings(xyz[out], cap, frames)
    with np.errstate(over="ignore"):
        alpha = 1.0 / (1.0 + np.exp(-v["opacity"].astype(np.float64)))
    visible = alpha >= MIN_ALPHA
    keep = finite & (inside | window) & visible
    stats = {"trained": len(v), "outside": int((finite & ~inside & ~window).sum()), "window": int(window.sum()),
             "transparent": int((finite & (inside | window) & ~visible).sum()),
             "kept": int(keep.sum()), "bounds": [lo.round(2).tolist(), hi.round(2).tolist()]}
    if not keep.any():
        raise ScanError("every trained splat was outside the captured volume or transparent: the capture's poses are probably broken, scan again")
    return v[keep], stats


def estimate_floor(seeds: np.ndarray, cams: np.ndarray) -> float | None:
    """Floor height from seed/depth points: the densest horizontal layer below the cameras, refined to a low percentile.

    Horizontal surfaces show up as sharp peaks in a histogram of point heights; the floor is the biggest one
    under the phone. Returns None when there is nothing to go on.
    """
    if len(seeds) < 200:
        return None
    y = seeds[:, 1].astype(np.float64)
    below = y[y < np.percentile(cams[:, 1], 10) - 0.2]
    if len(below) < 100:
        return None
    lo, hi = np.percentile(below, 0.1), below.max()
    bins = np.arange(lo, hi + 0.02, 0.02)
    if len(bins) < 3:
        return float(np.median(below))
    hist, edges = np.histogram(below, bins)
    peak = int(np.argmax(hist))
    # The floor is the lowest strong layer: prefer a lower peak with at least half the top count (a big table can rival it).
    strong = np.nonzero(hist >= 0.5 * hist[peak])[0]
    k = int(strong.min())
    layer = below[(below >= edges[k] - 0.03) & (below <= edges[k + 1] + 0.03)]
    return float(np.median(layer))
