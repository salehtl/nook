#!/bin/bash
# fullroom.sh NAME CAPTURE_DIR ROOM_DIR [nook-scan train flags]: the real pipeline with the branch's defaults, under the GPU lock, timed.
cd ~/nook-exp && . ./env.sh
name=$1; cap=$2; rooms=$3; shift 3
mkdir -p $rooms logs
start=$(date +%s)
NOOK_CONTRACT_DIR=$HOME/src/nook/contract NOOK_GSPLAT_BIN=$HOME/nook-exp/exp/nook-gsplat-wrap.sh PYTHONPATH=$HOME/src/nook/scan/src \
  flock /run/nook/gpu.lock nice -n 10 $SPY -m nook_scan train $cap --name $name --room-dir $rooms "$@" > logs/$name.out 2> logs/$name.err
rc=$?
echo "fullroom $name rc=$rc seconds=$(( $(date +%s) - start )) $(tail -1 logs/$name.out | cut -c1-500)" >> results.txt
