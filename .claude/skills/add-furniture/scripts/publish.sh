#!/usr/bin/env bash
# Publish one item from the dev library (~/src/nook/library) to the live one that nook.salehtl.com serves
# (/var/lib/nook/library, owned by the `nook` service user). Needs sudo, so an agent runs it only after the user's click for this one publish (SKILL.md §5).
# Usage: publish.sh <item-id>
set -euo pipefail
ID=${1:?usage: publish.sh <item-id>}
SRC=$(cd "$(dirname "$0")/../../../.." && pwd)/library
DST=/var/lib/nook/library
JQ=$(nix build --no-link --print-out-paths nixpkgs#jq | head -1)/bin/jq

entry=$("$JQ" -c --arg id "$ID" '.items[] | select(.id == $id)' "$SRC/library.json")
[ -n "$entry" ] || { echo "no $ID in $SRC/library.json" >&2; exit 1; }

# Assets the planner uses (raw/ is engine output and stays in the dev library).
sudo install -d -o nook -g nook -m 0750 "$DST/$ID"
for f in model.glb splat.ply thumb.jpg source.jpg; do
  [ -f "$SRC/$ID/$f" ] && sudo install -o nook -g nook -m 0640 "$SRC/$ID/$f" "$DST/$ID/$f"
done

# Merge the entry: replace an item with the same id, keep every other item.
if sudo test -f "$DST/library.json"; then
  current=$(sudo cat "$DST/library.json")
  sudo cp -a "$DST/library.json" "$DST/library.json.bak"
else
  current='{"version":1,"items":[]}'
fi
merged=$(printf '%s' "$current" | "$JQ" --argjson e "$entry" '.items |= (map(select(.id != $e.id)) + [$e])')
printf '%s\n' "$merged" | sudo -u nook tee "$DST/library.json.tmp" >/dev/null
sudo -u nook mv "$DST/library.json.tmp" "$DST/library.json"

echo "items now in $DST/library.json:"
sudo "$JQ" -r '.items[].id' "$DST/library.json"
