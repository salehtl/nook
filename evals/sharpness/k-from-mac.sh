#!/bin/bash
# k CMD...: run on kakapo over the shared link.  k --sync: push exp/ and the repo's scan/src + gsplat/ to ~/nook-exp
C="ssh -o ControlPath=$HOME/.ssh/cm-nook-kakapo -o BatchMode=yes"
S=/private/tmp/claude-501/-Users-saleh--claude-spares-spare-mE8ZaS/36a3b8c0-ef5b-4112-8504-880f64f4d133/scratchpad
N=/Users/saleh/Developer/claude-workspace/nook
if [ "$1" = --sync ]; then
  $C kakapo 'mkdir -p ~/nook-exp/src/scan ~/nook-exp/exp'
  rsync -a -e "$C" $S/exp/ kakapo:nook-exp/exp/ && rsync -a -e "$C" --exclude __pycache__ $N/scan/src kakapo:nook-exp/src/scan/ && rsync -a -e "$C" $N/gsplat/ kakapo:nook-exp/src/gsplat/
  exit $?
fi
exec $C kakapo "$@"
