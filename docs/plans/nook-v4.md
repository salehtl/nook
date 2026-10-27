# nook v4: sharper rooms, a measured shell, and a library you manage from the browser

**Status:** plan only, not started (2026-10-27).

## Goals
1. **Sharper rooms:** retraining that matches the capture. Today a 1,210-photo scan gets the same 20k steps and 1.2M splat cap as a 270-photo one, so it comes out undertrained.
2. **A measured room shell:** RoomPlan in the app, for exact walls, floor, windows and doors, plus automatic alignment. It sits next to the splat, not in place of it.
3. **Learning to scan:** an animated onboarding in the app.
4. **Managing the library and retraining from the web UI:**
   - add furniture by uploading a model (`.glb`, `.gltf`, `.obj`)
   - add furniture from a pasted image link run through a model (SAM 3D, TRELLIS 2)
   - remove items
   - retrain any room, with advanced settings

## What we know (2026-10-27)
- **scan-20261027-112322** (app v0.3, ~2 GB):
  - 1,210 training frames
  - 20,000 steps, so about 16 looks per photo where around 100 is normal
  - 1,134,027 splats, against the 1.2M cap
  - images downsized to 1920 px, although the stills are 4032 px
  - 19 min on kakapo
  
  It looks blurry everywhere.
- **First-scan measurements (v3 plan):** the trainer and the ARKit camera positions are fine; the bigger budget gave +0.2 dB at 270 frames. At 4.5× the frames, the budget is the most likely limit.
- **kakapo's nook service** (`nix/module.nix`) has **no `FAL_KEY` and no `nook-add`**. The furniture pipeline only runs on the Mac today. kakapo manages secrets with **sops** (`modules/sops.nix` in the kakapo repo).
- **`nook.salehtl.com` has no login** (house network and tailnet). Library actions spend money on fal and fetch URLs, so they need guards (§ Risks).
- **Planner v2 is merged** (PR #1). It has a rooms browser, a phone-first UI (`planner/ui/…`) and per-room config (contract §2.7). The library panel exists but is read-only.

## How the article shapes it
- **One main loop by default.** These stay in the main loop:
  - contracts
  - every GPU measurement (one card, `flock ~/nook-gpu.lock`)
  - integration and fixes
  - everything credentialed or outward-facing: TestFlight, the kakapo PR, the sops secret (which you add), pushing and merging
- **Builders split by context, not by step.** Each one owns a set of files and works against a written contract. None needs another's code to start: the planner UI builds against the contract with the fixtures and mock servers.
- **Blind verification, kept light.** You asked to skip eval suites. Each change gets one number or check from the main loop. One blind reviewer reads the finished diff against the contract (not the builders' notes) before the PR. Drop it if you'd rather.
- **Evals first, only where they're cheap.** The retrain gets its quality number before any default changes. The new APIs get their contract tests in the existing evals (`rooms_api`, `server_api`, `pipeline_offline`) by the builder that owns the API.

## Phase 0: main loop (before any agent)
1. **Retrain experiment** (GPU, about 2 h total). Run on scan-20261027-112322 under the GPU lock, held-out every 10th frame, judged in Spark:
   - **A.** As shipped: 20k steps, 1.2M splats, 1920 px.
   - **B.** Scaled: about 80 steps per training frame (capped at 120k), 3M splats, 1920 px.
   - **C.** B at 2880 px (stills only).

   Record PSNR, time and peak VRAM in this file, and pick the scaling rule from the winner.
   
   *This needs you:* the scan's zip from the app, and the kakapo link reopened (one YubiKey tap).
2. **Contract updates** (`contract/CONTRACT.md` and its schemas):
   - **§4.12 Capture v1.3 (optional), RoomPlan:**
     - `roomplan.json`: walls, floor, doors, windows and object boxes, each with dimensions and a 4×4 transform in the ARKit world (the same frame as `transforms.json`)
     - `roomplan.usdz` for viewing
     - `meta.json` `roomplan: {version, sessions: "shared" | "separate"}`
     
     Old captures stay valid.
   - **§4.9 Trainer v3: settings that scale with the capture.**
     - `steps = clamp(k × n_train, 20k, 120k)` and `max_splats` from VRAM, with k and the caps from step 1
     - 2880 px when stills exist
     - `--quality high` means "scaled"
     - explicit flags still win
   - **§5 Jobs API, retrain:**
     - `POST /api/scan/rooms/<name>/retrain` with a body of optional `{steps, max_splats, max_image_size, sh_degree, pose_opt, holdout_every}`
     - it re-queues the stored capture
     - the result is a **new room** `<name>-r<N>`, so you can compare it with the old one, which is kept
     - `GET /api/scan/defaults` returns the scaled settings the trainer would pick for a given capture
     - jobs record the settings they ran with
     - captures are kept for retraining, with `DELETE /api/scan/captures/<name>` to drop one
   - **§2.8 Library API** (on `planner/serve.py`):
     - `GET /api/library` returns the library
     - `POST /api/library/items` takes either:
       - multipart: a model file (`.glb`/`.gltf`/`.obj`, or an `.obj` zip with `.mtl` and textures), `name`, `dims_cm`, `category`, `yaw`
       - JSON: `{image_url, engine: sam3d|trellis2, name, dims_cm, prompt, resolution, yaw}`
       
       It returns `202 {job}` with the estimated cost.
     - `GET /api/library/jobs[/<id>]` returns progress and the result.
     - `DELETE /api/library/items/<id>` moves the item to `library/.trash/`.
     - `PATCH /api/library/items/<id>` changes name, category, dims (re-scaled), yaw or default render.
     - Model jobs run `nook-add` one at a time.
     - Cost rules: a cost estimate before every paid call, and a daily spend cap (default $2/day, from `costs.csv`).
   - **§3.1 Pipeline:** `--engine glb` also accepts `.obj` (with `.mtl` and textures, converted to GLB). A URL input may be an image page link only when it resolves to an image (content type checked).
3. **Brief per builder:** paths owned, contract sections, fixtures, done-when. Written in the same file as their prompts.

## Phase 1: workflow (5 builders in parallel, no shared files)
| Agent | Owns | Builds | Done when |
|---|---|---|---|
| `build:ios-roomplan` | `ios/NookScan/Capture/`, `ios/NookScan/RoomPlan/` (new), `ios/project.yml`, tests | RoomPlan running on the app's own ARKit session (`RoomCaptureSession(arSession:)`, iOS 17+), with a fallback 1-min separate pass if sharing hurts the capture. Writes `roomplan.json`/`.usdz` (§4.12). RoomPlan coaching shown during scans. | Device build clean; replay test writes a valid v1.3 capture; frame rate and stills rate with RoomPlan on vs off reported from a simulator/replay run (real phone in phase 3) |
| `build:ios-onboarding` | `ios/NookScan/UI/Onboarding/` (new) | Five looping SwiftUI animations (prepare, lock the light, pass 1, pass 2, pass 3 + close-ups) plus do/don't. First-run sheet and a **How to scan** button. Text matches `docs/SCANNING.md`. Optional mini-guide strip during a pass. | Builds; snapshot tests of each screen; the main loop wires in the one entry point |
| `build:scan` | `scan/`, `evals/server_api.sh` additions | Trainer v3 scaling (§4.9); retrain endpoint, stored captures, `/defaults` (§5); `roomplan.*` passed through to `<room-dir>/<name>.roomplan.json`/`.usdz` | `server_api` passes with new cases (fake trainer); `nook-scan train --dry-run` prints scaled settings for both real scans |
| `build:library-api` | `planner/serve.py` (library routes only), `pipeline/`, `nix/` (nook-add package, `FAL_KEY` `EnvironmentFile` option in `module.nix`) | §2.8 routes and job queue running `nook-add`; OBJ → GLB in the pipeline; guards (cost estimate, daily cap, URL checks, size limits); Nix package for `nook-add` | `pipeline_offline` + new `library_api` cases pass with `NOOK_FAL_MOCK`; `nix build .#nook` on kakapo (main loop runs it under the lock) |
| `build:planner-ui` | `planner/ui/`, `planner/styles/`, `planner/data.js`, `planner/engine.js` (RoomPlan shell only) | **Library manager:** add sheet with three tabs: upload a model, image link → model (engine, prompt and cost shown), from the phone's photos (upload an image). Job progress, edit, remove (with undo from trash). **Retrain sheet** on a room: one button with the scaled defaults, plus an **Advanced** section (steps, splats, image size, SH degree, camera refinement, held-out) with plain-language hints and the time estimate. New room versions appear in the rooms list, grouped under their scan. **RoomPlan:** auto-align from the floor and walls, wall dimensions on tap, a see-through shell toggle, furniture snapping to walls. Phone first, like v2. | `eval:planner` + rooms UI evals pass with new cases against mock servers; screenshots at 390 × 844 and 1280 × 800 |

Each builder gets the contract, its brief, and the fixtures and mock servers. Nothing else of the others' work is visible to it. Builders don't commit.

## Phase 2: main loop
1. **Integrate** the five sets of changes and run every eval once. Wire the onboarding entry point. Fix what breaks.
2. **GPU check:** retrain scan-20261027-112322 through the new endpoint with the defaults. It must match phase 0's winner within 0.2 dB.
3. **One blind review** (a fresh agent): the diff against the contract, reporting bugs and missing states only. The main loop fixes, or records why not.

## Phase 3: release (main loop, needs you where marked)
1. **nook PR** → you merge.
2. **kakapo PR** (you OK the merge): nook pin bump, `services.nook.falKeyFile` from a new sops secret, and `nook-add` in the service. *You add the secret value* (`sops` on kakapo); I never see it.
3. **TestFlight 0.4.0** via `ios/scripts/release.sh`.
4. **You rescan** with 0.4.0: onboarding first, then RoomPlan on. I score it against today's scan, check RoomPlan's effect on the frame rate on a real phone, and tune.

## Risks and guards
- **Spending from an open page:** anyone on the house Wi-Fi or tailnet could run paid model jobs.
  - Guards: a cost confirmation, a daily cap ($2 default, configurable), and every call logged to `costs.csv`.
  - Retrain and delete are free but slow or destructive. Delete goes to trash, and retrain is one job at a time.
  - Adding a login is out of scope unless you want it.
- **URL fetching:** the server fetches pasted links.
  - It allows only http(s), blocks private and tailnet addresses, caps size at 20 MB, and requires an image content type. A web page link is rejected with "paste the image's own link".
- **RoomPlan sharing the session** may lower the frame or stills rate. It's measured on your phone in phase 3. The fallback is a separate 1-minute pass.
- **Long retrains:** 120k steps is about 1.5–2 h on the 2060. The retrain sheet shows the estimate, and the defaults stay under about 90 min unless you raise them under Advanced.
- **Disk:** keeping captures for retrain is about 2 GB per scan. The rooms list shows capture size, and deleting a capture is one tap.

## Rough timing
| Phase | Time |
|---|---|
| Phase 0 | about 2.5 h (GPU-bound; starts when the zip and link are in) |
| Phase 1 workflow | about 3–4 h, builders in parallel |
| Phase 2 | about 1.5 h |
| Phase 3 | about 1 h of my work plus your merges, the secret and a rescan |

## Out of scope (later)
- Generative fill of unseen areas (v3 plan, phase 3).
- A login for `nook.salehtl.com`.
