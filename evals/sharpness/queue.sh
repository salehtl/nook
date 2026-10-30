#!/bin/bash
# queue.sh: run every line of ~/nook-exp/queue.txt ("NAME DATASET ARGS...") in order, appending results to results.txt.
# A line is taken when it is started (moved to queue.done), so new lines can be appended while it runs.
cd ~/nook-exp
while true; do
  line=$(head -n1 queue.txt 2>/dev/null)
  [ -z "$line" ] && { sleep 20; [ -s queue.txt ] || { [ -f queue.stop ] && exit 0; continue; }; continue; }
  sed -i 1d queue.txt; echo "$line" >> queue.done
  bash exp/run.sh $line >> results.txt 2>&1
done
