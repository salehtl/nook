import json, sys
from pathlib import Path
name, out = sys.argv[1:]
m = json.loads((Path(out) / "metrics.json").read_text())
train = json.loads((Path(out) / "summary.json").read_text().strip().splitlines()[-1])
def group(g):
    return (f"psnr {g['psnr']:.2f} raw {g['psnr_raw']:.2f} ssim {g['ssim']:.4f} lpips {g['lpips']:.4f} "
            f"sharp {g['sharp_ratio']:.3f} sharp1px {g['sharp_ratio_blur']:.3f} align {g['align_cm']:.2f}cm {g['align_deg']:.3f}deg n {g['n']}") if g else "-"
print(f"{name} | all {group(m['all'])} | sharp {group(m['sharp'])} | {train.get('train_seconds', 0):.0f}s "
      f"{train.get('steps_per_s', 0)}it/s vram {(train.get('peak_vram_gib') or {}).get('reserved', '-')}GiB splats {m['splats']}")
