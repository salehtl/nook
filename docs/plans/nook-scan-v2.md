# nook-scan v2: sharper scans and kakapo processing

> **Update 2026-10-26:** Brush is retired. Training runs on kakapo only, with gsplat (CUDA): the same held-out quality on the real scan in half the time (16 vs 33 min on the RTX 2060). The Brush and Metal/Vulkan details below are historical. See contract §4.9.

Two goals, one change set:

1. **Quality.** The first real scan (2026-10-26) trained in 8 minutes and scored 20.8 dB on held-out views. Most of the loss traces to iPhone auto-exposure and white balance drifting while scanning. The rest is coverage and conservative training defaults.
2. **Self-hosted processing.** Tap **Send to kakapo** in the app. kakapo (RTX 2060, always on, tailnet-only) trains the room and serves the web app with it, and the phone opens the room. No AirDrop, no Terminal.

```
iPhone (nook-scan 0.2)                      kakapo (tailnet only)                                   web app
capture with exposure + WB locked ──zip──▶  POST /api/scan/captures → queue → Brush (Vulkan)  ──▶  /planner/ shows the new room
job progress ◀── GET /api/scan/jobs/<id>    room/<name>.ply + room.json (+ scan viewpoints)          starts from a real scan viewpoint
```

## 1. How the article shapes the setup

Same rules as the earlier phases ([PLAN.md §1](../../PLAN.md)):

| Article | Here |
|---|---|
| One loop by default; subagents for independent work with a clean interface, or blind verification | **4 agents**: 2 builders in parallel (iOS app, server and trainer) and 2 blind verifiers. |
| Split by **context** | The iOS builder owns `ios/`; the server and trainer builder owns `scan/`. Their only interface is the contract: capture v1.1 (§4) and the server API (§5). |
| Evals first, with a golden reference | Before any agent starts: a **mock server** that implements §5 exactly, so the iOS side can be built and tested against it without the real server. Plus a server API eval, and a quality eval on **your real scan**, with a baseline of 20.8 dB. |
| Fold small or chained work into the main loop | The planner's scan viewpoints (about 50 lines that read what the trainer writes), integration, and all fixes. |
| Credentialed and outward-facing steps stay in the main loop | Everything on kakapo: the NixOS module in the **public** kakapo repo, the deploy key, `nixos-rebuild` through your YubiKey session. Also the TestFlight upload. |

## 2. Components

**`ios/` (nook-scan 0.2)**
- **Exposure and white balance lock:** use `ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera` to lock both once tracking has been normal for about 1 s. A lock icon shows on screen. The new `meta.json` fields are `exposure_locked` and `white_balance_locked`. Each frame also records `exposure_duration` and `exposure_offset`. Autofocus stays on, since per-frame intrinsics already handle it.
- **Guided passes:** loop 1 at chest height, loop 2 lower with the phone tilted down, then a pass through the middle. Coverage is tracked per pass, with a clear prompt for what to do next.
- **Processing server setting:** the URL, plus a connection test (`GET /api/scan/health`).
- **Send to server:** zip, then a background upload with progress, then job status polling (stage, percent, time left). Then **Open room**, which opens `<server>/planner/`. Job IDs are stored per capture outside the capture folder.
- Errors are actionable, e.g. "Can't reach kakapo: is Tailscale on?".

**`scan/` (trainer quality and server)**
- **Quality presets:**
  - `--quality draft`: 10k steps, 1280 px, the old default.
  - `--quality high`: the new default. About 30k steps at full resolution, tuned on your real scan.
  - `--max-splats` caps the size for the 6 GB GPU.
- **Scan viewpoints:** written into `room.json` as about 24 real camera poses in room coordinates, so the web app can start from them.
- **`nook-scan serve`** (Python stdlib only): the job API (contract §5). Uploads stream to disk, a single GPU worker runs a queue, progress comes from the trainer's step lines, and job state persists across restarts. Its `--room-dir` is the one the web app reads.
- **Platform-neutral:** the Brush build and run work on macOS (Metal) and Linux (Vulkan on NVIDIA). Vulkan is found through `VK_ICD_FILENAMES` or `/run/opengl-driver`.

**Main loop**
- **`planner/`:** standing and seated views start from the scan viewpoint nearest the room's center. **Scan views** (`[` and `]`) steps through them.
- **kakapo**, following its current patterns (read 2026-10-26: services come from a **public** repo's flake as a NixOS module, the way hasala and ledger do; ingress goes through the nginx LAN proxy at `<name>.salehtl.com`):
  - `nook.salehtl.com` goes on the proxy's **`tailnetOnly`** list (Tailscale identity gate, no public access), with `client_max_body_size 4G` and unbuffered uploads.
  - The nook flake provides `nixosModules.default`: a `nook` system user with GPU access, `/var/lib/nook` state, the jobs server on `127.0.0.1:8095`, and the web app on `127.0.0.1:8096`. The web app proxies `/api/scan/*` to the jobs server, so the proxy needs only one upstream.
  - Brush is built with Nix, with Vulkan from the host's NVIDIA driver (`/run/opengl-driver`).
  - kakapo pins the input to a commit, like hasala. It's tested with `nixos-rebuild test` from a kakapo branch before anything merges.
  - **Blocker for this step:** nook is private and kakapo (including its public CI) can only fetch public flake inputs. Options: make nook public (a secrets audit found nothing secret), or move the server into a new public repo.
- **TestFlight:** build 0.2.0.

## 3. Evals (written before the agents start)

| Eval | Checks | Who uses it |
|---|---|---|
| `evals/mock_scan_server.py` | A reference implementation of §5 with simulated progress | the iOS builder; the iOS eval |
| `evals/ios_build.sh` (extended) | The existing 13 checks, plus Swift tests: the exposure-lock policy, §5 JSON decoding, and an **upload and job-poll integration test against the mock server** (the simulator reaches the Mac's localhost) | iOS |
| `evals/server_api.sh` | Starts `nook-scan serve` with short training. Uploads the fixture capture zip and follows the job to `done`. Checks: room.json and viewpoints, duplicate upload is idempotent, a bad zip is a 400, cancel works, the job survives a restart, path-traversal safety. | server |
| `evals/scan_quality.sh` | On your real scan, if present: `--quality high` with held-out frames, judged by Spark. **≥ baseline + 1.5 dB** (baseline 20.8), in **≤ 40 min** on the M3 Max. | trainer |
| existing `scan_offline.sh`, `planner_smoke.mjs`, `validate_capture.py` | No regressions. Capture v1.1 stays valid under v1 rules, since the new fields are optional. | all |

## 4. Order

1. **Main loop:** contracts (§4.8 capture v1.1, §5 server API, room viewpoints), the mock server, the evals. Commit.
2. **Workflow:** `pipeline([ios, server], build, blindVerify)`.
3. **Main loop:**
   - planner viewpoints
   - fix the findings
   - point the iOS integration test at the **real** server
   - retrain your scan with `--quality high` and compare
4. **Main loop plus you:** kakapo branch, deploy key, `nixos-rebuild test`, GPU training on kakapo, then switch and merge.
5. **TestFlight 0.2.0:** you rescan with exposure locked, Send to kakapo, Open room.
