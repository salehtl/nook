"""The one scoreboard for nook training runs: score a trained splat on the held-out frames and write one report.

score.py SPLAT.ply DATA_DIR --out metrics.json --save-dir DIR [--summary summary.json] [--max-frames N]
         [--floor-y Y] [--views views.json] [--align-iters 150] [--spark] [--spark-args "--max 8"]

DATA_DIR holds transforms_val.json (the held-out frames, the same for every run) and images/. Prints one JSON line
(the report without its rows) and writes metrics.json (with them). Scores whatever PLY it is given.

Every held-out camera's pose is first aligned to its photo (6-DoF, splats frozen), so pose error in the held-out frame
itself is not scored as blur. PSNR, SSIM (fused_ssim, padding="valid"), LPIPS (AlexNet, v0.1 weights, images in [-1, 1],
full resolution) and both sharpness ratios are on the aligned render; psnr_raw is the same render before alignment.

Groups: all frames; each stretch of the path (a frame's `stretch` key, else runs of frames split at gaps in the file
numbers); sharp (the lowest-blur half, by exposure and the camera's velocity from its neighbours in time).

Saved in DIR: frames/<frame>.jpg (render | photo, 12 frames chosen from transforms_val.json alone, so the same names
in every run), crops/<frame>.jpg (the same at 1:1 around the photo's most detailed region, so the same pixels in every
run) and, with --views or --floor-y, views/<name>.jpg (no score). Without --views, --floor-y uses make_views.py's choice.

--spark also judges in Spark with software GL (psnr_judge.mjs --val) and merges its mean_psnr. Off by default: slow.
It needs a playwright-core next to the judge (`npm ci`); node and chromium come from the flake's `sharpness` shell."""
import argparse, json, math, os, shlex, shutil, subprocess, sys, time, urllib.request, hashlib
from pathlib import Path
import numpy as np, torch, torch.nn.functional as F
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_views import make_views
from gsplat import rasterization
from fused_ssim import fused_ssim

SAVED_FRAMES = 12
CROP_W, CROP_H = 400, 300
METRICS = ("psnr", "psnr_raw", "ssim", "lpips", "sharp_ratio", "sharp_ratio_blur", "align_cm", "align_deg")
NOTES = {
    "sharp_ratio": "render / photo gradient energy, 1.0 = as sharp as the photo. Photo noise inflates the photo side, "
                   "so this reads low on noisy photos; sharp_ratio_blur is the same after a Gaussian blur of both "
                   "(sigma 1 px), which removes most of the noise.",
    "lpips": "AlexNet (torchvision weights), LPIPS v0.1 linear layers, on aligned renders; lower is better.",
    "blur_px": "exposure x (angular speed + linear speed / 2 m) x focal length: an estimate, used only to rank frames.",
}

dev = torch.device(os.environ.get("NOOK_SCORE_DEVICE", "cuda"))
gl_to_cv = np.diag([1.0, -1.0, -1.0, 1.0])


# --- LPIPS: github.com/richzhang/PerceptualSimilarity's network, without torchvision (which $PY does not have) ---
LPIPS_CACHE = Path(os.environ.get("NOOK_LPIPS_CACHE", Path.home() / "nook-exp/lpips-cache"))
LPIPS_FILES = {
    "alexnet-owt-7be5be79.pth": ("https://download.pytorch.org/models/alexnet-owt-7be5be79.pth", "7be5be791159472b1fbf3c69796f7cb30dca7ad8466c2df70058c37116cdee02"),
    "lpips-alex-v0.1.pth": ("https://raw.githubusercontent.com/richzhang/PerceptualSimilarity/master/lpips/weights/v0.1/alex.pth", "df73285e35b22355a2df87cdb6b70b343713b667eddbda73e1977e0c860835c0"),
}


def lpips_weights(name):
    url, sha = LPIPS_FILES[name]
    path = LPIPS_CACHE / name
    if not path.exists():
        LPIPS_CACHE.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha:
        raise SystemExit(f"score: {path} does not match its checksum")
    return torch.load(path, map_location="cpu", weights_only=True)


