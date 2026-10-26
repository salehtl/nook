#!/usr/bin/env bash
# Planner rooms API eval (contract §2.7, P17–P19 server side): planner/serve.py on a scratch room dir with three
# rooms (copies of the fixture splat), a v1 room.json and a v1 layout. No browser, no network, $0.
# Usage: bash evals/rooms_api.sh   (or npm run eval:rooms). Output lands in evals/out/rooms/.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/rooms
ROOM="$OUT/room"
LAYOUTS="$OUT/layouts"
PORT=${NOOK_EVAL_ROOMS_PORT:-8796}
BASE="http://127.0.0.1:$PORT"
rm -rf "$OUT" && mkdir -p "$ROOM" "$LAYOUTS" "$OUT/r"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
# py EXPR: evaluate a Python expression with json/os/OUT/ROOM/LAYOUTS and helpers r(name) (a saved response) and
# f(path) (a JSON file) in scope; exits 0 when it is truthy.
py() { OUT="$OUT" ROOM="$ROOM" LAYOUTS="$LAYOUTS" python3 -c '
import json, os, sys
OUT, ROOM, LAYOUTS = os.environ["OUT"], os.environ["ROOM"], os.environ["LAYOUTS"]
r = lambda n: json.load(open(f"{OUT}/r/{n}.json"))
f = lambda p: json.load(open(p))
sys.exit(0 if eval(sys.argv[1]) else 1)' "$1"; }
# call NAME METHOD PATH [BODY-FILE]: saves the response to $OUT/r/NAME.json and prints the status code.
call() {
  local args=(-s -o "$OUT/r/$1.json" -w '%{http_code}' -X "$2")
  [ -n "${4:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$4")
  curl "${args[@]}" "$BASE$3"
}
body() { printf '%s' "$2" >"$OUT/r/$1.body"; echo "$OUT/r/$1.body"; }

# --- seed: three rooms with different mtimes, distractors, a v1 room.json and v1 layouts ----------------------------
cp fixtures/room/test.spz "$ROOM/hall-old.spz"
cp fixtures/room/test.spz "$ROOM/reading-room.spz"
cp fixtures/room/test.spz "$ROOM/study-new.spz"
head -c 1000 fixtures/room/test.spz >"$ROOM/study-new.ply"   # .spz wins over .ply
cp fixtures/room/test.spz "$ROOM/.hidden.spz"                 # dotfile: not a room
cp fixtures/room/test.spz "$ROOM/Bad_Name.spz"                # not a slug: not a room
mkdir -p "$ROOM/.trash/old-1" && cp fixtures/room/test.spz "$ROOM/.trash/old-1/gone.spz"
echo "notes" >"$ROOM/notes.txt"
python3 - "$ROOM" <<'EOF'
import os, sys, time
d, now = sys.argv[1], time.time()
for name, age in [("hall-old.spz", 3 * 86400), ("reading-room.spz", 2 * 86400), ("study-new.spz", 86400), ("study-new.ply", 86400)]:
    os.utime(os.path.join(d, name), (now - age, now - age))
EOF
cat >"$ROOM/room.json" <<EOF
{
  "version": 1,
  "splat": "$ROOM/reading-room.spz",
  "transform": {"position": [0.25, 0.9052, -0.5], "quaternion": [0, 0.3826834, 0, 0.9238795], "scale": 1.25},
  "look": {"exposure": 1.3, "warmth": -0.2},
  "viewpoints": [{"position": [0.1, 1.5, 0.2], "quaternion": [0, 0, 0, 1], "fov_y_deg": 60},
                 {"position": [-1.0, 1.4, 0.8], "quaternion": [0, 0.7071068, 0, 0.7071068], "fov_y_deg": 55}]
}
EOF
cp "$ROOM/room.json" "$OUT/room.v1.json"
python3 - "$ROOM" "$LAYOUTS" <<'EOF'
import json, sys
room = json.load(open(f"{sys.argv[1]}/room.json"))
items = [{"uid": "a1", "id": "chair", "render": "glb", "position": [0, 0, 0], "rotation_y_deg": 0},
         {"uid": "a2", "id": "lamp", "render": "glb", "position": [1, 0, 1], "rotation_y_deg": 90}]
json.dump({"version": 1, "name": "legacy-one", "library": None, "room": room, "items": items}, open(f"{sys.argv[2]}/legacy-one.json", "w"))
json.dump({"version": 1, "name": "other-v1", "library": None, "room": None, "items": []}, open(f"{sys.argv[2]}/other-v1.json", "w"))
EOF

python3 planner/serve.py --port "$PORT" --room-dir "$ROOM" --layouts-dir "$LAYOUTS" --renders-dir "$OUT/renders" \
  --costs-file "$OUT/costs.csv" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf "$BASE/api/room" >/dev/null && break; sleep 0.2; done
curl -sf "$BASE/api/room" >/dev/null || { echo "FAIL planner/serve.py did not start (log: $OUT/server.log)"; tail -n 5 "$OUT/server.log"; exit 1; }

# --- v1 endpoints answer as before ---------------------------------------------------------------------------------------
code=$(call v1room GET /api/room)
check "v1 GET /api/room returns room.json as is" '[ "$code" = 200 ] && py "r(\"v1room\") == f(OUT + \"/room.v1.json\")"' "$code"
code=$(call v1list GET /api/layouts)
check "v1 GET /api/layouts lists only the flat layouts, same shape" '[ "$code" = 200 ] && py "r(\"v1list\") == {\"layouts\": [\"legacy-one\", \"other-v1\"]}"' "$(cat "$OUT/r/v1list.json")"
code=$(call v1get GET /api/layouts/legacy-one)
check "v1 GET /api/layouts/<name> loads a flat layout" '[ "$code" = 200 ] && py "r(\"v1get\")[\"name\"] == \"legacy-one\""' "$code"
check "v1 GET /api/layouts/<missing> is 404" '[ "$(call v1miss GET /api/layouts/nope)" = 404 ]'
check "v1 PUT /api/layouts/<non-slug> is 400" '[ "$(call v1bad PUT /api/layouts/Bad%20Name "$(body v1bad "{}")")" = 400 ]'

# --- listing (P17) and adoption (P19) ------------------------------------------------------------------------------------
code=$(call list1 GET /api/rooms)
check "GET /api/rooms lists the three rooms newest first" '[ "$code" = 200 ] && py "[x[\"name\"] for x in r(\"list1\")[\"rooms\"]] == [\"study-new\", \"reading-room\", \"hall-old\"]"' "$code $(head -c 400 "$OUT/r/list1.json")"
check "room objects have exactly the contract fields" 'py "all(set(x) == {\"name\",\"title\",\"splat\",\"created\",\"size_bytes\",\"thumb_url\",\"aligned\",\"layouts\",\"current\"} for x in r(\"list1\")[\"rooms\"])"'
check "current is the room room.json points at" 'py "r(\"list1\")[\"current\"] == \"reading-room\" and [x[\"current\"] for x in r(\"list1\")[\"rooms\"]] == [False, True, False]"'
check "splat paths follow the trainer convention, .spz wins over .ply" 'py "[x[\"splat\"] for x in r(\"list1\")[\"rooms\"]] == [ROOM + \"/study-new.spz\", ROOM + \"/reading-room.spz\", ROOM + \"/hall-old.spz\"]"' "$(head -c 300 "$OUT/r/list1.json")"
check "size, created (ISO UTC), thumb_url, aligned, title" 'py "all(x[\"size_bytes\"] == os.path.getsize(ROOM + \"/test.spz\".replace(\"test\", x[\"name\"])) and x[\"created\"].endswith(\"Z\") and x[\"thumb_url\"] is None and x[\"aligned\"] is False and x[\"title\"] is None for x in r(\"list1\")[\"rooms\"])"'
check "legacy layout counted under its room only" 'py "[x[\"layouts\"] for x in r(\"list1\")[\"rooms\"]] == [0, 1, 0]"'
check "P19 adoption: room.json copied to reading-room.room.json" 'py "f(ROOM + \"/reading-room.room.json\") == f(OUT + \"/room.v1.json\")"'
check "no per-room config written for rooms room.json doesn't point at" '[ ! -e "$ROOM/hall-old.room.json" ] && [ ! -e "$ROOM/study-new.room.json" ]'
code=$(call getrr GET /api/rooms/reading-room)
check "P19 GET /api/rooms/<current> keeps alignment, look and viewpoints" '[ "$code" = 200 ] && py "r(\"getrr\") == f(OUT + \"/room.v1.json\")"' "$code"
code=$(call gethall GET /api/rooms/hall-old)
check "GET /api/rooms/<other> is the identity config with splat set" '[ "$code" = 200 ] && py "r(\"gethall\") == {\"version\": 1, \"splat\": ROOM + \"/hall-old.spz\"}"' "$(cat "$OUT/r/gethall.json")"

# --- per-room save (P17) ---------------------------------------------------------------------------------------------------
cp "$ROOM/reading-room.room.json" "$OUT/rr.before.json"; cp "$ROOM/room.json" "$OUT/roomjson.before.json"
code=$(call puthall PUT /api/rooms/hall-old "$(body puthall '{"version": 1, "splat": "elsewhere/x.spz", "title": "Hall, old scan", "saved": "1999-01-01T00:00:00Z", "transform": {"position": [0, 1.1, 0], "quaternion": [0, 0, 0, 1], "scale": 2}}')")
check "PUT /api/rooms/<name> writes <name>.room.json" '[ "$code" = 200 ] && [ -f "$ROOM/hall-old.room.json" ]' "$code $(cat "$OUT/r/puthall.json")"
check "splat forced to the room's scan, saved stamped by the server" 'py "(lambda c: c[\"splat\"] == ROOM + \"/hall-old.spz\" and c[\"saved\"] != \"1999-01-01T00:00:00Z\" and c[\"saved\"].endswith(\"Z\") and c[\"transform\"][\"scale\"] == 2 and c[\"title\"] == \"Hall, old scan\")(f(ROOM + \"/hall-old.room.json\"))"'
check "P17 saving one room leaves the others' configs and room.json unchanged" 'cmp -s "$OUT/rr.before.json" "$ROOM/reading-room.room.json" && cmp -s "$OUT/roomjson.before.json" "$ROOM/room.json" && [ ! -e "$ROOM/study-new.room.json" ]'
call list2 GET /api/rooms >/dev/null
check "listing shows the title and aligned after a save" 'py "[(x[\"title\"], x[\"aligned\"]) for x in r(\"list2\")[\"rooms\"] if x[\"name\"] == \"hall-old\"] == [(\"Hall, old scan\", True)]"'
code=$(call putrr PUT /api/rooms/reading-room "$(body putrr '{"version": 1, "transform": {"position": [0, 0.8, 0], "quaternion": [0, 0, 0, 1], "scale": 1.1}, "look": {"exposure": 0.9, "warmth": 0.3}, "viewpoints": null}')")
check "saving the current room updates room.json too" '[ "$code" = 200 ] && py "f(ROOM + \"/room.json\") == f(ROOM + \"/reading-room.room.json\") and f(ROOM + \"/room.json\")[\"transform\"][\"scale\"] == 1.1"' "$code"
call v1room2 GET /api/room >/dev/null
check "v1 GET /api/room sees the per-room save of the current room" 'py "r(\"v1room2\") == f(ROOM + \"/reading-room.room.json\")"'
cp "$ROOM/hall-old.room.json" "$OUT/hall.before.json"
code=$(call v1put PUT /api/room "$(body v1put "{\"version\": 1, \"splat\": \"$ROOM/reading-room.spz\", \"look\": {\"exposure\": 2, \"warmth\": 0}}")")
check "v1 PUT /api/room still writes room.json" '[ "$code" = 200 ] && py "r(\"v1put\") == {\"ok\": True} and f(ROOM + \"/room.json\")[\"look\"][\"exposure\"] == 2"' "$code"
check "v1 PUT /api/room mirrors into the current room's <name>.room.json only" 'py "f(ROOM + \"/reading-room.room.json\") == f(ROOM + \"/room.json\")" && cmp -s "$OUT/hall.before.json" "$ROOM/hall-old.room.json"'

# --- thumbnails --------------------------------------------------------------------------------------------------------------
python3 - "$OUT/r" <<'EOF'
import base64, json, sys
jpg = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 4 + b"\xff\xd9"
open(f"{sys.argv[1]}/thumb.jpg", "wb").write(jpg)
json.dump({"image": "data:image/jpeg;base64," + base64.b64encode(jpg).decode()}, open(f"{sys.argv[1]}/thumb.body", "w"))
json.dump({"image": "data:image/png;base64," + base64.b64encode(b"\x89PNG....").decode()}, open(f"{sys.argv[1]}/png.body", "w"))
big = b"\xff\xd8\xff\xe0" + b"\0" * (2 * 1024 * 1024 + 10)
json.dump({"image": "data:image/jpeg;base64," + base64.b64encode(big).decode()}, open(f"{sys.argv[1]}/big.body", "w"))
EOF
code=$(call thumb PUT /api/rooms/hall-old/thumb "$OUT/r/thumb.body")
check "PUT /api/rooms/<name>/thumb writes <name>.jpg" '[ "$code" = 200 ] && cmp -s "$OUT/r/thumb.jpg" "$ROOM/hall-old.jpg"' "$code $(cat "$OUT/r/thumb.json")"
check "thumbnail served at /room/<name>.jpg as image/jpeg" 'curl -s -D "$OUT/r/thumb.hdr" -o "$OUT/r/thumb.got" "$BASE/room/hall-old.jpg" && cmp -s "$OUT/r/thumb.jpg" "$OUT/r/thumb.got" && grep -qi "content-type: image/jpeg" "$OUT/r/thumb.hdr"'
call list3 GET /api/rooms >/dev/null
check "listing has thumb_url for that room only" 'py "{x[\"name\"]: x[\"thumb_url\"] for x in r(\"list3\")[\"rooms\"]} == {\"study-new\": None, \"reading-room\": None, \"hall-old\": \"/room/hall-old.jpg\"}"'
check "a non-JPEG thumbnail is 400" '[ "$(call thumbpng PUT /api/rooms/hall-old/thumb "$OUT/r/png.body")" = 400 ]'
check "a thumbnail over 2 MB is 413" '[ "$(call thumbbig PUT /api/rooms/hall-old/thumb "$OUT/r/big.body")" = 413 ]'
check "a thumbnail for an unknown room is 404" '[ "$(call thumbnope PUT /api/rooms/nope/thumb "$OUT/r/thumb.body")" = 404 ]'

# --- per-room layouts (P18) ---------------------------------------------------------------------------------------------------
LAY='{"version": 1, "name": "plan-a", "library": null, "room": null, "items": [{"uid": "u1", "id": "chair", "render": "glb", "position": [0, 0, 0], "rotation_y_deg": 0}]}'
code=$(call puta PUT "/api/layouts/plan-a?room=hall-old" "$(body puta "$LAY")")
check "PUT /api/layouts/<l>?room= writes layouts/<room>/<l>.json with room_name" '[ "$code" = 200 ] && py "f(LAYOUTS + \"/hall-old/plan-a.json\")[\"room_name\"] == \"hall-old\""' "$code $(cat "$OUT/r/puta.json")"
call la GET "/api/layouts?room=hall-old" >/dev/null; call lb GET "/api/layouts?room=study-new" >/dev/null; call lr GET "/api/layouts?room=reading-room" >/dev/null
check "GET /api/layouts?room= lists the room's layouts with details" 'py "r(\"la\")[\"layouts\"] == [\"plan-a\"] and r(\"la\")[\"details\"][0][\"items\"] == 1 and r(\"la\")[\"details\"][0][\"legacy\"] is False and r(\"la\")[\"details\"][0][\"updated\"].endswith(\"Z\")"' "$(cat "$OUT/r/la.json")"
check "P18 a layout saved in room A isn't listed in room B" 'py "r(\"lb\") == {\"layouts\": [], \"details\": []}"' "$(cat "$OUT/r/lb.json")"
check "P18 the v1 layout is listed under its room as legacy" 'py "r(\"lr\")[\"layouts\"] == [\"legacy-one\"] and r(\"lr\")[\"details\"] == [dict(r(\"lr\")[\"details\"][0], name=\"legacy-one\", items=2, legacy=True)]"' "$(cat "$OUT/r/lr.json")"
code=$(call getleg GET "/api/layouts/legacy-one?room=reading-room")
check "P18 the v1 layout loads through ?room= (fallback)" '[ "$code" = 200 ] && py "r(\"getleg\") == f(LAYOUTS + \"/legacy-one.json\")"' "$code"
code=$(call geta GET "/api/layouts/plan-a?room=hall-old")
check "GET /api/layouts/<l>?room= reads the room's layout" '[ "$code" = 200 ] && py "r(\"geta\")[\"room_name\"] == \"hall-old\""' "$code"
check "another room's layout is 404 through ?room=" '[ "$(call getab GET "/api/layouts/plan-a?room=study-new")" = 404 ]'
call v1list2 GET /api/layouts >/dev/null
check "room layouts don't appear in the v1 list" 'py "r(\"v1list2\") == {\"layouts\": [\"legacy-one\", \"other-v1\"]}"' "$(cat "$OUT/r/v1list2.json")"
check "written layouts are layout.schema.json-valid" 'evals/py -c "
import json, jsonschema
s = json.load(open(\"contract/layout.schema.json\"))
jsonschema.validate(json.load(open(\"$LAYOUTS/hall-old/plan-a.json\")), s)"'
code=$(call dela DELETE "/api/layouts/plan-a?room=hall-old")
check "DELETE /api/layouts/<l>?room= removes the room's layout" '[ "$code" = 200 ] && [ ! -e "$LAYOUTS/hall-old/plan-a.json" ]' "$code"
check "deleting it again is 404" '[ "$(call dela2 DELETE "/api/layouts/plan-a?room=hall-old")" = 404 ]'
check "v1 layouts aren't deleted through ?room= (404, file kept)" '[ "$(call delleg DELETE "/api/layouts/legacy-one?room=reading-room")" = 404 ] && [ -f "$LAYOUTS/legacy-one.json" ]'
check "DELETE /api/layouts/<l> without ?room= is 400, file kept" '[ "$(call delv1 DELETE /api/layouts/other-v1)" = 400 ] && [ -f "$LAYOUTS/other-v1.json" ]'

# --- bad names --------------------------------------------------------------------------------------------------------------
check "GET /api/rooms/<non-slug> is 404" '[ "$(call b1 GET /api/rooms/Bad_Name)" = 404 ]'
check "GET /api/rooms/<unknown> is 404" '[ "$(call b2 GET /api/rooms/nope)" = 404 ] && py "len(r(\"b2\")[\"error\"]) > 10"'
check "PUT /api/rooms/<non-slug> is 400" '[ "$(call b3 PUT /api/rooms/Bad%20Name "$(body b3 "{\"version\": 1}")")" = 400 ]'
check "PUT /api/rooms/<unknown> is 404" '[ "$(call b4 PUT /api/rooms/nope "$(body b4 "{\"version\": 1}")")" = 404 ] && [ ! -e "$ROOM/nope.room.json" ]'
check "PUT /api/rooms/<name> without version is 400" '[ "$(call b5 PUT /api/rooms/hall-old "$(body b5 "{\"splat\": 1}")")" = 400 ]'
check "DELETE /api/rooms/<unknown> is 404" '[ "$(call b6 DELETE /api/rooms/nope)" = 404 ]'
check "?room=<non-slug> is 400" '[ "$(call b7 GET "/api/layouts?room=Bad%20Name")" = 400 ]'
check "?room=<unknown> is 404" '[ "$(call b8 GET "/api/layouts?room=nope")" = 404 ]'
check "PUT /api/layouts/<non-slug>?room= is 400" '[ "$(call b9 PUT "/api/layouts/Bad%20Name?room=hall-old" "$(body b9 "{}")")" = 400 ]'
check "path traversal in a room name is 404" '[ "$(curl -s --path-as-is -o /dev/null -w "%{http_code}" "$BASE/api/rooms/..%2F..%2Fetc%2Fpasswd")" = 404 ]'
check "dotfiles in the room dir aren't served" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/room/.trash/old-1/gone.spz")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/room/.hidden.spz")" = 404 ]'

# --- schema ------------------------------------------------------------------------------------------------------------------
check "every written room config is room.schema.json-valid" 'evals/py -c "
import glob, json, jsonschema
s = json.load(open(\"contract/room.schema.json\"))
files = glob.glob(\"$ROOM/*.room.json\") + [\"$ROOM/room.json\"]
assert len(files) == 3, files
for p in files: jsonschema.validate(json.load(open(p)), s)"'

# --- delete rooms --------------------------------------------------------------------------------------------------------------
call putb PUT "/api/layouts/plan-b?room=reading-room" "$(body putb "${LAY/plan-a/plan-b}")" >/dev/null
call thumb2 PUT /api/rooms/reading-room/thumb "$OUT/r/thumb.body" >/dev/null
code=$(call delrr DELETE /api/rooms/reading-room)
T=$(python3 -c "import json; print(json.load(open('$OUT/r/delrr.json')).get('trash', ''))" 2>/dev/null)
check "DELETE /api/rooms/<current> answers ok with a .trash dir" '[ "$code" = 200 ] && [[ "$T" =~ ^\.trash/reading-room-[0-9]{8}-[0-9]{6}$ ]]' "$code $(cat "$OUT/r/delrr.json")"
check "the room's scan, config, thumbnail and layouts moved to the trash" '[ -f "$ROOM/$T/reading-room.spz" ] && [ -f "$ROOM/$T/reading-room.room.json" ] && [ -f "$ROOM/$T/reading-room.jpg" ] && [ -f "$ROOM/$T/layouts/plan-b.json" ] && [ ! -e "$ROOM/reading-room.spz" ] && [ ! -e "$ROOM/reading-room.room.json" ] && [ ! -e "$LAYOUTS/reading-room" ]' "$(cd "$ROOM" && find . | sort | tr '\n' ' ')"
check "room.json repointed at the newest remaining room" 'py "f(ROOM + \"/room.json\")[\"splat\"] == ROOM + \"/study-new.spz\""' "$(cat "$ROOM/room.json")"
call list4 GET /api/rooms >/dev/null
check "listing drops the deleted room; current follows room.json" 'py "[x[\"name\"] for x in r(\"list4\")[\"rooms\"]] == [\"study-new\", \"hall-old\"] and r(\"list4\")[\"current\"] == \"study-new\""' "$(head -c 300 "$OUT/r/list4.json")"
check "the v1 layout of the deleted room is kept" '[ -f "$LAYOUTS/legacy-one.json" ]'
cp "$ROOM/room.json" "$OUT/roomjson.before2.json"
code=$(call delhall DELETE /api/rooms/hall-old)
check "deleting a room room.json doesn't point at leaves room.json alone" '[ "$code" = 200 ] && cmp -s "$OUT/roomjson.before2.json" "$ROOM/room.json" && [ ! -e "$ROOM/hall-old.spz" ] && [ ! -e "$ROOM/hall-old.jpg" ]' "$code"
code=$(call delsn DELETE /api/rooms/study-new)
T3=$(python3 -c "import json; print(json.load(open('$OUT/r/delsn.json')).get('trash', ''))" 2>/dev/null)
check "deleting the last room moves room.json to the trash, .ply too" '[ "$code" = 200 ] && [ ! -e "$ROOM/room.json" ] && [ -f "$ROOM/$T3/room.json" ] && [ -f "$ROOM/$T3/study-new.ply" ] && [ -f "$ROOM/$T3/study-new.spz" ]' "$code $(ls -a "$ROOM")"
call list5 GET /api/rooms >/dev/null
check "no rooms left: empty list, current null" 'py "r(\"list5\") == {\"rooms\": [], \"current\": None}"' "$(cat "$OUT/r/list5.json")"
call v1room3 GET /api/room >/dev/null
check "v1 GET /api/room falls back to the placeholder" 'py "r(\"v1room3\") == {\"version\": 1, \"placeholder\": {\"w\": 3.5, \"d\": 4, \"h\": 2.7}}"'
check "the trash is never emptied (earlier entries still there)" '[ -f "$ROOM/.trash/old-1/gone.spz" ] && [ -f "$ROOM/$T/reading-room.spz" ]'

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
