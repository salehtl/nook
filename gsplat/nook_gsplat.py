#!/usr/bin/env python3
"""nook-gsplat: train a 3D Gaussian splat from a nook capture with gsplat (MCMC densification, CUDA).

    nook-gsplat CAPTURE_DIR --out OUT.ply [--steps 20000] [--max-splats 1200000] [--max-image-size 1920]
                [--stills-max-size N] [--sh-degree 1] [--holdout-every 0] [--pose-opt] [--depth-weight 0.2]
                [--init ROOM.spz]

Reads a contract §4 capture folder directly: transforms.json (Nerfstudio style, OpenGL camera-to-world, per-frame
intrinsics may override the top-level ones), images/, and points.ply seed points. Frames marked `"still": true` (the
high-resolution stills nook-scan prepares, contract §4.10) are sized by --stills-max-size, the others by
--max-image-size. Writes a standard 3DGS PLY
(contract §1) in capture world coordinates, the frame Brush writes. Progress goes to stderr as `step X/Y ...` lines;
the last stdout line is a JSON summary.

Training follows gsplat's examples/simple_trainer.py `mcmc` config: L1 + 0.2 SSIM (fused_ssim), MCMCStrategy capped at
--max-splats (so VRAM is bounded), opacity and scale regularization 0.01, progressive SH (one band per 1000 steps),
plus two changes the first real scan needed (a room walk-through, 1920x1440): simple_trainer's visible-only Adam
(SelectiveAdam), and a cap on splat size. With plain Adam the loss rose once the splat cap was reached, splats grew
toward a meter, and the run ran out of the RTX 2060's 6 GB at step ~9k.
"""

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")  # less fragmentation as splats grow

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

SH_C0 = 0.28209479177387814
SSIM_LAMBDA = 0.2
OPACITY_REG = 0.01
SCALE_REG = 0.01
INIT_OPACITY = 0.5
INIT_SCALE = 0.1  # times the mean distance to the 3 nearest seed points
MAX_SCALE = 0.1  # times the scene scale: largest splat sigma (3DGS prunes "big points" at the same size); a safety
# net that bounds tile intersections, and so VRAM, per view
SH_INTERVAL = 1000
PROGRESS_EVERY = 100


class Fail(Exception):
    pass


def say(msg: str) -> None:
    print(f"nook-gsplat: {msg}", file=sys.stderr, flush=True)


def fmt(secs: float) -> str:
    secs = int(secs)
    return f"{secs // 60}m{secs % 60:02d}s"


# --- capture -----------------------------------------------------------------------------------------------------

_PLY_TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2",
              "ushort": "u2", "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
              "float": "f4", "float32": "f4", "double": "f8", "float64": "f8"}


