# nook-scan v3: sharper rooms

**Goal:** close the gap to Polycam's fidelity, while keeping rooms measured: true to size, with nothing invented.

**Diagnosis (2026-10-26):** the trainer is fine. The synthetic room scores 32 dB, while real scans score 21–22 dB. The losses are on the capture side, most likely in this order:
1. ARKit's camera positions drift by centimeters over a room walk.
2. Video-stream frames (1920×1440, noisy, motion blur).
3. Too few frames (268 in the latest scan).
4. A conservative splat budget (1.2M, using 2.5 of the 6 GB).

## Decisions so far
- Train on **kakapo only**, with **gsplat**. Brush is retired.
- Order of attack:
  1. camera refinement: gsplat's own option first, then a learned camera estimator (VGGT or MASt3R) if needed
  2. app v0.3: high-resolution stills and denser keyframes
  3. a bigger splat budget
  4. generative fill, cloud GPU, gaps only and marked in the web app; **deferred**, only if gaps remain after 1–3

## How the article shapes it
- **Main loop:** contracts, evals, every GPU measurement, integration, fixes, releases (the kakapo PR, TestFlight).
- **Two builders in parallel,** split by context:
  - `ios/`: app v0.3
  - `poses/`: the learned camera estimator
- **Two blind verifiers.**
- **One GPU, one lock:** every GPU job (agents' and mine) runs under `flock ~/nook-gpu.lock` on kakapo, so experiments never share the card or spoil each other's timing.

## Phases
**0. Main loop (now)**
- Baseline gsplat score on your scan, then the same with `--pose-opt`. Record both, plus how far the cameras moved.
- **Contract v1.2:** optional high-resolution stills per keyframe (`images_hi/`, own intrinsics). The trainer uses them when present.
- **Evals:**
  - quality eval keyed per scan (both of your scans)
  - pose eval: the pose pass must not lower held-out PSNR, and the camera corrections must be reported
  - iOS: tests that write stills, and the denser-keyframe policy
- **Second real scan:** you share `scan-20261026-154649` from the app, since kakapo's copy belongs to the nook service.

**1. Workflow (4 agents)**
- `build:ios`: app v0.3.
  - ARKit `captureHighResolutionFrame` every few keyframes (~12 MP, written to `images_hi/`), keyframes every 4 cm or 3°.
  - Keeps the exposure and white-balance lock on the stills too. Tests included.
- `build:poses`: `nook-poses` on kakapo.
  - VGGT (or MASt3R) estimates camera positions from the images, using ARKit's as a prior, and writes a refined `transforms.json`.
  - Nix/CUDA package that fits the 2060.
  - nook-scan runs it before training when `--refine-poses` is set.
  - Measured on both scans under the GPU lock.
- `verify:ios` and `verify:poses`: blind, against contract v1.2 and the evals.

**2. Main loop**
- **Fix findings,** then measure four configurations on both scans:
  - baseline
  - `--pose-opt`
  - `nook-poses` + `--pose-opt`
  - bigger budget (1.6M / 30k steps)
- **Adopt** what wins into the high preset.
- **Release:**
  - nook to kakapo (pin-bump PR, your OK to merge)
  - TestFlight 0.3.0, with a rescan from you
- **Re-judge on the new capture.**

**3. Later, only if needed:** generative fill of uncovered areas on a cloud GPU, marked as filled in the planner.

## Also in flight
- kakapo pin bump to the gsplat version, after the current quality eval.
- Cleanup sweep: kakapo bench folder, temp logs, `result` links; Brush caches on the Mac.

## Rough timing
- Phase 0: about 1 h (GPU-bound).
- Workflow: about 2–3 h; the iOS builder runs in parallel with the GPU work.
- Phase 2: about 1–2 h, plus your rescan.
