#!/usr/bin/env bash
# nook-scan jobs server eval (contract §5, A1): real `nook-scan serve` on the 40-frame fixture, with a stand-in trainer.
# Usage: bash evals/server_api.sh [base-url]   (or npm run eval:server). With a base URL (e.g. the mock server, or
# the web app proxying /api/scan), it tests that server instead of starting one; the restart test is then skipped.
# Output lands in evals/out/server/.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/server
PORT=${NOOK_EVAL_SERVER_PORT:-8797}
BASE=${1:-}
rm -rf "$OUT" && mkdir -p "$OUT/zips"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }

# Captures with distinct folder names (the server dedupes by folder name).
for n in 1 2 3 4 5; do
  d="$OUT/zips/scan-20261026-00000$n"; cp -R fixtures/capture-small "$d"
  (cd "$OUT/zips" && zip -qr "c$n.zip" "scan-20261026-00000$n" && rm -rf "scan-20261026-00000$n")
done
echo "not a zip" >"$OUT/zips/bad.zip"

SERVER_PID=""
start_server() {
  # The server's own logic is under test here, so a stand-in trainer (evals/fake_gsplat.py, same CLI and output)
  # replaces gsplat: no GPU needed, and job length is set by FAKE_GSPLAT_SECONDS.
  NOOK_GSPLAT_BIN="$PWD/evals/fake_gsplat.py" FAKE_GSPLAT_SECONDS="${FAKE_SECONDS:-1.5}" \
    uv run -q --project scan nook-scan serve --port "$PORT" --data-dir "$OUT/data" --room-dir "$OUT/room" \
    --quality draft >>"$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 100); do curl -sf "$BASE/api/scan/health" >/dev/null && return 0; sleep 0.3; done
  return 1
}
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
trap 'stop_server' EXIT

if [ -z "$BASE" ]; then
  [ -f scan/pyproject.toml ] || { echo "FAIL scan/pyproject.toml not found"; exit 1; }
  BASE="http://127.0.0.1:$PORT"
  start_server || { echo "FAIL nook-scan serve did not answer /api/scan/health (log: $OUT/server.log)"; tail -n 5 "$OUT/server.log"; exit 1; }
  OWN=1
else
  OWN=0
fi
upload() { curl -s -o "$OUT/$2.json" -w '%{http_code}' -H 'Content-Type: application/zip' --data-binary "@$OUT/zips/$1" "$BASE/api/scan/captures" "${@:3}"; }
job() { curl -s "$BASE/api/scan/jobs/$1"; }
wait_status() {  # job-id, wanted statuses (regex), timeout seconds; records progress values seen
  local t0=$(date +%s) s
  while :; do
    s=$(job "$1" | tee "$OUT/last.json" | j 'd["status"]')
    job "$1" | j 'd["progress"]' >>"$OUT/progress-$1.txt"
    [[ "$s" =~ ^($2)$ ]] && { echo "$s"; return 0; }
    (( $(date +%s) - t0 > $3 )) && { echo "$s"; return 1; }
    sleep 1
  done
}

# --- health ---------------------------------------------------------------------------------------
check "GET /api/scan/health" 'curl -sf "$BASE/api/scan/health" | j "d[\"ok\"] is True and \"trainer\" in d and \"busy\" in d and \"queued\" in d" | grep -q True'

