# nook

Private sandbox for planning a home reading room: a Gaussian-splat scan of the room, furniture generated from photos at real-world size, and a browser planner to place it, compare layouts, and sit in the reading chair (virtually).

The parts:
- **Nook Scan** (`ios/`): iPhone app that captures the room with ARKit and sends it to kakapo.
- **nook-scan** (`scan/`, `gsplat/`, `poses/`): checks a capture, trains it into a splat with gsplat on kakapo's GPU, and runs the jobs server the app uploads to.
- **Planner** (`planner/`): browser app that browses every scanned room (each with its own alignment and layouts) and works on the phone as well as the desktop.
- **nook-add** (`pipeline/`): furniture from a photo, product page or GLB, at real-world size.

- Plan and history: [PLAN.md](PLAN.md) (v1), then [docs/plans/](docs/plans/) (nook-scan v1–v3, planner v2)
- Spec shared by the planner and the pipeline: [contract/CONTRACT.md](contract/CONTRACT.md)
- Scanning the room: [docs/SCANNING.md](docs/SCANNING.md)
- Engine comparison: [evals/golden/RESULTS.md](evals/golden/RESULTS.md)

## Where it runs

On kakapo, as the `services.nook` NixOS module ([nix/module.nix](nix/module.nix)): the jobs server (`nook-scan serve`, port 8095) and the planner at https://nook.salehtl.com/planner/. Scan, send and open a room as in [docs/SCANNING.md](docs/SCANNING.md). Deploying a new version is a nook pin bump in the kakapo repo.

## Use it locally

```bash
npm run serve            # http://localhost:8765/planner/
```

`planner/serve.py --room-dir --library-dir --scan-api <jobs-server-url>` points it at other data or a jobs server. Training only runs on kakapo; the Mac doesn't train.

Add furniture (or just ask Claude: the `add-furniture` skill knows the steps):

```bash
uv run --project pipeline nook-add photo.jpg --name "Reading chair" --dims 76x89x94 --prompt armchair
```

`sam3d` ($0.02) is the default engine. `--engine trellis2` ($0.25) is for a second opinion, and `--engine glb model.glb` (free) is for retailer 3D models. `FAL_KEY` goes in `.env`.

## Hosted copy (Cloudflare Pages)

https://nook-3mk.pages.dev: an older copy of the planner, from before planner v2. It has a single room and no rooms API (`deploy/functions/` hasn't had §2.7 ported). Layouts and room alignment are stored in KV, and furniture and scans in R2.

**Private:** Cloudflare Access (app "nook planner") guards the site and every preview URL (`*.nook-3mk.pages.dev`). Only salehtl@icloud.com can sign in, with a one-time code by email, and a session lasts 30 days. `cf:publish` / `cf:pull` use wrangler's own login, so Access doesn't affect them. Rendering on the hosted copy needs the fal key as a Pages secret: `cd deploy && npx wrangler pages secret put FAL_KEY --project-name nook`.

```bash
npm run cf:publish                 # upload new/changed library + room files to R2, deploy the planner
npm run cf:publish -- --push-room  # also overwrite the hosted room alignment with room/room.json
npm run cf:pull                    # bring hosted layouts back to layouts/ (add -- --room for the alignment)
```

Adding furniture still happens locally (the pipeline is Python). Publish afterwards to see it on the hosted copy. Code lives in `deploy/`: `functions/` mirrors `planner/serve.py`, and `wrangler.toml` holds the bindings. Check it with `node evals/hosted_check.mjs`. Behind Access it needs a service token in `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; without one, it only confirms the lock.

## Evals

`npm run eval:planner` · `eval:rooms` · `eval:rooms-ui` · `eval:pipeline` · `eval:server` · `eval:ios` · `eval:scan` and `eval:quality` (train on kakapo) · `node evals/library_in_planner.mjs [library.json]`. See [evals/README.md](evals/README.md) for what each checks.
