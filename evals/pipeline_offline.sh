#!/usr/bin/env bash
# Pipeline eval: runs nook-add against recorded fal responses (NOOK_FAL_MOCK), so it costs $0.
# Checks contract/CONTRACT.md §3. Output lands in evals/out/pipeline/.
# Usage: bash evals/pipeline_offline.sh   (or npm run eval:pipeline)
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/pipeline
LIB="$OUT/library"
rm -rf "$OUT" && mkdir -p "$OUT"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8').trim().split('\n').pop()); process.stdout.write(String($1))"; }
lastline() { tail -n 1 "$1" 2>/dev/null; }

[ -f pipeline/pyproject.toml ] || { echo "FAIL pipeline/pyproject.toml not found (pipeline not built yet)"; exit 1; }
for slug in sam-3-3d-objects trellis-2; do
  [ -f "fixtures/fal/$slug/response.json" ] || { echo "FAIL fixtures/fal/$slug/response.json missing (run the Phase 0 capture)"; exit 1; }
done
IMG=$(ls fixtures/fal/sam-3-3d-objects/input.* 2>/dev/null | head -n 1)
[ -n "$IMG" ] || { echo "FAIL no fixtures/fal/sam-3-3d-objects/input.* image"; exit 1; }

# Sync once with network, then run every CLI call offline with proxies pointed at a dead port:
# any network request the CLI makes fails loudly instead of silently costing money (L6).
uv sync -q --project pipeline || { echo "FAIL uv sync --project pipeline"; exit 1; }
add() {
  env -u FAL_KEY NOOK_NO_DOTENV=1 NOOK_FAL_MOCK=fixtures/fal \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= \
    uv run -q --offline --project pipeline nook-add "$@"
}
run() { local name=$1; shift; add "$@" >"$OUT/$name.out" 2>"$OUT/$name.err"; }

# --- engines (mocked) -------------------------------------------------------
if run sam "$IMG" --engine sam3d --prompt chair --name "Mock SAM Chair" --id mock-sam --dims 75x80x95 --library "$LIB"; then
  ok "sam3d run succeeds"
  check "sam3d summary: id/engine/mock/cost" '[ "$(lastline $OUT/sam.out | json "o.id+\"|\"+o.engine+\"|\"+o.mock+\"|\"+o.cost_usd")" = "mock-sam|sam3d|true|0" ]' "$(lastline $OUT/sam.out)"
  check "sam3d writes model.glb, splat.ply, thumb.jpg" '[ -f $LIB/mock-sam/model.glb ] && [ -f $LIB/mock-sam/splat.ply ] && [ -f $LIB/mock-sam/thumb.jpg ]'
else
  bad "sam3d run succeeds — $(tail -n 3 "$OUT/sam.err" | tr '\n' ' ')"
fi

if run trellis "$IMG" --engine trellis2 --name "Mock Trellis Chair" --id mock-trellis --dims "75 × 60.5 × 80" --library "$LIB"; then
  ok "trellis2 run succeeds (dims with spaces, ×, decimals)"
  check "trellis2 writes model.glb and no splat" '[ -f $LIB/mock-trellis/model.glb ] && [ ! -f $LIB/mock-trellis/splat.ply ]'
else
  bad "trellis2 run succeeds — $(tail -n 3 "$OUT/trellis.err" | tr '\n' ' ')"
fi

# --- glb engine: textures (L5), yaw (L7), upsert (L3) ------------------------
if run sheen fixtures/models/SheenChair.glb --engine glb --name "Sheen" --id sheen --dims 60x65x85 --category chair --library "$LIB"; then
  ok "glb run succeeds"
  imgs=$(evals/py evals/glb_info.py "$LIB/sheen/model.glb" | json "o.images")
  check "glb textures survive normalization" '[ "$imgs" = "7" ]' "images=$imgs (source has 7)"
else
  bad "glb run succeeds — $(tail -n 3 "$OUT/sheen.err" | tr '\n' ' ')"
fi

run arrow0 fixtures/models/arrow.glb --engine glb --name "Arrow 0" --id arrow-0 --dims 100x40x30 --library "$LIB" \
  && run arrow90 fixtures/models/arrow.glb --engine glb --name "Arrow 90" --id arrow-90 --dims 40x100x30 --yaw 90 --library "$LIB"
if [ $? -eq 0 ]; then
  c0=$(evals/py evals/glb_info.py "$LIB/arrow-0/model.glb" | json "o.centroid.map(v=>v.toFixed(3)).join(' ')")
  c90=$(evals/py evals/glb_info.py "$LIB/arrow-90/model.glb" | json "o.centroid.map(v=>v.toFixed(3)).join(' ')")
  check "yaw 0 keeps the arrow tip toward +X" 'node -e "const [x,,z]=\"$c0\".split(\" \").map(Number); process.exit(x>0.05&&Math.abs(z)<0.02?0:1)"' "centroid $c0"
  check "yaw 90 turns +X into -Z" 'node -e "const [x,,z]=\"$c90\".split(\" \").map(Number); process.exit(z<-0.05&&Math.abs(x)<0.02?0:1)"' "centroid $c90"
