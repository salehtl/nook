# evals

Written before the planner and pipeline existed, against [contract/CONTRACT.md](../contract/CONTRACT.md). Builders make them pass but don't edit them. If an eval is wrong, say so with the exact line, and the main session fixes it.

| Command | Checks | Cost |
|---|---|---|
| `npm run eval:planner` | `evals/planner_smoke.mjs`: starts `planner/serve.py` on port 8799 with scratch room/layout paths, opens the planner in headless Helium, and drives `window.nook` through the §2.5 and §2.6 criteria it can check without a human (P1–P4, P6–P8, P10–P15). Screenshots go to `evals/out/planner/*.png` for visual review. | $0 |
| `npm run eval:pipeline` | `evals/pipeline_offline.sh`: runs `nook-add` against the recorded fal responses in `fixtures/fal/` with network blocked, covering §3.6 L1–L7. Output goes to `evals/out/pipeline/`. | $0 |
| `evals/py evals/validate_library.py <library.json>` | The §1 normalized-asset rules and `library.schema.json`, for any library (fixtures, eval output, or your real `library/`). | $0 |
| `npm run eval:scan` | `evals/scan_offline.sh`: nook-scan trainer (contract §4.6–4.7). It trains on the synthetic ground-truth capture (`fixtures/make_capture.mjs` → `evals/out/capture-gt`), judges held-out frames with `psnr_judge.mjs` against the untrained `seed_splat.py` baseline (about 21 dB), and checks room.json and bad captures. | $0 |
| `npm run eval:ios` | `evals/ios_build.sh`: nook-scan iOS app. XcodeGen, unit tests on the simulator, the replay capture validated, an unsigned device build, release settings. | $0 |
| `evals/py evals/validate_capture.py <dir\|zip>` | Capture format rules (contract §4.5). | $0 |
| `node evals/psnr_judge.mjs <splat.ply> <capture>` | Renders a splat with Spark at held-out capture poses; prints PSNR. | $0 |
| `evals/py evals/glb_info.py <model.glb>` | Helper: image and material counts, bounds, vertex centroid. | $0 |

`evals/py` runs a helper under uv with its own pinned deps, independent of `pipeline/`'s environment.

Not covered automatically (check by hand or in the built-in browser): gizmo dragging (P5), the measure tool UI (P9), pick-floor and two-point scale clicks (P8 UI side), and how things look.

## Golden photos (live evals, cost money)

`evals/golden/` holds real furniture photos with their true dimensions in `golden.json`. They're used once, to compare engines side by side (PLAN.md Phase 2.3), and again whenever the default engine is reconsidered.
