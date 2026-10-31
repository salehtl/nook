"""The results table for every scored run on the test scan, from the raw files. Run from ~/nook-exp. make_table.py > table.md"""
import json
from pathlib import Path
rows = ["s1-b20", "s1-b20r2", "s1-seeds", "s1-pose1e5", "s1-pose1e4", "s1-pose5e4", "s1-rs10", "s1-ramp", "s1-depth2", "s1-still2", "s1-sharp",
        "s1-m15", "s1-s12k", "s1-A", "s1-B", "s1-D", "s1-D1e3", "s1-D2e3", "s1-E15", "s1-F40", "s1-G", "s1-cf", "s1-cg", "s1-colmap", "s1-H", "s1-old"]
print("| Run | PSNR | raw | SSIM | LPIPS | sharp (1 px blur) | train min | steps/s | VRAM GiB | splats |\n|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    p = Path("runs") / r / "metrics.json"
    if not p.is_file():
        continue
    m = json.loads(p.read_text()); a = m["all"]; t = json.loads((Path("runs") / r / "summary.json").read_text().strip().splitlines()[-1])
    print(f"| `{r}` | {a['psnr']:.2f} | {a['psnr_raw']:.2f} | {a['ssim']:.3f} | {a['lpips']:.3f} | {a['sharp_ratio_blur']:.3f} | {t['train_seconds'] / 60:.1f} | {t['steps_per_s']:.1f} | {t['peak_vram_gib']['reserved']} | {t['splats']:,} |")
