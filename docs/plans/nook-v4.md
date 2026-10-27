# nook v4: sharper rooms, a measured shell, and a library you manage from the browser

**Status:** IN PROGRESS (started 2026-10-27, branch `v4`). Revision 2 (2026-10-27), after a blind critique; the critique's findings are folded in and listed at the end.

## Progress log
- **2026-10-27, phase 0 (main loop):**
  - **0a** on kakapo (`evals/sizing_0a_remote.sh`, judged by `evals/sizing_0a_judge.sh`; scan-20261027-112322, 1,089 training frames, every 10th held out, held-out PSNR in Spark):

    | Run | Steps | Splats | Time | Peak VRAM | Held-out PSNR |
    |---|---|---|---|---|---|
    | A | 20,000 | 1.2M | 19.4 min | 2.45 GB | 21.36 dB |
    | B1 (40/frame) | 43,560 | 2M | 64 min | 3.97 GB | 21.44 dB |
    | B2 (80/frame) | 87,120 | 2M | 139 min | 4.05 GB | 22.03 dB |

    **Decision:** `k = 80` steps per frame (was 60). Speed measured at 47.9 s per 1,000 steps per million splats, so `gpu.py`'s 48.5 stays. Peak host RSS is 12.3 GB on every run. B3 (3M splats) is running and decides the 2060's training cap. C (2880 px stills) waits for B3 to end.
  - **0b** not run (needs the phone). **Decision for v4:** the app uses a **separate** RoomPlan pass with `world_from_roomplan` (§4.12), which can't disturb the capture session. A shared session stays a later experiment, after a device spike.
  - **0c** contracts written: §2.7 v4, §2.8, §2.9, §2.10 (raising items and hanging them on walls, added on request), §3.1 v4, §4.9.1, §4.12, §5.1; `roomplan.schema.json`, plus `meta.roomplan`, `parent`, `mount`, `mounted`.
  - **0d** evals first (failing until built): `library_api.sh` (new), `planner_v4_smoke.mjs` (new), v4 cases in `server_api.sh`, `rooms_api.sh`, `pipeline_offline.sh`, `ios_build.sh`, `validate_capture.py`; mocks `mock_scan_server.py` (§5.1, passes `server_api.sh` 35/35) and `mock_library_server.py` (new); fixtures `fixtures/roomplan/` (hand-made, labeled) and `fixtures/models/cube-obj.zip` (`fixtures/make_v4_fixtures.py`).
  - **Python:** the pipeline passes on 3.13 (all pre-v4 checks), so the pin is relaxed to `<3.14` and the Nix package uses nixpkgs' python3 (3.13). `fal-client` isn't in nixpkgs: it gets packaged in `nix/`.
  - **GPU lock:** `evals/remote.sh` takes `/run/nook/gpu.lock` when the module has made it, else `~/nook-gpu.lock`.

## Goals
1. **Sharper rooms:** retraining sized to the capture. Today a 1,210-photo scan gets the same 20k steps and 1.2M splats as a 270-photo one, so it comes out undertrained.
2. **A measured room shell:** RoomPlan in the app (walls, floor, windows, doors). It sits next to the splat, not in place of it.
3. **Learning to scan:** an animated onboarding in the app.
4. **Library and retraining from the web UI:**
   - add furniture from a model file (`.glb`, or `.obj` zipped with its `.mtl` and textures)
   - add furniture from an image (pasted link, or a photo from the phone) run through a model (SAM 3D, TRELLIS 2)
   - edit, remove and restore items
   - retrain any room whose capture is kept, with advanced settings

## What we know (checked in the code, 2026-10-27)
- **scan-20261027-112322:** 1,210 frames, 20k steps (about 16 looks per photo), 1,134,027 splats (cap 1.2M), 1920 px, 19 min.
- **Hardware limits:**
  - **VRAM:** 1.2M splats peak at about 2.5 GB at 1920 px, SH3 (`scan/src/nook_scan/gpu.py:15`), so 3M would be close to the whole 6 GB card.
  - **Host RAM:** the trainer decodes every training image into RAM (`gsplat/nook_gsplat.py`), about 9 GB for 1,089 frames at 1920 px.
  - **Browser:** the planner deliberately caps rooms at 1.5M splats, because Spark loads them in the browser (`gpu.py:14`). The planner is phone-first.
- **Stills:** the app takes a high-res still every 3rd keyframe only (`CaptureRecorder.swift`, `stillEvery = 3`). Held-out frames are judged as video at 1920 px (`dataset.py`).
- **Captures aren't kept.**
  - The jobs server deletes the upload when a job ends, and again on restart (`serve.py:93`, `:225`).
  - Re-uploading a capture returns its old job (`serve.py:133`).
  
  So no existing room can be retrained without a re-upload.
