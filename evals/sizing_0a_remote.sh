#!/usr/bin/env bash
# v4 phase 0a (docs/plans/nook-v4.md): retrain sizing runs on kakapo. Runs ON kakapo, detached:
#   nohup bash ~/src/nook/evals/sizing_0a_remote.sh CAPTURE.zip > ~/nook-sizing/run.log 2>&1 &
# Each run holds ~/nook-gpu.lock, holds out every 10th frame, and logs peak VRAM (nvidia-smi) and peak host RAM (time -v).
# Results: ~/nook-sizing/<run>/{room/,train.out,train.err,vram.log,time.txt}, one line per run in ~/nook-sizing/summary.tsv.
# Judging (Spark, held-out PSNR) happens on the Mac afterwards: evals/sizing_0a_judge.sh.
set -uo pipefail
CAP=${1:?capture zip}
OUT=~/nook-sizing
BIN=~/src/nook/result-nook/bin/nook-scan
N_TRAIN=${N_TRAIN:-1089}   # scan-20261027-112322: 1,210 frames, every 10th held out
mkdir -p "$OUT"
[ -f "$OUT/summary.tsv" ] || printf 'run\tsteps\tsplats\texit\tsecs\tpeak_vram_mib\tpeak_rss_kb\n' >"$OUT/summary.tsv"
free -g >"$OUT/free.txt"

run() {  # run <name> <steps> <max_splats>
  local name=$1 steps=$2 splats=$3 d="$OUT/$1"
  grep -q "^$name	" "$OUT/summary.tsv" && { echo "skip $name (done)"; return 0; }
  rm -rf "$d" && mkdir -p "$d"
  echo "$(date -Is) start $name: $steps steps, $splats splats"
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -lms 2000 >"$d/vram.log" &
  local smi=$! start rc
  start=$(date +%s)
  flock ~/nook-gpu.lock time -v -o "$d/time.txt" "$BIN" train "$CAP" --name "sz-${name,,}" --room-dir "$d/room" \
    --quality high --holdout-every 10 --steps "$steps" --max-splats "$splats" >"$d/train.out" 2>"$d/train.err"
  rc=$?
  kill "$smi" 2>/dev/null
  local secs=$(( $(date +%s) - start ))
  local vram rss
  vram=$(sort -n "$d/vram.log" | tail -n 1)
  rss=$(awk -F': ' '/Maximum resident/ {print $2}' "$d/time.txt")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$steps" "$splats" "$rc" "$secs" "$vram" "$rss" >>"$OUT/summary.tsv"
  echo "$(date -Is) end $name: exit $rc, ${secs}s, peak VRAM ${vram} MiB, peak RSS ${rss} kB"
}

run A 20000 1200000
run B1 $((40 * N_TRAIN)) 2000000
run B2 $((80 * N_TRAIN)) 2000000
b2_vram=$(awk -F'\t' '$1 == "B2" && $4 == 0 {print $6}' "$OUT/summary.tsv")
if [ -n "$b2_vram" ] && [ "$b2_vram" -lt 4500 ]; then
  run B3 $((80 * N_TRAIN)) 3000000
else
  echo "skip B3: B2 peak VRAM ${b2_vram:-unknown} MiB (need < 4500)"
fi
echo "$(date -Is) all done"
