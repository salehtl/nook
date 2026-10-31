#!/bin/bash
# queue.sh: run every line of ~/nook-exp/queue.txt in order, appending results to results.txt. The only thing that
# drives the GPU. A line is "NAME DATASET ARGS..." (train + score, run.sh) or "!SHELL COMMAND" (anything else that needs
# the GPU, such as re-scoring; take the lock yourself with `flock /run/nook/gpu.lock`). A line is taken when it is
# started (moved to queue.done), so new lines can be appended while it runs. `touch queue.stop` ends it when empty.
cd ~/nook-exp
while true; do
  line=$(head -n1 queue.txt 2>/dev/null)
  [ -z "$line" ] && { sleep 20; [ -s queue.txt ] || { [ -f queue.stop ] && exit 0; continue; }; continue; }
  sed -i 1d queue.txt; echo "$line" >> queue.done
  case "$line" in
    '!'*) bash -c "${line#!}" >> queue.log 2>&1 ;;
    *) bash exp/run.sh $line >> results.txt 2>&1 ;;
  esac
done