- **The GPU lock:** only my evals take `~/nook-gpu.lock`. The nook service's worker ignores it.
- **kakapo:** the nook service has no `FAL_KEY` and no `nook-add`. kakapo uses sops for secrets. The pipeline pins Python `<3.13` (`pipeline/pyproject.toml`).
- **Rendering:** `/api/render` is a paid fal call too. It's off on kakapo only because there's no key.
- **The site:** `nook.salehtl.com` has no login (house network and tailnet).
- **App:** targets iOS 18, so RoomPlan's shared-session initializer (iOS 17+) is available. Whether RoomPlan keeps the app's own session setup (hi-res video format, scene depth, exposure lock, delegate) is unknown until it runs on a phone. RoomPlan needs LiDAR.
- **Planner v2 is merged:** a rooms browser, phone-first UI, per-room config (§2.7) and a read-only library panel.

## How the article shapes it
- **One main loop by default.** These stay in the main loop:
  - contracts, **evals and mock servers (written before any builder starts)**
  - every GPU measurement
  - the RoomPlan device spike
  - integration, fixes, version bumps
  - everything credentialed or outward-facing: TestFlight, the kakapo PR, merges, the sops secret (which you add)
- **Builders split by context.** Four builders, each owning whole files (table below). They build against the contract plus the main loop's evals, fixtures and mocks. They **run** the evals but don't edit them (`evals/` is main-loop-only, per CLAUDE.md), so passing them is a real check, not self-grading.
- **Blind review, kept light.** You asked to skip eval suites, so there's no verifier per builder. One fresh reviewer reads the integrated diff against the contract only, not the builders' notes, before the PR.

## Phase 0: main loop
### 0a. Retrain sizing on kakapo (GPU, about 6 h, unattended)
- **Setup:**
  - scan-20261027-112322, held out every 10th frame, judged in Spark
  - stop `nook-scan.service` during the runs (or have it take the shared lock, 0d)
  - log peak VRAM **and** peak host RAM
  - first, `free -g` on kakapo
- **The runs, in order:**

  | Run | Steps | Splats | Notes |
  |---|---|---|---|
  | A | 20k | 1.2M | as shipped |
  | B1 | 40 per frame | 2M | |
  | B2 | 80 per frame | 2M | |
  | B3 | 80 per frame | 3M | only if B2's peak VRAM is under 4.5 GB and RAM allows |
  | C | best B | best B | at 2880 px **for stills only**; video frames unchanged |

  Held-out PSNR can't see C's extra detail, because held-out frames are video. Also score C on held-out *stills* and with a sharpness measure on the same crops.
- **Delivery test:**
  - The winner gets **delivered** at ≤1.5M splats (SH degree ≤2 if needed), however many it trained with.
  - Load that SPZ on your iPhone in the planner and note the load time and frame rate.
- **Phase 1 doesn't wait.** It starts with placeholder constants (`k = 60` steps per frame, a training cap of 2M, a delivery cap of 1.5M). 0a only changes the numbers.

### 0b. RoomPlan device spike (about 30 min, needs your phone)
- A throwaway build where RoomPlan shares the app's ARKit session. Check that:
  - keyframes, stills and the exposure lock still work
  - the photo rate stays within about 10% of today's
  - it produces a `CapturedRoom`
- **Shared session works:** v4 uses it.
- **It doesn't:** v4 uses a separate 1-minute RoomPlan pass, plus an alignment step defined in the contract (§4.12, `world_from_roomplan`, solved from the floor plane and wall planes against the splat's points).
- **Phones without LiDAR:** the app shows no RoomPlan.

### 0c. Contracts (`contract/CONTRACT.md` + schemas)
**§4.12 Capture v1.3 (optional), RoomPlan**
- **Files:**
  - `roomplan.json`: walls, floor, doors, windows and object boxes, each with dimensions and a 4×4 transform
  - `roomplan.usdz` for viewing
- **The coordinate frame:**
  - In the shared-session case, transforms are in the `transforms.json` world.
  - Otherwise `world_from_roomplan` (4×4) is stored, so `roomplan.json` is never assumed to be in the capture frame.
- **`meta.json`:** gains `roomplan: {version, sessions: "shared" | "separate"}`.
- **Old captures** stay valid.

**§4.9 Trainer v3, scaled settings**
- **Training settings:**
  - `steps = clamp(k × n_train, 20k, 120k)`
  - `train_max_splats`: a constant per GPU class, not "from VRAM", so a dry run gives the same answer on any machine
  - stills trained at `stills_max_size`
