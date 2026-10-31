"""Per-frame sharpness and camera motion for a nook capture. Usage: blur_stats.py CAPTURE_DIR OUT.json"""
import json, sys, math
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import torch, torch.nn.functional as F
from PIL import Image

DEV = "cuda" if torch.cuda.is_available() else "cpu"  # the GPU is only for the queue: set CUDA_VISIBLE_DEVICES=""
root = Path(sys.argv[1]); t = json.loads((root / "transforms.json").read_text()); fr = t["frames"]
LAP = torch.tensor([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=torch.float32, device=DEV).view(1, 1, 3, 3)

def load(p, size):
    with Image.open(p) as im:
        im.draft("L", (size[0], size[1]))
        im = im.convert("L")
        if im.size != size:
            im = im.resize(size, Image.LANCZOS)
        return np.asarray(im, np.float32) / 255.0

def sharp(a):  # variance of Laplacian, and mean gradient magnitude (Tenengrad-ish), at 960x720
    x = torch.from_numpy(a).to(DEV)[None, None]
    lap = F.conv2d(x, LAP)
    gx, gy = x[..., :, 1:] - x[..., :, :-1], x[..., 1:, :] - x[..., :-1, :]
    return lap.var().item(), (gx.abs().mean() + gy.abs().mean()).item() / 2

def job(i):
    f = fr[i]
    v = load(root / f["file_path"], (960, 720))
    s = load(root / f["hires_file_path"], (960, 720)) if f.get("hires_file_path") else None
    return i, v, s

out = []
c2w = [np.array(f["transform_matrix"]) for f in fr]
ts = [f.get("timestamp", i / 10) for i, f in enumerate(fr)]
with ThreadPoolExecutor(12) as pool:
    for i, v, s in pool.map(job, range(len(fr))):
        a = max(0, i - 1); b = min(len(fr) - 1, i + 1)
        dt = max(ts[b] - ts[a], 1e-3)
        R = c2w[a][:3, :3].T @ c2w[b][:3, :3]
        ang = math.degrees(math.acos(max(-1, min(1, (np.trace(R) - 1) / 2)))) / dt
        lin = float(np.linalg.norm(c2w[b][:3, 3] - c2w[a][:3, 3])) / dt
        lv, gv = sharp(v)
        row = {"i": i, "deg_s": round(ang, 2), "m_s": round(lin, 3), "lap_video": lv, "grad_video": gv,
               "pass": fr[i].get("pass")}
        if s is not None:
            ls_, gs = sharp(s); row.update(lap_still=ls_, grad_still=gs)
        out.append(row)
Path(sys.argv[2]).write_text(json.dumps(out))
deg = np.array([r["deg_s"] for r in out]); lv = np.array([r["lap_video"] for r in out])
fl = fr[0].get("fl_x", t["fl_x"]); exp_s = fr[0].get("exposure_duration", 0.01)
blur_px = np.radians(deg) * fl * exp_s
print(f"frames {len(out)}  angular speed deg/s p10/50/90/max {np.percentile(deg,[10,50,90]).round(1)} {deg.max():.0f}")
print(f"rotational blur px at 1920 (fl {fl:.0f}, {exp_s*1000:.0f} ms): p10/50/90 {np.percentile(blur_px,[10,50,90]).round(1)}")
print(f"lin speed m/s p50/90 {np.percentile([r['m_s'] for r in out],[50,90]).round(2)}")
print("corr(log lap, deg/s):", np.corrcoef(np.log(lv), deg)[0, 1].round(3))
st = [r for r in out if "lap_still" in r]
print(f"stills {len(st)}: lap video/still median {np.median([r['lap_video'] for r in st]):.5f} / {np.median([r['lap_still'] for r in st]):.5f}"
      f"  grad video/still {np.median([r['grad_video'] for r in st]):.4f} / {np.median([r['grad_still'] for r in st]):.4f}")
for p in (1, 2, 3):
    rows = [r for r in out if r["pass"] == p]
    print(f"pass {p}: n {len(rows)} deg/s p50 {np.median([r['deg_s'] for r in rows]):.1f} lap p50 {np.median([r['lap_video'] for r in rows]):.5f}")
# blur relative to temporal neighbours (window 15)
rel = []
for k, r in enumerate(out):
    w = lv[max(0, k - 7):k + 8]
    rel.append(r["lap_video"] / np.median(w))
rel = np.array(rel)
print("relative sharpness (vs +-7 neighbours) p5/10/25:", np.percentile(rel, [5, 10, 25]).round(2), " frames < 0.6:", int((rel < 0.6).sum()))
