# Sourced by evals that train (scan_offline.sh, scan_quality.sh). Training runs on kakapo, the only machine with the
# trainer (gsplat on its NVIDIA GPU); every check and the Spark judge still run here, on what comes back.
#
#   NOOK_SCAN_HOST   ssh host to train on (default: kakapo); "local" runs nook-scan here (a Linux box with CUDA)
#   NOOK_SSH_CONTROL ssh ControlPath to reuse (default: ~/.ssh/cm-nook-kakapo, the shared YubiKey link)
#
# scan <nook-scan args...> behaves like `nook-scan` run locally: local capture paths are copied to the host, a
# --room-dir is mapped to a folder there and copied back afterwards, and the exit code, stdout and stderr pass through.
NOOK_SCAN_HOST=${NOOK_SCAN_HOST:-kakapo}
NOOK_SSH_CONTROL=${NOOK_SSH_CONTROL:-$HOME/.ssh/cm-nook-kakapo}
_SSH=(ssh -o ControlPath="$NOOK_SSH_CONTROL" -o BatchMode=yes "$NOOK_SCAN_HOST")
_RSH="ssh -o ControlPath=$NOOK_SSH_CONTROL -o BatchMode=yes"
_REMOTE_EVAL='nook-eval'   # ~/nook-eval on the host

# Sync this tree to ~/src/nook on the host and build the nook package there (nook-scan + gsplat). Once per eval run.
remote_prepare() {
  [ "$NOOK_SCAN_HOST" = local ] && return 0
  "${_SSH[@]}" true 2>/dev/null || { echo "FAIL can't reach $NOOK_SCAN_HOST over $NOOK_SSH_CONTROL (open the shared ssh link first)"; return 1; }
  rsync -a -e "$_RSH" --exclude '.git/' --exclude '.env' --exclude 'ios/' --exclude 'scan/.tools/' --exclude 'scan/.venv/' \
    --exclude 'pipeline/.venv/' --exclude 'node_modules/' --exclude 'evals/out/' --exclude 'library/*/' --exclude 'room/' \
    --exclude 'renders/' --exclude 'build/' --exclude 'deploy/dist/' --exclude 'layouts/' --exclude 'fixtures/fal/' \
    --exclude 'fixtures/models/' --exclude 'fixtures/library*/' --exclude 'fixtures/room/' --exclude 'result*' --exclude 'target/' \
    --exclude '__pycache__/' ./ "$NOOK_SCAN_HOST:src/nook/" || return 1
  "${_SSH[@]}" "cd ~/src/nook && nix build path:.#nook -o result-nook 2>&1 | tail -n 3 && rm -rf ~/$_REMOTE_EVAL && mkdir -p ~/$_REMOTE_EVAL/in ~/$_REMOTE_EVAL/rooms" || return 1
}

scan() {
  if [ "$NOOK_SCAN_HOST" = local ]; then uv run -q --project scan nook-scan "$@"; return; fi
  local args=() room_local="" room_remote="" a i=0
  for a in "$@"; do args+=("$a"); done
  for ((i = 0; i < ${#args[@]}; i++)); do
    a=${args[$i]}
    if [ "$a" = --room-dir ]; then
      room_local=${args[$((i + 1))]}
      room_remote="$_REMOTE_EVAL/rooms/$(printf %s "$room_local" | shasum | cut -c1-12)"
      args[$((i + 1))]="$room_remote"
      i=$((i + 1))
    elif [ "$i" -ge 1 ] && [ "${a#-}" = "$a" ] && [ -e "$a" ] && [ "${args[$((i - 1))]#--}" = "${args[$((i - 1))]}" ]; then
      # A local capture (file or folder) given as a positional argument: copy it over, keep its name.
      rsync -a -e "$_RSH" "${a%/}" "$NOOK_SCAN_HOST:$_REMOTE_EVAL/in/" >/dev/null || return 1
      args[$i]="$_REMOTE_EVAL/in/$(basename "${a%/}")"
    fi
  done
  [ -n "$room_remote" ] && "${_SSH[@]}" "rm -rf ~/$room_remote"
  local quoted="" rc
  for a in "${args[@]}"; do quoted+=" $(printf %q "$a")"; done
  "${_SSH[@]}" "cd ~ && NOOK_GSPLAT_ARGS=$(printf %q "${NOOK_GSPLAT_ARGS:-}") ~/src/nook/result-nook/bin/nook-scan$quoted"
  rc=$?
  if [ -n "$room_local" ] && "${_SSH[@]}" "test -d ~/$room_remote"; then
    mkdir -p "$room_local" && rsync -a -e "$_RSH" "$NOOK_SCAN_HOST:$room_remote/" "$room_local/" >/dev/null
  fi
  return $rc
}
