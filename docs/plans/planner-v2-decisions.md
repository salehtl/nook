# Planner v2: critique decisions

The blind critique of design v1 (Paper file **nook · Planner v2**, page "Critique") returned 21 findings. These are the decisions the v2 designers and builders follow. "Taken" means v2 fixes it as recommended unless a note says otherwise.

## Glossary (F7)

| Term | Means | Not |
|---|---|---|
| **Room** | a finished, trained scan you can open | "scan" for a finished one |
| **Scan** | an upload on kakapo that isn't a room yet (queued, training, failed, cancelled) | "job", "capture" |
| **In the room** | furniture placed in the open room (dock may shorten to "In room") | Items, In this room |
| **Library** | furniture you can add | |
| **Layout** | a saved arrangement of furniture, belonging to one room | |
| Save room · Revert… · Move to trash · Dismiss (a failed or cancelled scan) · Cancel scan (queued or training) · Rename | one verb per action | Save alignment, Reset, Delete scan, Remove |
| Status words | Queued · Preparing · Training · Ready · Failed · Cancelled | |

## Decisions

| # | Sev | Decision |
|---|---|---|
| F1 Safari chrome | high | **Taken.** The planner runs in Safari (that's where **Open room** lands). With a full-screen canvas the page never scrolls, so Safari's bottom bar **stays visible**: phone frames show it, and the dock and sheets sit above it (layout from the dynamic viewport and safe-area insets, not 844). Builders: `touch-action: none` and `overscroll-behavior: none` on the canvas, no page pinch-zoom, `beforeunload` guard while anything is unsaved. Add-to-Home-Screen works (manifest and meta tags) but **not taken:** a designed tip leading there; it's a nice-to-have. |
| F2 Check room | high | **Taken.** A "Check room" card at the peek detent: measured W × D × H, a level readout (floor tilt in degrees, "Level" with a check), **Pick floor**, **Check size** (two-point scale with something you know), **Save room**. Raw yaw/pitch/roll/x/y/z/scale go behind **Fine-tune**. 50 cm grid toggle in the Room panel. Opens from the post-scan hint and from Room. |
| F3 duplicates | high | **Taken** with the critic's picks: A1/A4 for Rooms, B7 for loading (bottom card with cancel), A3/A5 for empty, D5.2 for the gesture hint. D flows reuse those designs exactly. |
| F4 selection | high | **Taken.** One selection look everywhere: brass footprint outline on the floor plus the name label. One move model: **drag the selected item itself** across the floor (generous hit area), on phone and desktop; no separate move handle, no translate gizmo. Rotation: a small grip on the footprint outline that drags to rotate (snaps to 15° on phone, Shift on desktop), plus −15°/+15° buttons and R / Shift+R. Lives in the kit. |
| F5 gestures | medium | **Taken, with one change:** no on-screen stick at all. In Seated/Standing: one-finger drag looks, **tap the floor to walk there** (glide), viewpoint stepper, Back to orbit. The dock stays reachable. Rule: a drag that starts on the selected item moves it; anything else orbits/looks; two fingers pan and zoom. Draw Seated. |
| F6 status glyphs | medium | **Taken.** Rings mean progress only. Unsaved gets its own glyph and a word in the switcher ("Unsaved", "Loading 62 %", "Can't load"). |
| F7 names | medium | **Taken** (glossary above). |
| F8 compare at desk | medium | **Taken, cheap version:** desktop Rooms widens to a table-like list (bigger thumbnails; aligned tabular columns for splats, size, training time, quality, layouts, aligned). **Not taken:** sortable headers (a handful of rooms, newest first is enough) and side-by-side 3D compare (costly). |
| F9 desktop first-person | medium | **Taken.** Desktop Seated/Standing frame with the viewpoint stepper, a clickable WASD keycap cluster, eye height, Back to orbit. |
| F10 render lifecycle | medium | **Taken.** "Rendering…" chip in the workspace → "Render ready · View" toast; phone viewer full screen with a Planner/Render toggle; failed row on phone; **Render again** goes through the confirm, prefilled. |
| F11 loading without thumbnail | medium | **Taken.** Default loading frame has no thumbnail backdrop; a thumbnail is used only when one exists. No progressive reveal. |
| F12 link to a training room | medium | **Taken.** `?room=<name>` that matches a queued/training scan shows its progress card with **Open when ready**, then loads it. "Can't find this room" only for trashed rooms and typos. |
| F13 offline | medium | **Partly taken.** Save failing offline shows a clear state ("Not saved · kakapo isn't answering", Retry) and the changes stay in the open page. Rooms offline shows the last-known list (from this device) greyed with "As of 14:32", actions that need kakapo disabled. **Not taken:** a local save queue that syncs later (the page holds the changes; a sync engine is too much for a one-person tool). |
| F14 first run | medium | **Taken.** No carry-over and no auto-open. With no rooms, the workspace shows the existing plain placeholder room (it costs nothing; v1 already has it) and Rooms shows the A3/A5 empty state with the live scan row; then the normal chip and "ready · Open" toast. |
| F15 touch precision | medium | **Taken, mostly.** The dragged point floats about 40 pt above the finger with a small loupe ring; points land on the floor/scan hit. Keyboard-up state drawn for the two-point distance (card lifted, points visible). **Not taken:** snapping to edges (no edge data in a splat). |
| F16 phone sizes | medium | **Taken.** Dock labels ≥ 12 px, active one in text colour; phone meta 15 px (dimensions at least 13 px in text colour); chips and the training chip get 44 pt hit areas. |
| F17 undo, confirms | low | **Taken.** Removing an item shows "Linen armchair removed · Undo". Revert… confirms on phone too and moves into the sheet's "…" menu. |
| F18 rail moves | low | **Taken.** The rail is pinned; toasts stop short of it. |
| F19 library grid | low | **Taken.** One list layout at every detent. |
| F20 row actions | low | **Taken.** One trailing slot: tapping the row does the default (Open), "…" holds the rest; failed and cancelled rows have their own default. Counts: "3 rooms · 2 scans on kakapo". A long-list frame with sticky section headers. |
| F21 copy | low | **Taken** as listed. |
