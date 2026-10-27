#!/usr/bin/env bash
# nook-scan jobs server eval (contract §5, A1): real `nook-scan serve` on the 40-frame fixture, with a stand-in trainer.
# v4 (§5.1, A3): kept captures, retrain, naming, parent copy, dedupe for uploads only, and X-Nook on mutations (§2.9).
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
upload() { curl -s -o "$OUT/$2.json" -w '%{http_code}' -H 'X-Nook: 1' -H 'Content-Type: application/zip' --data-binary "@$OUT/zips/$1" "$BASE/api/scan/captures" "${@:3}"; }
job() { curl -s "$BASE/api/scan/jobs/$1"; }
wait_status() {  # job-id, wanted statuses (regex), timeout seconds; records progress values seen
  local t0=$(date +%s) s
  [ -n "$1" ] || { echo "no-job"; return 1; }   # the request that should have made the job failed
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
code=$(curl -s -o "$OUT/cancel3.json" -w '%{http_code}' -X POST -H 'X-Nook: 1' "$BASE/api/scan/jobs/$J3/cancel")
check "cancel a queued job" '[ "$code" = 200 ] && [ "$(j "d[\"status\"]" <"$OUT/cancel3.json")" = cancelled ]' "$code"
wait_status "$J2" 'training' 120 >/dev/null
code=$(curl -s -o "$OUT/cancel2.json" -w '%{http_code}' -X POST -H 'X-Nook: 1' "$BASE/api/scan/jobs/$J2/cancel")
check "cancel a training job" '[ "$code" = 200 ] && [ "$(job "$J2" | j "d[\"status\"]")" = cancelled ]' "$code"
sleep 3
check "no trainer left running after cancel" '! pgrep -f "evals/fake_gsplat.py" >/dev/null'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Nook: 1' "$BASE/api/scan/jobs/$J1/cancel")
check "cancel a finished job is 409" '[ "$code" = 409 ]' "$code"

# --- bad requests ---------------------------------------------------------------------------------
code=$(upload bad.zip bad)
check "bad zip is 400 with an error message" '[ "$code" = 400 ] && j "len(d[\"error\"]) > 10" <"$OUT/bad.json" | grep -q True' "$code $(cat "$OUT/bad.json" 2>/dev/null)"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Nook: 1' -H 'Content-Type: application/zip' -H 'Transfer-Encoding: chunked' --data-binary "@$OUT/zips/c4.zip" "$BASE/api/scan/captures")
check "upload without Content-Length is 411" '[ "$code" = 411 ]' "$code"
check "unknown job is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/scan/jobs/nope")" = 404 ]'
check "path traversal is 404" '[ "$(curl -s --path-as-is -o /dev/null -w "%{http_code}" "$BASE/api/scan/jobs/../../../etc/passwd")" = 404 ]'
code=$(upload c4.zip badname -H 'X-Nook-Name: Bad Name')
check "non-slug X-Nook-Name is 400" '[ "$code" = 400 ]' "$code"

