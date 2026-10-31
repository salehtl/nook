#!/bin/bash
# run.sh NAME DATASET TRAINER_ARGS...: train and score one run, both under the GPU lock. Keeps the trainer used in
# runs/NAME. Prints one line: the name and the key metrics (the whole report is runs/NAME/metrics.json).
# $TRAINER: the trainer to copy (default src/gsplat/nook_gsplat.py). $SCORE_ARGS: more arguments for score.py
# (--floor-y Y, --views views.json, ...).
set -u
here=$(cd "$(dirname "$0")" && pwd)
cd ~/nook-exp && . ./env.sh
name=$1; ds=$2; shift 2
out=runs/$name; mkdir -p $out
trainer=${TRAINER:-src/gsplat/nook_gsplat.py}
cp $trainer $out/trainer.py
echo "$*" > $out/args
nice -n 10 flock /run/nook/gpu.lock bash -c "
  $PY $out/trainer.py ds/$ds/data --out $out/splat.ply --sh-degree 3 $* > $out/summary.json 2> $out/train.log &&
  $PY $here/score.py $out/splat.ply ds/$ds/data --out $out/metrics.json --save-dir $out/shots --summary $out/summary.json ${SCORE_ARGS:-} > $out/score.txt 2>&1"
status=$?
[ $status -eq 0 ] || { echo "$name FAILED ($status): $(tail -qn1 $out/train.log $out/score.txt 2>/dev/null | tail -c 300 | tr '\n' ' ')"; exit 0; }
$PY -I - "$name" "$out" <<'PY'
import json, sys
from pathlib import Path
name, out = sys.argv[1:]
m = json.loads((Path(out) / "metrics.json").read_text())
train = json.loads((Path(out) / "summary.json").read_text().strip().splitlines()[-1])
def group(g):
    if not g:
        return "-"
    return (f"psnr {g['psnr']:.2f} raw {g['psnr_raw']:.2f} ssim {g['ssim']:.4f} lpips {g['lpips']:.4f} "
            f"sharp {g['sharp_ratio']:.3f} sharp1px {g['sharp_ratio_blur']:.3f} align {g['align_cm']:.2f}cm {g['align_deg']:.3f}deg n {g['n']}")
print(f"{name} | all {group(m['all'])} | sharp {group(m['sharp'])} | "
      f"{train.get('train_seconds', 0):.0f}s {train.get('steps_per_s', 0)}it/s "
      f"vram {(train.get('peak_vram_gib') or {}).get('reserved', '-')}GiB splats {m['splats']} | crop {train.get('crop') or '-'}")
PY