class Lpips:
    # AlexNet's feature layers up to each of the five ReLUs LPIPS reads: (conv index, in, out, kernel, stride, padding)
    CONVS = [(0, 3, 64, 11, 4, 2), (3, 64, 192, 5, 1, 2), (6, 192, 384, 3, 1, 1), (8, 384, 256, 3, 1, 1), (10, 256, 256, 3, 1, 1)]

    def __init__(self):
        alex = lpips_weights("alexnet-owt-7be5be79.pth")
        lin = lpips_weights("lpips-alex-v0.1.pth")
        self.convs = []
        for i, *_, stride, padding in self.CONVS:
            self.convs.append((alex[f"features.{i}.weight"].to(dev), alex[f"features.{i}.bias"].to(dev), stride, padding))
        self.lins = [lin[f"lin{k}.model.1.weight"].to(dev) for k in range(5)]
        self.shift = torch.tensor([-0.030, -0.088, -0.188], device=dev)[None, :, None, None]
        self.scale = torch.tensor([0.458, 0.448, 0.450], device=dev)[None, :, None, None]

    def features(self, x):  # [1,3,H,W] in [-1,1]
        x = (x - self.shift) / self.scale
        out = []
        for k, (w, b, stride, padding) in enumerate(self.convs):
            if k in (1, 2):  # the max-pools between conv1, conv2 and conv3
                x = F.max_pool2d(x, 3, 2)
            x = F.relu(F.conv2d(x, w, b, stride, padding))
            out.append(x)
        return out

    def __call__(self, a, b):  # [H,W,3] in [0,1]
        fa = self.features(a.permute(2, 0, 1)[None] * 2 - 1)
        fb = self.features(b.permute(2, 0, 1)[None] * 2 - 1)
        total = 0.0
        for x, y, lin in zip(fa, fb, self.lins):
            unit = lambda t: t / (t.pow(2).sum(1, keepdim=True).sqrt() + 1e-10)
            total += F.conv2d((unit(x) - unit(y)) ** 2, lin).mean().item()
        return total


# --- the splat and its rendering, as judge.py and the trainer's rasterization ---
def load_splat(path):
    head, _, body = Path(path).read_bytes().partition(b"end_header\n")
    lines = [ln for ln in head.decode().splitlines() if ln.startswith("property")]
    if any(ln.split()[1] != "float" for ln in lines):
        raise SystemExit(f"score: {path}: expected only float properties")
    names = [ln.split()[-1] for ln in lines]
    v = torch.from_numpy(np.frombuffer(body, "<f4").reshape(-1, len(names)).copy()).to(dev)
    col = {c: v[:, i] for i, c in enumerate(names)}
    rest = sorted((c for c in names if c.startswith("f_rest_")), key=lambda c: int(c[7:]))
    n, dim = len(v), len(rest) // 3
    sh0 = torch.stack([col[f"f_dc_{i}"] for i in range(3)], 1)[:, None]
    shN = torch.stack([col[c] for c in rest], 1).reshape(n, 3, dim).transpose(1, 2) if dim else sh0[:, :0]
    return dict(means=torch.stack([col["x"], col["y"], col["z"]], 1),
                quats=torch.stack([col[f"rot_{i}"] for i in range(4)], 1),
                scales=torch.exp(torch.stack([col[f"scale_{i}"] for i in range(3)], 1)),
                opacities=torch.sigmoid(col["opacity"]), colors=torch.cat([sh0, shN], 1),
                sh_degree=int(round(math.sqrt(dim + 1))) - 1)


def render(s, vm, K, w, h):
    r, _, _ = rasterization(s["means"], s["quats"], s["scales"], s["opacities"], s["colors"], vm[None], K[None], w, h,
                            sh_degree=s["sh_degree"], packed=False)
    return r[0].clamp(0, 1)


def rot6d(d6):
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    return torch.stack((b1, b2, torch.cross(b1, b2, dim=-1)), dim=-2)


IDENT = torch.tensor([1.0, 0, 0, 0, 1, 0], device=dev)


def aligned_view(c2w, d):
    T = torch.eye(4, device=dev).clone()
    T[:3, :3] = rot6d(d[3:] + IDENT)
    T[:3, 3] = d[:3]
    return torch.linalg.inv(c2w @ T)


