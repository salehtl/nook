# nook: build plan

A private, experimental tool for planning a home reading room. Three parts:

1. **Room**: a Gaussian-splat scan of the empty room (iPhone, Scaniverse), leveled and scaled to real meters.
2. **Furniture pipeline**: photo (or product link) → 3D object at real-world size, added to a local library.
3. **Planner**: a browser app that shows the room splat, lets you place, move and compare furniture layouts, and view the room from a seated reading position.

Scope: personal use only. No auth, no deploy, no tests beyond what catches real breakage. Simple beats robust.

---

## 1. How the article shapes this setup

Source: *Building agents: when to fold subagents into your main agent loop* (Anthropic). Its rules, and what they mean here:

| Article says | Applied here |
|---|---|
| Default to **one loop, one context**; subagents only for parallel work that needs little from the rest, clean interfaces, or black-box verification. | The workflow has **4 agents**: 2 builders running in parallel and 2 blind verifiers. Everything else (contract, evals, integration, fixes, your photos and scan) stays in the main session, which keeps the full context. |
| Split by **context**, not by problem type, to avoid the "telephone game". | One builder per component (planner, pipeline), and each owns its whole folder. No "UI agent / rendering agent / controls agent" split, and no separate "scale-normalizer" agent. |
| Each subagent gets work that needs little from the rest and **returns a compact result**. | The only thing the two components share is a written **contract** (file layout, coordinates, JSON schemas). Builders return a small structured report, not prose. |
| **Build evals first.** About 10 golden examples to start, graded on final outputs. | Phase 0 writes the eval scripts and fixtures *before* any building. Builders must make them pass and may not edit them. A few real golden photos cover the live evals. |
| Domain procedure goes into **skills**, hard limits into **tools**, and preconditions are enforced inside tools. | `CLAUDE.md` holds the shared conventions, injected into every agent, so there's no copy-pasted "Frankenprompt". The "how to add a piece of furniture" judgment (finding dimensions, choosing an engine) becomes a project skill. The CLI rejects output that fails the schema or dimension checks, and returns a message the model can act on. |
| Optional **verifier after the answer**: black-box, independent. | Each verifier gets only the contract and evals, never the builder's report, and tries to break the component. |
| Avoid lossy handoffs; **fold work back into the main loop** when it chains on prior context. | Fixes are *not* handed to fresh "fixer" agents. Verifier findings come back to the main session, which fixes them with full context, one change at a time, and re-runs the evals after each fix. |
| Measure, change one thing at a time, keep what holds. | Cheap engine by default. Upgrade to the expensive one only where a side-by-side on your golden photos shows it's worth it. |

Splits deliberately **not** made: an orchestrator/router agent, one agent per API, a "fixer" agent per finding, a separate integration agent. Each would mean another lossy handoff with no new context to show for it.

---

## 2. Technical choices

**Planner**: static web app, no build step.
- three.js `0.180.0` plus Spark `2.4.0` (`@sparkjsdev/spark`), loaded via an importmap. Spark renders `.spz/.ply/.splat/.ksplat/.sog`, mixes splats with normal three.js meshes, and supports raycasting against splats.
- A tiny Python stdlib server (`planner/serve.py`) serves the repo and saves layouts and room alignment as JSON on disk. Claude can read those files later, so I can see what you've tried.

**Furniture pipeline**: Python 3.12 CLI via `uv`, using `fal-client` and `trimesh`. Engines, cheapest first:

| Engine | Cost / item | Use when |
|---|---|---|
| Retailer 3D model (GLB/USDZ from the "view in your room" button) | free | Always try first. Real model, best quality. |
| `fal-ai/sam-3/3d-objects` (Meta SAM 3D) | **$0.02** | **Default.** Pulls one object out of a cluttered photo from a text prompt ("armchair"). Outputs a splat `.ply` *and* a GLB, so furniture can be a splat that matches the room's look. |
| `fal-ai/trellis-2` | $0.25 (512p) – $0.35 (1536p) | Hero pieces, when SAM 3D's result is too rough. Works best on clean product shots. |

