"""nook-poses: refine a capture's ARKit camera poses with VGGT (contract §4.11), on kakapo's RTX 2060.

    nook-poses CAPTURE_DIR --out TRANSFORMS.json [--max-frames N] [--chunk 32] [--prior-cm 1.5] [--prior-deg 0.05] [--smooth 3]

ARKit's poses are metric and gravity-aligned, and smooth from frame to frame, but drift by centimeters over a room
walk: when the walk comes back past the same wall, the two passes disagree. VGGT (facebookresearch/vggt, VGGT-1B)
estimates the cameras of a set of images jointly from the images alone, up to a similarity.

1. Chunks: frames are grouped into sets of `--chunk` frames that look at the same things (nearest neighbours by camera
   position and by the point 1.5 m in front of the camera), so a chunk mixes passes that saw the same wall.
   Each chunk goes through VGGT's aggregator (fp16 weights, 518 px wide images) and camera head (fp32).
2. Alignment: each chunk's cameras are mapped into the ARKit world by a Sim(3): rotation by Umeyama on the camera
   centers plus points along each camera's axes (so a chunk walked along a line is still well-posed), then scale and
   translation from the centers alone, with Cauchy reweighting against outliers. The world stays ARKit's: metric,
   gravity-up, same origin.
3. Blend: a frame's corrections (VGGT minus ARKit) from all its chunks are averaged; their spread is VGGT's
   uncertainty, and each correction is shrunk toward zero (ARKit) by prior^2/(prior^2 + spread^2), with ARKit's own
   error taken as `--prior-cm` for positions and `--prior-deg` for rotations. On the first real scan VGGT's chunks
   disagree by ~4 cm and ~1-2 deg, so positions move a little and rotations (ARKit's gyro is much better) stay. Corrections over 25 cm or 10 degrees are dropped as VGGT failures. Since ARKit's error is
   drift (smooth in time) and VGGT's is per-frame noise, the corrections are then smoothed along the walk
   (Gaussian, `--smooth` frames).

Writes TRANSFORMS.json: the input's keys, frames, intrinsics and order, with refined transform_matrix values.
The last stdout line is JSON: {"frames", "shift_cm_median", "shift_cm_max", "rot_deg_median", "seconds", ...}.
Model weights (5 GB, fp32 safetensors) are downloaded on first run into NOOK_POSES_CACHE (default ~/.cache/nook-poses).
NOOK_POSES_VGGT points at the VGGT source tree (the Nix package sets it).
"""

import argparse
import json
import math
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

WEIGHTS_URL = "https://huggingface.co/facebook/VGGT-1B/resolve/860abec7937da0a4c03c41d3c269c366e82abdf9/model.safetensors"
WEIGHTS_FILE = "vggt-1b-860abec7.safetensors"
WEIGHTS_BYTES = 5_026_367_224
WIDTH = 518                      # VGGT's training width; height is the aspect-matched multiple of 14
GL_TO_CV = np.diag([1.0, -1.0, -1.0, 1.0])
MAX_SHIFT_M, MAX_ROT_DEG = 0.25, 10.0


class Fail(Exception):
    pass


def say(msg: str) -> None:
    print(f"nook-poses: {msg}", flush=True)


# ---------------------------------------------------------------- rotations

def rotvec(R: np.ndarray) -> np.ndarray:
    """Axis-angle vector of a rotation matrix."""
    c = np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)
    a = math.acos(c)
    v = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    if a < 1e-8:
        return v / 2
    if a > math.pi - 1e-4:  # near 180 degrees: from the symmetric part
        w, V = np.linalg.eigh((R + R.T) / 2)
        return V[:, -1] * a
    return v * (a / (2 * math.sin(a)))


def expmap(v: np.ndarray) -> np.ndarray:
    a = float(np.linalg.norm(v))
    if a < 1e-12:
        return np.eye(3)
    k = v / a
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def project_so3(M: np.ndarray) -> np.ndarray:
    U, _, Vt = np.linalg.svd(M)
    D = np.diag([1.0, 1.0, np.sign(np.linalg.det(U @ Vt))])
    return U @ D @ Vt


def angle_deg(R: np.ndarray) -> float:
    return math.degrees(math.acos(np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)))


# ---------------------------------------------------------------- model

