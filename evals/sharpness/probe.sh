#!/bin/bash
# probe.sh RUN: score a run on frames it trained on. Sharp here and soft on held-out frames means coverage, not the trainer.
cd ~/nook-exp && . ./env.sh
r=$1; out=runs/$r/probe; mkdir -p $out
flock /run/nook/gpu.lock nice -n 10 $PY exp/score.py runs/$r/splat.ply ds/s1/probe/data --out $out/metrics.json --save-dir $out/shots --summary runs/$r/summary.json > $out/score.txt 2>&1
echo "probe-train-frames $(tail -1 $out/score.txt | cut -c1-400)" >> queue.log
cp runs/$r/summary.json $out/summary.json; $PY -I exp/line.py "$r-on-probe-frames" $out >> results.txt
