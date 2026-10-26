# nook-scan: build plan

> **Superseded 2026-10-26:** scans now go from the app straight to kakapo ("Send to kakapo") and train there with gsplat. Brush, the Mac trainer and the AirDrop step are retired. See [nook-scan-v2.md](nook-scan-v2.md).

A free replacement for Polycam/Scaniverse, built for this project: an **iPhone capture app** (shipped via TestFlight) plus a **Mac trainer** that turns a capture into the room splat the planner uses.

```
iPhone (nook-scan app)                         Mac (M3 Max)                                  planner
ARKit + LiDAR: posed keyframes, depth, points   nook-scan train capture.zip                    room/room.json
→ capture folder (contract §4) → AirDrop  ───▶  validate → Brush (Metal/WebGPU) → crop/level ─▶ room/<name>.ply
```

**Why this split:** ARKit already knows where the phone was for every frame, in metric, gravity-aligned (Y-up) world space. That removes the slowest and most fragile step of DIY splatting (COLMAP pose solving). It also means the splat arrives level and in real meters: in the planner only the floor offset and yaw are left to set. Training happens on the Mac, where an M3 Max GPU can do it in minutes. On a phone it would take hours.

## 1. How the article shapes the setup

Same rules as [PLAN.md §1](../../PLAN.md), applied here:

| Article says | Here |
|---|---|
| One loop by default; subagents only for independent work with a clean interface, or for blind verification | **4 agents**: 2 builders in parallel (iOS app, Mac trainer) and 2 blind verifiers. Contract, fixtures, evals, integration, fixes, signing and the TestFlight upload stay in the main session. |
| Split by **context**, not by problem type | One builder per component, owning its whole folder. No "UI agent / ARKit agent / writer agent" split. |
| Interface = a compact contract | The **capture format** (contract §4 + `capture.schema.json`) is the only thing the two sides share. |
| Evals first | The capture validator, a **synthetic ground-truth capture** (a rendered room with known camera poses), a **PSNR judge** that renders the trained splat with Spark from held-out poses, and the iOS build+test script, all written before any agent starts. |
| Verifier = black-box, independent | Verifiers get the contract and evals only, never the builder's report. |
| Fold fixes back into the main loop | Findings come back to the main session, which fixes them one at a time. |
| Outward-facing or credentialed steps | Signing, archiving and the TestFlight upload happen in the main session, with you in the loop. No agent touches your Apple account. |

Splits deliberately not made: a separate "transfer/server" agent (AirDrop needs no code), an icon/design agent, or a release agent.

## 2. Components

**`ios/` (nook-scan app, SwiftUI + ARKit, XcodeGen project)**
- **Capture:** live camera with ARKit world tracking, plus `sceneDepth` on LiDAR devices.
  - Auto keyframes: a frame is kept when the phone has moved ≥ 8 cm or turned ≥ 6° since the last one, tracking is `normal`, and the image isn't blurry.
  - Guidance: frame counter, tracking-state banner, a "slow down" warning, and a coverage hint.
- **Writer:** produces the contract §4 capture folder: images, LiDAR depth, `transforms.json`, `points.ply` seeds and `meta.json`.
- **Captures list:** frame count, size and date per capture; **Share** as `.zip` (AirDrop to the Mac); delete.
- **Replay mode** (simulator and tests): feeds a recorded capture through the same keyframe selector and writer. ARKit doesn't run in the simulator.
- **Release basics:** camera usage string, `ITSAppUsesNonExemptEncryption = NO`, an `arkit` device requirement, app icon, version 0.1.0.

**`scan/` (Mac trainer, uv project, Python 3.12, console script `nook-scan`)**
- `nook-scan train <capture.zip|dir> [--name scan] [--steps N] [--room-dir room]`:
  1. Unzip and validate (contract §4).
  2. Optionally downscale images.
  3. Train with **Brush**, built from source via cargo into `scan/.tools/`, with the version pinned. It falls back to another Metal trainer only if Brush can't ingest the capture.
  4. Export PLY, crop floaters outside the captured volume, and estimate the floor from LiDAR/seed points.
  5. Write `room/<name>.ply`, then update `room/room.json`: `splat` = the new file, transform = floor to y = 0, identity rotation, scale 1.
- The last stdout line is a JSON summary: splat count, PSNR on held-out frames if computed, time taken, paths.
- `nook-scan check <capture>`: validate only.

## 3. Phases

**Phase 0 (main session):**
- contract §4 and `capture.schema.json`
- `fixtures/make_capture.mjs`: renders a synthetic room (textured walls and floor, rug, SheenChair, shelf boxes) with three.js in headless Helium, along a phone-like path of two loops at different heights. It writes a ground-truth capture: images, OpenGL camera-to-world poses, intrinsics, depth and seed points. The floor sits at y = −1.35, the way ARKit puts the world origin at the phone's starting position.
- evals:
  - `validate_capture.py`
  - `psnr_judge.mjs`: renders a splat with Spark at held-out poses and computes PSNR against the ground truth
  - `scan_offline.sh`
  - `ios_build.sh`: XcodeGen, then build and test on the simulator, then validate the capture the replay test wrote
- toolchain checks

**Phase 1 (workflow, 4 agents):** `pipeline(['ios', 'trainer'], build, blindVerify)`. Each component goes to verification as soon as its build finishes.

**Phase 2 (main session):**
- Fix findings, one at a time, re-running the evals after each.
- End to end: replay capture in the simulator → zip → `nook-scan train` → planner shows the room at the right size with the floor at 0 (`planner_smoke` + screenshots).

**Phase 3 (main session plus you): TestFlight.**
- Automatic signing with team `8CFG28JHP3` (`-allowProvisioningUpdates`).
- `xcodebuild archive`.
- `-exportArchive` with `destination: upload`, using your existing App Store Connect API key file.
- **Needs from you:**
  - **(a)** an App Store Connect app record for bundle ID `com.salehtl.nookscan`
  - **(b)** your API key's **Issuer ID**, which identifies the key and isn't a secret (App Store Connect → Users and Access → Integrations)
- After processing, the build shows up in TestFlight for internal testing on your phone.

**Phase 4 (you):** install from TestFlight, scan the room, AirDrop the zip, then:

```bash
uv run --project scan nook-scan train ~/Downloads/<capture>.zip
```

## 4. Acceptance

- **iOS:**
  - `bash evals/ios_build.sh` passes: it builds, the unit tests pass, and the replayed capture validates.
  - The app launches in the simulator with no crash, and its screens work.
  - `xcodebuild archive` succeeds for a generic iOS device.
- **Trainer:**
  - `bash evals/scan_offline.sh` passes: a valid capture trains to a splat with **mean PSNR ≥ 26 dB on held-out views, and ≥ 4 dB above the untrained seed baseline (Spark-rendered)**, the floor is at 0 ± 5 cm, and `room.json` is written. It takes under 15 minutes on the M3 Max with the default step count.
  - Bad captures fail with one actionable stderr line.
- **Release:** the build is uploaded and processed in TestFlight, and installs on your iPhone.
