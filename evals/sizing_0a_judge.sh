#!/usr/bin/env bash
# v4 phase 0a: pull the sizing runs back from kakapo (evals/sizing_0a_remote.sh) and judge held-out views in Spark.
# Usage: bash evals/sizing_0a_judge.sh [capture.zip]   (default: ~/Downloads/scan-20261027-112322.zip)
set -uo pipefail
cd "$(dirname "$0")/.."
CAP=${1:-$HOME/Downloads/scan-20261027-112322.zip}
OUT=evals/out/sizing
RSH="ssh -o ControlPath=$HOME/.ssh/cm-nook-kakapo -o BatchMode=yes"
mkdir -p "$OUT"
rsync -a -e "$RSH" --exclude '*.spz' kakapo:nook-sizing/ "$OUT/runs/" || exit 1
[ -f "$OUT/capture/transforms.json" ] || [ -n "$(find "$OUT/capture" -name transforms.json 2>/dev/null)" ] ||
  { mkdir -p "$OUT/capture" && (cd "$OUT/capture" && unzip -q "$CAP"); }
DIR=$(find "$OUT/capture" -maxdepth 2 -name transforms.json -exec dirname {} \; | head -n 1)
cat "$OUT/runs/summary.tsv"
for d in "$OUT"/runs/*/; do
  run=$(basename "$d"); ply=$(ls "$d"room/*.ply 2>/dev/null | head -n 1)
  [ -n "$ply" ] || continue
  [ -f "$d/psnr.json" ] || node evals/psnr_judge.mjs "$ply" "$DIR" --every 10 --max 18 >"$d/psnr.json" || { echo "FAIL judge $run"; continue; }
  echo "$run: $(python3 -c "import json; print(json.load(open('$d/psnr.json'))['mean_psnr'])") dB held-out (Spark)"
done
