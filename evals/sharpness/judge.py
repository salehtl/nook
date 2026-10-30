"""Judge a trained splat on held-out frames, the way sharpness matters: each held-out camera's pose is first aligned
to its photo (6-DoF, splats frozen), so pose error in the held-out frame itself isn't scored as blur. Reports PSNR,
SSIM and a sharpness ratio (render gradient energy / photo gradient energy, 1.0 = as sharp as the photo) on all
held-out frames and on the sharp ones (from blur.json).

judge.py SPLAT.ply DATA_DIR BLUR_JSON [--align-iters 150] [--out metrics.json] [--save-dir DIR]"""
import argparse, json, sys, math
from pathlib import Path
import numpy as np, torch, torch.nn.functional as F
from PIL import Image
sys.path.insert(0, str(Path(__file__).parent))
from gsplat import rasterization
from fused_ssim import fused_ssim

p = argparse.ArgumentParser()
p.add_argument("splat"); p.add_argument("data"); p.add_argument("blur")
p.add_argument("--align-iters", type=int, default=150)
p.add_argument("--out"); p.add_argument("--save-dir")
a = p.parse_args()
dev = torch.device("cuda")

head, _, body = Path(a.splat).read_bytes().partition(b"end_header\n")
names = [ln.split()[-1] for ln in head.decode().splitlines() if ln.startswith("property")]
v = torch.from_numpy(np.frombuffer(body, "<f4").reshape(-1, len(names)).copy()).to(dev)
col = {c: v[:, i] for i, c in enumerate(names)}
rest = sorted((c for c in names if c.startswith("f_rest_")), key=lambda c: int(c[7:]))
n, dim = len(v), len(rest) // 3
means = torch.stack([col["x"], col["y"], col["z"]], 1)
scales = torch.exp(torch.stack([col[f"scale_{i}"] for i in range(3)], 1))
quats = torch.stack([col[f"rot_{i}"] for i in range(4)], 1)
opac = torch.sigmoid(col["opacity"])
sh0 = torch.stack([col[f"f_dc_{i}"] for i in range(3)], 1)[:, None]
shN = torch.stack([col[c] for c in rest], 1).reshape(n, 3, dim).transpose(1, 2) if dim else sh0[:, :0]
colors = torch.cat([sh0, shN], 1)
deg = int(round(math.sqrt(dim + 1))) - 1

blur = {r["i"]: r for r in json.loads(Path(a.blur).read_text())}
lv = np.array([blur[i]["lap_video"] for i in sorted(blur)])
t = json.loads((Path(a.data) / "transforms_val.json").read_text())
gl_to_cv = np.diag([1.0, -1.0, -1.0, 1.0])

def rot6d(d6):
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1); b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    return torch.stack((b1, b2, torch.cross(b1, b2, dim=-1)), dim=-2)

def render(vm, K, w, h):
    r, _, _ = rasterization(means, quats, scales, opac, colors, vm[None], K[None], w, h, sh_degree=deg, packed=False)
    return r[0].clamp(0, 1)

def gradmag(x):  # [H,W,3]
    g = x.mean(-1)
    return ((g[:, 1:] - g[:, :-1]).abs().mean() + (g[1:] - g[:-1]).abs().mean()) / 2

rows = []
for f in t["frames"]:
    i = int(Path(f["file_path"]).stem)
    with Image.open(Path(a.data) / f["file_path"]) as im:
        gt = torch.from_numpy(np.asarray(im.convert("RGB"), np.float32) / 255).to(dev)
    h, w = gt.shape[:2]
    K = torch.tensor([[f["fl_x"], 0, f["cx"]], [0, f["fl_y"], f["cy"]], [0, 0, 1]], dtype=torch.float32, device=dev)
    c2w = torch.tensor(np.array(f["transform_matrix"]) @ gl_to_cv, dtype=torch.float32, device=dev)
    d = torch.zeros(9, device=dev, requires_grad=True)
    ident = torch.tensor([1.0, 0, 0, 0, 1, 0], device=dev)
    def vm_of(d):
        T = torch.eye(4, device=dev); T = T.clone()
        T[:3, :3] = rot6d(d[3:] + ident); T[:3, 3] = d[:3]
        return torch.linalg.inv(c2w @ T)
    # align at half resolution
    gt_s = F.interpolate(gt.permute(2, 0, 1)[None], scale_factor=0.5, mode="area")[0].permute(1, 2, 0)
    Ks = K.clone(); Ks[:2] *= 0.5
    with torch.no_grad():
        before = F.mse_loss(render(vm_of(d), K, w, h), gt).item()
    opt = torch.optim.Adam([d], lr=2e-4)
    for _ in range(a.align_iters):
        loss = (render(vm_of(d), Ks, w // 2, h // 2) - gt_s).abs().mean()
        opt.zero_grad(); loss.backward(); opt.step()
    with torch.no_grad():
        img = render(vm_of(d), K, w, h)
        mse = F.mse_loss(img, gt).item()
        ssim = fused_ssim(img.permute(2, 0, 1)[None].contiguous(), gt.permute(2, 0, 1)[None].contiguous(), padding="valid").item()
        sr = (gradmag(img) / gradmag(gt)).item()
        shift = d[:3].norm().item() * 100
        R = rot6d(d[3:] + ident); ang = math.degrees(math.acos(max(-1, min(1, (R.trace().item() - 1) / 2))))
    k = sorted(blur).index(i)
    rel = blur[i]["lap_video"] / np.median(lv[max(0, k - 7):k + 8])
    fl = f["fl_x"] * 1920 / w
    bpx = math.radians(blur[i]["deg_s"]) * fl * 0.01
    rows.append({"i": i, "psnr": -10 * math.log10(mse), "psnr_raw": -10 * math.log10(before), "ssim": ssim, "sharp_ratio": sr,
                 "align_cm": shift, "align_deg": ang, "rel_sharp": rel, "blur_px": bpx, "pass": blur[i]["pass"]})
    if a.save_dir and len(rows) % 6 == 1:
        Path(a.save_dir).mkdir(parents=True, exist_ok=True)
        both = torch.cat([img, gt], 1).cpu().numpy()
        Image.fromarray((both * 255).astype(np.uint8)).save(Path(a.save_dir) / f"{i:06d}.jpg", quality=92)

def summ(rs):
    if not rs:
        return None
    return {k: round(float(np.mean([r[k] for r in rs])), 4) for k in ("psnr", "psnr_raw", "ssim", "sharp_ratio", "align_cm", "align_deg")} | {"n": len(rs)}
sharp = [r for r in rows if r["rel_sharp"] >= 0.9 and r["blur_px"] < 3 and r["pass"] != 3]
res = {"all": summ(rows), "sharp": summ(sharp), "splats": n}
print(json.dumps(res))
if a.out:
    Path(a.out).write_text(json.dumps(res | {"rows": rows}))