else
  bad "arrow glb runs succeed — $(tail -n 2 "$OUT/arrow0.err" "$OUT/arrow90.err" | tr '\n' ' ')"
fi

if run sheen2 fixtures/models/SheenChair.glb --engine glb --name "Sheen" --id sheen --dims 62x65x85 --library "$LIB"; then
  n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LIB/library.json','utf8')).items.filter(i=>i.id==='sheen').length)")
  check "upsert leaves exactly one entry" '[ "$n" = "1" ]' "count=$n"
  check "upsert is reported" 'grep -qi "replac" "$OUT/sheen2.out" "$OUT/sheen2.err"'
  w=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LIB/library.json','utf8')).items.find(i=>i.id==='sheen').dims_cm.w)")
  check "upsert stores the new dims" '[ "$w" = "62" ]' "w=$w"
else
  bad "glb re-run (upsert) succeeds — $(tail -n 3 "$OUT/sheen2.err" | tr '\n' ' ')"
fi

# --- bad input (L4): non-zero exit, one actionable line, no traceback, library untouched --------
sum_before=$(shasum "$LIB/library.json" 2>/dev/null)
rows_before=$(wc -l <"$LIB/costs.csv" 2>/dev/null)
: >"$OUT/model.usdz"
bad_case() {
  local name=$1; shift
  if run "$name" "$@"; then bad "$name is rejected"; return; fi
  if grep -q "Traceback" "$OUT/$name.err"; then bad "$name: no traceback — $(tail -n 1 "$OUT/$name.err")"; return; fi
  if [ -z "$(tail -n 1 "$OUT/$name.err")" ]; then bad "$name: explains itself on stderr"; return; fi
  ok "$name is rejected: $(tail -n 1 "$OUT/$name.err")"
}
bad_case no-dims        "$IMG" --name "X" --library "$LIB"
bad_case bad-dims       "$IMG" --name "X" --dims 75by80 --library "$LIB"
bad_case zero-dims      "$IMG" --name "X" --dims 0x80x90 --library "$LIB"
bad_case bad-engine     "$IMG" --name "X" --dims 75x80x95 --engine foo --library "$LIB"
bad_case missing-file   "$OUT/nope.jpg" --name "X" --dims 75x80x95 --library "$LIB"
bad_case usdz           "$OUT/model.usdz" --engine glb --name "X" --dims 75x80x95 --library "$LIB"
# Outside mock mode with no key: must fail before any network call.
if env -u FAL_KEY -u NOOK_FAL_MOCK NOOK_NO_DOTENV=1 HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
    uv run -q --offline --project pipeline nook-add "$IMG" --name "X" --dims 75x80x95 --library "$LIB" >"$OUT/no-key.out" 2>"$OUT/no-key.err"; then
  bad "missing FAL_KEY is rejected"
else
  check "missing FAL_KEY is rejected with a FAL_KEY hint" 'tail -n 1 "$OUT/no-key.err" | grep -q FAL_KEY && ! grep -q Traceback "$OUT/no-key.err"' "$(tail -n 1 "$OUT/no-key.err")"
fi
check "bad input leaves library.json untouched" '[ "$(shasum "$LIB/library.json" 2>/dev/null)" = "$sum_before" ]'
check "bad input adds no cost rows" '[ "$(wc -l <"$LIB/costs.csv" 2>/dev/null)" = "$rows_before" ]'

# --- costs + contract validation (L2) ----------------------------------------
check "costs.csv has a header and one row per successful run" '[ "$(tail -n +2 "$LIB/costs.csv" 2>/dev/null | grep -c .)" -ge 6 ]' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
check "costs.csv columns are date,id,engine,cost_usd,mock,input" '[ "$(head -n 1 "$LIB/costs.csv" 2>/dev/null)" = "date,id,engine,cost_usd,mock,input" ]'
check "mock runs record \$0 and mock=true" 'node -e "
  const rows = require(\"fs\").readFileSync(\"$LIB/costs.csv\", \"utf8\").trim().split(\"\n\").slice(1).map(r => r.split(\",\"))
  process.exit(rows.length && rows.every(r => Number(r[3]) === 0 && r[4] === \"true\") ? 0 : 1)"' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
if evals/py evals/validate_library.py "$LIB/library.json" >"$OUT/validate.out" 2>&1; then
  ok "library passes evals/validate_library.py"
else
  bad "library passes evals/validate_library.py — $(grep FAIL "$OUT/validate.out" | tr '\n' ' ')"
fi

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