# --- upload, idempotency, train to done ------------------------------------------------------------
code=$(upload c1.zip up1)
check "POST /api/scan/captures returns 202 with a queued/training job" '[ "$code" = 202 ] && j "d[\"status\"] in (\"queued\",\"training\")" <"$OUT/up1.json" | grep -q True' "$code $(head -c 300 "$OUT/up1.json")"
J1=$(j 'd["id"]' <"$OUT/up1.json" 2>/dev/null)
code=$(upload c1.zip up1b)
check "re-uploading the same capture is idempotent (200, same job)" '[ "$code" = 200 ] && [ "$(j "d[\"id\"]" <"$OUT/up1b.json")" = "$J1" ]' "$code"
st=$(wait_status "$J1" 'done|failed|cancelled' 900)
check "job 1 trains to done" '[ "$st" = done ]' "$st: $(j 'd["message"]' <"$OUT/last.json" 2>/dev/null)"
check "progress never goes down and ends at 1" 'python3 -c "
import sys; v=[float(x) for x in open(\"$OUT/progress-$J1.txt\") if x.strip()]
sys.exit(0 if v and all(b >= a - 1e-9 for a, b in zip(v, v[1:])) and v[-1] == 1 else 1)"'
check "done job carries result with room_url and ply_url" 'job "$J1" | j "d[\"result\"][\"room_url\"] == \"/planner/?room=\" + d[\"name\"] and d[\"result\"][\"ply_url\"].endswith(\".ply\") and d[\"finished\"] is not None" | grep -q True'
if [ "$OWN" = 1 ]; then
  check "room.json written, schema-valid, with viewpoints ≥ 0.95 m above the floor" 'evals/py -c "
import json, jsonschema
r = json.load(open(\"$OUT/room/room.json\")); jsonschema.validate(r, json.load(open(\"contract/room.schema.json\")))
vp = r.get(\"viewpoints\") or []
assert 1 <= len(vp) <= 24, len(vp)
assert all(v[\"position\"][1] >= 0.95 for v in vp), [v[\"position\"][1] for v in vp]
"' "$(head -c 400 "$OUT/room/room.json" 2>/dev/null)"
  check "<name>.room.json written next to room.json, same config" 'evals/py -c "
import json
r = json.load(open(\"$OUT/room/room.json\")); name = r[\"splat\"].rsplit(\"/\", 1)[-1].rsplit(\".\", 1)[0]
assert json.load(open(f\"$OUT/room/{name}.room.json\")) == r
"' "$(ls "$OUT/room" 2>/dev/null | tr '\n' ' ')"
  check "trained PLY exists in room-dir" 'ls "$OUT"/room/*.ply >/dev/null 2>&1'
fi
check "GET /api/scan/jobs lists the job, newest first" 'curl -s "$BASE/api/scan/jobs" | j "[x[\"id\"] for x in d[\"jobs\"]][0] == \"$J1\"" | grep -q True'

# --- queue + cancel ----------------------------------------------------------------------------------
upload c2.zip up2 >/dev/null; J2=$(j 'd["id"]' <"$OUT/up2.json")
upload c3.zip up3 >/dev/null; J3=$(j 'd["id"]' <"$OUT/up3.json")
check "second job waits while the first trains (one at a time)" '[ "$(job "$J3" | j "d[\"status\"]")" = queued ]'
code=$(curl -s -o "$OUT/cancel3.json" -w '%{http_code}' -X POST "$BASE/api/scan/jobs/$J3/cancel")
check "cancel a queued job" '[ "$code" = 200 ] && [ "$(j "d[\"status\"]" <"$OUT/cancel3.json")" = cancelled ]' "$code"
wait_status "$J2" 'training' 120 >/dev/null
code=$(curl -s -o "$OUT/cancel2.json" -w '%{http_code}' -X POST "$BASE/api/scan/jobs/$J2/cancel")
check "cancel a training job" '[ "$code" = 200 ] && [ "$(job "$J2" | j "d[\"status\"]")" = cancelled ]' "$code"
sleep 3
check "no trainer left running after cancel" '! pgrep -f "evals/fake_gsplat.py" >/dev/null'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/scan/jobs/$J1/cancel")
check "cancel a finished job is 409" '[ "$code" = 409 ]' "$code"

# --- bad requests ---------------------------------------------------------------------------------
code=$(upload bad.zip bad)
check "bad zip is 400 with an error message" '[ "$code" = 400 ] && j "len(d[\"error\"]) > 10" <"$OUT/bad.json" | grep -q True' "$code $(cat "$OUT/bad.json" 2>/dev/null)"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/zip' -H 'Transfer-Encoding: chunked' --data-binary "@$OUT/zips/c4.zip" "$BASE/api/scan/captures")
check "upload without Content-Length is 411" '[ "$code" = 411 ]' "$code"
check "unknown job is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/scan/jobs/nope")" = 404 ]'
check "path traversal is 404" '[ "$(curl -s --path-as-is -o /dev/null -w "%{http_code}" "$BASE/api/scan/jobs/../../../etc/passwd")" = 404 ]'
code=$(upload c4.zip badname -H 'X-Nook-Name: Bad Name')
check "non-slug X-Nook-Name is 400" '[ "$code" = 400 ]' "$code"

# --- restart: running job fails cleanly, finished job persists ------------------------------------
if [ "$OWN" = 1 ]; then
  # A long job, so it is certainly still training when the server stops.
  stop_server; FAKE_SECONDS=60 start_server || bad "server restarts with a long job"
  upload c5.zip up5 >/dev/null; J5=$(j 'd["id"]' <"$OUT/up5.json")
  wait_status "$J5" 'training' 120 >/dev/null; sleep 3
  stop_server; sleep 2
  start_server || bad "server restarts"
  check "after restart, the interrupted job is failed with a restart message" 'job "$J5" | j "d[\"status\"] == \"failed\" and \"restart\" in d[\"message\"]" | grep -q True' "$(job "$J5" | head -c 300)"
  check "after restart, the finished job is still done" '[ "$(job "$J1" | j "d[\"status\"]")" = done ]'
fi

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