- **Delivered splats:** `deliver_max_splats` (1.5M by default) prunes by opacity × volume before writing the room, keeping the full PLY only on request.
- **Precedence:** `--quality high` means scaled settings, and explicit flags win.
- **Q1:** updated, since the old "<40 min" rule no longer holds.
- **Advanced settings and the trainer flags they map to:**

  | Setting | Flag |
  |---|---|
  | steps | `--steps` |
  | training splats | `--max-splats` |
  | delivered splats | `--deliver-max-splats` |
  | image size | `--max-image-size` |
  | stills size | `--stills-max-size` |
  | detail | `--sh-degree` |
  | camera refinement | `--pose-opt` (made a real flag; `nook-poses` is not offered, it gave nothing) |
  | held out | `--holdout-every` |

**§5 Jobs API: captures and retrain**
- **Keeping captures:**
  - A finished job's upload is **kept** as `captures/<capture>.zip`.
  - Restarts no longer delete it.
  - The restart message becomes "server restarted during training: retrain from the planner".
- **New routes:**
  - `GET /api/scan/captures` returns `{name, size_bytes, created, rooms: [...]}`.
  - `DELETE /api/scan/captures/<name>` removes a capture.
- **Retrain:**
  - `POST /api/scan/captures/<name>/retrain` takes a body of `{settings}` (the table above, all optional) and returns `202 {job}`.
  - Jobs gain `kind: "upload" | "retrain"`, `parent` (room name) and `settings` (what actually ran).
  - The upload dedupe applies only to `kind: "upload"`.
- **Naming:**
  - A retrain of room `<base>` (base = name with any `-r\d+` suffix removed) becomes `<base>-r<N>`, where N is the highest existing number plus 1.
  - Names stay within the 64-character slug limit by truncating the base.
  - A user-chosen title is the room's `title`, not its name, so it can't collide.
- **The new room starts from its parent's alignment and look.** `<new>.room.json` copies the parent's `transform` and `look`; it's the same world frame. Its viewpoints are recomputed, and its layouts start empty with an offer to copy them. It doesn't become `current` unless you open it.
- **`GET /api/scan/captures/<name>/defaults`** returns the scaled settings and an `eta_s` estimate.
- **Proxy:** every mutating `/api/scan` route is proxied by `planner/serve.py`, including DELETE.

**§2.7 additions (rooms)**
- room objects gain `roomplan_url`, `capture` (name or null) and `parent`
- the rooms list groups `-rN` rooms under their base

**§2.8 Library API (`planner/serve.py`)**
- **Routes:**
  - `GET /api/library`
  - `POST /api/library/items` with a **raw body** (no multipart, since `cgi` is gone from Python 3.13), described by headers:
    - `X-Nook-Kind: model | image`
    - `X-Nook-Filename`
    - `X-Nook-Meta`: base64 JSON of name, dims_cm, category, yaw, engine, prompt, resolution
    
    The body is one of: a `.glb`; a `.zip` with an `.obj`, `.mtl` and textures; or an image file (a photo from the phone).
  - `POST /api/library/items/from-url`, JSON `{image_url, ...meta}`
  - Both return `202 {job, cost_usd_estimate}`.
  - `GET /api/library/jobs[/<id>]`
  - `PATCH /api/library/items/<id>` changes name, category, yaw, default render, or dims. Dims are rescaled **server-side** from the item's normalized assets (`nook-add --rescale <id>`), with no new model call.
  - `DELETE /api/library/items/<id>` moves the item to `library/.trash/`.
  - `POST /api/library/items/<id>/restore` brings it back.
- **Layouts that use a deleted item:** they load, with the item shown as a "missing item" placeholder.
- **Writes:** all library writes (`nook-add` and the server) take one lock and go through one queue.
- **Limits:**
  - uploads: 200 MB for models, 20 MB for images
  - zips: extracted files allowlisted (`.obj .mtl .png .jpg .jpeg`), no path escapes, at most 500 MB unpacked
  - `.gltf` with side files: zip it, or convert to `.glb` first
- **What `/library/` serves:** item assets only. It doesn't serve `raw/` or `.trash/`, and sends `X-Content-Type-Options: nosniff`.

