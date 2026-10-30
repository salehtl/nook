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
from .capture import Capture, is_test_walk
from .ply import read_points, write_points

MAX_SEEDS = 600_000
PLY_SEED_CAP = 400_000                 # ios CaptureWriter.maxSeedPoints: at this count the app has stopped collecting
FAR_MAX_SEEDS = 120_000                # window seeds, added to the room's by the callers of far_points
DEPTH_MAX_SEEDS = MAX_SEEDS - FAR_MAX_SEEDS
DEPTH_STRIDE = 3                       # depth pixels between seed candidates, both axes
DEPTH_EDGE = 0.02                      # a seed's neighbours differ in depth by less than this share of its depth


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
    entry = {"file_path": f"images/{name}", "transform_matrix": f["transform_matrix"],
             "fl_x": fx * sx, "fl_y": fy * sy, "cx": cx * sx, "cy": cy * sy, "w": nw, "h": nh}
    for k in ("timestamp", "exposure_duration"):  # nook-gsplat --motion-blur: how the camera moved while exposing
        if f.get(k) is not None:
            entry[k] = f[k]
    return entry


def _voxel_thin(xyz: np.ndarray, rgb: np.ndarray, size: float) -> tuple[np.ndarray, np.ndarray]:
    """Keep the first point in each voxel of `size` meters. Surfaces end up equally dense, however many frames saw them."""
    v = np.floor(xyz.astype(np.float64) / size).astype(np.int64)
    v -= v.min(0)
    _, first = np.unique(v[:, 0] << 42 | v[:, 1] << 21 | v[:, 2], return_index=True)
    first.sort()
    return xyz[first], rgb[first]


