#!/usr/bin/env bash
# Real-capture quality eval (contract §4.9, Q1): train a real iPhone scan with --quality high and held-out frames,
# judge held-out views with Spark. Baseline (v1 defaults, 2026-10-26): 20.76 dB. Pass: >= 22.3 dB in < 40 min.
# Usage: bash evals/scan_quality.sh [capture.zip]   (default: $NOOK_REAL_CAPTURE or ~/Downloads/scan-20261026-093654.zip)
# Skips (exit 0) when the capture is absent: it is the user's private scan and never committed.
set -uo pipefail
cd "$(dirname "$0")/.."

CAP=${1:-${NOOK_REAL_CAPTURE:-$HOME/Downloads/scan-20261026-093654.zip}}
OUT=evals/out/quality
BASELINE=20.76
BAR=22.3   # contract §4.9 Q1 (baseline + 1.5, rounded as the contract states it)
[ -f "$CAP" ] || { echo "SKIP no real capture at $CAP (set NOOK_REAL_CAPTURE)"; exit 0; }
rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$OUT" && unzip -q "$CAP")
DIR=$(find "$OUT" -maxdepth 2 -name transforms.json -exec dirname {} \; | head -n 1)

start=$(date +%s)
if ! uv run -q --project scan nook-scan train "$CAP" --name quality --room-dir "$OUT/room" --quality high --holdout-every 10 >"$OUT/train.out" 2>"$OUT/train.err"; then
  echo "FAIL train --quality high — $(tail -n 2 "$OUT/train.err" | tr '\n' ' ')"; exit 1
fi
secs=$(( $(date +%s) - start ))
node evals/psnr_judge.mjs "$OUT/room/quality.ply" "$DIR" --every 10 --max 18 --save "$OUT/renders" >"$OUT/psnr.json" || { echo "FAIL psnr judge"; exit 1; }
psnr=$(python3 -c "import json; print(json.load(open('$OUT/psnr.json'))['mean_psnr'])")
summary=$(tail -n 1 "$OUT/train.out")
echo "trained in ${secs}s: $summary"
echo "held-out PSNR (Spark): $psnr dB  (baseline $BASELINE, need >= $BAR)"
fail=0
python3 -c "import sys; sys.exit(0 if $psnr >= $BAR else 1)" && echo "ok   quality" || { echo "FAIL quality"; fail=1; }
[ "$secs" -lt 2400 ] && echo "ok   time (${secs}s < 2400s)" || { echo "FAIL time ${secs}s >= 2400s"; fail=1; }
python3 -c "import json,sys; r=json.load(open('$OUT/room/room.json')); sys.exit(0 if r.get('viewpoints') else 1)" && echo "ok   viewpoints in room.json" || { echo "FAIL viewpoints in room.json"; fail=1; }
exit $fail
