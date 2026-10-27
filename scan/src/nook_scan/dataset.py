"""Turn a validated capture into the trainer's Nerfstudio-style dataset in a temp workspace."""

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from . import ScanError, photometric, say
from .capture import Capture
from .ply import read_points, write_points

MAX_SEEDS = 600_000


@dataclass
class Prepared:
    data_dir: Path
    n_train: int
    n_eval: int
    long_side: int           # of the video frames
    stills: int              # training frames that use a high-resolution still
    seeds: np.ndarray        # (N,3) world-space seed points (may be empty)
    seed_source: str         # "points.ply", "depth" or "none"


def _source(cap: Capture, f: dict, hires: bool) -> tuple[Path, tuple[int, int], tuple[float, float, float, float]]:
    """A frame's image, size and intrinsics: its high-resolution still (contract §4.10) when asked and present,
    else the video frame."""
    if hires and f.get("hires_file_path"):
        return (cap.root / f["hires_file_path"], (int(f["hires_w"]), int(f["hires_h"])),
                tuple(float(f[k]) for k in ("hires_fl_x", "hires_fl_y", "hires_cx", "hires_cy")))
    return cap.root / f["file_path"], cap.size(f), cap.intrinsics(f)


def _frame_entry(cap: Capture, f: dict, name: str, scale: float, size=None, intr=None) -> dict:
    w, h = size or cap.size(f)
    fx, fy, cx, cy = intr or cap.intrinsics(f)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    sx, sy = nw / w, nh / h
    return {"file_path": f"images/{name}", "transform_matrix": f["transform_matrix"],
            "fl_x": fx * sx, "fl_y": fy * sy, "cx": cx * sx, "cy": cy * sy, "w": nw, "h": nh}


