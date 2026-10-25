# evals

Written before the planner and pipeline existed, against [contract/CONTRACT.md](../contract/CONTRACT.md). Builders make them pass but don't edit them. If an eval is wrong, say so with the exact line, and the main session fixes it.

| Command | Checks | Cost |
|---|---|---|
| `npm run eval:planner` | `evals/planner_smoke.mjs`: starts `planner/serve.py` on port 8799 with scratch room/layout paths, opens the planner in headless Helium, and drives `window.nook` through the §2.5 criteria it can check without a human (P1–P4, P6–P8, P10). Screenshots go to `evals/out/planner/*.png` for visual review. | $0 |
| `npm run eval:pipeline` | `evals/pipeline_offline.sh`: runs `nook-add` against the recorded fal responses in `fixtures/fal/` with network blocked, covering §3.6 L1–L7. Output goes to `evals/out/pipeline/`. | $0 |
| `evals/py evals/validate_library.py <library.json>` | The §1 normalized-asset rules and `library.schema.json`, for any library (fixtures, eval output, or your real `library/`). | $0 |
| `evals/py evals/glb_info.py <model.glb>` | Helper: image and material counts, bounds, vertex centroid. | $0 |

`evals/py` runs a helper under uv with its own pinned deps, independent of `pipeline/`'s environment.

Not covered automatically (check by hand or in the built-in browser): gizmo dragging (P5), the measure tool UI (P9), pick-floor and two-point scale clicks (P8 UI side), and how things look.

## Golden photos (live evals, cost money)

`evals/golden/` holds real furniture photos with their true dimensions in `golden.json`. They're used once, to compare engines side by side (PLAN.md Phase 2.3), and again whenever the default engine is reconsidered.
