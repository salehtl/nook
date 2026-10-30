# Sharper rooms: handoff (2026-10-30, branch `sharpness`)

**Goal (Saleh):** a crisp splat of the majlis. "majlis better" = room `scan-20261027-214555` (1,079 frames, 331 stills at
4032×3024, LiDAR; the working copy is unzipped in `~/nook-exp/cap`, so don't go to `/var/lib/nook` for it). End state is merged
PRs and kakapo running the result, but **every merge and deploy needs Saleh's word in your own session**; this note
is not that word. Nothing is merged or deployed yet.

## Who does what (agreed with Saleh, 2026-10-30)

Two sessions, split by files so they never edit the same thing. Neither touches the other's branch.

| | **Mac session** ("Medulus Better output sharpness") | **kakapo session** |
|---|---|---|
| Owns | `ios/` | everything else: `gsplat/`, `scan/`, `poses/`, `nix/`, `contract/`, `evals/`, `docs/`, `CLAUDE.md` |
| Branch | `shutter-cap` (its own PR) | `sharpness` (this branch) |
| Work | the adaptive shutter (below) and any later capture changes; simulator tests; the TestFlight build (`ios/scripts/release.sh`, with Saleh's OK); comparing the new scan with "majlis better" in the browser | the GPU experiments in `~/nook-exp` (sole user of the GPU and of `~/nook-exp`; the Mac session no longer queues runs); trainer and nook-scan changes; the nook PR; the kakapo pin bump and deploy |
| Merges | its own PR into `main`, on Saleh's word in that session | its own PR into `main`, then the kakapo PR, each on Saleh's word in that session |

- **Talking to each other:** the sessions can't message each other, so they write here. Either one may add a line
  under "Requests" below (the one exception to the file split), commit it on its own branch and push; the other reads
  it with `git fetch && git show origin/<branch>:docs/plans/sharpness.md`. Saleh relays anything urgent.
- **Contract:** a capture change that the trainer must read (a new `meta.json` or frame key) is specified in
  `contract/CONTRACT.md` by the kakapo session first; the Mac session then writes it. The capped shutter needs no
  contract change: `exposure_duration` and `lock_exposure_duration` already record it.
- **Testing the capture side:** Saleh rescans the majlis with the TestFlight build the same way as "majlis better" (same
  passes) and sends it to kakapo. The kakapo session trains it with the winning settings and compares the two rooms.

## Capture side (Mac session, branch `shutter-cap`)
- **Adaptive shutter at the lock:** auto exposure's brightness at the fastest shutter the light allows: down to
  1/1000 s within ISO 800; past that, ISO up to the maximum to hold 1/250 s; slower only in a dark room, which the
  capture screen flags ("Too dark for a fast shutter"). `exposure_duration` per frame and `lock_iso` /
  `lock_exposure_duration` in `meta.json` record what was used; no contract change.
- **Slow-down warning predicts blur** (pixels moved while the shutter is open) and warns past 2 px.
- **To compare:** the rescan's frames should show `exposure_duration` ≈ 0.001–0.004 s instead of 0.01. If noise
  shows at ISO 800+, the budget (`AdaptiveShutter.isoBudget`) is the knob.

## Requests

- **kakapo → Mac (2026-10-30):** if the rebuilt app marks a test walk, write `"test_walk": true` per frame (and `"pass": 4` if it adds one). The trainer on `sharpness` will accept both and score test-walk frames without training on them. **The deployed server validates passes 1-3 only**, so a capture with `"pass": 4` is refused until this branch is merged and deployed.
- **kakapo → Mac (2026-10-30), for the next capture build:** add a level loop at seated height (about 1.15 m) and a level loop at standing height (about 1.6 m), and a slow close pass around the main furniture from 2-3 heights. Allow perhaps 5-8 min in total (an estimate). Reason: `scan-20261030-154924` has almost no level frames at the heights the room is judged from. Not yet proved by a rescan; compare the new scan on the same scoreboard, but do not mix its scores with this scan's.

## Tuning for speed (started 2026-10-30, kakapo session): how to pick this up

Goal: under 30 min upload to room, no visible loss, judged at the seated (1.15 m) and standing (1.6 m) views on the sofa, table, rug, curtains and walls.

- **Test scan, for every comparison:** `scan-20261030-154924` (1,122 frames, 366 stills, 2 ms shutter, LiDAR), copied to `~/nook-exp/incoming` and unzipped to `~/nook-exp/cap`. Its server job was cancelled at step 5,700 to free the GPU; no room exists for it yet.
- **Datasets:** `~/nook-exp/ds/s1/<name>/data`. `base` is `prep2.py`: 8 stretches of 12 frames scored, 3 guard frames each side left out of training (978 train, 96 scored). `sharp`, `still1`, `still2` come from `filter.py`; `colmap` from `colmap_refine.py` (log: `colmap/s1.log`).
- **Queue:** `tmux attach -t nook-queue` runs `exp/queue.sh`, the only thing that drives the GPU. Append lines to `queue.txt`; `!` lines are plain shell. Runs are in `runs/s1-*`; results are in `results.txt` (older lines are the earlier scan and scoring).
- **Survives logout, not reboot.** It runs in tmux, not `sudo systemd-run` (no sudo for project work; `Linger=no`). After a reboot restart the queue and re-add the line that was running.
- **Fixed:** pose refinement now uses a per-camera Adam with decay (`PoseAdam`). Each camera is drawn only about `steps / n` times, so `lr` limits how far it can move: about 0.2 mm or 0.01 deg per unit of 1e-5 per look.

### Learnings so far (2026-10-30, on `scan-20261030-154924`, 20k steps, 1M splats unless noted)

| Run | PSNR | SSIM | LPIPS | Sharpness (1 px blur) | Train min |
|---|---|---|---|---|---|
| `s1-b20` baseline | 20.89 | 0.692 | 0.583 | 0.325 | 20.4 |
| `s1-seeds` rebuilt seeds | 22.40 | 0.694 | 0.579 | 0.381 | 17.7 |
| `s1-pose1e5` | 21.32 | 0.693 | 0.578 | 0.340 | 21.2 |
| `s1-pose1e4` | 21.08 | 0.692 | 0.576 | 0.344 | 21.5 |
| `s1-pose5e4` | 21.16 | 0.692 | 0.563 | 0.365 | 21.1 |
| `s1-rs10` rolling shutter 10 ms | 20.67 | 0.690 | 0.584 | 0.329 | 32.1 |
| `s1-ramp` low resolution first | 20.77 | 0.690 | 0.577 | 0.327 | 16.2 |
| `s1-depth2` depth loss 0.2 | 21.68 | 0.692 | 0.562 | 0.343 | 24.6 |
| `s1-still2` stills, few video frames | 20.58 | 0.682 | 0.560 | 0.400 | 18.3 |
| `s1-sharp` blurry frames dropped | 20.75 | 0.692 | 0.575 | 0.330 | 20.3 |
| `s1-m15` 1.5M splats | 21.64 | 0.693 | 0.568 | 0.354 | 25.7 |
| `s1-s12k` 12k steps | 20.77 | 0.692 | 0.600 | 0.292 | 11.0 |

- **Read the images before the scores.** All runs look nearly the same. Seated views: the sofa is lumpy, the curtains streak, the rug's items smear. Held-out table close-ups are a smear. Run differences are small next to differences between stretches (LPIPS 0.32 to 0.75).
- **Noise is not measured yet.** `s1-pose1e5` moved cameras almost nothing but gained 0.43 dB, so noise may be about 0.4 dB. `s1-b20r2` measures it. Train times are also unreliable: other jobs loaded the host.
- **Real so far:** rebuilt seeds (+4 to +6 dB in stretches 6 and 7, little elsewhere). Rolling shutter is rejected (1.6x slower, no gain). Dropping blurry frames gives no clear gain at a 2 ms shutter.
- **Pose lr sets reach.** A camera is drawn about 20 times, so lr 1e-4 moved poses only 0.03 deg. COLMAP cannot fit the target: features and matching took over 1 hour, and the first bundle adjustment 2 hours, on the CPU.
- **Stills are not sharper by every measure:** at 960 px, video gradient energy (0.0240) beat stills (0.0215) on this scan, against the 1.39x in the brief. Scored frames are video only, which may bias the stills test.
- **MCMC does not place blobs by error.** gsplat's `mcmc.py` and `ops.py` choose by opacity, so blurry areas don't directly get more blobs.
- **Spark:** default Spark scored 3.1 dB below gsplat on `base-25k`; `extSplats` plus `accumExtSplats` gave only +0.05 dB. The old `psnr_judge.mjs` scored stale sorts under software GL (20.1 dB against 23.9 dB), so older Spark numbers from software GL are suspect.
- **The scan plan misses the target views** (`coverage.py`, this one scan, not proved by a rescan). Pass 1: 390 frames at 1.31-1.46 m, 19-9 deg down. Pass 2: 732 frames at 1.53-1.89 m, 45 deg down to 45 deg up. The seated view (1.15 m, level) is below nearly all cameras, and few frames are level at 1.6 m. A held-out frame has only about 5-9 similar training frames (within 50 cm, 20 deg). The walk took 2.4 min.
- **Phone speed is not the limit at a 2 ms shutter.** The fastest stretch (0.82 m/s) has the best LPIPS, 0.324. Downward views of busy objects score worst (0.58-0.75), upward views of plain surfaces best (0.32-0.52). Content is mixed in with coverage, so this is not all a coverage fault.
- **Next question:** `probe.sh` scores runs on frames they trained on. Sharp there means coverage or Spark is the limit, so stop tuning. Soft there means training or poses.
- **Host limits:** kakapo fell to 1.2 GiB available during this work (no swap). Run browser tests one at a time under `flock ~/nook-exp/browser.lock`, in a scope with `MemoryMax=6G` and `CPUQuota=800%`.
- **An app upload starts a job on the deployed server that holds the GPU lock for hours.** Only Saleh stopped the last one; an agent's cancel call was blocked.

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
  `results.txt`, `runs/<name>/{metrics.json,shots/}`. Start the queue in herdr or tmux, with no sudo: `rm queue.stop`,
  then `bash exp/queue.sh`. `touch queue.stop` ends it once the queue is empty. Runs take `nice -n 10` from `run.sh`.
- `colmap` comes from the project: `nix develop ~/src/nook#sharpness -c nice -n 10 taskset -c 0-7 <command>`.
- An earlier queue used `sudo systemd-run` units to survive logout. That breaks the project rules; ask Saleh if a run
  must survive logout. The loss on 2026-10-29 was blamed on `Linger=no`, but that boot also ended with no shutdown, so
  the cause isn't known.
- `~/nook-exp` sits outside `~/src` and holds a capture of the house: delete it when this work ends, after saving
  `results.txt` and any run worth keeping (`rm -rf ~/nook-exp`).
- Protocol: 25k steps, 1M splats, SH3 (~20 min). `judge.py` aligns each held-out pose first, then reports PSNR/SSIM
  and a sharpness ratio (render vs photo gradient energy) on all held-out frames and on the sharp ones.

## Queue at handoff
`base-25k`, `mb4-25k` (--motion-blur 4), `poseopt4-25k` (--pose-opt-lr 1e-4), `nop3-25k`. Next: rolling shutter
(5/10/15 ms), `colmap`, `st2880`, then the best combination at full size (2M splats, 80 steps/frame) as a retrain.

## Shipping path
nook PR → merge → kakapo repo pin bump PR (`flake.nix` nook rev), `ci-local.sh <pr>` → merge (on Saleh's word in your session) →
`deploy.sh <sha>` or the 04:00 autoUpgrade. New defaults go into the high preset (`settings.py`/`trainer.py`) and
contract §4.9.1; `evals/fake_gsplat.py` must accept new flags.
