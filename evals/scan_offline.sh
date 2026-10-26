#!/usr/bin/env bash
# nook-scan trainer eval (contract §4.6–4.7, S1–S2): train on the synthetic ground-truth capture, judge with Spark.
# Usage: bash evals/scan_offline.sh   (or npm run eval:scan). Output lands in evals/out/scan/.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/scan
GT=evals/out/capture-gt
rm -rf "$OUT" && mkdir -p "$OUT/room"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
# Like check, but the failure detail is a command run after the check, so it can read logs the check just wrote.
checkl() { if eval "$2"; then ok "$1"; else bad "$1 — $(eval "$3" 2>/dev/null | tr '\n' ' ' | cut -c1-600)"; fi; }
last() { tail -n 1 "$1" 2>/dev/null; }
# Training runs on kakapo (gsplat needs its NVIDIA GPU); the checks below run here. See evals/remote.sh.
source evals/remote.sh

[ -f scan/pyproject.toml ] || { echo "FAIL scan/pyproject.toml not found (trainer not built yet)"; exit 1; }
remote_prepare || exit 1
if [ ! -f "$GT/transforms.json" ]; then node fixtures/make_capture.mjs --out "$GT" >/dev/null || { echo "FAIL could not generate $GT"; exit 1; }; fi
(cd "$(dirname "$GT")" && rm -f "$OLDPWD/$OUT/capture.zip" && zip -qr "$OLDPWD/$OUT/capture.zip" "$(basename "$GT")")

# --- check ---------------------------------------------------------------------------------------
checkl "nook-scan check accepts the fixture capture" 'scan check "$OUT/capture.zip" >"$OUT/check.out" 2>&1' 'tail -n 2 "$OUT/check.out"'

# --- train (S1) ----------------------------------------------------------------------------------
start=$(date +%s)
if scan train "$OUT/capture.zip" --name eval-scan --room-dir "$OUT/room" --holdout-every 10 >"$OUT/train.out" 2>"$OUT/train.err"; then
  secs=$(( $(date +%s) - start ))
  ok "train succeeds (${secs}s)"
  check "train finishes in under 15 minutes" '[ "$secs" -lt 900 ]' "${secs}s"
  check "last stdout line is the JSON summary" 'last "$OUT/train.out" | node -e "const o=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); process.exit(o.name===\"eval-scan\"&&o.splats>0&&o.trainer?0:1)"' "$(last "$OUT/train.out")"
  PLY="$OUT/room/eval-scan.ply"
  check "writes room/eval-scan.ply" '[ -f "$PLY" ]'
  check "room.json matches room.schema.json, floor at 0 ±5 cm, level, scale 1" 'evals/py -c "
import json, jsonschema, sys
r = json.load(open(\"$OUT/room/room.json\")); s = json.load(open(\"contract/room.schema.json\"))
jsonschema.validate(r, s)
t = r[\"transform\"]
ok = abs(t[\"position\"][1] - 1.35) <= 0.05 and max(abs(a - b) for a, b in zip(t[\"quaternion\"], [0, 0, 0, 1])) < 1e-3 and t[\"scale\"] == 1 and r[\"splat\"].endswith(\"eval-scan.spz\")
sys.exit(0 if ok else 1)"' "$(cat "$OUT/room/room.json" 2>/dev/null | tr -d '\n ' | cut -c1-300)"

  # Quality: Spark-rendered PSNR on held-out frames vs an untrained seed-point baseline.
  evals/py evals/seed_splat.py "$GT/points.ply" "$OUT/seed.ply" >/dev/null
  base=$(node evals/psnr_judge.mjs "$OUT/seed.ply" "$GT" --every 10 | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).mean_psnr)")
  judged=$(node evals/psnr_judge.mjs "$PLY" "$GT" --every 10 --save "$OUT/renders")
  psnr=$(echo "$judged" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).mean_psnr)")
  echo "$judged" >"$OUT/psnr.json"
  check "held-out PSNR ≥ 26 dB (got $psnr, seed baseline $base)" 'node -e "process.exit($psnr >= 26 ? 0 : 1)"'
  check "held-out PSNR ≥ seed baseline + 4 dB" 'node -e "process.exit($psnr >= $base + 4 ? 0 : 1)"'
else
  bad "train succeeds — $(tail -n 3 "$OUT/train.err" | tr '\n' ' ')"
fi

# --- bad captures (S2): non-zero exit, one actionable line, no traceback, nothing written ----------
mk() { rm -rf "$OUT/bad/$1" && mkdir -p "$OUT/bad" && cp -R fixtures/capture-small "$OUT/bad/$1"; }
bad_case() {
  local name=$1 cap=$2
  if scan train "$cap" --name "bad-$name" --room-dir "$OUT/badroom" >"$OUT/bad-$name.out" 2>"$OUT/bad-$name.err"; then bad "$name is rejected"; return; fi
  if grep -q Traceback "$OUT/bad-$name.err"; then bad "$name: no traceback"; return; fi
  if [ -z "$(tail -n 1 "$OUT/bad-$name.err")" ]; then bad "$name: explains itself on stderr"; return; fi
  if [ -e "$OUT/badroom/bad-$name.ply" ] || [ -e "$OUT/badroom/room.json" ]; then bad "$name: wrote into room-dir"; return; fi
  ok "$name is rejected: $(tail -n 1 "$OUT/bad-$name.err")"
}
mk missing-image && rm "$OUT/bad/missing-image/images/000005.jpg";                       bad_case missing-image "$OUT/bad/missing-image"
mk nan-pose && python3 - "$OUT/bad/nan-pose/transforms.json" <<'EOF'
import json, sys; t = json.load(open(sys.argv[1])); t["frames"][2]["transform_matrix"][1][3] = float("nan"); open(sys.argv[1], "w").write(json.dumps(t))
EOF
bad_case nan-pose "$OUT/bad/nan-pose"
mk too-few && python3 - "$OUT/bad/too-few" <<'EOF'
import json, sys; p = sys.argv[1]; t = json.load(open(p + "/transforms.json")); m = json.load(open(p + "/meta.json"))
t["frames"] = t["frames"][:10]; m["frame_count"] = 10; json.dump(t, open(p + "/transforms.json", "w")); json.dump(m, open(p + "/meta.json", "w"))
EOF
bad_case too-few "$OUT/bad/too-few"
mk static && python3 - "$OUT/bad/static/transforms.json" <<'EOF'
import json, sys; t = json.load(open(sys.argv[1]))
for f in t["frames"]:
    for r in range(3): f["transform_matrix"][r][3] = 0.0
open(sys.argv[1], "w").write(json.dumps(t))
EOF
bad_case static "$OUT/bad/static"
(cd fixtures/capture-small && zip -qr "$OLDPWD/$OUT/bad/no-folder.zip" .)
bad_case no-top-folder "$OUT/bad/no-folder.zip"

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
