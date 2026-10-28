---
name: add-furniture
description: Add a piece of furniture to the nook library from a photo, product page link, or 3D model file, at real-world size. Use whenever the user shares a furniture photo or product link and wants to see it in the room.
---

# Add furniture to the nook library

The CLI does the mechanical work (`pipeline/`, see contract/CONTRACT.md §3). Your job is the judgment: finding dimensions, picking the cheapest engine that will be good enough, and checking the result.

## 1. Gather inputs

- **Dimensions (required)**: W × D × H in cm. Read them from the product page (look for "Dimensions", "Product size", "Measurements"). If you're given only a photo, ask the user; never guess. Width is side to side when facing the front, depth is front to back.
  - A bare image URL from a maker's site still names the product: find its product page. Some makers (e.g. Herman Miller) list no dims on the product page; their "3D Models and Planning Tools" / product-models page usually does, in mm. Say where the dims came from and how sure you are.
- **Name and category**: short and human, e.g. "Strandmon wing chair", category `armchair`.
- **Photo**: prefer the clearest view of the whole piece, ideally a three-quarter front view. Save remote images to `library/_inbox/` first so the input is kept.

## 2. Choose the engine (cheapest first)

1. **Retailer 3D model (free)**: product pages with "View in your room"/AR often link a `.glb` or `.usdz`. Look for it in the page source. A GLB goes in with `--engine glb`. A USDZ isn't supported yet: tell the user and fall back to an image engine. Maker planning files (`.skp`, `.dwg`, `.rfa`) aren't usable either.
2. **`sam3d` ($0.02, default)**: works on cluttered and styled photos. Set `--prompt` to the object noun ("armchair", "floor lamp", "side table"). It gives a splat plus a mesh. It also picks one piece out of a set photo (e.g. `--prompt ottoman` on a chair-plus-ottoman shot), so no cropping is needed.
3. **`trellis2` ($0.25 at 512p)**: only when the user asks for higher fidelity, or after a `sam3d` result looks too rough. Works best on a clean, single-object product shot. Use `--resolution 1024` ($0.30) only on request.

Check the current engine defaults in `evals/golden/RESULTS.md` if it exists. It records which engine won for which kind of furniture.

## 3. Run

```bash
uv run --project pipeline nook-add <image|url|model.glb> --name "<name>" --dims <W>x<D>x<H> --category <category> [--engine sam3d|trellis2|glb] [--prompt <noun>] [--yaw 0|90|180|270]
```

For a dry run with no spend, set `NOOK_FAL_MOCK=fixtures/fal`.

### On kakapo (Linux)

- **Key**: `nook-add` reads `FAL_KEY` from `~/src/nook/.env`. It isn't in sops and the `nook` service doesn't have one; never look in `/run/secrets`. If `.env` is missing, check with `grep -c '^FAL_KEY=.' .env` (never print it) and give the user this to run in their own terminal (not via `!`, so the key stays off screen and out of history):

  ```bash
  (umask 077; read -rsp 'FAL key: ' k; echo; printf 'FAL_KEY=%s\n' "$k" > ~/src/nook/.env)
  ```

- **Tools**: there is no `.envrc`; run everything through `nix develop -c`. The pip wheels (numpy, trimesh) need `libstdc++` and `zlib`, which the devShell doesn't expose, so set `LD_LIBRARY_PATH` for the run:

  ```bash
  L=$(nix build --no-link --print-out-paths --impure --expr 'let p = (builtins.getFlake "'$PWD'").inputs.nixpkgs.legacyPackages.x86_64-linux; in p.symlinkJoin { name = "nook-ld"; paths = [ p.stdenv.cc.cc.lib p.zlib ]; }')
  LD_LIBRARY_PATH=$L/lib nice -n 10 nix develop -c uv run --project pipeline nook-add …
  ```

  The same applies to `evals/py` (it calls `uv`) and any Python check.

## 4. Check, then report

- The CLI validates its own output. If it fails, read the one-line error and fix the cause; don't retry blindly. Each live retry costs money.
- Run `evals/py evals/validate_library.py library/library.json`. On kakapo, items made on the Mac fail with "asset missing": `library/*/` is git-ignored, so only the Mac has their files. That's expected; judge only the new item.
- Read the fit errors in the CLI output. The GLB is stretched to the dims, so its error is always 0. The splat is scaled by height only, so a large splat w/d error (>10%) means the splat is off; then compare the raw mesh's W/H and D/H ratios (`trimesh`, on `library/<id>/raw/*.glb`) with the real ones. Within ~5% means the mesh is the right object and only the splat is loose; say so.
- Look at it (Mac only: the planner check needs Helium; on kakapo, say it wasn't done): open the planner (`npm run serve`, then `http://localhost:8765/planner/`), add the item, and check it faces +Z (the front points toward the default camera). If it's backwards or sideways, just rotate it in the planner: placement rotation is saved in the layout. Only fix the asset itself if it will be reused a lot. A free re-run with `--engine glb --yaw N` on `library/<id>/raw/*.glb` works, but it produces a GLB-only item (no splat, no thumbnail).
- Tell the user the item name, dims, engine, the cost (from the CLI's summary line), and anything that looked off.

## 5. Publish to nook.salehtl.com

`nook-add` writes to the dev library, `~/src/nook/library`. The live site (the `nook` service on kakapo) serves `/var/lib/nook/library` instead, so a new item isn't on the site until it's copied there. The web app has no upload API, and that directory belongs to the `nook` user, so publishing needs sudo. The project rules forbid sudo without the user's say-so, so ask every time, with a button: call `AskUserQuestion` ("Publish <name> to nook.salehtl.com?", options "Publish" and "Do not publish"). Only on "Publish", run it yourself:

```bash
~/src/nook/.claude/skills/add-furniture/scripts/publish.sh <id>
```

That click covers this one publish only; never run it without one (auto mode included). The script copies the item's assets, merges its `library.json` entry (same id replaced, other items kept, old file saved as `library.json.bak`) and lists the live items. No restart is needed: the web app reads `library.json` on each request. Tell the user to reload the page.
