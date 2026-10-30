#!/bin/bash
# score_run.sh NAME DATASET: score a trained run under the GPU lock and append its one line to results.txt.
set -u
cd ~/nook-exp && . ./env.sh
name=$1; ds=$2; out=runs/$name
flock /run/nook/gpu.lock nice -n 10 $PY exp/score.py $out/splat.ply ds/$ds/data --out $out/metrics.json --save-dir $out/shots --summary $out/summary.json --floor-y -1.4742109 --views views-s1.json > $out/score.txt 2>&1 || { echo "$name SCORE FAILED: $(tail -c 300 $out/score.txt)" >> results.txt; exit 0; }
$PY -I exp/line.py "$name" "$out" >> results.txt
