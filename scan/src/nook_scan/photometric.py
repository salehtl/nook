"""Photometric normalization for captures shot with auto exposure and white balance (contract §4.9).

When `meta.exposure_locked` isn't true, the iPhone changes exposure and white balance while scanning, so the same wall
shows up brighter or bluer in some frames than in others. The splat then has to explain that with floaters and
view-dependent color. This module measures one RGB gain per frame from the capture itself and divides it out.

How it measures: the seed points (LiDAR or ARKit points in world space) are projected into every training frame. A
coarse z-buffer of those same points keeps only the ones that frame actually sees. Their colors (in linear light, from
a 1/8-scale decode, ignoring clipped and near-black pixels) give observations `color(frame, point)`. In log space that
is `log gain(frame) + log albedo(point)`, which is solved by alternating means with outlier trimming. The gauge is the
median frame, so corrected images keep the capture's typical exposure.
"""

from dataclasses import dataclass

import numpy as np
from PIL import Image

from .capture import Capture

SAMPLE_POINTS = 60_000
GRID = (96, 72)             # z-buffer cells across the image (long x short side)
DECODE_SCALE = 8            # JPEG draft decode at 1/8 scale: fast, and each sample averages an 8x8 block
LO, HI = 10 / 255, 245 / 255
MIN_OBS = 200               # frames with fewer usable samples keep the gain of their neighbours
ITERATIONS = 12


@dataclass
class Gains:
    gains: dict[int, np.ndarray]   # frame index -> RGB gain relative to the median frame (divide linear light by it)
    spread_ev: float               # p5-p95 range of per-frame luminance gain, in EV
    residual_before: float         # median |log2 residual| between frames seeing the same point, without gains
    residual_after: float          # the same with gains: how much more consistent the images become
    frames_measured: int


def srgb_to_linear(v: np.ndarray) -> np.ndarray:
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v: np.ndarray) -> np.ndarray:
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def _observe(cap: Capture, index: int, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Visible point ids and their linear RGB in frame `index`."""
    f = cap.frames[index]
    w, h = cap.size(f)
    fx, fy, cx, cy = cap.intrinsics(f)
    m = np.asarray(f["transform_matrix"], dtype=np.float64)
    cam = (pts - m[:3, 3]) @ m[:3, :3]               # world -> OpenGL camera (x right, y up, looking along -z)
    z = -cam[:, 2]
    front = z > 0.1
    u = fx * cam[:, 0] / np.where(front, z, 1) + cx
    v = cy - fy * cam[:, 1] / np.where(front, z, 1)
    ok = front & (u >= 0) & (u < w) & (v >= 0) & (v < h)
    ids = np.nonzero(ok)[0]
    if len(ids) < MIN_OBS:
        return ids[:0], np.zeros((0, 3))
    u, v, z = u[ids], v[ids], z[ids]
    gx, gy = GRID if w >= h else GRID[::-1]
    cell = (np.minimum((v * gy / h).astype(int), gy - 1) * gx + np.minimum((u * gx / w).astype(int), gx - 1))
    zmin = np.full(gx * gy, np.inf)
    np.minimum.at(zmin, cell, z)
    vis = z <= zmin[cell] * 1.04 + 0.03              # nearest surface in that cell only: no colors seen through walls
    ids, u, v = ids[vis], u[vis], v[vis]
    with Image.open(cap.root / f["file_path"]) as im:
        im.draft("RGB", (max(1, w // DECODE_SCALE), max(1, h // DECODE_SCALE)))
        small = np.asarray(im.convert("RGB"), dtype=np.float64) / 255.0
    sh, sw = small.shape[:2]
    rgb = small[np.minimum((v * sh / h).astype(int), sh - 1), np.minimum((u * sw / w).astype(int), sw - 1)]
    good = np.all((rgb > LO) & (rgb < HI), axis=1)
    return ids[good], srgb_to_linear(rgb[good])


def measure(cap: Capture, frames: list[int], seeds: np.ndarray) -> Gains | None:
    """Per-frame RGB gains for `frames` (indices into cap.frames), or None when there is too little to go on."""
    if len(seeds) < 1000 or len(frames) < 10:
        return None
    rng = np.random.default_rng(0)
    pts = seeds if len(seeds) <= SAMPLE_POINTS else seeds[rng.choice(len(seeds), SAMPLE_POINTS, replace=False)]
    pts = pts.astype(np.float64)
    fi, pi, cols = [], [], []
    for k, index in enumerate(frames):
        ids, rgb = _observe(cap, index, pts)
        fi.append(np.full(len(ids), k)), pi.append(ids), cols.append(rgb)
    fi, pi, logc = np.concatenate(fi), np.concatenate(pi), np.log(np.concatenate(cols))
    if len(fi) < MIN_OBS * 5:
        return None
    nf, npt = len(frames), len(pts)
    counts = np.bincount(fi, minlength=nf)
    seen = np.bincount(pi, minlength=npt) >= 2            # a point seen once says nothing about relative exposure
    keep = seen[pi]
    fi, pi, logc = fi[keep], pi[keep], logc[keep]

    def fit(use_gains: bool):
        lg, la = np.zeros((nf, 3)), np.zeros((npt, 3))
        w = np.ones(len(fi))
        for it in range(ITERATIONS if use_gains else 2):
            for c in range(3):
                den_p = np.bincount(pi, w, npt)
                la[:, c] = np.bincount(pi, w * (logc[:, c] - lg[fi, c]), npt) / np.maximum(den_p, 1e-9)
                if use_gains:
                    den_f = np.bincount(fi, w, nf)
                    lg[:, c] = np.bincount(fi, w * (logc[:, c] - la[pi, c]), nf) / np.maximum(den_f, 1e-9)
            if use_gains:
                lg -= np.median(lg[counts >= MIN_OBS], axis=0) if (counts >= MIN_OBS).any() else 0
            r = np.abs(logc - lg[fi] - la[pi]).mean(1)
            if it >= 1:  # trim misprojected samples (edges, specular highlights) and refit
                mad = np.median(r) + 1e-9
                w = (r < 4 * mad).astype(np.float64)
        return lg, np.median(r)

    _, before = fit(False)
    lg, after = fit(True)
    good = np.nonzero(counts >= MIN_OBS)[0]
    if len(good) < max(5, nf // 4):
        return None
    # Frames that saw too little borrow the gain of the nearest measured frame in capture order.
    for k in range(nf):
        if counts[k] < MIN_OBS:
            lg[k] = lg[good[np.argmin(np.abs(good - k))]]
    lum = lg @ np.array([0.2126, 0.7152, 0.0722]) / np.log(2)
    spread = float(np.percentile(lum, 95) - np.percentile(lum, 5))
    return Gains({index: np.exp(lg[k]) for k, index in enumerate(frames)}, spread, before / np.log(2), after / np.log(2), len(good))


def lut(gain: np.ndarray) -> list[int]:
    """A PIL point() table (R, G, B) that divides linear light by `gain` and re-encodes sRGB."""
    x = srgb_to_linear(np.arange(256) / 255.0)
    out = [np.round(linear_to_srgb(x / g) * 255).astype(int) for g in gain]
    return [int(v) for ch in out for v in ch]