# --- v4: kept captures and retraining (§5.1, A3) ---------------------------------------------------------------------------
post() {  # post NAME PATH [JSON]: a mutation with X-Nook; saves the response, prints the status
  local b=${3:-}; [ -n "$b" ] || b='{}'
  curl -s -o "$OUT/$1.json" -w '%{http_code}' -X POST -H 'X-Nook: 1' -H 'Content-Type: application/json' --data-binary "$b" "$BASE$2"
}
C1=scan-20261026-000001
check "W1 an upload without X-Nook is 403" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/zip" --data-binary "@$OUT/zips/c4.zip" "$BASE/api/scan/captures")" = 403 ]'
check "W1 a cancel with a foreign Origin is 403" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Nook: 1" -H "Origin: http://evil.example" "$BASE/api/scan/jobs/$J1/cancel")" = 403 ]'
curl -s "$BASE/api/scan/captures" >"$OUT/caps.json"
check "GET /api/scan/captures lists the finished job's capture, with its room" 'j "[c for c in d[\"captures\"] if c[\"name\"] == \"$C1\" and c[\"size_bytes\"] > 0 and \"$C1\" in c[\"rooms\"] and c[\"roomplan\"] is False]" <"$OUT/caps.json" | grep -q "$C1"' "$(head -c 400 "$OUT/caps.json")"
check "a cancelled job's capture is kept too" 'j "[c[\"name\"] for c in d[\"captures\"]]" <"$OUT/caps.json" | grep -q scan-20261026-000002'
[ "$OWN" = 1 ] && check "the kept capture is <data-dir>/captures/<capture>.zip" '[ -s "$OUT/data/captures/$C1.zip" ]' "$(ls "$OUT/data" "$OUT/data/captures" 2>&1 | tr '\n' ' ')"
code=$(curl -s -o "$OUT/defaults.json" -w '%{http_code}' "$BASE/api/scan/captures/$C1/defaults")
check "GET /captures/<name>/defaults returns n_train, settings and eta_s" '[ "$code" = 200 ] && j "d[\"n_train\"] > 0 and d[\"eta_s\"] > 0 and {\"steps\",\"train_max_splats\",\"deliver_max_splats\",\"max_image_size\",\"stills_max_size\",\"sh_degree\",\"pose_opt\",\"holdout_every\"} <= set(d[\"settings\"])" <"$OUT/defaults.json" | grep -q True' "$code $(cat "$OUT/defaults.json")"
check "defaults scale with the capture: steps = clamp(60 x n_train, 20k, 120k)" 'j "d[\"settings\"][\"steps\"] == min(120000, max(20000, 60 * d[\"n_train\"]))" <"$OUT/defaults.json" | grep -q True'
check "retrain with an unknown setting is 400 naming it" '[ "$(post rbad1 "/api/scan/captures/$C1/retrain" "{\"settings\": {\"warp\": 9}}")" = 400 ] && grep -q warp "$OUT/rbad1.json"'
check "retrain with a value out of range is 400 naming it" '[ "$(post rbad2 "/api/scan/captures/$C1/retrain" "{\"settings\": {\"sh_degree\": 7}}")" = 400 ] && grep -q sh_degree "$OUT/rbad2.json"'
check "retrain of an unknown capture is 404" '[ "$(post rbad3 /api/scan/captures/scan-nope/retrain)" = 404 ]'
code=$(post r1 "/api/scan/captures/$C1/retrain" '{"settings": {"steps": 2000, "holdout_every": 0}, "title": "Sharper"}')
R1=$(j 'd["id"]' <"$OUT/r1.json" 2>/dev/null)
check "POST /captures/<name>/retrain is 202 with a retrain job named <base>-r1" '[ "$code" = 202 ] && j "d[\"kind\"] == \"retrain\" and d[\"parent\"] == \"$C1\" and d[\"name\"] == \"$C1-r1\"" <"$OUT/r1.json" | grep -q True' "$code $(head -c 400 "$OUT/r1.json")"
code=$(post r2 "/api/scan/captures/$C1/retrain" '{"settings": {"steps": 2000}}')
R2=$(j 'd["id"]' <"$OUT/r2.json" 2>/dev/null)
check "a second retrain while the first is queued is <base>-r2 (queued jobs count)" '[ "$code" = 202 ] && [ "$(j "d[\"name\"]" <"$OUT/r2.json")" = "$C1-r2" ]' "$code $(head -c 300 "$OUT/r2.json")"
check "upload jobs carry kind upload" '[ "$(job "$J1" | j "d.get(\"kind\")")" = upload ]'
check "DELETE a capture while a job for it is queued or training is 409" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X DELETE -H "X-Nook: 1" "$BASE/api/scan/captures/$C1")" = 409 ]'
st=$(wait_status "$R1" 'done|failed|cancelled' 900)
check "retrain job 1 trains to done, settings record what ran" '[ "$st" = done ] && job "$R1" | j "d[\"settings\"][\"steps\"] == 2000" | grep -q True' "$st: $(j 'd["message"]' <"$OUT/last.json" 2>/dev/null)"
wait_status "$R2" 'done|failed|cancelled' 900 >/dev/null
if [ "$OWN" = 1 ]; then
  check "the retrained room copies its parent's transform and look, with parent and title set" 'evals/py -c "