def _seeds_from_depth(cap: Capture, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Back-project LiDAR depth maps (16-bit mm) into world-space colored points."""
    frames = [f for f in cap.frames if f.get("depth_file_path")]
    if not frames:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    per_frame = max(1, max_points // len(frames))
    rng = np.random.default_rng(0)
    xyz_all, rgb_all = [], []
    for f in frames:
        with Image.open(cap.root / f["depth_file_path"]) as dm:
            depth = np.asarray(dm, dtype=np.float64) / 1000.0
        dh, dw = depth.shape
        w, h = cap.size(f)
        fx, fy, cx, cy = cap.intrinsics(f)
        sx, sy = dw / w, dh / h
        v, u = np.nonzero((depth > 0.15) & (depth < 6.0))
        if len(u) > per_frame:
            pick = rng.choice(len(u), per_frame, replace=False)
            u, v = u[pick], v[pick]
        z = depth[v, u]
        x = (u + 0.5 - cx * sx) * z / (fx * sx)
        y = (v + 0.5 - cy * sy) * z / (fy * sy)
        cam = np.stack([x, -y, -z], 1)                      # OpenCV pixel ray -> OpenGL camera frame
        m = np.array(f["transform_matrix"], dtype=np.float64)
        xyz_all.append(cam @ m[:3, :3].T + m[:3, 3])
        with Image.open(cap.root / f["file_path"]) as im:
            rgb = np.asarray(im.convert("RGB"))
        iu = np.clip(((u + 0.5) / sx).astype(int), 0, rgb.shape[1] - 1)
        iv = np.clip(((v + 0.5) / sy).astype(int), 0, rgb.shape[0] - 1)
        rgb_all.append(rgb[iv, iu])
    return np.concatenate(xyz_all).astype(np.float32), np.concatenate(rgb_all).astype(np.uint8)


def far_points(cap: Capture, frames: list[int], distance: float, max_points: int = 120_000) -> tuple[np.ndarray, np.ndarray]:
    """Seed points for what is seen through windows: bright pixels where LiDAR got no return (depth 0), placed
    `distance` meters out along their rays. Without them the trainer explains the view outside with floaters on the glass."""
    xyz_all, rgb_all = [], []
    for i in frames:
        f = cap.frames[i]
        if not f.get("depth_file_path"):
            continue
        with Image.open(cap.root / f["depth_file_path"]) as dm:
            depth = np.asarray(dm, dtype=np.float64)
        dh, dw = depth.shape
        w, h = cap.size(f)
        fx, fy, cx, cy = cap.intrinsics(f)
        with Image.open(cap.root / f["file_path"]) as im:
            im.draft("RGB", (dw * 2, dh * 2))
            rgb = np.asarray(im.convert("RGB").resize((dw, dh)))
        v, u = np.nonzero((depth == 0) & (rgb.mean(2) > 150))
        v, u = v[::3], u[::3]
        if not len(u):
            continue
        x = ((u + 0.5) * w / dw - cx) / fx
        y = ((v + 0.5) * h / dh - cy) / fy
        ray = np.stack([x, -y, -np.ones_like(x)], 1)
        ray /= np.linalg.norm(ray, axis=1, keepdims=True)
        m = np.array(f["transform_matrix"], dtype=np.float64)
        xyz_all.append(ray @ m[:3, :3].T * distance + m[:3, 3])
        rgb_all.append(rgb[v, u])
    if not xyz_all:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    xyz, rgb = np.concatenate(xyz_all), np.concatenate(rgb_all)
    _, first = np.unique(np.floor(xyz / (distance * 0.01)).astype(np.int64), axis=0, return_index=True)
    xyz, rgb = xyz[first], rgb[first]
    if len(xyz) > max_points:
        pick = np.random.default_rng(0).choice(len(xyz), max_points, replace=False)
        xyz, rgb = xyz[pick], rgb[pick]
    return xyz.astype(np.float32), rgb.astype(np.uint8)




def is_held_out(i: int, holdout_every: int) -> bool:
    return holdout_every > 0 and i % holdout_every == 0


def seed_points(cap: Capture) -> tuple[np.ndarray, np.ndarray | None, str]:
    """Seed points: the capture's points.ply, else back-projected LiDAR depth, else none (the trainer starts from random splats)."""
    t = cap.transforms
    if t.get("ply_file_path"):
        xyz, rgb = read_points(cap.root / t["ply_file_path"])
        if len(xyz):
            return xyz, (rgb if rgb is not None else np.full((len(xyz), 3), 128, np.uint8)), "points.ply"
    xyz, rgb = _seeds_from_depth(cap, MAX_SEEDS)
    if len(xyz):
        # Neighbouring depth maps overlap heavily: keep one point per 2 cm voxel.
        _, first = np.unique(np.floor(xyz / 0.02).astype(np.int64), axis=0, return_index=True)
        return xyz[first], rgb[first], "depth"
    return np.zeros((0, 3), np.float32), None, "none"


def _write_image(src: Path, dst: Path, size: tuple[int, int], scale: float, table: list[int] | None) -> None:
    if scale >= 1.0 and table is None:
        shutil.copyfile(src, dst)
    else:
        with Image.open(src) as im:
            im = im.convert("RGB")
            if table is not None:
                im = im.point(table)
            if scale < 1.0:
                im = im.resize((max(1, round(size[0] * scale)), max(1, round(size[1] * scale))), Image.LANCZOS)
            im.save(dst, quality=95)


def prepare(cap: Capture, work: Path, holdout_every: int, max_image_size: int,
            seeds: tuple[np.ndarray, np.ndarray | None, str] | None = None, gains: dict | None = None,
            stills_max_size: int | None = None) -> Prepared:
    """Write the training dataset. `gains` (frame index -> RGB gain, from photometric.measure) divides each training
    image's linear light by its gain; held-out frames are copied untouched. High-resolution stills (§4.10) are scaled
    to `stills_max_size` (default: max_image_size) and marked `"still": true`, so nook-gsplat sizes them with its
    --stills-max-size; video frames stay at max_image_size."""
    stills_max_size = stills_max_size or max_image_size
    data = work / "data"
    (data / "images").mkdir(parents=True)
    long_side = max(max(cap.size(f)) for f in cap.frames)
    scale = min(1.0, max_image_size / long_side)
    if scale < 1.0:
        say(f"downscaling images to a long side of {round(long_side * scale)} px (from {long_side})")

    jobs, train, held = [], [], []
    stills = 0
    for i, f in enumerate(cap.frames):
        name = f"{i:06d}.jpg"
        out = is_held_out(i, holdout_every)
        gain = gains.get(i) if gains and not out else None
        # Training frames use the high-res still when there is one; held-out frames stay video, as judged.
        src, size, intr = _source(cap, f, hires=not out)
        still = src.parent.name == "images_hi"
        stills += still
        fscale = min(1.0, (stills_max_size if still else max_image_size) / max(size))
        jobs.append((src, data / "images" / name, size, fscale, photometric.lut(gain) if gain is not None else None))
        entry = _frame_entry(cap, f, name, fscale, size, intr)
        if still:
            entry["still"] = True
        if f.get("depth_file_path"):  # for nook-gsplat --depth-weight; the capture folder outlives the run
            entry["depth_file_path"] = str((cap.root / f["depth_file_path"]).resolve())
        (held if out else train).append(entry)
    if stills:
        say(f"using {stills} high-resolution stills in place of their video frames, at up to {stills_max_size} px")
    if len(train) < 10:
        raise ScanError(f"--holdout-every {holdout_every} leaves only {len(train)} training frames: use a larger value (or 0)")
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:  # PIL decodes/encodes outside the GIL
        list(pool.map(lambda j: _write_image(*j), jobs))

    xyz, rgb, source = seeds if seeds is not None else seed_points(cap)
    seeds = np.zeros((0, 3), np.float32)
    if len(xyz):
        seeds = xyz
        if len(seeds) > MAX_SEEDS:
            pick = np.random.default_rng(0).choice(len(seeds), MAX_SEEDS, replace=False)
            seeds, rgb = seeds[pick], rgb[pick]
        write_points(data / "points.ply", seeds, rgb)

    def doc(frames):
        d = {"camera_model": "OPENCV", "fl_x": frames[0]["fl_x"], "fl_y": frames[0]["fl_y"],
             "cx": frames[0]["cx"], "cy": frames[0]["cy"], "w": frames[0]["w"], "h": frames[0]["h"], "frames": frames}
        if len(seeds):
            d["ply_file_path"] = "points.ply"
        return d

    (data / "transforms.json").write_text(json.dumps(doc(train)))
    if held:
        (data / "transforms_val.json").write_text(json.dumps(doc(held)))
    return Prepared(data, len(train), len(held), round(long_side * scale), stills, seeds, source)
