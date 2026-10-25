# nook

Private sandbox for planning a home reading room: a Gaussian-splat scan of the room, furniture generated from photos at real-world size, and a browser planner to place it, compare layouts, and sit in the reading chair (virtually).

- Plan and history: [PLAN.md](PLAN.md)
- Spec shared by the planner and the pipeline: [contract/CONTRACT.md](contract/CONTRACT.md)
- Scanning the room: [docs/SCANNING.md](docs/SCANNING.md)
- Engine comparison: [evals/golden/RESULTS.md](evals/golden/RESULTS.md)

## Use it locally

```bash
npm run serve            # http://localhost:8765/planner/
```

Add furniture (or just ask Claude: the `add-furniture` skill knows the steps):

```bash
uv run --project pipeline nook-add photo.jpg --name "Reading chair" --dims 76x89x94 --prompt armchair
```

`sam3d` ($0.02) is the default engine. `--engine trellis2` ($0.25) is for a second opinion, and `--engine glb model.glb` (free) is for retailer 3D models. `FAL_KEY` goes in `.env`.

## Hosted copy (Cloudflare Pages)

https://nook-3mk.pages.dev: the same planner. Layouts and room alignment are stored in KV, and furniture and scans in R2.

```bash
npm run cf:publish                 # upload new/changed library + room files to R2, deploy the planner
npm run cf:publish -- --push-room  # also overwrite the hosted room alignment with room/room.json
npm run cf:pull                    # bring hosted layouts back to layouts/ (add -- --room for the alignment)
```

Adding furniture still happens locally (the pipeline is Python). Publish afterwards to see it on the hosted copy. Code lives in `deploy/`: `functions/` mirrors `planner/serve.py`, and `wrangler.toml` holds the bindings. Check it with `node evals/hosted_check.mjs`.

## Evals

`npm run eval:planner` · `npm run eval:pipeline` · `node evals/library_in_planner.mjs [library.json]`. See [evals/README.md](evals/README.md).