Rough spend: about 20 pieces explored at mostly $0.02, plus a few Trellis upgrades, comes to **under $3**. A $5–10 fal credit is plenty.

**Scale**: no image model knows real size. The CLI takes `--dims W×D×H cm` and normalizes the model to that size. In-session, Claude reads the dimensions off the product listing and passes them in: the model does the judgment, the tool does the mechanical work.

**Big files**: room scans and generated GLB/PLY files are git-ignored (scans can exceed GitHub's 100 MB file limit). `library/library.json`, layouts and alignment *are* committed, so the decisions are versioned.

---

## 3. Repo layout (target)

```
nook/
  CLAUDE.md                     shared conventions (every agent gets this)
  PLAN.md                       this file
  contract/
    CONTRACT.md                 coordinates, file layout, run commands, window.nook hook, acceptance criteria
    library.schema.json
    layout.schema.json
    room.schema.json
  evals/                        written in Phase 0; builders may not edit
    README.md
    planner_smoke.mjs           headless Helium + playwright-core, drives window.nook
    validate_library.py         schema + GLB bounds/dims/floor checks
    pipeline_offline.sh         runs the CLI against recorded fal responses ($0)
    golden/                     your 3 photos + their real dims (for live evals)
  fixtures/
    room/test.spz               public sample splat
    library/                    hand-built, contract-conforming library (Khronos SheenChair GLB)
    fal/                        real fal responses captured once in Phase 0
  .claude/skills/add-furniture/SKILL.md
  planner/                      ← built by workflow
  pipeline/                     ← built by workflow
  room/                         your scan + alignment.json
  library/                      your furniture
  layouts/                      saved layouts
```

---

## 4. Phases

### Phase 0: Foundations (main session, before any agents)

1. **Conventions** → `CLAUDE.md`: meters, Y-up, right-handed (glTF/three.js), floor at y=0. An item's origin is its footprint center on the floor, and its front faces +Z. Each builder touches only its own folder, nobody commits but the main session, and no keys in code (only `FAL_KEY` from `.env`).
2. **Contract** → `contract/`: the three JSON schemas, the exact run commands, the `window.nook` test hook (`ready`, `loadRoom`, `addItem`, `getState`, `saveLayout`, `loadLayout`), and the acceptance criteria per component.
3. **Fixtures**: download a public sample splat and Khronos's `SheenChair.glb`, and hand-write a valid `fixtures/library/library.json`.
4. **Live fixture capture** (needs your `FAL_KEY`, about **$0.27**). *As run:* no key was available yet, so Phase 0 built **synthetic** fixtures from fal's documented response schemas (`fixtures/make_fal_mock.py`), and the real capture moves to Phase 2. The original plan: one SAM 3D call and one Trellis 2 512p call on a golden photo. Save the full responses and files to `fixtures/fal/`. This settles the unknowns (do SAM 3D's GLB and splat share a coordinate frame? What do its `metadata` units mean?) and lets the pipeline be built and verified **offline for $0**.
5. **Evals**: write `planner_smoke.mjs`, `validate_library.py` and `pipeline_offline.sh` against the contract and fixtures, and confirm they fail cleanly (no planner or pipeline exists yet).
6. **Skill**: `.claude/skills/add-furniture/SKILL.md`, the procedure for a future session. Check the listing for a retailer 3D model, read the dimensions, choose an engine and prompt, run the CLI, validate, and report the cost.
7. **Toolchain**: `brew install uv`, then `uv python install 3.12` (system Python 3.15 is too new for some wheels), and `npm i -D playwright-core` for the evals. Commit as the baseline, so `git diff` shows exactly what the builders changed.

### Phase 1: Workflow (4 agents)

