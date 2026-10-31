#!/bin/bash
# browser_eval.sh TAG COMMAND...: one browser job at a time, in a memory-limited scope, from the repo. Refuses under 8 GiB available.
tag=$1; shift
cd ~/src/nook
exec flock ~/nook-exp/browser.lock bash -c '
  [ "$(awk "/MemAvailable/{print int(\$2/1048576)}" /proc/meminfo)" -ge 8 ] || { echo "under 8 GiB available: not started"; exit 4; }
  exec systemd-run --user --scope --quiet --unit=nook-eval-'"$tag"'-$$ -p MemoryMax=6G -p CPUQuota=800% taskset -c 8-15 nice -n 10 "$@"' _ "$@"
