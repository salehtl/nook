# Sharper rooms: handoff (2026-10-30, branch `sharpness`)

**Goal (Saleh):** a crisp splat of the majlis. "majlis better" = room `scan-20261027-214555` (1,079 frames, 331 stills at
4032×3024, LiDAR, kept capture at `/var/lib/nook/jobs/captures/scan-20261027-214555.zip`). Free rein; end state is
merged PRs and kakapo running the result. Nothing is merged or deployed yet.

## Who does what (agreed with Saleh, 2026-10-30)

Two sessions, split by files so they never edit the same thing. Neither touches the other's branch.

| | **Mac session** ("Medulus Better output sharpness") | **kakapo session** |
|---|---|---|
| Owns | `ios/` | everything else: `gsplat/`, `scan/`, `poses/`, `nix/`, `contract/`, `evals/`, `docs/`, `CLAUDE.md` |
| Branch | `shutter-cap` (its own PR) | `sharpness` (this branch) |
| Work | the capped shutter (1/250 s, ISO raised to match) and any later capture changes; simulator tests; the TestFlight build (`ios/scripts/release.sh`, with Saleh's OK); comparing the new scan with "majlis better" in the browser | the GPU experiments in `~/nook-exp` (sole user of the GPU and of `~/nook-exp`; the Mac session no longer queues runs); trainer and nook-scan changes; the nook PR; the kakapo pin bump and deploy |
| Merges | its own PR into `main` | its own PR into `main`, then the kakapo PR (Saleh asked for both to be merged and deployed) |

- **Talking to each other:** the sessions can't message each other, so they write here. Either one may add a line
  under "Requests" below (the one exception to the file split), commit it on its own branch and push; the other reads
  it with `git fetch && git show origin/<branch>:docs/plans/sharpness.md`. Saleh relays anything urgent.
- **Contract:** a capture change that the trainer must read (a new `meta.json` or frame key) is specified in
  `contract/CONTRACT.md` by the kakapo session first; the Mac session then writes it. The capped shutter needs no
  contract change: `exposure_duration` and `lock_exposure_duration` already record it.
- **Testing the capture side:** Saleh rescans the majlis with the TestFlight build the same way as "majlis better" (same
  passes) and sends it to kakapo. The kakapo session trains it with the winning settings and compares the two rooms.

## Requests

- *(none yet)*

## Diagnosis so far (measured, `evals/sharpness/blur_stats.py`)
- Exposure locked at **10 ms**, ISO 141. Median phone turn 12°/s → ~3 px rotational blur at 1920 px (p90 11 px), plus
  ~2–5 px from walking 0.38 m/s at 1–2 m.
- **Pass 3** (walk through the middle, 214 frames) turns at a median 41°/s: Laplacian sharpness 4× lower than passes 1–2.
- v3's "pose drift isn't the problem" came from scoring held-out frames at uncorrected poses; its 0.2° median
  correction is ~5 px at this focal length. Pose error is still a suspect.
- Literature (Seiskari et al., ECCV 2024, iPhone + VIO, "Gaussian Splatting on the Move"): pose opt ≈ +1.15 dB,
  rolling shutter ≈ +1.0 dB, motion-blur modelling ≈ +0.6 dB (N=5 poses). iPhone readout guess 5–15 ms.

## Code on `sharpness` (untested on the GPU at handoff)
- `gsplat/nook_gsplat.py`: `--motion-blur K` (render up to K poses across each frame's exposure from neighbour
  velocities, average; `--motion-blur-px` per sample), `--rolling-shutter-ms R` (gsplat 3DGUT, `viewmats_rs`).
  Needs `timestamp`/`exposure_duration` per frame.
- `scan/src/nook_scan/dataset.py`: prepared frames carry `timestamp` and `exposure_duration`.

## Harness on kakapo (`~/nook-exp`, copies in `evals/sharpness/`)
- `cap/` unzipped capture, `blur.json` per-frame blur, `env.sh` (`$PY` = nook-gsplat's python, `$SPY` = nook-scan's).
- `ds/<name>/data`: prepared datasets (`prep.py`, production-identical, every 10th frame held out): `base`, `nop3`
  (no pass 3), `sharp`/`sharp2` (blurry frames dropped, `filter.py`), `st2880` (stills at 2880 px), `colmap` (when
  `colmap_refine.py` finishes: COLMAP 4 known-pose triangulation + BA, aligned back to ARKit).
- `queue.txt` → `queue.sh` → `run.sh NAME DS ARGS` (train with `src/gsplat/nook_gsplat.py`, then `judge.py`) →
  `results.txt`, `runs/<name>/{metrics.json,shots/}`. Runs as `sudo systemd-run` units (`nook-exp-queue`,
  `nook-exp-colmap`, PATH must be set) so they survive logout (Linger=no killed last night's jobs).
- Protocol: 25k steps, 1M splats, SH3 (~20 min). `judge.py` aligns each held-out pose first, then reports PSNR/SSIM
  and a sharpness ratio (render vs photo gradient energy) on all held-out frames and on the sharp ones.

## Queue at handoff
`base-25k`, `mb4-25k` (--motion-blur 4), `poseopt4-25k` (--pose-opt-lr 1e-4), `nop3-25k`. Next: rolling shutter
(5/10/15 ms), `colmap`, `st2880`, then the best combination at full size (2M splats, 80 steps/frame) as a retrain.

## Shipping path
nook PR → merge → kakapo repo pin bump PR (`flake.nix` nook rev), `ci-local.sh <pr>` → merge (Saleh asked for it) →
`deploy.sh <sha>` or the 04:00 autoUpgrade. New defaults go into the high preset (`settings.py`/`trainer.py`) and
contract §4.9.1; `evals/fake_gsplat.py` must accept new flags.