import json, jsonschema
p = json.load(open(\"$OUT/room/$C1.room.json\")); c = json.load(open(\"$OUT/room/$C1-r1.room.json\"))
jsonschema.validate(c, json.load(open(\"contract/room.schema.json\")))
assert c[\"transform\"] == p[\"transform\"] and c.get(\"look\") == p.get(\"look\"), (c, p)
assert c[\"parent\"] == \"$C1\" and c[\"title\"] == \"Sharper\" and c.get(\"viewpoints\"), c
"' "$(ls "$OUT/room" | tr '\n' ' ')"
  check "a retrain doesn't repoint room.json" 'evals/py -c "
import json; r = json.load(open(\"$OUT/room/room.json\")); assert \"-r1\" not in r[\"splat\"] and \"-r2\" not in r[\"splat\"], r[\"splat\"]"'
  check "retrained rooms have no layouts" '[ ! -e "$OUT/layouts/$C1-r1" ]'
fi
code=$(post r3 "/api/scan/captures/$C1/retrain" '{"settings": {"steps": 2000}}')
check "retraining again from the newest room continues the numbering (-r3)" '[ "$code" = 202 ] && [ "$(j "d[\"name\"]" <"$OUT/r3.json")" = "$C1-r3" ] && [ "$(j "d[\"parent\"]" <"$OUT/r3.json")" = "$C1-r2" ]' "$code $(head -c 300 "$OUT/r3.json")"
R3=$(j 'd["id"]' <"$OUT/r3.json" 2>/dev/null); post r3c "/api/scan/jobs/$R3/cancel" >/dev/null
code=$(upload c1.zip up1c)
check "re-uploading after retrains still dedupes to the upload job only" '[ "$code" = 200 ] && [ "$(j "d[\"id\"]" <"$OUT/up1c.json")" = "$J1" ]' "$code $(head -c 200 "$OUT/up1c.json")"
LONG=a123456789-b123456789-c123456789-d123456789-e123456789-f1234567   # 64 characters
code=$(upload c4.zip uplong -H "X-Nook-Name: $LONG")
JL=$(j 'd["id"]' <"$OUT/uplong.json" 2>/dev/null)
wait_status "$JL" 'done|failed|cancelled' 900 >/dev/null
code=$(post rlong /api/scan/captures/scan-20261026-000004/retrain '{"settings": {"steps": 2000}}')
check "a 64-character base is truncated so <base>-r1 stays a slug of at most 64" '[ "$code" = 202 ] && j "len(d[\"name\"]) <= 64 and d[\"name\"].endswith(\"-r1\") and __import__(\"re\").fullmatch(\"[a-z0-9][a-z0-9-]{0,63}\", d[\"name\"]) is not None" <"$OUT/rlong.json" | grep -q True' "$code $(head -c 300 "$OUT/rlong.json")"
RL=$(j 'd["id"]' <"$OUT/rlong.json" 2>/dev/null); wait_status "$RL" 'done|failed|cancelled' 900 >/dev/null
code=$(curl -s -o "$OUT/delcap.json" -w '%{http_code}' -X DELETE -H 'X-Nook: 1' "$BASE/api/scan/captures/scan-20261026-000004")
check "DELETE /api/scan/captures/<name> removes it; its rooms stay" '[ "$code" = 200 ] && ! curl -s "$BASE/api/scan/captures" | grep -q scan-20261026-000004' "$code $(cat "$OUT/delcap.json")"
[ "$OWN" = 1 ] && check "its rooms stay after the capture is deleted" 'ls "$OUT/room/$LONG".* >/dev/null 2>&1'

# --- restart: running job fails cleanly, finished job persists ------------------------------------
if [ "$OWN" = 1 ]; then
  # A long job, so it is certainly still training when the server stops.
  stop_server; FAKE_SECONDS=60 start_server || bad "server restarts with a long job"
  upload c5.zip up5 >/dev/null; J5=$(j 'd["id"]' <"$OUT/up5.json")
  wait_status "$J5" 'training' 120 >/dev/null; sleep 3
  stop_server; sleep 2
  start_server || bad "server restarts"
  check "after restart, the interrupted job is failed with a restart message" 'job "$J5" | j "d[\"status\"] == \"failed\" and \"restart\" in d[\"message\"]" | grep -q True' "$(job "$J5" | head -c 300)"
  check "v4 the restart message points at retraining from the planner" 'job "$J5" | j "\"retrain from the planner\" in d[\"message\"]" | grep -q True'
  check "v4 a restart keeps every capture, the interrupted one included" '[ -s "$OUT/data/captures/$C1.zip" ] && [ -s "$OUT/data/captures/scan-20261026-000005.zip" ]' "$(ls "$OUT/data/captures" 2>&1 | tr '\n' ' ')"
  check "after restart, the finished job is still done" '[ "$(job "$J1" | j "d[\"status\"]")" = done ]'
fi

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
