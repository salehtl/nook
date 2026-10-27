# Planner v2: design brief

Every designer, the critic and every builder gets this. Plan: [planner-v2.md](planner-v2.md). Paper file: **nook · Planner v2**.

## Who and when

One person plans their home reading room. Two moments matter most:

1. **On the iPhone, right after a scan.** They tapped **Send to kakapo** in the Nook Scan app, the room trained for about 16 minutes, and **Open room** dropped them into the planner in Safari. They are standing in the room, one hand free. They want to see the new room, check it's level and the right size, and drop a chair in.
2. **At the desk (1280 × 800 and up).** Longer sessions: comparing scans, arranging furniture, saving layouts, measuring, a paid photoreal render now and then.

It is a private tool for one person. No accounts, no sharing, no onboarding tour. Calm, precise and quiet; the 3D room is the hero and the chrome stays out of its way.

## What exists today (v1)

One collapsible 300 px sidebar over a full-screen 3D view: Library, In the room, Layouts, Room & alignment (+ Look), Renders. Top right: Orbit / Seated / Standing, Measure, Frame, Render. A selection bar at the bottom (Move / Rotate, ±15°, GLB / Splat, Relight here, Remove). Toasts top right. Keyboard shortcuts everywhere, nothing for touch. It only knows one room: the last scan.

## Screens and areas (one designer each)