**§2.9 Mutating requests and money (applies to every route above and to `/api/render`)**
- **Against forged requests (CSRF):** every POST, PUT, PATCH and DELETE needs the header `X-Nook: 1` and an `Origin` that's absent or the page's own. Anything else gets `403`. The iOS app's upload sends the header too.
- **Spend cap:**
  - A server flag (`--daily-spend-usd`, default 2), not settable from the page.
  - It covers `/api/render` too.
  - Check-and-reserve is atomic, logged to `costs.csv`, and refunded on failure.
  - `costs.csv` isn't served.
- **URL fetches (SSRF):**
  - `nook-web` downloads the image **itself** and passes a local file to `nook-add`, which never fetches URLs on the server.
  - http(s) only. The resolved IP is pinned and checked on every redirect hop (at most 3).
  - Blocked: 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fd7a:115c:a1e0::/48, fc00::/7, and v4-mapped forms.
  - Image content type required, 20 MB at most. A web page link gets "paste the image's own link".

**§3.1 Pipeline**
- `--engine glb` accepts `.glb` and an `.obj` zip (converted to GLB).
- `--rescale <id>`.
- Mock mode accepts a local image, so the from-URL flow is tested at $0 through `nook-web`'s download plus a local file.

### 0d. Evals, mocks and fixtures first (main loop, before the builders)
- **Failing eval cases** for §2.8, §2.9, §5 (captures and retrain) and §4.12. They go in the existing suites (`rooms_api`, `server_api`, `pipeline_offline`) plus a new `library_api`.
- **`evals/mock_scan_server.py`** extended for captures and retrain, so the planner UI and iOS tests have something to talk to (A2 parity kept).
- **A new `evals/mock_library_server.py`.**
- **A RoomPlan fixture:** from the 0b spike's real `CapturedRoom` if possible, otherwise hand-made and labeled as such.
- **The shared GPU lock:** `/run/nook/gpu.lock` (in the module's `RuntimeDirectory`), taken by the service worker and by `evals/remote.sh`.
- **Python:** decide the pipeline's version, either relaxing the `<3.13` pin after a test or packaging it with `python312`. Also check whether nixpkgs has `fal-client`, otherwise package it.

## Phase 1: workflow (4 builders in parallel, whole-file ownership)
| Agent | Owns | Builds | Done when |
|---|---|---|---|
| `build:ios` | all of `ios/` (`Capture/`, `UI/` including `CaptureView.swift`, `SettingsView.swift`, the new `UI/Onboarding/` and `RoomPlan/`, `project.yml`, tests) | RoomPlan as decided in 0b, with on-screen coaching and a settings toggle, hidden without LiDAR; writes §4.12. **Then** the onboarding: five looping SwiftUI guides (prepare, lock the light, three passes with close-ups) plus do/don't, a first-run sheet, a **How to scan** button, an optional in-pass strip; text matches `docs/SCANNING.md`. Sends `X-Nook: 1`. One builder, so `project.yml` and the Xcode project are never edited twice. | Device build clean; unit + replay tests pass (replay writes a valid v1.3 capture from the 0b fixture); onboarding snapshot tests. Real-phone checks happen in phase 3, not here |
| `build:scan` | `scan/`, `gsplat/`, `nix/nook-gsplat.nix` | §4.9 (scaling, delivery pruning, real `--pose-opt` flag); §5 captures, retrain, naming, parent copy, dedupe and restart rules; `roomplan.*` passed through to the room dir; the service worker takes the shared lock | main-loop evals `server_api` (fake trainer) pass, untouched; `nook-scan train --dry-run` prints the scaled settings for both real scans |
| `build:web-server` | all of `planner/serve.py`, `pipeline/`, `nix/nook.nix`, `nix/module.nix`, `flake.nix` | §2.7 additions, §2.8, §2.9 (header check, spend cap including render, the URL fetcher), proxying every `/api/scan` method; `nook-add --rescale`, OBJ zips, the single library lock; Nix package for `nook-add` (Python per 0d), `--library ${dataDir}/library`, a module option `falKeyFile` (an EnvironmentFile in `FAL_KEY=…` form), `RuntimeDirectory` for the lock | main-loop evals `library_api`, `rooms_api` and `pipeline_offline` pass with `NOOK_FAL_MOCK`, untouched |
| `build:planner-ui` | `planner/ui/`, `planner/styles/`, `planner/data.js`, `planner/engine.js`, `planner/main.js`, `planner/index.html` | **Library manager:** add sheet with model file / image link / photo from the phone; the cost shown before you confirm; the day's remaining budget; job progress; edit; remove with undo (restore). **Retrain sheet:** one button with defaults and time estimate, plus **Advanced** (the §4.9 settings, with plain hints). Rooms grouped with their `-rN` versions; "this capture isn't kept, upload again to retrain" when there's none. **RoomPlan (v4 scope):** a see-through shell toggle and wall lengths on tap. *Auto-align and snapping wait for v4.1, built against a real RoomPlan capture.* Sends `X-Nook: 1` on every mutation | `eval:planner` and rooms UI evals pass against the mock servers, untouched; screenshots at 390 × 844 and 1280 × 800 |

Builders don't commit and don't edit `evals/` or `contract/`. If the contract is wrong, they report it and the main loop decides.

## Phase 2: main loop
1. **Integrate.** Bump versions: nook 0.3.0 (`nix/nook.nix`), app 0.4.0 (`MARKETING_VERSION`). Run every eval, fix what breaks.
2. **GPU check on kakapo from the branch** (`evals/remote.sh` builds the branch in `~/src/nook`, under the shared lock):
   - upload the capture to a branch-built jobs server on a spare port
   - retrain through the new endpoint with `holdout_every: 10`
   - pass if within 0.2 dB of 0a's winner, and the delivered room is ≤1.5M splats
3. **One blind review** (a fresh agent): the diff against the contract only, reporting bugs and missing states. The main loop fixes them, or records why not.

## Phase 3: release (main loop; needs you where marked)
1. **nook PR.** You merge it.
2. **kakapo PR** (you OK the merge): the nook pin bump, `services.nook.falKeyFile` pointing at a new sops secret in `FAL_KEY=…` form, and `--daily-spend-usd`.
   - *You add the secret value* with sops on kakapo. I never see it.
   - Until then, library model jobs and Render say "no fal key on the server".
3. **TestFlight 0.4.0.**
4. **You rescan with 0.4.0.** I score it against today's scan, check the photo rate with RoomPlan on, and use the real RoomPlan output for v4.1 (auto-align, snapping).

## Risks
- **Retrain time:** 2M splats at 80 per frame on a 1,200-frame scan is likely 2–3 h. The retrain sheet shows the estimate from 0a's measured speed. Defaults come from 0a, not from guesses.
- **Disk:** each kept capture is about 2 GB, and each retrained room adds an SPZ (about 100 MB at 1.5M splats). The PLY isn't kept for retrains unless asked. The rooms list shows sizes, and deleting a capture or room is one tap (rooms go to `.trash/`, which you empty yourself).
- **RoomPlan:** if the device spike fails both ways, RoomPlan moves to v4.1 and v4 ships everything else.
- **Open page:** §2.9 covers forged requests, URL fetches and money. Anyone on your Wi-Fi or tailnet can still use the page directly, by design. A login stays out of scope unless you want it.

## Rough timing
| Phase | Time |
|---|---|
| 0a GPU sizing | about 6 h unattended; runs while 0c/0d and phase 1 proceed |
| 0b spike | 30 min with your phone |
| 0c/0d | about 2 h |
| Phase 1 | about 3–4 h |
| Phase 2 | about 2 h plus one GPU retrain (2–3 h) |
| Phase 3 | about 1 h of my work, plus your merges, the secret and the rescan |

## Critique findings and what changed
| # | Finding | Change |
|---|---|---|
| 1 | Phase 0 GPU sizing unrealistic, VRAM/RAM | 0a rebuilt: staged runs, RAM logged, 6 h, placeholder constants |
| 2 | 3M splats too heavy for the browser and phone | Training cap and delivery cap split; phone load test |
| 3 | Captures deleted, retrain hits the dedupe, naming and parent gaps | §5 captures, retrain, naming, parent copy, dedupe and restart rules |
| 4 | Unowned files | Whole-file ownership; main loop owns mocks and fixtures |
| 5 | Two iOS builders collide | One iOS builder, RoomPlan then onboarding |
| 6 | RoomPlan untested, simulator check impossible, separate-session frame | 0b device spike; `world_from_roomplan`; no simulator metric |
| 7 | Planner RoomPlan built without real data | v4: shell and wall lengths only; auto-align and snapping in v4.1 |
| 8 | CSRF, SSRF, XSS, render outside the cap | §2.9 |
| 9 | Builders grading themselves | Main loop writes the evals first; builders can't edit them |
| 10 | Library API gaps | Photo upload, restore, server-side rescale, single lock, missing-item placeholder |
| 11 | Nix, Python pin, secret option naming | 0d decision; one option `falKeyFile` |
| 12 | GPU lock not shared with the service | Shared lock in `/run/nook` |
| 13 | Phase 2 can't run before merge | Branch-built server on kakapo, held out |
| 14 | Minor contract points | Wording fixed, flag mapping, constants per GPU class, version bumps owned, `costs.csv` not served |