def _frame_seeds(cap: Capture, f: dict) -> tuple[np.ndarray, np.ndarray]:
    """One frame's LiDAR depth (16-bit mm) back-projected on a fixed grid, with image colors."""
    with Image.open(cap.root / f["depth_file_path"]) as dm:
        depth = np.asarray(dm, dtype=np.float64) / 1000.0
    dh, dw = depth.shape
    w, h = cap.size(f)
    fx, fy, cx, cy = cap.intrinsics(f)
    sx, sy = dw / w, dh / h
    g = np.zeros_like(depth, bool)
    g[DEPTH_STRIDE // 2::DEPTH_STRIDE, DEPTH_STRIDE // 2::DEPTH_STRIDE] = True
    # The PNG has no confidence channel (points.ply keeps only high confidence): at least drop flying pixels at depth edges.
    jump = np.zeros_like(depth)
    jump[:, :-1] = np.abs(np.diff(depth, axis=1))
    jump[:, 1:] = np.maximum(jump[:, 1:], jump[:, :-1])
    down = np.zeros_like(depth)
    down[:-1] = np.abs(np.diff(depth, axis=0))
    down[1:] = np.maximum(down[1:], down[:-1])
    v, u = np.nonzero(g & (depth > 0.15) & (depth < 6.0) & (np.maximum(jump, down) < DEPTH_EDGE * depth))
    z = depth[v, u]
    x = (u + 0.5 - cx * sx) * z / (fx * sx)
    y = (v + 0.5 - cy * sy) * z / (fy * sy)
    cam = np.stack([x, -y, -z], 1)                      # OpenCV pixel ray -> OpenGL camera frame
    m = np.array(f["transform_matrix"], dtype=np.float64)
    with Image.open(cap.root / f["file_path"]) as im:
        im.draft("RGB", (dw * 2, dh * 2))
        rgb = np.asarray(im.convert("RGB").resize((dw, dh)))
    return (cam @ m[:3, :3].T + m[:3, 3]).astype(np.float32), rgb[v, u]


def _seeds_from_depth(cap: Capture, frames: list[int], max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Back-project these frames' LiDAR depth into world-space colored points, one per 2 cm voxel. Every frame keeps its
    whole grid, so a frame looking at a far ceiling counts as much as one looking at the floor below it. Past
    `max_points` the voxels grow: dropping points at random would keep the floor-heavy mix of what the phone looked at."""
    use = [cap.frames[i] for i in frames if cap.frames[i].get("depth_file_path")]
    if not use:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:  # PIL decodes outside the GIL
        parts = list(pool.map(lambda f: _frame_seeds(cap, f), use))
    xyz, rgb = np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts])
    if not len(xyz):
        return xyz, rgb
    size = 0.02
    xyz, rgb = _voxel_thin(xyz, rgb, size)
    while len(xyz) > max_points:
        size *= 1.1
        xyz, rgb = _voxel_thin(xyz, rgb, size)
    return xyz, rgb.astype(np.uint8)


def far_points(cap: Capture, frames: list[int], distance: float, max_points: int = FAR_MAX_SEEDS) -> tuple[np.ndarray, np.ndarray]:
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


def training_frames(cap: Capture, holdout_every: int = 0, held_out: set[int] | None = None) -> list[int]:
    """The frames a run trains on: all but the held-out ones and the test walk (contract §4.8)."""
    return [i for i, f in enumerate(cap.frames)
            if not (is_held_out(i, holdout_every) or (held_out and i in held_out) or is_test_walk(f))]


def seed_points(cap: Capture, frames: list[int] | None = None) -> tuple[np.ndarray, np.ndarray | None, str]:
    """Seed points: the capture's points.ply, else back-projected LiDAR depth, else none (the trainer starts from random splats).

    The depth maps replace points.ply when the app stopped collecting at its cap (what it saw last has no seeds) or when
    the capture has a test walk (its frames are in points.ply and can't be taken out). `frames` limits the depth maps
    used, so held-out frames feed no seeds; points.ply can't be split, so it ignores `frames`. Test-walk frames never
    feed seeds."""
    use = [i for i in (range(len(cap.frames)) if frames is None else frames) if not is_test_walk(cap.frames[i])]
    t = cap.transforms
    xyz, rgb = np.zeros((0, 3), np.float32), None
    if t.get("ply_file_path"):
        xyz, rgb = read_points(cap.root / t["ply_file_path"])
    rebuild = (len(xyz) >= PLY_SEED_CAP or any(is_test_walk(f) for f in cap.frames)) and any(cap.frames[i].get("depth_file_path") for i in use)
    if len(xyz) and not rebuild:
        return xyz, (rgb if rgb is not None else np.full((len(xyz), 3), 128, np.uint8)), "points.ply"
    dxyz, drgb = _seeds_from_depth(cap, use, DEPTH_MAX_SEEDS)
    if len(dxyz):
        return dxyz, drgb, "depth"
    if len(xyz):
        return xyz, (rgb if rgb is not None else np.full((len(xyz), 3), 128, np.uint8)), "points.ply"
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


def _write_seeds(data: Path, xyz: np.ndarray, rgb: np.ndarray | None) -> np.ndarray:
    """Write points.ply, at most MAX_SEEDS points. Returns the points written."""
    if not len(xyz):
        return np.zeros((0, 3), np.float32)
    if len(xyz) > MAX_SEEDS:
        pick = np.random.default_rng(0).choice(len(xyz), MAX_SEEDS, replace=False)
        xyz, rgb = xyz[pick], rgb[pick]
    write_points(data / "points.ply", xyz, rgb)
    return xyz


def apply_poses(cap: Capture, data: Path) -> None:
    """Give the capture's frames (in memory) the poses of its prepared dataset, after refinement. Seeds, the crop and
    the viewpoints then all use the poses the trainer uses. A prepared image is named after its frame's index."""
    for name in ("transforms.json", "transforms_val.json"):
        if (data / name).is_file():
            for f in json.loads((data / name).read_text())["frames"]:
                cap.frames[int(Path(f["file_path"]).stem)]["transform_matrix"] = f["transform_matrix"]


def depth_seeds(cap: Capture, frames: list[int]) -> tuple[np.ndarray, np.ndarray]:
    """Seeds from these frames' depth maps at the frames' current poses, whatever points.ply holds: points.ply was
    collected at the ARKit poses, so it doesn't agree with refined ones. Empty without depth maps."""
    return _seeds_from_depth(cap, frames, DEPTH_MAX_SEEDS)


def replace_seeds(prep: Prepared, xyz: np.ndarray, rgb: np.ndarray, source: str) -> None:
    """Replace a prepared dataset's points.ply (the transforms have pointed at it since prepare, when it had seeds)."""
    prep.seeds = _write_seeds(prep.data_dir, xyz, rgb)
    prep.seed_source = source
    for name in ("transforms.json", "transforms_val.json"):
        if (prep.data_dir / name).is_file():
            doc = json.loads((prep.data_dir / name).read_text())
            if doc.get("ply_file_path") != "points.ply":
                doc["ply_file_path"] = "points.ply"
                (prep.data_dir / name).write_text(json.dumps(doc))


def prepare(cap: Capture, work: Path, holdout_every: int, max_image_size: int,
            seeds: tuple[np.ndarray, np.ndarray | None, str] | None = None, gains: dict | None = None,
            stills_max_size: int | None = None, held_out: set[int] | None = None) -> Prepared:
    """Write the training dataset. `gains` (frame index -> RGB gain, from photometric.measure) divides each training
    image's linear light by its gain; held-out frames are copied untouched. High-resolution stills (§4.10) are scaled
    to `stills_max_size` (default: max_image_size) and marked `"still": true`, so nook-gsplat sizes them with its
    --stills-max-size; video frames stay at max_image_size. Frames are held out by the `holdout_every` rule, by the
    explicit `held_out` indices, and by being on the test walk (§4.8): all of them go to transforms_val.json."""
    stills_max_size = stills_max_size or max_image_size
    data = work / "data"
    (data / "images").mkdir(parents=True)
    long_side = max(max(cap.size(f)) for f in cap.frames)
    scale = min(1.0, max_image_size / long_side)
    if scale < 1.0:
        say(f"downscaling images to a long side of {round(long_side * scale)} px (from {long_side})")

    train_frames = training_frames(cap, holdout_every, held_out)
    train_set = set(train_frames)
    jobs, train, held = [], [], []
    stills = 0
    for i, f in enumerate(cap.frames):
        name = f"{i:06d}.jpg"
        out = i not in train_set
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
        raise ScanError(f"--holdout-every {holdout_every} and the test walk leave only {len(train)} training frames: "
                        "use a larger --holdout-every (or 0), or capture more of the room")
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:  # PIL decodes/encodes outside the GIL
        list(pool.map(lambda j: _write_image(*j), jobs))

    xyz, rgb, source = seeds if seeds is not None else seed_points(cap, train_frames)
    seeds = _write_seeds(data, xyz, rgb)

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