def align(s, c2w, K, gt, iters):
    """Adam on a 6-DoF correction at half resolution, as judge.py."""
    h, w = gt.shape[:2]
    gt_s = F.interpolate(gt.permute(2, 0, 1)[None], scale_factor=0.5, mode="area")[0].permute(1, 2, 0)
    Ks = K.clone()
    Ks[:2] *= 0.5
    d = torch.zeros(9, device=dev, requires_grad=True)
    opt = torch.optim.Adam([d], lr=2e-4)
    for _ in range(iters):
        loss = (render(s, aligned_view(c2w, d), Ks, w // 2, h // 2) - gt_s).abs().mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
    return d.detach()


# --- sharpness ---
def gradmag(x):  # [H,W,3]
    g = x.mean(-1)
    return ((g[:, 1:] - g[:, :-1]).abs().mean() + (g[1:] - g[:-1]).abs().mean()) / 2


def gaussian(x, sigma=1.0):  # [H,W,C]
    r = int(math.ceil(3 * sigma))
    k = torch.exp(-torch.arange(-r, r + 1, device=x.device, dtype=x.dtype) ** 2 / (2 * sigma ** 2))
    k = (k / k.sum())[None, None]
    t = x.permute(2, 0, 1)[:, None]  # each channel on its own
    t = F.conv2d(F.pad(t, (r, r, 0, 0), mode="replicate"), k[:, :, None, :])
    t = F.conv2d(F.pad(t, (0, 0, r, r), mode="replicate"), k[:, :, :, None])
    return t[:, 0].permute(1, 2, 0)


def detail_box(photo):
    """(x, y) of the CROP_W x CROP_H window with the most gradient energy in the photo, ignoring noise. From the photo
    alone, so a frame's crop is the same pixels in every run."""
    g = gaussian(photo).mean(-1)
    energy = torch.zeros_like(g)
    energy[:, 1:] += (g[:, 1:] - g[:, :-1]).abs()
    energy[1:] += (g[1:] - g[:-1]).abs()
    h, w = g.shape
    cw, ch = min(CROP_W, w), min(CROP_H, h)
    pooled = F.avg_pool2d(energy[None, None], (ch, cw), stride=8)[0, 0]
    k = pooled.argmax().item()
    return (k % pooled.shape[1]) * 8, (k // pooled.shape[1]) * 8, cw, ch


# --- the frames ---
def frame_number(f):
    stem = Path(f["file_path"]).stem
    return int(stem) if stem.isdigit() else None


def stretch_ids(frames):
    """A frame's `stretch` key; without any, runs of frames split where the file numbers jump (more than 3x the usual
    gap); without file numbers, one stretch."""
    if any("stretch" in f for f in frames):
        return [str(f.get("stretch", "none")) for f in frames]
    nums = [frame_number(f) for f in frames]
    if len(frames) < 2 or None in nums:
        return ["0"] * len(frames)
    gaps = np.diff(nums)
    usual = np.median(gaps)
    ids, cur = ["0"], 0
    for g in gaps:
        cur += g > 3 * usual
        ids.append(str(cur))
    return ids


def motion_blur(data, frames):
    """Each held-out frame's estimated blur in pixels, from the velocity between its neighbours in time (train and
    held-out frames together, so a held-out stretch still has neighbours at its ends). None without a timestamp."""
    path = list(frames)
    if (data / "transforms.json").exists():
        path += json.loads((data / "transforms.json").read_text())["frames"]
    seen, unique = set(), []
    for f in path:
        if f["file_path"] not in seen and f.get("timestamp") is not None and not f.get("still"):
            seen.add(f["file_path"])
            unique.append(f)
    unique.sort(key=lambda f: f["timestamp"])
    where = {f["file_path"]: k for k, f in enumerate(unique)}
    out = []
    for f in frames:
        k = where.get(f["file_path"])
        if k is None:
            out.append(dict(blur_px=None, deg_s=None, m_s=None, exposure=f.get("exposure_duration")))
            continue
        m = np.array(f["transform_matrix"])
        speeds = []
        for j in (k - 1, k + 1):
            if not 0 <= j < len(unique):
                continue
            dt = abs(unique[j]["timestamp"] - f["timestamp"])
            if not 1e-3 < dt <= 1.0:  # a neighbour across a cut in the path says nothing about this frame
                continue
            o = np.array(unique[j]["transform_matrix"])
            cos = (np.trace(m[:3, :3].T @ o[:3, :3]) - 1) / 2
            speeds.append((math.acos(float(np.clip(cos, -1, 1))) / dt, float(np.linalg.norm(m[:3, 3] - o[:3, 3])) / dt))
        if not speeds:
            out.append(dict(blur_px=None, deg_s=None, m_s=None, exposure=f.get("exposure_duration")))
            continue
        rad_s, m_s = np.mean(speeds, axis=0)
        exposure = f.get("exposure_duration") or 0.01  # the trainer's default too
        out.append(dict(blur_px=float(exposure * (rad_s + m_s / 2.0) * f["fl_x"]), deg_s=math.degrees(rad_s), m_s=float(m_s),
                        exposure=exposure))
    return out


def stable_subset(frames):
    """Indices of the frames to save, from the held-out list alone."""
    n = len(frames)
    return sorted({int(round(x)) for x in np.linspace(0, n - 1, min(SAVED_FRAMES, n))})


def choose(n, saved, limit):
    """The frames to score: all, or with --max-frames the saved ones first (so that a short run shows the same frames)."""
    if not limit or limit >= n:
        return list(range(n))
    if limit <= len(saved):
        return [saved[int(round(x))] for x in np.linspace(0, len(saved) - 1, limit)]
    rest = [i for i in range(n) if i not in saved]
    more = limit - len(saved)
    return sorted(saved + [rest[int(round(x))] for x in np.linspace(0, len(rest) - 1, more)])


def summ(rows):
    if not rows:
        return None
    return {k: round(float(np.mean([r[k] for r in rows])), 4) for k in METRICS} | {"n": len(rows)}


def to_jpeg(x, path):  # [H,W,3] in [0,1]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((x.cpu().numpy() * 255).round().astype(np.uint8)).save(path, quality=92)


def spark_judge(a):
    judge = Path(__file__).resolve().parent.parent / "psnr_judge.mjs"
    if not judge.exists():
        judge = Path(os.environ.get("NOOK_PSNR_JUDGE", Path.home() / "nook-exp/src/evals/psnr_judge.mjs"))
    args = ["node", str(judge), str(Path(a.splat).resolve()), str(Path(a.data).resolve()), "--val", *shlex.split(a.spark_args)]
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"} | {"NOOK_SOFTWARE_GL": "1"}
    limit = ["nice", "-n", "10", "taskset", "-c", "0-7"]
    if shutil.which("node") and env.get("NOOK_BROWSER"):
        cmd = limit + args
    else:
        flake = os.environ.get("NOOK_FLAKE", str(Path.home() / "src/nook"))
        inner = 'NOOK_BROWSER=$(command -v chromium) exec "$@"'
        cmd = ["nix", "develop", f"{flake}#sharpness", "-c", "bash", "-c", inner, "--", *limit, *args]
    done = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if done.returncode:
        return {"error": done.stderr.strip()[-500:]}
    return json.loads(done.stdout.splitlines()[-1])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("splat"); p.add_argument("data")
    p.add_argument("--out", required=True); p.add_argument("--save-dir", required=True)
    p.add_argument("--summary", help="the trainer's JSON: its last line is merged into the report")
    p.add_argument("--max-frames", type=int)
    p.add_argument("--align-iters", type=int, default=150)
    p.add_argument("--floor-y", type=float, help="the floor in capture world, for the novel views")
    p.add_argument("--views", help="views.json from make_views.py")
    p.add_argument("--spark", action="store_true"); p.add_argument("--spark-args", default="--max 8")
    a = p.parse_args()
    started = time.time()
    data, save = Path(a.data), Path(a.save_dir)

    all_frames = json.loads((data / "transforms_val.json").read_text())["frames"]
    stretch = stretch_ids(all_frames)
    blur = motion_blur(data, all_frames)
    saved = stable_subset(all_frames)
    s = load_splat(a.splat)
    lpips = Lpips()

    rows = []
    for k in choose(len(all_frames), saved, a.max_frames):
        f = all_frames[k]
        with Image.open(data / f["file_path"]) as im:
            gt = torch.from_numpy(np.asarray(im.convert("RGB"), np.float32) / 255).to(dev)
        h, w = gt.shape[:2]
        K = torch.tensor([[f["fl_x"], 0, f["cx"]], [0, f["fl_y"], f["cy"]], [0, 0, 1]], dtype=torch.float32, device=dev)
        c2w = torch.tensor(np.array(f["transform_matrix"]) @ gl_to_cv, dtype=torch.float32, device=dev)
        d = align(s, c2w, K, gt, a.align_iters)
        with torch.no_grad():
            raw = render(s, torch.linalg.inv(c2w), K, w, h)
            img = render(s, aligned_view(c2w, d), K, w, h)
            R = rot6d(d[3:] + IDENT)
            row = {
                "name": Path(f["file_path"]).stem, "stretch": stretch[k],
                "psnr": -10 * math.log10(F.mse_loss(img, gt).item()),
                "psnr_raw": -10 * math.log10(F.mse_loss(raw, gt).item()),
                "ssim": fused_ssim(img.permute(2, 0, 1)[None].contiguous(), gt.permute(2, 0, 1)[None].contiguous(), padding="valid").item(),
                "lpips": lpips(img, gt),
                "sharp_ratio": (gradmag(img) / gradmag(gt)).item(),
                "sharp_ratio_blur": (gradmag(gaussian(img)) / gradmag(gaussian(gt))).item(),
                "align_cm": d[:3].norm().item() * 100,
                "align_deg": math.degrees(math.acos(max(-1, min(1, (R.trace().item() - 1) / 2)))),
                **blur[k],
            }
            rows.append(row)
            if k in saved:
                to_jpeg(torch.cat([img, gt], 1), save / "frames" / f"{row['name']}.jpg")
                x, y, cw, ch = detail_box(gt)
                to_jpeg(torch.cat([img[y:y + ch, x:x + cw], gt[y:y + ch, x:x + cw]], 1), save / "crops" / f"{row['name']}.jpg")

    known = sorted((r for r in rows if r["blur_px"] is not None), key=lambda r: r["blur_px"])
    sharp = known[:max(1, len(known) // 2)] if known else []
    for r in sharp:
        r["sharp"] = True
    report = {
        "splat": str(a.splat), "data": str(a.data), "splats": len(s["means"]), "sh_degree": s["sh_degree"],
        "lpips_net": "alex",
        "all": summ(rows), "sharp": summ(sharp),
        "stretches": {i: summ([r for r in rows if r["stretch"] == i]) for i in sorted({r["stretch"] for r in rows}, key=str)},
    }

    views = None
    if a.views:
        views = json.loads(Path(a.views).read_text())
        views = views["views"] if isinstance(views, dict) else views
    elif a.floor_y is not None:
        views = make_views(a.data, a.floor_y)
    if views:
        with torch.no_grad():
            for v in views:
                w, h = v["w"], v["h"]
                fl = w / 2 / math.tan(math.radians(v["fov_x_deg"]) / 2)
                K = torch.tensor([[fl, 0, w / 2], [0, fl, h / 2], [0, 0, 1]], dtype=torch.float32, device=dev)
                c2w = torch.tensor(np.array(v["transform_matrix"]) @ gl_to_cv, dtype=torch.float32, device=dev)
                to_jpeg(render(s, torch.linalg.inv(c2w), K, w, h), save / "views" / f"{v['name']}.jpg")
        report["views"] = [v["name"] for v in views]
    if a.floor_y is not None:
        report["floor_y"] = a.floor_y

    if a.summary and Path(a.summary).exists():
        lines = Path(a.summary).read_text().strip().splitlines()
        train = json.loads(lines[-1]) if lines else {}
        report["train"] = {k: train[k] for k in ("seconds", "train_seconds", "steps", "steps_per_s", "peak_vram_gib", "splats") if k in train}
    report["peak_vram_gib_score"] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)

    if a.spark:
        spark = spark_judge(a)
        report["spark"] = {k: v for k, v in spark.items() if k != "frames"}
        if "mean_psnr" in spark:
            report["spark_mean_psnr"] = spark["mean_psnr"]

    report["score_seconds"] = round(time.time() - started, 1)
    report["notes"] = NOTES
    print(json.dumps({k: v for k, v in report.items() if k != "notes"}))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(report | {"rows": rows}))


if __name__ == "__main__":
    main()
