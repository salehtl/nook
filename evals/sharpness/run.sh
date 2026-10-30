#!/bin/bash
# run.sh NAME DATASET TRAINER_ARGS...: train with ~/nook-exp/src/gsplat/nook_gsplat.py (or $TRAINER), then judge. Under the GPU lock.
set -u
cd ~/nook-exp && . ./env.sh
name=$1; ds=$2; shift 2
out=runs/$name; mkdir -p $out
trainer=${TRAINER:-src/gsplat/nook_gsplat.py}
cp $trainer $out/trainer.py
echo "$*" > $out/args
nice -n 10 flock /run/nook/gpu.lock bash -c "
  $PY $out/trainer.py ds/$ds/data --out $out/splat.ply --sh-degree 3 $* > $out/summary.json 2> $out/train.log &&
  $PY exp/judge.py $out/splat.ply ds/$ds/data blur.json --out $out/metrics.json --save-dir $out/shots > $out/judge.txt 2>&1"
echo "$name done: $(tail -1 $out/summary.json 2>/dev/null | head -c 300) | $(cat $out/judge.txt | tail -1)"
