#!/bin/bash
# near.sh RUN: score a run on look-down frames (over 30 deg down) it trained on (ds/s1/near), to compare with a run trained only on them.
cd ~/nook-exp && . ./env.sh
r=$1; out=runs/$r/near; mkdir -p $out
flock /run/nook/gpu.lock nice -n 10 $PY exp/score.py runs/$r/splat.ply ds/s1/near/data --out $out/metrics.json --save-dir $out/shots --summary runs/$r/summary.json > $out/score.txt 2>&1
$PY -I exp/line.py "$r-on-near-frames" $out >> results.txt 2>/dev/null