def weights_path() -> Path:
    cache = Path(os.environ.get("NOOK_POSES_CACHE") or "~/.cache/nook-poses").expanduser()
    path = cache / WEIGHTS_FILE
    if path.is_file() and path.stat().st_size == WEIGHTS_BYTES:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    say(f"downloading VGGT-1B weights (5.0 GB, once) into {cache}")
    try:
        with urllib.request.urlopen(WEIGHTS_URL, timeout=60) as r, open(part, "wb") as f:
            done, shown = 0, 0
            while chunk := r.read(1 << 22):
                f.write(chunk)
                done += len(chunk)
                if done - shown >= WEIGHTS_BYTES // 10:
                    shown = done
                    say(f"  {done / WEIGHTS_BYTES:.0%}")
    except OSError as e:
        raise Fail(f"can't download the VGGT weights ({e}): check the network, or put {WEIGHTS_FILE} in {cache}")
    if part.stat().st_size != WEIGHTS_BYTES:
        raise Fail(f"the VGGT weights download is incomplete ({part.stat().st_size} bytes): run again")
    part.rename(path)
    return path


def read_safetensors(path: Path, prefix: str) -> dict:
    """The tensors under `prefix` (prefix stripped) from a safetensors file, memory-mapped (no safetensors package)."""
    import torch
    dtypes = {"F32": np.float32, "F16": np.float16, "I64": np.int64}
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
    data = np.memmap(path, dtype=np.uint8, mode="r", offset=8 + n)
    out = {}
    for k, v in header.items():
        if k == "__metadata__" or not k.startswith(prefix):
            continue
        a, b = v["data_offsets"]
        arr = np.frombuffer(data[a:b], dtype=dtypes[v["dtype"]]).reshape(v["shape"])
        out[k[len(prefix):]] = torch.from_numpy(arr.copy())
    return out


def load_model(device):
    import torch
    vggt_src = os.environ.get("NOOK_POSES_VGGT")
    if vggt_src:
        sys.path.insert(0, vggt_src)
    try:
        from vggt.heads.camera_head import CameraHead
        from vggt.models.aggregator import Aggregator
    except ImportError:
        raise Fail("can't import VGGT: set NOOK_POSES_VGGT to a checkout of github.com/facebookresearch/vggt")
    path = weights_path()
    say("loading VGGT-1B (aggregator in fp16, camera head in fp32)")
    agg = Aggregator(img_size=518, patch_size=14, embed_dim=1024, cached_layer_indices=())  # keep only the last layer
    agg.load_state_dict(read_safetensors(path, "aggregator."))
    head = CameraHead(dim_in=2048)
    head.load_state_dict(read_safetensors(path, "camera_head."))
    return agg.half().to(device).eval(), head.to(device).eval()


def run_chunk(model, imgs: np.ndarray, device) -> np.ndarray:
    """VGGT on one chunk of (S, H, W, 3) uint8 images: (S, 4, 4) camera-to-world matrices, OpenGL convention, in the
    chunk's own frame (first camera at the origin, VGGT's scale)."""
    import torch
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri
    agg, head = model
    with torch.inference_mode():
        x = torch.from_numpy(imgs).to(device).permute(0, 3, 1, 2).float().div_(255)[None]
        with torch.autocast("cuda", dtype=torch.float16):
            toks, _ = agg(x)
        last = toks[-1][:, :, :1].float()  # the camera head only reads each frame's camera token
        del toks, x
        with torch.autocast("cuda", enabled=False):
            enc = head([last])[-1]
        extr, _ = pose_encoding_to_extri_intri(enc, imgs.shape[1:3], build_intrinsics=False)
    w2c = np.tile(np.eye(4), (len(imgs), 1, 1))
    w2c[:, :3, :4] = extr[0].double().cpu().numpy()
    return np.linalg.inv(w2c) @ GL_TO_CV


# ---------------------------------------------------------------- geometry

