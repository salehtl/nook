# nook

Private, experimental tool for planning a home reading room: a Gaussian-splat scan of the room, furniture generated from photos, and a browser planner for placing it. Personal use only; nothing here ships. Prefer the simplest thing that works.

The spec is [contract/CONTRACT.md](contract/CONTRACT.md). Read it before changing `planner/` or `pipeline/`.

## Conventions

- Units are **meters** in 3D space, **centimeters** only in `dims_cm` and CLI `--dims`.
- Coordinates: right-handed, **Y-up** (glTF / three.js). The room floor is at **y = 0**.
- Item frame: origin at the **center of the footprint, on the floor** (min y = 0). Width along X, height along Y, depth along Z. The item's **front faces +Z**.
- Asset paths inside `library.json` are relative to the directory containing that `library.json`.
- Ids and layout names are slugs: `^[a-z0-9][a-z0-9-]{0,63}$`.

## Ownership

| Path | Owner |
|---|---|
| `planner/` | planner (browser app + `planner/serve.py`) |
| `pipeline/` | furniture CLI (`nook-add`) |
| `contract/`, `evals/`, `fixtures/`, `CLAUDE.md`, `PLAN.md` | main session only; treat as read-only otherwise |
| `room/`, `library/`, `layouts/` | user data written by the tools |

Only the main session commits.

## Secrets and cost

- `FAL_KEY` lives in `.env` at the repo root (git-ignored). Never print it, log it, or write it anywhere else.
- Live fal calls cost money. During development use `NOOK_FAL_MOCK=fixtures/fal`, which replays recorded responses for $0.

## Tooling

- Browser: **Helium** (`/Applications/Helium.app/Contents/MacOS/Helium`), not Chrome. Headless WebGL needs `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- Python: `uv` with Python 3.12 (system Python 3.15 is too new for some wheels). The pipeline is a uv project in `pipeline/`.
- **Training runs on kakapo only** (gsplat on its RTX 2060, CUDA; the `nook` NixOS service there). The Mac doesn't train. Evals that train (`scan_offline`, `scan_quality`) run training on kakapo over the shared ssh link (`~/.ssh/cm-nook-kakapo`, see `evals/remote.sh`) and check the results here. The server eval uses a stand-in trainer (`evals/fake_gsplat.py`).
- Node: only used for evals (`playwright-core`, `ajv`). The planner has no build step.

## Evals

- `npm run eval:planner` runs `evals/planner_smoke.mjs`.
- `npm run eval:pipeline` runs `evals/pipeline_offline.sh` (offline, mocked fal, $0).
- `evals/validate_library.py <library.json>` checks any library against the contract.

Scratch output goes to `evals/out/` (git-ignored).
