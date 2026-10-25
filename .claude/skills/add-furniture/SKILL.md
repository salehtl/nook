---
name: add-furniture
description: Add a piece of furniture to the nook library from a photo, product page link, or 3D model file, at real-world size. Use whenever the user shares a furniture photo or product link and wants to see it in the room.
---

# Add furniture to the nook library

The CLI does the mechanical work (`pipeline/`, see contract/CONTRACT.md §3). Your job is the judgment: finding dimensions, picking the cheapest engine that will be good enough, and checking the result.

## 1. Gather inputs

- **Dimensions (required)**: W × D × H in cm. Read them from the product page (look for "Dimensions", "Product size", "Measurements"). If you're given only a photo, ask the user; never guess. Width is side to side when facing the front, depth is front to back.
- **Name and category**: short and human, e.g. "Strandmon wing chair", category `armchair`.
- **Photo**: prefer the clearest view of the whole piece, ideally a three-quarter front view. Save remote images to `library/_inbox/` first so the input is kept.

## 2. Choose the engine (cheapest first)

1. **Retailer 3D model (free)**: product pages with "View in your room"/AR often link a `.glb` or `.usdz`. Look for it in the page source. A GLB goes in with `--engine glb`. A USDZ isn't supported yet: tell the user and fall back to an image engine.
2. **`sam3d` ($0.02, default)**: works on cluttered and styled photos. Set `--prompt` to the object noun ("armchair", "floor lamp", "side table"). It gives a splat plus a mesh.
3. **`trellis2` ($0.25 at 512p)**: only when the user asks for higher fidelity, or after a `sam3d` result looks too rough. Works best on a clean, single-object product shot. Use `--resolution 1024` ($0.30) only on request.

Check the current engine defaults in `evals/golden/RESULTS.md` if it exists. It records which engine won for which kind of furniture.

## 3. Run

```bash
uv run --project pipeline nook-add <image|url|model.glb> --name "<name>" --dims <W>x<D>x<H> --category <category> [--engine sam3d|trellis2|glb] [--prompt <noun>] [--yaw 0|90|180|270]
```

For a dry run with no spend, set `NOOK_FAL_MOCK=fixtures/fal`.

## 4. Check, then report

- The CLI validates its own output. If it fails, read the one-line error and fix the cause; don't retry blindly. Each live retry costs money.
- Run `evals/py evals/validate_library.py library/library.json`.
- Look at it: open the planner (`npm run serve`, then `http://localhost:8765/planner/`), add the item, and check it faces +Z (the front points toward the default camera). If it's backwards or sideways, re-run with `--yaw` using `--engine glb` on `library/<id>/raw/` output, which is free, instead of regenerating.
- Tell the user the item name, dims, engine, the cost (from the CLI's summary line), and anything that looked off.
