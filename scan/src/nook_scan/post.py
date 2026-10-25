"""Post-process a trained splat: crop floaters and transparent splats, estimate the floor."""

import numpy as np

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


def crop(path, seeds: np.ndarray, cams: np.ndarray) -> tuple[np.ndarray, dict]:
    v = read_vertices(path)
    missing = [k for k in REQUIRED if k not in v.dtype.names]
    if missing:
        raise ScanError(f"trained PLY lacks {', '.join(missing)}: the trainer output is not a 3DGS splat (see scan/.tools/last-train.log)")
    xyz = np.stack([v["x"], v["y"], v["z"]], 1)
    lo, hi = captured_bounds(seeds, cams)
    finite = np.all([np.isfinite(v[k]) for k in v.dtype.names], axis=0)
    inside = np.all((xyz >= lo) & (xyz <= hi), axis=1)
    with np.errstate(over="ignore"):
        alpha = 1.0 / (1.0 + np.exp(-v["opacity"].astype(np.float64)))
    visible = alpha >= MIN_ALPHA
    keep = finite & inside & visible
    stats = {"trained": len(v), "outside": int((finite & ~inside).sum()), "transparent": int((finite & inside & ~visible).sum()),
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
    below = y[y < cams[:, 1].min() - 0.2]
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