def read_points(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Seed points from a PLY whose first element is `vertex` (x y z, optional red green blue): (N,3) f32, (N,3) u8."""
    raw = path.read_bytes()
    end = raw.find(b"end_header")
    if not raw.startswith(b"ply") or end < 0:
        raise Fail(f"{path} is not a PLY file")
    body = raw.index(b"\n", end) + 1
    fmt_, count, props, in_vertex, seen = None, 0, [], False, False
    for line in raw[:body].decode("ascii", "replace").splitlines():
        p = line.split()
        if not p:
            continue
        if p[0] == "format":
            fmt_ = p[1]
        elif p[0] == "element":
            in_vertex = p[1] == "vertex"
            if in_vertex:
                count, seen = int(p[2]), True
            elif not seen:
                raise Fail(f"{path.name}: vertex must be the first PLY element")
        elif p[0] == "property" and in_vertex:
            if p[1] == "list" or p[1] not in _PLY_TYPES:
                raise Fail(f"{path.name}: unsupported PLY vertex property {' '.join(p[1:])}")
            props.append((p[2], _PLY_TYPES[p[1]]))
    if fmt_ == "ascii":
        rows = np.loadtxt(raw[body:].decode("ascii").splitlines()[:count], ndmin=2)
        v = {n: rows[:, i] for i, (n, _) in enumerate(props)}
    elif fmt_ in ("binary_little_endian", "binary_big_endian"):
        order = "<" if fmt_ == "binary_little_endian" else ">"
        arr = np.frombuffer(raw, np.dtype([(n, order + t) for n, t in props]), count=count, offset=body)
        v = {n: arr[n] for n, _ in props}
    else:
        raise Fail(f"{path.name}: unknown PLY format {fmt_}")
    if not {"x", "y", "z"} <= v.keys():
        raise Fail(f"{path.name}: PLY has no x/y/z")
    xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)
    if {"red", "green", "blue"} <= v.keys():
        c = np.stack([v["red"], v["green"], v["blue"]], 1)
        rgb = (np.clip(c, 0, 1) * 255 if c.dtype.kind == "f" else np.clip(c, 0, 255)).astype(np.uint8)
    else:
        rgb = np.full((len(xyz), 3), 128, np.uint8)
    ok = np.isfinite(xyz).all(1)
    return xyz[ok], rgb[ok]


def load_capture(root: Path, holdout_every: int, max_image_size: int, stills_max_size: int | None = None,
                 with_depth: bool = False):
    """Training frames as (uint8 HxWx3 CPU images, viewmats [N,4,4], Ks [N,3,3], camera centers [N,3]), plus the
    frames' LiDAR depth in meters (None per frame without one, or all None unless `with_depth`)."""
    tf = root / "transforms.json"
    if not tf.is_file():
        raise Fail(f"{root} has no transforms.json: pass an unzipped capture folder (scan-YYYYMMDD-HHMMSS)")
    t = json.loads(tf.read_text())
    frames = t.get("frames") or []
    train = [(i, f) for i, f in enumerate(frames) if not (holdout_every > 0 and i % holdout_every == 0)]
    if len(train) < 10:
        raise Fail(f"only {len(train)} training frames (of {len(frames)}): use a larger --holdout-every, or 0")
    gl_to_cv = np.diag([1.0, -1.0, -1.0, 1.0])  # OpenGL camera (y up, looks down -z) -> OpenCV (y down, +z)

    def load(item):
        i, f = item
        try:
            w, h = int(f.get("w", t.get("w"))), int(f.get("h", t.get("h")))
            fx, fy, cx, cy = (float(f.get(k, t.get(k))) for k in ("fl_x", "fl_y", "cx", "cy"))
        except (TypeError, ValueError):
            raise Fail(f"frame {i}: missing or bad intrinsics (fl_x, fl_y, cx, cy, w, h)")
        if "file_path" not in f or "transform_matrix" not in f:
            raise Fail(f"frame {i}: needs file_path and transform_matrix")
        c2w = np.array(f["transform_matrix"], dtype=np.float64)
        if c2w.shape != (4, 4) or not np.isfinite(c2w).all():
            raise Fail(f"frame {i}: transform_matrix is not a finite 4x4 matrix")
        limit = (stills_max_size or max_image_size) if f.get("still") else max_image_size
        s = min(1.0, limit / max(w, h))
        nw, nh = max(1, round(w * s)), max(1, round(h * s))
        path = root / f["file_path"]
        try:
            with Image.open(path) as im:
                if im.size != (w, h):
                    raise Fail(f"{f['file_path']} is {im.size[0]}x{im.size[1]}, transforms.json says {w}x{h}")
                im = im.convert("RGB")
                if (nw, nh) != (w, h):
                    im = im.resize((nw, nh), Image.LANCZOS)
                img = torch.from_numpy(np.array(im))
        except OSError as e:
            raise Fail(f"cannot read {f['file_path']}: {e}")
        sx, sy = nw / w, nh / h
        K = np.array([[fx * sx, 0, cx * sx], [0, fy * sy, cy * sy], [0, 0, 1]])
        depth = None
        if with_depth and f.get("depth_file_path"):
            try:
                with Image.open(root / f["depth_file_path"]) as dm:  # 16-bit mm, 0 = no data (contract §4)
                    depth = torch.from_numpy(np.asarray(dm, dtype=np.float32) / 1000.0).half()
            except OSError as e:
                raise Fail(f"cannot read {f['depth_file_path']}: {e}")
        stamp = (f.get("timestamp"), f.get("exposure_duration"))
        return img, np.linalg.inv(c2w @ gl_to_cv), K, c2w[:3, 3], depth, stamp

    with ThreadPoolExecutor(max_workers=min(16, os.cpu_count() or 4)) as pool:  # PIL decodes outside the GIL
        out = list(pool.map(load, train))
    images = [o[0] for o in out]
    depths = [o[4] for o in out]
    viewmats = torch.tensor(np.stack([o[1] for o in out]), dtype=torch.float32)
    Ks = torch.tensor(np.stack([o[2] for o in out]), dtype=torch.float32)
    centers = np.stack([o[3] for o in out])
    stamps = [o[5] for o in out]

    seeds = None
    ply = root / t.get("ply_file_path", "points.ply")
    if ply.is_file():
        seeds = read_points(ply)
        if not len(seeds[0]):
            seeds = None
    return t, len(frames), images, viewmats, Ks, centers, seeds, depths, stamps


# --- training ----------------------------------------------------------------------------------------------------

def init_splats(seeds, centers: np.ndarray, scene_scale: float, max_splats: int, sh_degree: int, rng):
    if seeds is not None:
        xyz, rgb = seeds
        if len(xyz) > max_splats:
            pick = rng.choice(len(xyz), max_splats, replace=False)
            xyz, rgb = xyz[pick], rgb[pick]
        rgb = rgb.astype(np.float32) / 255.0
    else:  # simple_trainer's "random" init: a cube around the cameras
        n = min(100_000, max_splats)
        xyz = (centers.mean(0) + 3.0 * scene_scale * (rng.random((n, 3)) * 2 - 1)).astype(np.float32)
        rgb = rng.random((n, 3)).astype(np.float32)
    from scipy.spatial import cKDTree

    d, _ = cKDTree(xyz).query(xyz, k=4, workers=-1)
    dist = np.sqrt((d[:, 1:] ** 2).mean(1)).clip(1e-7)
    n = len(xyz)
    log_scales = np.repeat(np.log(dist * INIT_SCALE)[:, None], 3, 1)
    params = {
        "means": torch.from_numpy(xyz),
        "scales": torch.from_numpy(log_scales.astype(np.float32)),
        "quats": torch.rand(n, 4),
        "opacities": torch.logit(torch.full((n,), INIT_OPACITY)),
        "sh0": torch.from_numpy((rgb - 0.5) / SH_C0)[:, None, :],
    }
    if sh_degree > 0:
        params["shN"] = torch.zeros(n, (sh_degree + 1) ** 2 - 1, 3)
    return params


def read_init(path: Path, max_splats: int, sh_degree: int) -> dict:
    """Splats to fine-tune from: a 3DGS PLY (contract §1) or an SPZ v2 room (scan/src/nook_scan/spz.py's format), in
    the capture's world frame. Higher SH bands than `sh_degree` are dropped, missing ones start at zero; past
    `max_splats`, the most opaque are kept."""
    import gzip
    import struct

    data = path.read_bytes()
    if data[:2] == b"\x1f\x8b":  # SPZ: gzip of a header, then each attribute for all splats in turn
        raw = gzip.decompress(data)
        magic, ver, n, deg, frac = struct.unpack_from("<IIIBB", raw, 0)
        if magic != 0x5053474E or ver != 2:
            raise Fail(f"{path}: not an SPZ v2 file")
        dim = (deg + 1) ** 2 - 1
        off, parts = 16, {}
        for k, size in (("pos", 9), ("alpha", 1), ("color", 3), ("scale", 3), ("rot", 3), ("sh", dim * 3)):
            parts[k] = np.frombuffer(raw, np.uint8, n * size, off).reshape(n, size).astype(np.float32)
            off += n * size
        b = parts["pos"].reshape(n, 3, 3).astype(np.int64)
        fixed = b[..., 0] + (b[..., 1] << 8) + (b[..., 2] << 16)
        means = (np.where(fixed >= 1 << 23, fixed - (1 << 24), fixed) / float(1 << frac)).astype(np.float32)
        alpha = (parts["alpha"][:, 0] / 255.0).clip(1e-4, 1 - 1e-4)
        xyz = parts["rot"] / 127.5 - 1.0
        quats = np.concatenate([np.sqrt((1 - (xyz ** 2).sum(1, keepdims=True)).clip(0)), xyz], 1)  # wxyz
        p = {"means": means, "scales": parts["scale"] / 16.0 - 10.0, "quats": quats,
             "opacities": np.log(alpha / (1 - alpha)),
             "sh0": ((parts["color"] / 255.0 - 0.5) / 0.15)[:, None, :],
             "shN": ((parts["sh"] - 128.0) / 128.0).reshape(n, dim, 3)}
    else:
        head, _, body = data.partition(b"end_header\n")
        names = [ln.split()[-1] for ln in head.decode().splitlines() if ln.startswith("property")]
        if b"binary_little_endian" not in head or "opacity" not in names:
            raise Fail(f"{path}: not a binary 3DGS splat PLY (see contract §1)")
        v = np.frombuffer(body, "<f4").reshape(-1, len(names))
        col = {c: v[:, i] for i, c in enumerate(names)}
        rest = sorted((c for c in names if c.startswith("f_rest_")), key=lambda c: int(c[7:]))
        n, dim = len(v), len(rest) // 3
        p = {"means": np.stack([col["x"], col["y"], col["z"]], 1),
             "scales": np.stack([col[f"scale_{i}"] for i in range(3)], 1),
             "quats": np.stack([col[f"rot_{i}"] for i in range(4)], 1), "opacities": col["opacity"],
             "sh0": np.stack([col[f"f_dc_{i}"] for i in range(3)], 1)[:, None, :],
             "shN": np.stack([col[c] for c in rest], 1).reshape(n, 3, dim).transpose(0, 2, 1) if dim
             else np.zeros((n, 0, 3), np.float32)}
    if n > max_splats:
        keep = np.argsort(-p["opacities"])[:max_splats]
        p = {k: a[keep] for k, a in p.items()}
    want = (sh_degree + 1) ** 2 - 1
    sh = np.zeros((len(p["means"]), want, 3), np.float32)
    sh[:, :min(want, p["shN"].shape[1])] = p["shN"][:, :want]
    params = {k: torch.from_numpy(np.ascontiguousarray(p[k], dtype=np.float32))
              for k in ("means", "scales", "quats", "opacities", "sh0")}
    if sh_degree > 0:
        params["shN"] = torch.from_numpy(sh)
    return params


def depth_loss(pred: torch.Tensor, lidar: torch.Tensor) -> torch.Tensor:
    """L1 in log depth between the rendered expected depth ([H, W], averaged down to the LiDAR map's size) and LiDAR,
    on pixels LiDAR is sure of: a return under 5 m, away from depth edges (where the coarse map blends near and far)."""
    dh, dw = lidar.shape
    p = F.adaptive_avg_pool2d(pred[None, None], (dh, dw))[0, 0]
    d = lidar.float()
    near = -F.max_pool2d(-torch.where(d > 0, d, torch.full_like(d, 1e3))[None, None], 3, 1, 1)[0, 0]
    far = F.max_pool2d(d[None, None], 3, 1, 1)[0, 0]
    ok = (d > 0.15) & (d < 5.0) & (far - near < 0.1 * d) & (p > 0.01)
    if not ok.any():
        return pred.sum() * 0.0
    return (torch.log(p[ok]) - torch.log(d[ok])).abs().mean()


class SSIM(torch.nn.Module):
    """SSIM with an 11x11 Gaussian window (sigma 1.5) and "valid" padding: a slow (~30 ms per 1920x1440 step)
    stand-in for fused_ssim, which simple_trainer uses and the Nix package ships."""

    def __init__(self, device):
        super().__init__()
        g = torch.exp(-((torch.arange(11, dtype=torch.float32) - 5) ** 2) / (2 * 1.5**2))
        self.g = (g / g.sum()).to(device)

    def blur(self, x):  # [1, C, H, W], separable
        c = x.shape[1]
        x = F.conv2d(x, self.g.view(1, 1, 1, 11).expand(c, 1, 1, 11), groups=c)
        return F.conv2d(x, self.g.view(1, 1, 11, 1).expand(c, 1, 11, 1), groups=c)

    def forward(self, x, y):  # x: render, y: target; [1, 3, H, W]
        with torch.no_grad():
            mu_y, yy = self.blur(torch.cat([y, y * y], 1)).chunk(2, 1)
        mu_x, xx, xy = self.blur(torch.cat([x, x * x, x * y], 1)).chunk(3, 1)
        c1, c2 = 0.01**2, 0.03**2
        sxx, syy, sxy = xx - mu_x * mu_x, yy - mu_y * mu_y, xy - mu_x * mu_y
        num = (2 * mu_x * mu_y + c1) * (2 * sxy + c2)
        den = (mu_x * mu_x + mu_y * mu_y + c1) * (sxx + syy + c2)
        return (num / den).mean()


def write_ply(path: Path, splats, sh_degree: int) -> int:
    """Standard 3DGS PLY: x y z nx ny nz f_dc_0..2 f_rest_* opacity scale_0..2 rot_0..3 (logit opacity, log scales,
    normalized wxyz quaternions; f_rest channel-major like the reference implementation)."""
    with torch.no_grad():
        n = len(splats["means"])
        rest = (splats["shN"].transpose(1, 2).reshape(n, -1) if sh_degree > 0
                else torch.zeros(n, 0, device=splats["means"].device))
        cols = torch.cat([splats["means"], torch.zeros_like(splats["means"]), splats["sh0"].reshape(n, 3), rest,
                          splats["opacities"].reshape(n, 1), splats["scales"],
                          F.normalize(splats["quats"], dim=-1)], 1)
        data = cols.float().cpu().numpy()
    ok = np.isfinite(data).all(1)
    if not ok.all():
        say(f"dropping {int((~ok).sum())} splats with non-finite parameters")
        data = data[ok]
    names = (["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
             + [f"f_rest_{i}" for i in range(rest.shape[1])]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    head = ("ply\nformat binary_little_endian 1.0\n"
            "comment nook-gsplat splat, capture world coordinates (Y up, meters)\n"
            f"element vertex {len(data)}\n" + "".join(f"property float {c}\n" for c in names) + "end_header\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(head.encode() + data.astype("<f4").tobytes())
    os.replace(tmp, path)
    return len(data)


def exposure_poses(c2w: np.ndarray, stamps: list, Ks: np.ndarray, samples: int, px_per_sample: float,
                   readout_s: float) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """Camera-to-world poses (OpenCV) across each frame's exposure, from the camera's motion between its neighbours
    in time: [N, samples, 4, 4] at the start of the readout, the same at its end (rolling shutter; equal to the first
    when readout_s is 0), and how many of the samples each frame uses. A frame that moved by under px_per_sample
    pixels during its exposure (or has no timestamp) gets one sample, its own pose.

    The poses are spread evenly over the exposure (`exposure_duration`, 10 ms when missing), centered on the frame's
    timestamp; with a readout time, the top row sees the pose readout_s / 2 earlier and the bottom row readout_s / 2
    later. Velocities are central differences over the neighbouring frames, so the camera path is taken as straight
    and evenly turning over the exposure: the shape of the blur, not just its length."""
    from scipy.spatial.transform import Rotation

    n = len(c2w)
    start = np.repeat(c2w[:, None], samples, 1)
    end = start.copy()
    counts = [1] * n
    timed = sorted((s[0], i) for i, s in enumerate(stamps) if s[0] is not None)
    for r, (t, i) in enumerate(timed):
        a, b = timed[max(r - 1, 0)], timed[min(r + 1, len(timed) - 1)]
        dt = b[0] - a[0]
        if dt <= 0 or dt > 0.6:  # an end of the walk, or a gap: no reliable motion
            continue
        ra, rb = c2w[a[1], :3, :3], c2w[b[1], :3, :3]
        omega = Rotation.from_matrix(rb @ ra.T).as_rotvec() / dt  # world frame, rad/s
        vel = (c2w[b[1], :3, 3] - c2w[a[1], :3, 3]) / dt
        exp_s = stamps[i][1] or 0.01
        f = float(Ks[i, 0, 0])
        blur_px = f * exp_s * (np.linalg.norm(omega) + np.linalg.norm(vel) / 1.5)  # rotation, plus moving 1.5 m away
        k = int(min(samples, max(1, math.ceil(blur_px / px_per_sample))))
        if k == 1 and readout_s <= 0:
            continue
        counts[i] = k
        offs = np.linspace(-exp_s / 2, exp_s / 2, k) if k > 1 else np.zeros(1)
        for j, tau in enumerate(offs):
            for out, d in ((start, -readout_s / 2), (end, readout_s / 2)):
                m = c2w[i].copy()
                m[:3, :3] = Rotation.from_rotvec(omega * (tau + d)).as_matrix() @ m[:3, :3]
                m[:3, 3] += vel * (tau + d)
                out[i, j] = m
    return start, end, counts


def rot6d_to_matrix(d6: torch.Tensor) -> torch.Tensor:
    """[N, 6] continuous rotation representation (Zhou et al. 2019) to [N, 3, 3] rotation matrices."""
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    return torch.stack((b1, b2, torch.cross(b1, b2, dim=-1)), dim=-2)


class PoseCorrection(torch.nn.Module):
    """A learnable correction per training camera (simple_trainer's --pose_opt): a small translation and rotation in
    the camera's own frame, starting at zero. ARKit's poses drift by centimeters over a room walk; splat training
    needs the views to agree to millimeters, so the drift shows up as blur and ghosting unless the poses can move."""

    IDENTITY_6D = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)

    def __init__(self, camtoworlds: torch.Tensor):
        super().__init__()
        self.register_buffer("c2w", camtoworlds)
        self.register_buffer("ident", torch.tensor(self.IDENTITY_6D, device=camtoworlds.device))
        self.embed = torch.nn.Embedding(len(camtoworlds), 9, device=camtoworlds.device)
        torch.nn.init.zeros_(self.embed.weight)

    def delta(self, idx: torch.Tensor) -> torch.Tensor:
        d = self.embed(idx)
        t = torch.eye(4, device=d.device).repeat(len(idx), 1, 1)
        t[:, :3, :3] = rot6d_to_matrix(d[:, 3:] + self.ident)
        t[:, :3, 3] = d[:, :3]
        return t

    def viewmats(self, idx: torch.Tensor, c2w: torch.Tensor | None = None) -> torch.Tensor:
        """View matrices of cameras `idx`, corrected; `c2w` ([len(idx), 4, 4], default: their poses) applies the same
        correction to other poses of those cameras, e.g. across the exposure."""
        return torch.linalg.inv((self.c2w[idx] if c2w is None else c2w) @ self.delta(idx))

    @torch.no_grad()
    def stats(self) -> dict:
        t = self.delta(torch.arange(len(self.c2w), device=self.c2w.device))
        shift_cm = t[:, :3, 3].norm(dim=-1) * 100
        cos = ((t[:, 0, 0] + t[:, 1, 1] + t[:, 2, 2] - 1) / 2).clamp(-1, 1)
        deg = torch.rad2deg(torch.acos(cos))
        return {"shift_cm_median": round(shift_cm.median().item(), 2), "shift_cm_max": round(shift_cm.max().item(), 2),
                "rot_deg_median": round(deg.median().item(), 3), "rot_deg_max": round(deg.max().item(), 3)}


class PoseAdam:
    """Adam over one camera at a time. Each camera has its own moments and step count, and only the drawn camera moves:
    a plain Adam keeps stepping every camera on stale momentum, and its step count, shared by all cameras, turns a
    camera's first update into about 3 x lr instead of lr. A camera is drawn only steps / n times, so lr sets its reach:
    about lr x that many in meters and radians, less with the decay."""

    def __init__(self, weight: torch.nn.Parameter, lr: float, steps: int, betas=(0.9, 0.999), eps=1e-15):
        self.weight, self.lr, self.gamma, self.betas, self.eps = weight, lr, 0.01 ** (1.0 / steps), betas, eps
        self.m, self.v = torch.zeros_like(weight), torch.zeros_like(weight)
        self.t = torch.zeros(len(weight), device=weight.device)

    @torch.no_grad()
    def step(self, i: int, global_step: int) -> None:
        g, (b1, b2) = self.weight.grad[i], self.betas
        self.t[i] += 1
        self.m[i] = b1 * self.m[i] + (1 - b1) * g
        self.v[i] = b2 * self.v[i] + (1 - b2) * g * g
        m_hat, v_hat = self.m[i] / (1 - b1 ** self.t[i]), self.v[i] / (1 - b2 ** self.t[i])
        self.weight[i] -= self.lr * self.gamma ** global_step * m_hat / (v_hat.sqrt() + self.eps)
        self.weight.grad = None


def train(args) -> dict:
    started = time.time()
    if not torch.cuda.is_available():
        raise Fail("no CUDA GPU available: nook-gsplat needs an NVIDIA GPU and its driver (libcuda.so, "
                   "/run/opengl-driver/lib on NixOS)")
    from gsplat import MCMCStrategy, SelectiveAdam, rasterization
    from gsplat.cuda._wrapper import RollingShutterType
    from gsplat.version import __version__ as gsplat_version

    dev = torch.device("cuda")
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    torch.backends.cudnn.benchmark = True

    t, n_frames, images, viewmats, Ks, centers, seeds, depths, stamps = load_capture(
        Path(args.capture), args.holdout_every, args.max_image_size, args.stills_max_size, with_depth=args.depth_weight > 0)
    n = len(images)
    scene_scale = 1.1 * float(np.linalg.norm(centers - centers.mean(0), axis=1).max())
    scene_scale = max(scene_scale, 0.1)
    sizes = sorted({(im.shape[1], im.shape[0]) for im in images})
    say(f"{n} training frames, {n_frames - n} held out, images {' '.join(f'{w}x{h}' for w, h in sizes)}, "
        f"{len(seeds[0]) if seeds else 0} seed points, scene scale {scene_scale:.2f} m "
        f"(loaded in {time.time() - started:.1f} s)")
    if seeds is None:
        say("no points.ply: starting from random points around the cameras")

    if args.init:
        init = read_init(Path(args.init), args.max_splats, args.sh_degree)
        say(f"fine-tuning {len(init['means']):,} splats from {args.init}")
    else:
        init = init_splats(seeds, centers, scene_scale, args.max_splats, args.sh_degree, rng)
    if args.depth_weight > 0:
        with_depth = sum(d is not None for d in depths)
        say(f"depth loss {args.depth_weight:g} against LiDAR in {with_depth} of {n} training frames")
    splats = torch.nn.ParameterDict({k: torch.nn.Parameter(v) for k, v in init.items()}).to(dev)
    lrs = {"means": (1.6e-5 if args.init else 1.6e-4) * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2,
           "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    # SelectiveAdam (simple_trainer's --visible_adam) only steps splats seen in the current frame. A room walk-through
    # sees each splat in a few percent of its frames; plain Adam keeps moving the unseen ones on stale momentum.
    optimizers = {k: SelectiveAdam([{"params": splats[k], "lr": lrs[k], "name": k}], eps=1e-15, betas=(0.9, 0.999))
                  for k in splats}
    means_sched = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / args.steps))
    strategy = MCMCStrategy(cap_max=args.max_splats, refine_stop_iter=args.steps * 5 // 6)
    strategy.check_sanity(splats, optimizers)
    state = strategy.initialize_state()
    try:
        from fused_ssim import fused_ssim

        def ssim(x, y):
            return fused_ssim(x.contiguous(), y.contiguous(), padding="valid")
    except ImportError:
        say("fused_ssim not installed: using a slower SSIM in plain PyTorch")
        ssim = SSIM(dev)
    max_log_scale = math.log(MAX_SCALE * scene_scale)
    viewmats, Ks = viewmats.to(dev), Ks.to(dev)
    poses = None
    if args.pose_opt:
        poses = PoseCorrection(torch.linalg.inv(viewmats))
        pose_optim = PoseAdam(poses.embed.weight, args.pose_opt_lr, args.steps)
        say(f"refining camera poses (lr {args.pose_opt_lr:g}); held-out frames keep their ARKit poses")
    sub_start = sub_end = None
    if args.motion_blur > 1 or args.rolling_shutter_ms > 0:
        c2w_np = torch.linalg.inv(viewmats).cpu().double().numpy()
        start_np, end_np, counts = exposure_poses(c2w_np, stamps, Ks.cpu().numpy(), max(1, args.motion_blur),
                                                  args.motion_blur_px, args.rolling_shutter_ms / 1000)
        sub_start = torch.tensor(start_np, dtype=torch.float32, device=dev)
        sub_end = torch.tensor(end_np, dtype=torch.float32, device=dev)
        timed = sum(s[0] is not None for s in stamps)
        say(f"modelling camera motion during the exposure in {timed} of {n} frames: "
            f"{sum(c > 1 for c in counts)} blurred enough for {max(counts)} poses (mean {np.mean(counts):.2f} renders "
            f"per step)" + (f", rolling shutter read out in {args.rolling_shutter_ms:g} ms" if args.rolling_shutter_ms > 0 else ""))

    say(f"training {args.steps} steps, up to {args.max_splats:,} splats of at most {MAX_SCALE * scene_scale:.2f} m, "
        f"SH degree {args.sh_degree} (gsplat {gsplat_version}, {torch.cuda.get_device_name(0)})")
    torch.cuda.reset_peak_memory_stats()
    loop_start = time.time()
    order = rng.permutation(n)
    last_t, last_step = loop_start, 0
    loss_sum = torch.zeros((), device=dev)
    for step in range(args.steps):
        i = int(order[step % n])
        if step % n == n - 1:
            order = rng.permutation(n)
        img = images[i].to(dev, non_blocking=True)
        h, w = img.shape[:2]
        K = Ks[i:i + 1]
        if args.res_ramp > 0 and not args.init and step < args.res_ramp * args.steps:  # low resolution first (DashGaussian's idea)
            s = args.res_start + (1 - args.res_start) * step / (args.res_ramp * args.steps)
            nh, nw = max(16, round(h * s / 2) * 2), max(16, round(w * s / 2) * 2)
            img = F.interpolate(img.permute(2, 0, 1)[None].float(), (nh, nw), mode="area")[0].permute(1, 2, 0)
            K = K * torch.tensor([[[nw / w], [nh / h], [1.0]]], device=dev)
            h, w = nh, nw
        sh_deg = args.sh_degree if args.init else min(step // SH_INTERVAL, args.sh_degree)
        colors = torch.cat([splats["sh0"], splats["shN"]], 1) if args.sh_degree > 0 else splats["sh0"]
        if sub_start is None:  # one pinhole camera at the frame's pose
            k, rs = 1, {}
            vm = poses.viewmats(torch.tensor([i], device=dev)) if poses is not None else viewmats[i:i + 1]
        else:  # the k poses across the exposure, rendered together and averaged: the photo's motion blur
            k = counts[i]
            cams = torch.full((k,), i, device=dev)
            if poses is not None:
                vm = poses.viewmats(cams, sub_start[i, :k])
                vm_rs = poses.viewmats(cams, sub_end[i, :k])
            else:
                vm, vm_rs = torch.linalg.inv(sub_start[i, :k]), torch.linalg.inv(sub_end[i, :k])
            rs = ({"with_ut": True, "with_eval3d": True, "viewmats_rs": vm_rs,
                   "rolling_shutter": RollingShutterType.ROLLING_TOP_TO_BOTTOM} if args.rolling_shutter_ms > 0 else {})
        renders, _, info = rasterization(
            means=splats["means"], quats=splats["quats"], scales=torch.exp(splats["scales"]),
            opacities=torch.sigmoid(splats["opacities"]), colors=colors,
            viewmats=vm, Ks=K.expand(k, 3, 3), width=w, height=h,
            sh_degree=sh_deg, packed=False, near_plane=0.01, far_plane=1e10, rasterize_mode="classic",
            render_mode="RGB+ED" if depths[i] is not None else "RGB", **rs)
        renders = renders.mean(0, keepdim=True)
        pred = renders[0, ..., :3]  # [H, W, 3]
        target = img.float() / 255.0  # the ramp's area average is float already, and still 0-255
        l1 = (pred - target).abs().mean()
        ssim_val = ssim(pred.permute(2, 0, 1)[None], target.permute(2, 0, 1)[None])
        loss = (1 - SSIM_LAMBDA) * l1 + SSIM_LAMBDA * (1 - ssim_val)
        loss_sum += loss.detach()
        if depths[i] is not None:
            loss = loss + args.depth_weight * depth_loss(renders[0, ..., 3], depths[i].to(dev, non_blocking=True))
        loss = loss + OPACITY_REG * torch.sigmoid(splats["opacities"]).mean()
        loss = loss + SCALE_REG * torch.exp(splats["scales"]).mean()
        loss.backward()
        visible = (info["radii"] > 0).all(-1).any(0)  # [N]
        for opt in optimizers.values():
            opt.step(visible)
            opt.zero_grad(set_to_none=True)
        if poses is not None:
            pose_optim.step(i, step)
        means_sched.step()
        with torch.no_grad():
            splats["scales"].clamp_(max=max_log_scale)
        strategy.step_post_backward(splats, optimizers, state, step, info, lr=means_sched.get_last_lr()[0])

        done = step + 1
        if done % PROGRESS_EVERY == 0 or done == args.steps:
            now = time.time()
            rate = (done - last_step) / max(now - last_t, 1e-9)
            mean_loss = loss_sum.item() / (done - last_step)
            loss_sum.zero_()
            last_t, last_step = now, done
            eta = (args.steps - done) / max(rate, 1e-9)
            with torch.no_grad():  # health: tile intersections in this view (VRAM driver), share from splats < 0.5 m
                ids = info["flatten_ids"].long()  # away from the camera, and the largest splat sizes
                near = (info["depths"].reshape(-1)[ids] < 0.5).float().mean().item() if len(ids) else 0.0
                smax = torch.exp(splats["scales"].max(1).values)
                s999 = torch.quantile(smax[:: max(1, len(smax) // 1_000_000)], 0.999).item()
            print(f"step {done}/{args.steps}  splats {len(splats['means']) // 1000}k  loss {mean_loss:.4f}  "
                  f"{rate:.1f} steps/s  {fmt(now - loop_start)} elapsed  ~{fmt(eta)} left  "
                  f"vram {torch.cuda.max_memory_reserved() / 2**30:.2f} GiB  isects {len(ids) / 1e6:.1f}M "
                  f"({near:.0%} near)  scale p99.9 {s999:.2f} max {smax.max().item():.1f} m",
                  file=sys.stderr, flush=True)
    torch.cuda.synchronize()
    train_secs = time.time() - loop_start

    out = Path(args.out)
    written = write_ply(out, splats, args.sh_degree)
    total = time.time() - started
    say(f"wrote {written:,} splats to {out} ({train_secs / 60:.1f} min training, {total / 60:.1f} min total)")
    pose_stats = poses.stats() if poses is not None else None
    if pose_stats:
        say(f"pose corrections: shift median {pose_stats['shift_cm_median']} cm (max {pose_stats['shift_cm_max']}), "
            f"rotation median {pose_stats['rot_deg_median']} deg (max {pose_stats['rot_deg_max']})")
    return {"ply": str(out), "splats": written, "steps": args.steps, "seconds": round(total, 1),
            "train_seconds": round(train_secs, 1), "steps_per_s": round(args.steps / train_secs, 2),
            "frames": {"train": n, "held_out": n_frames - n}, "sh_degree": args.sh_degree,
            "max_splats": args.max_splats, "max_image_size": args.max_image_size,
            "stills_max_size": args.stills_max_size or args.max_image_size,
            "peak_vram_gib": {"allocated": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                              "reserved": round(torch.cuda.max_memory_reserved() / 2**30, 2)},
            "trainer": f"gsplat {gsplat_version} (MCMC)", "pose_opt": pose_stats,
            "init": args.init, "depth_weight": args.depth_weight, "res_ramp": args.res_ramp,
            "res_start": args.res_start, "rolling_shutter_ms": args.rolling_shutter_ms,
            "pose_opt_lr": args.pose_opt_lr if args.pose_opt else None}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="nook-gsplat", description=__doc__.split("\n\n")[0])
    p.add_argument("capture", help="unzipped capture folder (contains transforms.json)")
    p.add_argument("--out", required=True, help="output .ply")
    p.add_argument("--steps", type=int, default=20_000)
    p.add_argument("--max-splats", type=int, default=1_200_000)
    p.add_argument("--max-image-size", type=int, default=1920, help="downscale so the long side is at most this")
    p.add_argument("--stills-max-size", type=int, help="the same for frames marked \"still\" (default: --max-image-size)")
    p.add_argument("--sh-degree", type=int, default=1, choices=range(4))
    p.add_argument("--holdout-every", type=int, default=0, help="skip frames with index %% N == 0 (0: train on all)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--pose-opt", action="store_true", help="refine the training cameras' poses along with the splats")
    p.add_argument("--pose-opt-lr", type=float, default=1e-3, help="learning rate of the pose corrections")
    p.add_argument("--depth-weight", type=float, default=0.0,
                   help="weight of a log-depth loss against the frames' LiDAR depth (0: off; 0.1-0.3 keeps floaters "
                        "out of free space)")
    p.add_argument("--motion-blur", type=int, default=1, metavar="K",
                   help="render up to K poses across each photo's exposure and average them, so motion blur in the "
                        "photos isn't learned into the room (1: off); needs timestamps in transforms.json")
    p.add_argument("--motion-blur-px", type=float, default=2.0,
                   help="one pose per this many pixels of predicted motion blur (with --motion-blur)")
    p.add_argument("--rolling-shutter-ms", type=float, default=0.0,
                   help="the sensor's readout time, top row to bottom row (0: global shutter); renders with gsplat's "
                        "rolling-shutter camera (3DGUT)")
    p.add_argument("--res-ramp", type=float, default=0.5, metavar="FRAC",
                   help="grow the training resolution linearly over this fraction of the steps (0: full size throughout; "
                        "--init always trains at full size)")
    p.add_argument("--res-start", type=float, default=0.25, help="the starting scale of --res-ramp")
    p.add_argument("--init", metavar="SPLAT", help="fine-tune from this splat (.ply or .spz, the capture's world frame) "
                                                   "instead of training from seed points; a few thousand steps")
    args = p.parse_args(argv)
    if (args.steps < 1 or args.max_splats < 1000 or args.max_image_size < 16 or args.holdout_every < 0
            or (args.stills_max_size is not None and args.stills_max_size < 16) or args.depth_weight < 0):
        p.error("--steps >= 1, --max-splats >= 1000, --max-image-size and --stills-max-size >= 16, --holdout-every >= 0")
    try:
        summary = train(args)
    except Fail as e:
        print(f"nook-gsplat: {e}", file=sys.stderr)
        sys.exit(1)
    except torch.cuda.OutOfMemoryError:
        print("nook-gsplat: out of GPU memory: lower --max-splats or --max-image-size", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