| Area | What it covers |
|---|---|
| **A. Rooms** (captures browser) | Every scan: thumbnail, title, date, status, numbers. Open, rename, delete. Empty, loading, error states. |
| **B. Workspace** (3D view chrome) | Top bar with the room switcher, views (Orbit / Seated / Standing), Measure, Frame, Render. Selection label and actions. Measure, pick-floor and two-point-scale modes. First-person movement on touch. Scan viewpoints (step through the phone's real positions). Toasts. |
| **C. Panels** | Library, In the room, Layouts (per room), Room alignment & Look, Renders, Render confirm and Render viewer. Desktop: side panel, collapse, ≤ ⅓ of the view at 1280 × 800. Phone: bottom sheets. |
| **D. Flows** | First run (no scans at all), a scan arriving while you plan (training → ready), a failed job, switching rooms with unsaved changes, opening a room from the app's **Open room** link. |

Each area: **phone (390 × 844, portrait, touch)** and **desktop (1280 × 800)** frames. Both are first-class. iPad follows from them and isn't drawn.

## Data the UI has

**A room** is one trained scan on kakapo (`GET /api/rooms`, new):

| Field | Example | Notes |
|---|---|---|
| `name` | `scan-20261026-093654` | slug, stable id, used in URLs (`/planner/?room=<name>`) |
| `title` | "Reading room, morning" | optional, set by rename; else show a friendly date ("Sun 26 Oct, 09:36") |
| `created` | 2026-10-26T09:36Z | |
| `thumb_url` | `/room/<name>.jpg` or null | made by the planner the first time the room is opened (or on Save); **null until then** |
| `splats` | 1 184 220 | |
| `size_bytes` | 61 MB (spz) | |
| `train_seconds` | 960 | about 16 min |
| `steps` | 30 000 | |
| `quality` | `high` / `draft` | |
| `psnr` | 23.1 dB or null | usually null; don't design around it |
| `aligned` | true/false | whether alignment was saved for this room |
| `layouts` | 3 | count of layouts saved for this room |
| `current` | true | the room `room.json` points at (newest finished scan) |

**A job** (an upload, `GET /api/scan/jobs`, exists, contract §5): `status` `queued | training | done | failed | cancelled`, `stage` (`waiting`, `preparing`, `building trainer`, `training`, `finishing`, `done`), `progress` 0–1, `step / total_steps`, `eta_s`, `message` ("training: step 12000/30000", or one actionable error sentence for failed), `created / started / finished`. Can be cancelled while queued or training. A done job becomes a room. Queued, training, failed and cancelled jobs show in the rooms list too (no thumbnail, no numbers yet). Only one job trains at a time (one GPU); others queue.

**Per room**: alignment (yaw/pitch/roll, x/y/z, scale; Pick floor, Two-point scale), Look (exposure 0.25–4×, warmth cool…warm, contact shadows on/off, Relight), up to 24 **scan viewpoints** (real phone positions), and its own **layouts** (name, item count, saved date). Old global layouts show under the room they were saved with.

**Library** (shared by all rooms): items with name, W × D × H cm, thumbnail (may be missing), `glb` and maybe `splat`. Usually 5–30 items.

**Renders**: a paid photoreal pass of the current view, about $0.04, needs confirmation (model, price, optional prompt). Listed newest first; viewer shows planner view and render side by side.

## Rules for every frame

- **Phone:** the 3D view stays full screen. Panels are **bottom sheets** with detents (peek / half / full). Gestures on the 3D view: one finger orbits (or looks, in seated/standing), two fingers pan and pinch-zoom, tap selects, drag a selected item on the floor moves it. Nothing may need hover or a keyboard. Touch targets ≥ 44 pt. Respect the notch and home indicator (safe areas). Seated/standing move with an on-screen stick or tap-to-walk. Keep primary actions in thumb reach (bottom half).
- **Desktop:** panels collapse; at 1280 × 800 they cover at most about a third of the view. Keyboard shortcuts stay (R, Shift+R, G, Del, Esc, M, F, 1 2 3, [ ], WASD) but every one also has a visible control.
- **States to draw:** loading (a splat is 20–80 MB, so seconds on Wi-Fi), empty, error (jobs server unreachable, room file missing), offline/unreachable kakapo.
- **Destructive actions** (delete a room, cancel a training job, discard unsaved alignment) confirm first. Delete moves the scan to a trash folder on kakapo; say so.
- **Accessibility:** text contrast ≥ 4.5:1 (≥ 3:1 for ≥ 18 px), visible focus, no colour-only status (pair status colour with a word or icon).
- **Content:** mock data only. Room names like `scan-20261026-093654`, titles like "Reading room, morning", "Study corner", "Living room (test)". Furniture like "Eames lounge chair", "Oak reading lamp", "Linen armchair", "Walnut side table", "Bookcase 80". **No real scans or photos**: thumbnails are flat placeholders (a soft gradient or abstract splat-like dots in muted room colours). No AI-generated images.
- **Copy:** plain, short, sentence case, no exclamation marks. Say what happened and what to do ("kakapo isn't answering. Check you're on home Wi-Fi or Tailscale.").

## Shared tokens (already in the Paper file; use them, don't add new ones without a reason)

Mood: **surveyor's field kit at dusk**: graphite instrument case, chalk line, brass plumb bob, moss-green level bubble, red survey flagging. Dark chrome so the scan's colours read true.

| Token | Value | Use |
|---|---|---|
| `--color-ground` | `#131417` | app background, behind the 3D view |
| `--color-surface` | `#1C1E22` | panels, sheets (use at 94 % over the 3D view) |
| `--color-raised` | `#262930` | fields, cards, pressed rows |
| `--color-line` | `#FFFFFF17` | hairlines (9 % white) |
| `--color-text` | `#ECE8E0` | chalk: primary text |
| `--color-muted` | `#A39E94` | secondary text (≥ 6:1 on surface) |
| `--color-accent` | `#D9A441` | brass: the one strong colour (primary action, selection, training progress) |
| `--color-accent-ink` | `#16130C` | text on brass |
| `--color-ok` | `#8CC4A0` | level-bubble green: done, saved |
| `--color-danger` | `#E8735A` | flagging red: failed, destructive |
| fonts | SF Pro Display (≥ 20 px), SF Pro Text (< 20 px) | builds as `system-ui`; tabular numbers for all measurements |
| text sizes | 11 (caps labels, +0.06em) · 13 (desktop body) · 15 (phone body) · 17 (phone titles) · 22 (section) · 34 (display) | |
| spacing | 4 · 8 · 12 · 16 · 24 · 32 | |
| radius | 6 (controls) · 10 (panels, cards) · 16 (sheets) · 999 (pills) | |

## Proposed behaviour (designers may push back, with a reason)

- `/planner/` opens the room you were last in on this device, else the newest room. `/planner/?room=<name>` opens that room (the app's **Open room** will link there).
- The **room switcher** sits in the workspace top bar (room title + status dot). It opens Rooms: a full-screen page on the phone, a panel or overlay on desktop.
- A training job shows in the workspace as a small live chip ("Training · 62 % · 6 min"); when it finishes, a toast offers **Open**.
- Layouts, alignment and look belong to a room. Switching rooms with unsaved alignment asks first.
- Rename changes the title, never the file name.