`pipeline()`, no barrier: each component goes into verification as soon as its own build finishes. The script is in §5.

- **build:planner**: owns `planner/`. MVP:
  - load a room splat (path, URL or drag-drop), with a placeholder box room of configurable size as the fallback
  - an alignment panel: rotate and offset the splat, pick the floor, and set scale from two clicked points plus a known distance; saved to `room/alignment.json`
  - a library panel to add items, loading GLBs or splats
  - move on the floor, rotate around Y, snap to the floor, and show dimensions
  - a measure tool
  - named layouts, saved and loaded through `serve.py`
  - orbit view and a first-person view at seated (1.15 m) and standing (1.6 m) eye height
  - the `window.nook` hook
- **build:pipeline**: owns `pipeline/`.
  - `nook-add <image|url> --name --dims WxDxH --prompt --engine sam3d|trellis2|glb`
  - uploads to fal and downloads the outputs
  - normalizes: orient, center the footprint, put the base at y=0, fit to dims, and report the fit error
  - writes `library/<id>/` and upserts into `library.json`
  - appends to `library/costs.csv`
  - `NOOK_FAL_MOCK=fixtures/fal` replays the recorded responses
- **verify:planner / verify:pipeline**: blind and read-only. They run the evals, check the evals are untouched (`git diff --quiet evals/`), then probe the acceptance criteria and edge cases. The planner verifier also looks at the screenshots: is the splat visible? Is the chair upright, on the floor and the right size? Each returns findings with repro steps and evidence.

### Phase 2: Integrate and fix (main session)

1. Triage the verdicts. Fix blockers and majors myself, one at a time, re-running the evals after each.
2. **End-to-end check**: mock pipeline → `library/` → planner smoke against *that* library. This tests the interface between the two components, which neither builder could test alone.
3. **Live golden eval** (about $0.85): run SAM 3D and Trellis 2 on your 3 golden photos, view the results side by side in the planner, and decide the default engine per kind of furniture. Write the decision into the skill.
4. Commit and push.

### Phase 3: Your room (you plus the main session)

1. **Empty the room.** Scan it in **Scaniverse** with even daylight, slow overlapping loops at two heights, and coverage of the corners and ceiling edge. Export **SPZ** (or PLY).
2. Optionally, do a **RoomPlan** scan (Polycam Room mode) and note one or two real wall lengths with a tape measure.
3. Drop the scan into `room/` and align it in the planner using a measured wall.
4. From there on it's iteration: send photos or links, and I add pieces, place them and compare layouts.

---

## 5. Workflow script (Phase 1)

```js
export const meta = {
  name: 'nook-build',
  description: 'Build the planner and furniture pipeline in parallel against the shared contract, then blind-verify each',
  phases: [
    { title: 'Build', detail: 'one agent per component; each owns its folder' },
    { title: 'Verify', detail: 'one blind black-box verifier per component' },
  ],
}

const REPO = '/Users/saleh/Developer/Claude Workspace/nook'

const BUILD_REPORT = {
  type: 'object',
  properties: {
    evals_pass: { type: 'boolean' },
    eval_output_tail: { type: 'string', description: 'last ~30 lines of the final eval run' },
    files_changed: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' }, description: 'every departure from the contract, with the reason' },
    known_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['evals_pass', 'eval_output_tail', 'files_changed', 'deviations', 'known_gaps'],
}

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    evals_untouched: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          repro: { type: 'string' },
          evidence: { type: 'string', description: 'command output, screenshot path, or file:line' },
        },
        required: ['severity', 'title', 'repro', 'evidence'],
      },
    },
  },
  required: ['pass', 'evals_untouched', 'findings'],
}

const COMPONENTS = [
  {
    key: 'planner',
    owns: 'planner/',
    evals: 'node evals/planner_smoke.mjs',
    brief: 'the browser planner (three.js + Spark, no build step) and planner/serve.py. Implement every MVP item in contract/CONTRACT.md §Planner, including the window.nook hook exactly as specified.',
  },
  {
    key: 'pipeline',
    owns: 'pipeline/',
    evals: 'bash evals/pipeline_offline.sh',
    brief: 'the nook-add furniture CLI (uv project, Python 3.12). Implement contract/CONTRACT.md §Pipeline. Use NOOK_FAL_MOCK=fixtures/fal for all development; never call the live fal API.',
  },
]

const build = c => agent(
  `Build ${c.brief}