def chunks_for(poses: np.ndarray, k: int) -> list[list[int]]:
    """Overlapping sets of k frames that look at the same things, each led by its anchor frame."""
    n = len(poses)
    if n <= k:
        return [list(range(n))]
    c = poses[:, :3, 3]
    look = c - 1.5 * poses[:, :3, 2]  # 1.5 m along the view direction (-Z)
    dist = np.linalg.norm(c[:, None] - c[None], axis=-1) + np.linalg.norm(look[:, None] - look[None], axis=-1)
    chunks, covered = [], np.zeros(n, int)

    def add(a):
        members = [int(j) for j in np.argsort(dist[a], kind="stable")[:k]]
        members.remove(a)
        chunks.append([a] + members)
        covered[chunks[-1]] += 1

    for a in range(0, n, max(1, k // 2)):
        add(a)
    for a in range(n):
        if covered[a] < 2:
            add(a)
    return chunks


def align(src: np.ndarray, dst: np.ndarray, w: np.ndarray, arm: float = 0.3):
    """Sim(3) taking chunk cameras `src` onto ARKit cameras `dst` (both (S,4,4) c2w): returns s, R, t.

    R: weighted Umeyama on the centers plus points `arm` m along each camera's axes; s, t: least squares on centers."""
    cs, cd = src[:, :3, 3], dst[:, :3, 3]
    ws = w / w.sum()
    ms, md = ws @ cs, ws @ cd
    spread_s = math.sqrt(ws @ ((cs - ms) ** 2).sum(1))
    spread_d = math.sqrt(ws @ ((cd - md) ** 2).sum(1))
    s0 = spread_d / max(spread_s, 1e-9)
    P = [cs] + [cs + (arm / s0) * src[:, :3, i] for i in range(3)]
    Q = [cd] + [cd + arm * dst[:, :3, i] for i in range(3)]
    P, Q, W = np.concatenate(P), np.concatenate(Q), np.tile(ws, 4) / 4
    H = ((P - W @ P) * W[:, None]).T @ (Q - W @ Q)
    R = project_so3(H.T)
    rc = (cs - ms) @ R.T
    s = float(ws @ (rc * (cd - md)).sum(1)) / max(float(ws @ (rc ** 2).sum(1)), 1e-12)
    t = md - s * R @ ms
    return s, R, t


def apply_sim3(T: np.ndarray, s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    out = T.copy()
    out[:, :3, :3] = R @ T[:, :3, :3]
    out[:, :3, 3] = s * T[:, :3, 3] @ R.T + t
    return out


def fit_chunk(est: np.ndarray, ark: np.ndarray, iters: int = 4, scale_m: float = 0.05):
    """Robust Sim(3) (Cauchy weights on center residuals): aligned estimates, final weights, RMS residual (m)."""
    w = np.ones(len(est))
    for _ in range(iters):
        s, R, t = align(est, ark, w)
        al = apply_sim3(est, s, R, t)
        r = np.linalg.norm(al[:, :3, 3] - ark[:, :3, 3], axis=1)
        w = 1.0 / (1.0 + (r / scale_m) ** 2)
    return al, w, float(np.sqrt(np.mean(r ** 2))), s


# ---------------------------------------------------------------- main

def load_images(paths: list[Path], size: tuple[int, int]) -> np.ndarray:
    def one(p):
        with Image.open(p) as im:
            im.draft("RGB", (size[0] * 2, size[1] * 2))
            return np.asarray(im.convert("RGB").resize(size, Image.BICUBIC))
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:
        return np.stack(list(pool.map(one, paths)))


def refine(args) -> dict:
    started = time.time()
    root = Path(args.capture).expanduser()
    tf_path = root / "transforms.json"
    if not tf_path.is_file():
        raise Fail(f"{root} has no transforms.json: pass a capture folder (or nook-scan's prepared dataset)")
    doc = json.loads(tf_path.read_text())
    frames = doc["frames"]
    n = len(frames)
    if n < 2:
        raise Fail(f"{tf_path} has {n} frames: need at least 2")
    ark = np.array([f["transform_matrix"] for f in frames], dtype=np.float64)
    paths = [root / f["file_path"] for f in frames]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise Fail(f"{len(missing)} images are missing, e.g. {missing[0]}")

    use = np.arange(n)
    if args.max_frames and n > args.max_frames:
        use = np.unique(np.linspace(0, n - 1, args.max_frames).round().astype(int))
        say(f"estimating {len(use)} of {n} frames (--max-frames); the others get interpolated corrections")
    w0, h0 = int(frames[0].get("w", doc.get("w"))), int(frames[0].get("h", doc.get("h")))
    size = (WIDTH, max(14, round(h0 * WIDTH / w0 / 14) * 14))
    chunks = chunks_for(ark[use], args.chunk)
    say(f"{n} frames, {len(chunks)} chunks of up to {args.chunk}, VGGT at {size[0]}x{size[1]}")

    import torch
    if not torch.cuda.is_available():
        raise Fail("no CUDA GPU available: nook-poses needs an NVIDIA GPU and its driver (libcuda.so, /run/opengl-driver/lib on NixOS)")
    device = torch.device("cuda")
    free, total = torch.cuda.mem_get_info()
    if free < 3.5 * 2**30:
        raise Fail(f"only {free / 2**30:.1f} of {total / 2**30:.1f} GB GPU memory free: VGGT needs about 3.5 GB "
                   "(is another job on the GPU? run under flock ~/nook-gpu.lock)")
    t_load = time.time()
    imgs = load_images([paths[i] for i in use], size)
    model = load_model(device)
    say(f"model and {len(use)} images loaded in {time.time() - t_load:.0f} s")

    # Per estimated frame: aligned estimates from every chunk it is in.
    est: list[list[tuple[np.ndarray, float]]] = [[] for _ in use]
    fits, raw_shift, raw_rot = [], [], []
    t_run = time.time()
    for ci, members in enumerate(chunks):
        idx = use[members]
        span = float(np.linalg.norm(np.ptp(ark[idx, :3, 3], axis=0)))
        try:
            vg = run_chunk(model, imgs[members], device)
        except torch.cuda.OutOfMemoryError:
            raise Fail(f"out of GPU memory on a chunk of {len(members)} frames: lower --chunk")
        if span < 0.1:  # cameras nearly static: scale and translation are unobservable
            continue
        al, w, rms, s = fit_chunk(vg, ark[idx])
        fits.append(rms)
        for m, T, wi in zip(members, al, w):
            est[m].append((T, float(wi)))
        raw_shift.extend(np.linalg.norm(al[:, :3, 3] - ark[idx, :3, 3], axis=1))
        raw_rot.extend(angle_deg(A[:3, :3] @ B[:3, :3].T) for A, B in zip(al, ark[idx]))
        if (ci + 1) % 10 == 0 or ci + 1 == len(chunks):
            say(f"  chunk {ci + 1}/{len(chunks)}: fit to ARKit {rms * 100:.1f} cm RMS, {time.time() - t_run:.0f} s")
    peak = torch.cuda.max_memory_allocated() / 2**30
    del model
    torch.cuda.empty_cache()

    # Combine each frame's estimates, measure their spread (translation in m, rotation in deg), shrink toward ARKit.
    dt = np.zeros((len(use), 3))
    dr = np.zeros((len(use), 3))
    alpha_t, alpha_r = np.zeros(len(use)), np.zeros(len(use))
    spread_t, spread_r, single = np.full(len(use), np.nan), np.full(len(use), np.nan), []
    for m, lst in enumerate(est):
        if not lst:
            continue
        Ts = np.array([T for T, _ in lst])
        ws = np.array([w for _, w in lst]) + 1e-6
        ws /= ws.sum()
        c = ws @ Ts[:, :3, 3]
        R = project_so3(np.einsum("k,kij->ij", ws, Ts[:, :3, :3]))
        a = ark[use[m]]
        dt[m] = c - a[:3, 3]
        dr[m] = rotvec(R @ a[:3, :3].T)
        if len(lst) > 1:
            spread_t[m] = math.sqrt(ws @ (np.linalg.norm(Ts[:, :3, 3] - c, axis=1) ** 2))
            spread_r[m] = math.sqrt(ws @ np.array([angle_deg(T[:3, :3] @ R.T) ** 2 for T in Ts]))
        else:
            single.append(m)
    known = ~np.isnan(spread_t)
    for m in single:  # one estimate only: assume the typical spread
        spread_t[m] = np.median(spread_t[known]) if known.any() else 1.0
        spread_r[m] = np.median(spread_r[known]) if known.any() else 90.0
    # Chunks share most of their frames, so their estimates are correlated and can agree by chance: never trust a
    # frame more than the typical spread warrants.
    if known.any():
        spread_t = np.maximum(spread_t, np.median(spread_t[known]))
        spread_r = np.maximum(spread_r, np.median(spread_r[known]))
    pt, pr = args.prior_cm / 100, args.prior_deg
    for m, lst in enumerate(est):
        if not lst:
            continue
        if np.linalg.norm(dt[m]) > MAX_SHIFT_M or math.degrees(np.linalg.norm(dr[m])) > MAX_ROT_DEG:
            continue  # VGGT got this one wrong
        alpha_t[m] = pt ** 2 / (pt ** 2 + spread_t[m] ** 2)
        alpha_r[m] = pr ** 2 / (pr ** 2 + spread_r[m] ** 2)

    # Smooth the (shrunk) corrections along the walk and apply them to every frame.
    out_t, out_r = np.zeros((n, 3)), np.zeros((n, 3))
    sig = args.smooth
    for i in range(n):
        if sig > 0:
            g = np.exp(-0.5 * ((use - i) / sig) ** 2)
            g[np.abs(use - i) > 3 * sig] = 0
            if g.sum() < 1e-9:  # far from any estimated frame (with --max-frames): nearest one
                g = (use == use[np.argmin(np.abs(use - i))]).astype(float)
        else:
            g = (use == i).astype(float)
            if g.sum() == 0:
                g = (use == use[np.argmin(np.abs(use - i))]).astype(float)
        g /= g.sum()
        out_t[i] = g @ (alpha_t[:, None] * dt)
        out_r[i] = g @ (alpha_r[:, None] * dr)
    refined = ark.copy()
    for i in range(n):
        refined[i, :3, :3] = project_so3(expmap(out_r[i]) @ ark[i, :3, :3])
        refined[i, :3, 3] = ark[i, :3, 3] + out_t[i]

    new = dict(doc)
    new["frames"] = [dict(f, transform_matrix=[[round(float(v), 7) for v in row] for row in refined[i]])
                     for i, f in enumerate(frames)]
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(new, indent=1))
    os.replace(tmp, out)

    shift = np.linalg.norm(out_t, axis=1) * 100
    rot = np.degrees(np.linalg.norm(out_r, axis=1))
    vg_vs = np.array(raw_shift) * 100
    vg_rot = np.array(raw_rot)
    summary = {
        "frames": n, "shift_cm_median": round(float(np.median(shift)), 2), "shift_cm_max": round(float(shift.max()), 2),
        "rot_deg_median": round(float(np.median(rot)), 3), "rot_deg_max": round(float(rot.max()), 3),
        "seconds": round(time.time() - started, 1),
        "model": "VGGT-1B", "estimated": int(sum(1 for e in est if e)), "chunks": len(chunks), "chunk": args.chunk,
        "chunk_fit_cm_median": round(float(np.median(fits)) * 100, 2) if fits else None,
        "vggt_vs_arkit_cm_median": round(float(np.median(vg_vs)), 2) if len(vg_vs) else None,
        "vggt_vs_arkit_deg_median": round(float(np.median(vg_rot)), 3) if len(vg_rot) else None,
        "spread_cm_median": round(float(np.nanmedian(spread_t)) * 100, 2) if known.any() else None,
        "spread_deg_median": round(float(np.nanmedian(spread_r)), 3) if known.any() else None,
        "trust_t_median": round(float(np.median(alpha_t)), 3), "trust_r_median": round(float(np.median(alpha_r)), 4),
        "gpu_peak_gb": round(peak, 2),
    }
    say(f"VGGT vs ARKit before blending: median {summary['vggt_vs_arkit_cm_median']} cm, "
        f"{summary['vggt_vs_arkit_deg_median']} deg; VGGT's own spread between chunks: {summary['spread_cm_median']} cm, "
        f"{summary['spread_deg_median']} deg")
    say(f"poses moved: median {summary['shift_cm_median']} cm (max {summary['shift_cm_max']}), rotation median "
        f"{summary['rot_deg_median']} deg (max {summary['rot_deg_max']})")
    return summary


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="nook-poses", description=__doc__.split("\n\n")[0])
    p.add_argument("capture", help="capture folder (or nook-scan's prepared dataset) with transforms.json")
    p.add_argument("--out", required=True, help="where to write the refined transforms.json")
    p.add_argument("--max-frames", type=int, default=0, help="estimate at most N frames, evenly spread (0: all)")
    p.add_argument("--chunk", type=int, default=32, help="frames per VGGT pass (GPU memory grows with it)")
    p.add_argument("--prior-cm", type=float, default=1.5, help="ARKit's expected position error: VGGT's position corrections "
                                                               "are trusted by prior^2 / (prior^2 + VGGT's spread^2)")
    p.add_argument("--prior-deg", type=float, default=0.05, help="ARKit's expected rotation error, likewise. ARKit's rotations "
                                                                 "(gyro) are far better than VGGT's, so they are all but kept")
    p.add_argument("--smooth", type=float, default=3.0, help="Gaussian smoothing of the corrections along the walk, in frames (0: off)")
    args = p.parse_args(argv)
    if args.chunk < 4 or args.max_frames < 0 or args.prior_cm <= 0 or args.prior_deg <= 0 or args.smooth < 0:
        p.error("--chunk >= 4, --max-frames >= 0, --prior-cm > 0, --prior-deg > 0, --smooth >= 0")
    try:
        summary = refine(args)
    except Fail as e:
        print(f"nook-poses: error: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
