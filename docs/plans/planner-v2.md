# Planner v2: rooms you can browse

**Goal:** the planner works on the phone as well as the desktop, and it knows about every scan you've made, not just the last one. You can see your scans, open any of them, follow one that's still training, and keep layouts per room. Then a redesign of the whole planner around that, designed in Paper first and only then built.

## Today (2026-10-26)
- **One room at a time.** Every finished scan writes `<room-dir>/<name>.spz/.ply` and repoints the single `room.json` at it (contract §2.1, §4.6, §5). Older trained rooms stay on disk, but nothing in the UI shows them.
- **Layouts are global.** They aren't tied to a room. Alignment and the look are saved per `room.json`, so one at a time.
- **The jobs API (§5)** already lists every upload with its status, progress and result. The planner doesn't use it, apart from the Render view.
- **UI:** one collapsible sidebar (`planner/index.html`, `main.js` about 1,850 lines, `style.css`). Its sections are Library, In the room, Layouts, Room & alignment (+ Look), and Renders. Top right has the views (orbit, seated, standing), Render and measure.
- **Where it runs:** on kakapo at `https://nook.salehtl.com/planner/` (nook service, `/var/lib/nook`), served by `planner/serve.py --room-dir --library-dir --scan-api`.

## Phases
**1. Understand (main loop of the orchestrating session).** Read contract §2 and §5, `planner/`, `scan/src/nook_scan/serve.py`, and `docs/SCANNING.md`. Write a short brief listing the screens, states, data and constraints, and share it with every designer.

**2. Design v1 in Paper (fleet of subagents).** One Paper file, with designers split by area so they don't overlap. Each one works on its own artboards from the shared brief and a small shared token set: palette, type, spacing.

**Mobile is a first-class target, not a shrunk desktop.** You'll often open the planner on the iPhone right after a scan, from the app's **Open room** button. Every area is designed for both:
- **Phone** (about 390 × 844, portrait, touch). The 3D view stays full screen. Panels become bottom sheets. Gestures:
  - one finger orbits or looks
  - two fingers pan and zoom
  - tap selects
  - drag on the floor moves
  
  Targets are at least 44 pt, with no hover-only controls and no keyboard-only shortcuts. Seated and standing views move with an on-screen stick or tap-to-walk.
- **Desktop** (1280 × 800 and up).

The iPad layout follows from those two.
- **Captures / rooms browser:** list or grid of scans with a thumbnail, date, status (queued, training with progress, done, failed, cancelled), and size and quality numbers. Open, rename, delete; empty and error states.
- **Room workspace:** the 3D view and its chrome: views, measure, Render, the room switcher, selection labels, and touch gestures on the phone.
- **Panels:** library, placed items, layouts (per room), alignment and look, renders. This also covers the phone bottom-sheet versions and collapse behavior at 1280 × 800.
- **Flows:** first run with no scans, a scan arriving while you're planning, and a failed job.

**3. UX critique (one fresh, blind agent).** It reviews the Paper design against the brief, not against the designers' notes. It returns ranked findings: usability, hierarchy, consistency, missing states, phone usability (thumb reach, sheet heights, gesture conflicts with the 3D view), and accessibility (contrast, targets, keyboard).

**4. Design v2 in Paper.** Fix the findings: designers adjust their own artboards, and the orchestrator decides any finding that isn't fixed and records why.

**5. Build (fleet of subagents).** First a contract change (§2) for what the UI needs, for example `GET /api/rooms` (every trained room, with its job, thumbnail, alignment and layouts), per-room layouts, and switching the room without overwriting another room's alignment. The changes must stay compatible with existing `room.json` and layouts. Then builders split by file and area against that contract, plus the server changes in `planner/serve.py`.

**6. Check.**
- `npm run eval:planner`.
- A smoke test on kakapo-shaped data: several rooms, one of them training.
- Screenshots of the built UI next to the Paper frames, at phone width and at desktop width. For phone width, use Helium with touch emulation at 390 × 844.
- Splat rendering performance on a phone-class GPU noted, not assumed.

## Constraints
- **No build step.** three.js 0.180.0 and Spark 2.4.0 through the importmap; `planner/serve.py` uses the Python stdlib only.
- **Only the orchestrating session commits.** It works on its own branch and ends in a nook PR. Deploying to kakapo is a nook pin bump in the kakapo repo, which needs the user's OK. Don't touch kakapo itself.
- **The user's real scans are private:** never commit them, never put them in Paper. Use the fixture room or mock data in designs.
- **No live fal calls** (`NOOK_FAL_MOCK=fixtures/fal`).