Repo: ${REPO}. Read contract/CONTRACT.md, the schemas in contract/, and evals/README.md first; they are the spec.
You own ${c.owns} only. Do not edit anything outside it (evals/, fixtures/, contract/, CLAUDE.md are read-only). Do not commit.
Done means \`${c.evals}\` passes and you have checked the acceptance criteria for your component yourself.
If the contract is wrong or impossible somewhere, work around it inside your folder and record it in deviations; do not change the contract.`,
  { label: `build:${c.key}`, phase: 'Build', schema: BUILD_REPORT },
)

// Blind: the verifier never sees the builder's report. It gets the spec and the evals, nothing else.
const verify = (report, c) => agent(
  `You are verifying the ${c.key} component of nook, in ${REPO}. Someone else built it; you have no notes from them.
Spec: contract/CONTRACT.md (§${c.key === 'planner' ? 'Planner' : 'Pipeline'} and its acceptance criteria) and the schemas in contract/.
1. Run \`git diff --quiet HEAD -- evals/ fixtures/ contract/\` and report whether they are untouched.
2. Run \`${c.evals}\` and record the result.
3. Black-box test every acceptance criterion, then try to break it: odd inputs, missing files, reloads, edge sizes.${c.key === 'planner' ? ' Open the screenshots the smoke eval writes to evals/out/ and judge them visually: room visible, furniture upright, on the floor, plausibly sized.' : ''}
Read-only: do not modify any tracked file. Scratch files go in evals/out/ only.
Report only real, reproducible problems, each with evidence. pass=true only if there are no blockers or majors.`,
  { label: `verify:${c.key}`, phase: 'Verify', schema: VERDICT },
).then(verdict => ({ component: c.key, report, verdict }))

const results = await pipeline(COMPONENTS, build, verify)
const done = results.filter(Boolean)
log(done.map(r => `${r.component}: ${r.verdict.pass ? 'pass' : 'FAIL'} (${r.verdict.findings.length} findings)`).join(' · '))
return done
```

Agent count: 4, under the session's medium guideline of fewer than 10. Model and effort are inherited. No worktrees, because the builders' folders don't overlap.

---

## 6. What I need from you

1. **Approve this plan**, or tell me what to change.
2. **fal account**: create one at fal.ai, add $5–10 credit, and put the key in `nook/.env` as `FAL_KEY=...` yourself. The file is git-ignored, and I won't handle the key value.
3. **Three golden photos** of furniture you're actually considering (a mix: one clean product shot, one in a styled room), each with its real W×D×H. Product links work too.
4. **Later**: the room scan (Phase 3). It isn't needed until the tools exist.

## 7. Risks and unknowns

- **Splat and mesh occlusion in Spark** isn't documented clearly. If GLB furniture doesn't sort correctly against the room splat, use SAM 3D's splat output for furniture (it may look more consistent anyway).
- **SAM 3D's coordinate frame and metadata** are unknown until the Phase 0 capture. That's why the capture happens before building.
- **Headless WebGL** for the smoke eval: Helium with SwiftShader should work. If not, the eval falls back to checking `window.nook.getState()` only, and the screenshots get checked in the built-in browser.
- **Lighting mismatch** between baked splat lighting and lit meshes: fine for spatial decisions. Not a goal to fix.
- **Repainting walls or swapping the floor** inside the splat isn't practical. For color and material ideas, use AI-edited photos of the room alongside the planner.
