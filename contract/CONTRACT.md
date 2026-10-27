# nook contract

The shared spec between the **planner** (`planner/`) and the **furniture pipeline** (`pipeline/`). The only thing they share is the files described here. Conventions (units, axes, item frame, slugs) are in [CLAUDE.md](../CLAUDE.md) and apply everywhere.

Schemas: [library.schema.json](library.schema.json), [layout.schema.json](layout.schema.json), [room.schema.json](room.schema.json), [capture.schema.json](capture.schema.json), [roomplan.schema.json](roomplan.schema.json).

---

## 1. Files on disk

```
library/library.json          furniture library (library.schema.json)
library/<id>/model.glb        normalized mesh, always present
library/<id>/splat.ply        normalized 3DGS splat, optional
library/<id>/thumb.jpg        square thumbnail, optional
library/<id>/source.<ext>     the input image or model, as given
library/<id>/raw/             untouched engine outputs (debugging only, never served)
library/.trash/<id>-<stamp>/  deleted items (§2.8), never served
library/costs.csv             one row per pipeline run: date,id,engine,cost_usd,mock,input
room/room.json                room config of the current room (room.schema.json)
room/<scan>.spz|.ply|...      the scan itself (git-ignored)
room/<scan>.room.json         that room's own config, room/<scan>.jpg its thumbnail (§2.7)
layouts/<name>.json           saved layouts (layout.schema.json)
layouts/<room>/<name>.json    a room's layouts (§2.7)
```

### Normalized assets

Both `model.glb` and `splat.ply` are stored **already in the item frame**: no runtime transform is needed beyond the item's placement.

- **`model.glb`**: axis-aligned bounds have footprint center at x = z = 0 (±1 cm), min y = 0 (±0.5 cm), and size equal to `dims_cm` within **2 % per axis** (X = w, Y = h, Z = d). Materials and textures from the source are preserved.
- **`splat.ply`**: standard 3DGS PLY (`x y z`, `f_dc_0..2`, optional `f_rest_*`, `opacity`, `scale_0..2`, `rot_0..3`). Spark can only scale splats uniformly, so the splat is fitted with a **uniform** scale that matches height. Measured on the 1st–99th percentile of positions (to ignore floaters): height within **5 %** of `dims_cm.h`, min y within ±3 cm of 0, footprint center within 5 cm of the origin. If baking a rotation into a splat that has `f_rest_*`, either rotate the SH bands correctly or drop `f_rest_*`.

---

## 2. Planner

A static web app in `planner/` (three.js `0.180.0` + `@sparkjsdev/spark` `2.4.0` via importmap, no build step) plus `planner/serve.py` (Python stdlib only).

### 2.1 Server

```
python3 planner/serve.py [--port 8765] [--room-file room/room.json] [--layouts-dir layouts]
```

- Serves the **repo root** as static files. `GET /` redirects to `/planner/`.
- `GET /api/room` returns the room file, or `{"version":1,"placeholder":{"w":3.5,"d":4,"h":2.7}}` if it doesn't exist.
- `PUT /api/room` validates the basic shape (an object with `version`) and writes the room file.
- `GET /api/layouts` returns `{"layouts": ["name", ...]}`, sorted.
- `GET /api/layouts/<name>` returns the layout, or `404 {"error": ...}`.
- `PUT /api/layouts/<name>` writes the layout. Responds `400` if `<name>` isn't a slug.
- `--scan-api URL` (optional, v2): reverse-proxy `/api/scan/*` to the nook-scan jobs server at `URL` (§5), streaming request and response bodies, so one origin serves both the web app and the jobs API.
- All `/api` responses are JSON. Static files are served with correct MIME types (`.js` as `text/javascript`, `.wasm`, `.glb`, `.spz`, `.ply`). Cache headers are off so reloads pick up edits.

### 2.2 URL parameters

- `?library=<url>`: library to load (default `/library/library.json`). Asset paths resolve relative to it. A missing library is an empty library, not an error.
- `?room=<name>`: the room to open (§2.7).

### 2.3 Features (MVP)

1. **Room**:
   - Loads the room from `GET /api/room`. With `splat` set, it renders the splat with `transform` applied. Otherwise, or if the splat fails to load, it shows a **placeholder room**: a floor and four walls at `placeholder` size (default 3.5 × 4 × 2.7 m), centered on the origin, open toward the camera or semi-transparent so you can see in.
   - Dragging and dropping a `.spz/.ply/.splat/.ksplat/.sog` file onto the page uses it as the room for this session.
2. **Alignment panel**: edit the room transform:
   - yaw, pitch, roll in degrees; position x/y/z; uniform scale
   - **pick floor**: click a point on the splat, and the transform shifts so that point is at y = 0
   - **two-point scale**: click two points on the splat and enter their real distance in meters; the transform's scale updates to match
   - **Save** writes `PUT /api/room`. Reloading restores it.
3. **Library panel**: lists library items (thumbnail if present, name, W×D×H cm). Clicking an item adds it to the room near the center, on the floor.
4. **Items**:
   - Click (tap) an item to select it. **Dragging the selected item** moves it **on the floor plane only** (y stays 0); a grip on its footprint outline **rotates it around Y only**, as do −15°/+15° buttons. Keyboard: `R` rotates by 15°, `Delete`/`Backspace` removes, `Esc` deselects.
   - The selected item shows a label with its name and W×D×H cm.
   - Each placed item has a `render` of `glb` or `splat`. A toggle switches between them when the item has both assets.
5. **Measure tool**: click two points (on the floor, items or splat) to show a line with its distance in m and cm. `Esc` clears it.
6. **Layouts**: a name field plus Save / Load / a list of saved layouts, backed by the `/api/layouts` endpoints. A layout records the room source, item placements and camera.
7. **Views**:
   - **Orbit**: the default, using OrbitControls.
   - **Seated**: eye height 1.15 m.
   - **Standing**: eye height 1.6 m.
   - Seated and standing are first-person views: WASD/arrow keys to move on the floor (or tap the floor to walk there), drag to look.
8. **Errors**: anything that fails (missing asset, bad file) shows a small non-blocking message in the UI and is pushed to `window.nook.errors`. It never throws an uncaught exception.
9. Usable at 1280 × 800: panels can collapse and don't cover more than about a third of the view. Usable on a phone (390 × 844, touch): panels are bottom sheets, and every action has a touch control (§2.7, P20).

### 2.4 `window.nook` test hook

Exposed on `window.nook` once the module has loaded. Every method that loads something returns a Promise that resolves **after the asset has loaded** (rejects on failure).

```ts
interface Nook {
  ready: Promise<void>                       // initial room + library loaded (placeholder counts)
  errors: string[]                           // see 2.3.8
  getLibrary(): LibraryItem[]                // items from library.json, as-is
  loadRoom(room: RoomConfig): Promise<void>  // same shape as room.schema.json; does not persist
  addItem(id: string, opts?: { position?: [number, number, number], rotation_y_deg?: number, render?: 'glb' | 'splat' }): Promise<string>  // resolves with a new uid
  moveItem(uid: string, opts: { position?: [number, number, number], rotation_y_deg?: number }): void
  removeItem(uid: string): void
  clearItems(): void
  saveLayout(name: string): Promise<void>    // PUT /api/layouts/<name>
  loadLayout(name: string): Promise<void>    // replaces current items (and room if the layout names one)
  listLayouts(): Promise<string[]>
  setView(view: 'orbit' | 'seated' | 'standing'): void
  getState(): {
    room: { kind: 'placeholder' | 'splat', loaded: boolean, splatCount?: number, transform: { position: number[], quaternion: number[], scale: number } },
    items: Array<{ uid: string, id: string, render: 'glb' | 'splat', position: number[], rotation_y_deg: number,
                   worldBounds: { min: number[], max: number[] } }>,  // axis-aligned, world space, meters
    camera: { view: 'orbit' | 'seated' | 'standing', position: number[] }
  }
}
```

`position[1]` is the item's **elevation**: the height of its bottom above the floor, in meters (v4, §2.10; before v4 it was ignored and items always sat on the floor). For `render: 'splat'`, `worldBounds` is computed from splat centers (1st–99th percentile is fine).

### 2.5 Acceptance criteria: planner

- P1. `npm run eval:planner` passes.
- P2. No uncaught exceptions or console errors during normal use with the fixtures.
- P3. A placeholder room renders when there's no splat. The fixture splat room renders when given.
- P4. An added item's `worldBounds` size matches its `dims_cm` within 2 %, with min y = 0 (±1 cm). Rotating 90° swaps the X and Z extents.
- P5. Dragging an item keeps y = 0, and rotation is around Y only.
- P6. Layouts round-trip: positions within 1 mm, rotation within 0.1°.
- P7. Seated and standing views put the camera at 1.15 m and 1.6 m (±1 cm).
- P8. Alignment edits (including pick-floor and two-point scale) persist through `PUT /api/room` (or `PUT /api/rooms/<name>`, §2.7) and survive a reload. Pick floor moves the picked point to y = 0 and, when the floor around it is tilted by 0.3–12°, also levels the scan.
- P9. The measure tool shows the correct distance (e.g. between two placed items' known positions).
- P11–P16: see §2.6. P17–P20: see §2.7.

### 2.6 Realism and "Render this view"

Goal: semi-realistic for $0 in the planner, plus an optional paid photoreal pass of the current view.

**Realism (free, in the planner)**

1. **Tone and color**: ACES Filmic tone mapping, sRGB output. A **Look** control (in the Room & alignment panel) sets `exposure` (0.25–4, default 1) and `warmth` (−1 cool … +1 warm, default 0, a gentle white-balance tint applied to the whole frame). Saved with **Save room** as `look` in the room config (room.schema.json).
2. **Room-lit furniture**: when a splat room is loaded, bake an environment map from the room splat. Render a cube map of the splat (furniture hidden) from a probe point, PMREM it, and set it as `scene.environment`, so GLB furniture is lit by the room's own light. The default probe is the room's center at 1.0 m height. **Relight here** re-bakes from the selected item's position (at 1.0 m). Re-bake automatically after a room loads or its alignment is saved. The placeholder room uses a neutral studio environment (three.js `RoomEnvironment`).
3. **Contact shadows**: every placed item (GLB or splat) gets a soft blob shadow on the floor: a radial-gradient quad slightly larger than its footprint, just above y = 0, which follows the item's position and rotation. It can be toggled.
4. Splat furniture already matches the scan's look. Nothing changes there beyond the contact shadow.

**Render this view (paid, about $0.04)**. The default model is `nano-banana`, picked by a live comparison (evals/golden/RESULTS.md).

5. A **Render** button (top bar) captures the current view (the canvas only, no UI) as a JPEG and asks for confirmation, showing the model and its price. It then `POST`s to `/api/render` and shows the result side by side with the input. A **Renders** panel lists past renders, newest first.
6. The FAL key never reaches the browser. The server makes the fal call.

**Server additions (`planner/serve.py`, still stdlib only)**

```
python3 planner/serve.py ... [--renders-dir renders] [--costs-file library/costs.csv]
```

- `POST /api/render` with body `{ "image": "data:image/jpeg;base64,...", "model"?: "kontext" | "nano-banana" | "qwen", "prompt"?: string, "view"?: string, "layout"?: string }`:
  - Calls fal synchronously (`https://fal.run/<endpoint>`, header `Authorization: Key $FAL_KEY`), passing the image as a data URI. FAL_KEY comes from the environment or `.env`, the same rules as the pipeline (§3.3, including `NOOK_NO_DOTENV`).
  - Saves `<renders>/<name>.jpg` (the result), `<name>-input.jpg` and `<name>.json` (metadata). `<name>` is `render-YYYYMMDD-HHMMSS` (UTC), plus a numeric suffix on collision.
  - Appends a row to the costs file (`date,id,engine,cost_usd,mock,input` with `engine` = `render:<model>` and `input` = the view name).
  - Responds `200 { name, url, input_url, model, cost_usd, mock, prompt, created }`. URLs are site paths, e.g. `/renders/<name>.jpg`; renders are served statically.
  - Errors: `400` for a bad or missing image or unknown model, `503 {"error": "FAL_KEY not set: add FAL_KEY=... to nook/.env"}` when there's no key (outside mock mode), and `502 {"error": ...}` when fal fails. No cost row is written on failure before fal returns.
- `GET /api/renders` responds `{ "renders": [metadata, ...] }`, newest first.
- **Mock**: with `NOOK_FAL_MOCK` set, there are no network calls. The "result" is a copy of the input, `mock: true` and `cost_usd: 0`.

| model | fal endpoint | arguments | cost recorded |
|---|---|---|---|
| `kontext` | `fal-ai/flux-pro/kontext` | `image_url`, `prompt`, `output_format: "jpeg"` | $0.04 |
| `nano-banana` (default) | `fal-ai/nano-banana/edit` | `image_urls: [image]`, `prompt`, `output_format: "jpeg"` | $0.0398 |
| `qwen` | `fal-ai/qwen-image-edit` | `image_url`, `prompt`, `output_format: "jpeg"` | $0.03 × megapixels of the input |

Default prompt: *"Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, soft natural daylight, subtle contact shadows. Do not add, remove or move anything."*

**Hook additions (`window.nook`)**

```ts
getRenderSettings(): { toneMapping: 'aces', exposure: number, warmth: number, envSource: 'splat' | 'neutral', contactShadows: boolean, shadowCount: number }
setRenderSettings(s: Partial<{ exposure: number, warmth: number, contactShadows: boolean }>): void   // live; persisted only via Save room
relight(position?: [number, number, number]): Promise<void>   // re-bake the environment; resolves when the new map is applied
renderView(opts?: { model?: string, prompt?: string }): Promise<RenderMeta>   // no confirmation dialog when called from the hook
listRenders(): Promise<RenderMeta[]>
```

`shadowCount` is the number of contact shadows in the scene: it equals the number of placed items when shadows are on, and 0 when they're off.

**Acceptance criteria**

- P11. Tone mapping is ACES. Exposure and warmth change the image live, and `look` round-trips through Save room and a reload.
- P12. With a splat room, `relight()` resolves and `envSource` is `'splat'`. With the placeholder, it's `'neutral'`. A GLB item under a splat room is visibly lit by the room's colors, not flat grey.
- P13. Every placed item has a contact shadow that follows it when moved or rotated. Toggling them off sets `shadowCount` to 0.
- P14. In mock mode, `renderView()` writes the jpg/input/json files, appends a mock cost row, and returns a URL that serves the image. The render shows up in `listRenders()` and in the Renders panel.
- P15. Without a key (and not in mock mode), `/api/render` returns 503 with the FAL_KEY message, and the UI shows it as a toast.
- P16. Performance: with the fixture splat room and 3 items, orbiting stays interactive. Baking happens only on load, on save, or when asked, never per frame.
- P10. A missing or corrupt asset shows an error message and the rest of the app keeps working.

### 2.7 Rooms (planner v2)

The planner knows every trained scan, not just the last one. A **room** is one scan file in the room dir plus its own config, layouts and thumbnail. Everything here is additive: `room.json`, `GET/PUT /api/room`, the flat `layouts/` and every v1 call keep working.

**Files** (in `--room-dir`, default the repo's `room/`, served as `/room/`):

```
<room-dir>/room.json             the current room (newest scan), as before (§4.6)
<room-dir>/<name>.spz | .ply     a room's scan; <name> is a slug. .spz wins when both exist
<room-dir>/<name>.room.json      that room's config (room.schema.json): alignment, look, viewpoints, title
<room-dir>/<name>.jpg            its thumbnail (made by the planner), optional
<room-dir>/.trash/<name>-<UTC stamp>/   deleted rooms, all of their files (never removed by the tools)
layouts/<room>/<layout>.json     a room's layouts (layout.schema.json, with room_name)
layouts/<layout>.json            v1 layouts (no room), still listed and loadable
```

**A room's config** is, first match wins: `<name>.room.json`; else `room.json` when its `splat` is this room's file (the server then copies it to `<name>.room.json`, so a later scan repointing `room.json` can't lose it); else `{version: 1, splat: <path of the scan>}` (identity transform). `room.schema.json` gains `title` (free text, set by rename; the file name never changes) and `saved` (ISO time of the last Save room from the planner).

**Server** (`planner/serve.py`, stdlib only):

| Method and path | Response |
|---|---|
| `GET /api/rooms` | `200 {"rooms": [room, ...], "current": "<name>" \| null}`, newest first. `current` is the room `room.json` points at. |
| `GET /api/rooms/<name>` | `200` the room's config (as above, with `splat` set), or `404`. |
| `PUT /api/rooms/<name>` | Body: a room config. Writes `<name>.room.json` (`splat` forced to the room's file, `saved` stamped unless only `title` changed, so a rename doesn't mark the room aligned). When `room.json` points at this room, it's updated too. `404` for an unknown room. |
| `PUT /api/rooms/<name>/thumb` | Body: `{"image": "data:image/jpeg;base64,..."}` (≤ 2 MB). Writes `<name>.jpg`. |
| `DELETE /api/rooms/<name>` | Moves all of the room's files (scan, config, thumbnail, `layouts/<name>/`) to `.trash/`. If `room.json` pointed at it, `room.json` is repointed at the newest remaining room (its config), or removed when none is left. `200 {"ok": true, "trash": "<dir>"}`. |
| `GET /api/layouts?room=<name>` | `200 {"layouts": ["name", ...], "details": [{"name", "items", "updated", "legacy"}]}`: the room's layouts, plus v1 layouts whose `room.splat` is this room's scan (`legacy: true`). |
| `GET/PUT /api/layouts/<layout>?room=<name>` | Reads or writes `layouts/<name>/<layout>.json` (GET falls back to a v1 layout). PUT sets `room_name`. |
| `DELETE /api/layouts/<layout>?room=<name>` | Removes the room's layout (`404` if it isn't there). v1 layouts aren't deleted. |

The room object in `GET /api/rooms`:

```json
{ "name": "scan-20261026-093654", "title": "Reading room, morning" | null,
  "splat": "room/scan-20261026-093654.spz", "created": "<ISO-8601 UTC, the scan file's mtime>",
  "size_bytes": 61234567, "thumb_url": "/room/scan-20261026-093654.jpg" | null,
  "aligned": true, "layouts": 3, "current": true }
```

`aligned` is true when the room has a `saved` time. Training numbers (splats, seconds, steps, quality) and the status of scans still in progress come from the jobs API (§5, `/api/scan/jobs` through `--scan-api`), matched to rooms by `name`. Without `--scan-api` the planner shows rooms only.

**Planner:**
- `?room=<name>` opens that room. Without it the planner opens the room last opened on this device, if it still exists; otherwise it loads `GET /api/room` as in v1 (the current room, or the placeholder). A room whose name is in neither (`?room` naming a deleted room) shows an error with a way back to the rooms list.
- Layouts, alignment, look and the thumbnail belong to the open room. Saving the room writes `PUT /api/rooms/<name>`; layouts use `?room=<name>`. The placeholder room (and a dropped file) use the v1 endpoints.
- Opening a room for the first time saves a thumbnail of the default view.
- Jobs: queued, training, failed and cancelled scans are listed with the rooms; a training job shows live progress (poll `/api/scan/jobs` about every 5 s while one is active, every 60 s otherwise); a job turning `done` offers to open the new room.

**Hook additions (`window.nook`)**

```ts
listRooms(): Promise<Room[]>                 // GET /api/rooms
openRoom(name: string): Promise<void>        // loads the room, its config and layouts; resolves when the scan has loaded
getState().room.name: string | null          // the open room, null for the placeholder or a dropped file
saveRoom(): Promise<void>                    // Save room: PUT /api/rooms/<name>, or PUT /api/room when no named room is open
```

**Acceptance**
- P17. With three rooms in the room dir, `listRooms()` returns them newest first, `openRoom()` loads each, and saving the alignment of one leaves the others' configs unchanged.
- P18. A layout saved in room A isn't listed in room B; a v1 layout still loads.
- P19. A `room.json` from before v2 (no per-room files) opens with its alignment and viewpoints intact.
- P20. Usable at 390 × 844 with touch only: every action reachable, targets ≥ 44 px.

**v4 additions (§2.7)**
- The room object in `GET /api/rooms` gains:
  - `roomplan_url`: `/room/<name>.roomplan.json` when the room has a measured shell (§4.12), else null
  - `capture`: the name of the kept capture it was trained from (§5, captures), or null when that capture isn't kept
  - `parent`: the room it was retrained from, or null
- `<name>.room.json` gains `parent` (room.schema.json). A retrain writes it (§5).
- The trainer copies a capture's `roomplan.json` / `roomplan.usdz` next to the scan as `<name>.roomplan.json` / `<name>.roomplan.usdz`. Deleting a room moves them to `.trash/` with the rest.
- **The planner groups rooms by base name:** `<base>-r<N>` rooms are listed under `<base>` (newest first), with the base room itself as one of them. **Retrain** on a room whose `capture` is null explains "this capture isn't kept, upload again to retrain" (in the retrain sheet, not as a note on every room in the list).
- **Measured shell (v4 scope):** with `roomplan_url`, the planner offers a see-through shell toggle (walls, floor, doors and windows drawn from `roomplan.json`, in the room's transform) and shows a wall's length when it's tapped. Auto-align and snapping are v4.1.

**Hook additions (v4)**

```ts
getState().room.roomplan: boolean            // the open room has a measured shell
setShell(visible: boolean): void             // see-through shell on or off
getState().shell: boolean
```

- P21. A room with `roomplan_url` shows the shell when `setShell(true)` is called; tapping a wall shows its length in cm, matching `roomplan.json` within 1 cm.
- P22. `-rN` rooms are grouped under their base in the rooms list.

### 2.8 Library API (`planner/serve.py`, v4)

Library writes go to the existing `--library-dir` (default the repo's `library/`). `serve.py` gains `--nook-add CMD` (default `uv run --project pipeline nook-add`; the Nix package passes its own binary) and runs it with `--library <library-dir>`. The spend cap (§2.9) reads and writes `--costs-file`. Everything is JSON except the upload body.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/library` | | `200` the `library.json` (with an empty `items` when there's none), plus `"trash": [{id, name, deleted}]` |
| `POST /api/library/items` | **Raw body** (no multipart: `cgi` is gone from Python 3.13), `Content-Length` required. Headers: `X-Nook-Kind: model \| image`, `X-Nook-Filename: <name.ext>`, `X-Nook-Meta: <base64 of JSON meta>` | `202 {job, cost_usd_estimate}` |
| `POST /api/library/items/from-url` | JSON `{image_url, ...meta}` | `202 {job, cost_usd_estimate}` |
| `GET /api/library/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/library/jobs/<id>` | | `200` the job object itself (not wrapped), or `404` |
| `PATCH /api/library/items/<id>` | JSON, any of `name`, `category`, `mount`, `yaw` (0/90/180/270, relative to now), `default_render` (`glb` \| `splat`, only if that asset exists), `dims_cm` | `200` the item, or `202 {job}` when `dims_cm` or `yaw` changed |
| `DELETE /api/library/items/<id>` | | `200 {"ok": true}`: the item's entry and folder move to `library/.trash/<id>-<UTC stamp>/` |
| `POST /api/library/items/<id>/restore` | | `200` the item (the newest trashed copy), `404` when none, `409` when an item with that id exists again |

**Meta** (both add routes): `name` (required), `dims_cm` `{w,d,h}` (required), `id` (default: slug of `name`), `category`, `mount` (`floor` \| `wall`, §2.10), `yaw`, `engine` (`sam3d` \| `trellis2` for images; forced to `glb` for models), `prompt`, `resolution`. `400` with one actionable sentence for anything else wrong (a non-slug id, missing dims, unknown engine).

**Bodies:**
- `model`: a `.glb`, or a `.zip` holding one `.obj` with its `.mtl` and textures. `.gltf` with side files: zip it with an `.obj`, or convert it to `.glb` first (the message says so). `.usdz`: "convert to GLB first".
- `image`: a JPEG, PNG, HEIC or WebP file (a photo from the phone).

**Limits:** models 200 MB, images 20 MB (`413` beyond, `411` without a length). Zips: only `.obj .mtl .png .jpg .jpeg` files are extracted, nothing else; no absolute paths, no `..`, no links; at most 500 MB unpacked and 1,000 entries (`400` otherwise). Uploads land in a private temp folder, never under a served path.

**Jobs:** one queue, one job at a time. Each runs `nook-add` on a local file (never a URL, see §2.9). The job object:

```json
{ "id": "l-20261027-101500-ab12", "kind": "add | rescale", "item_id": "eames-ottoman",
  "status": "queued | running | done | failed", "engine": "sam3d",
  "cost_usd_estimate": 0.02, "cost_usd": null, "mock": false,
  "created": "<ISO-8601 UTC>", "started": null, "finished": null,
  "message": "human-readable status line", "item": null }
```

When `done`, `item` is the library entry and `cost_usd` what was recorded. A failed job's `message` is `nook-add`'s stderr line. An id that already exists is replaced (upsert, as `nook-add`), and the job's message says so.

**Editing:** `PATCH` changes `name`, `category` and `default_render` in place. A changed `dims_cm` or `yaw` runs `nook-add --rescale <id>` (§3.1) as a job: it refits the item's normalized assets, with no model call and $0.

**Missing items:** a layout that places a deleted item still loads. Layout items carry the item's `dims_cm` (layout.schema.json, v4) so this works. The planner shows a "missing item" placeholder box at its dims (from the layout, or 50 cm cubed) and keeps it in the layout until removed. Restoring the item replaces the placeholder on reload.

**One writer:** every write to the library (`nook-add`, PATCH, DELETE, restore) takes `<library>/.lock` (`flock`), so the server and a `nook-add` run by hand never interleave. PATCH, DELETE and restore wait up to 60 s for a running job, then answer `503 {"error": "library is busy: …"}`. Library jobs live in memory; a restart forgets them (the items they made stay). `library.json` writes stay atomic.

**What `/library/` serves:** item assets only (`<id>/model.glb`, `splat.ply`, `thumb.jpg`, `source.<ext>`) and `library.json`. `raw/`, `.trash/`, `.lock` and `costs.csv` get `404`. Responses carry `X-Content-Type-Options: nosniff`.

**Hook additions (v4)**

```ts
libraryJobs(): Promise<LibraryJob[]>                         // GET /api/library/jobs
addItemFromFile(file: File, meta: Meta): Promise<LibraryJob> // POST /api/library/items
addItemFromUrl(url: string, meta: Meta): Promise<LibraryJob>
editLibraryItem(id: string, patch: object): Promise<Item | LibraryJob>
removeLibraryItem(id: string): Promise<void>       // removeItem(uid) still removes a placed item
restoreLibraryItem(id: string): Promise<Item>
```

**Acceptance**
- L8. In mock mode (`NOOK_FAL_MOCK`), a `.glb` upload, an OBJ zip upload, a photo upload and a from-URL add each end in a `done` job and a library that passes `evals/validate_library.py`.
- L9. Delete, then restore, round-trips the item byte for byte. A layout placing a deleted item loads with a placeholder.
- L10. A zip with `../x`, an absolute path, a symlink or a `.exe` is refused with `400` and nothing is written.
- L11. `PATCH dims_cm` refits within §1's tolerances at $0.

### 2.9 Mutating requests and money (v4)

These rules apply to every `POST`, `PUT`, `PATCH` and `DELETE` that `planner/serve.py` answers or proxies, including `/api/render`, the rooms and layouts routes, and `/api/scan/*`.

**Forged requests:** a mutating request needs the header `X-Nook: 1`, and an `Origin` header that's either absent or equal to the page's own origin (`http(s)://` + the request's `Host`). Anything else gets `403 {"error": "cross-site request refused"}`. The planner sends the header on every mutation, and so does the iOS app's upload (`nook-scan serve` checks it too, since the app talks to it through the planner's origin).

**Host names (against DNS rebinding):** every request, reads included, must carry a `Host` that is a loopback name (`127.0.0.1`, `localhost`, `[::1]`, any port) or one given with `--allowed-host NAME` (repeatable; the NixOS module's `allowedHosts`, e.g. `nook.salehtl.com`). Anything else gets `403 {"error": "unknown host name: add it with --allowed-host"}` before any other handling. `nook-scan serve` applies the same rule (its own `--allowed-host`; the planner's proxy talks to it on loopback).

**Paths:** static paths are normalized (percent-decoding, `.` and `..` segments) **before** any rule about what is served, so `/./library/costs.csv` or `/planner/../library/raw/…` get the same `404` as the plain path.

**Spend cap:**
- `serve.py --daily-spend-usd N` (default `2`). It's a server flag only; no route changes it.
- It covers every paid call: library adds and `/api/render`.
- Before a paid call, the server **reserves** the estimate against today's (UTC) total from `costs.csv`, atomically within the server (one mutex; the library lock is held by `nook-add` for its whole run, so it can't be used here). A `nook-add` run by hand isn't reserved. A request that would cross the cap gets `402 {"error": "today's fal budget ($2.00) is used up: $1.98 spent", "spent_usd", "cap_usd"}` and no call is made. A failed call releases its reservation; a successful one records the actual cost.
- `GET /api/spend` returns `{"day": "YYYY-MM-DD", "spent_usd", "reserved_usd", "cap_usd"}` so the page can show the remaining budget.
- Mock calls cost $0 and count for nothing.
- `costs.csv` is `<library-dir>/costs.csv` by default (`--costs-file` overrides it; when `--library-dir` is also given and the two differ, the server refuses to start, since `nook-add` writes `<library-dir>/costs.csv`. Evals that pass only `--costs-file`, to keep render rows out of the repo, are fine). Cost rows are appended under their own small lock, `costs.csv.lock` (`flock`), taken by the server and by `nook-add`, never the library lock, so a render never waits for a running add.
- A paid job killed at its timeout keeps its reservation for the rest of the day (fal may have charged), and its job says so.

**URL fetches (the from-URL add):**
- `serve.py` downloads the image **itself**, to a temp file, and passes that file to `nook-add`. `nook-add` never fetches URLs when called by the server.
- `http` and `https` only. The host is resolved once and the connection goes to that IP (pinned). Every redirect (at most 3) is resolved and checked again.
- Refused addresses: `0.0.0.0/8`, `127.0.0.0/8`, `::1`, `::`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `fc00::/7`, `fe80::/10`, multicast, and the IPv4-mapped forms of all of these. `400 {"error": "that address is on a private network"}`.
- The response must have an `image/*` content type and be at most 20 MB. An HTML page gets `400 {"error": "that's a web page: paste the image's own link (right-click the image, Copy Image Address)"}`.
- 20 s timeout overall.
- `NOOK_FETCH_ALLOW=<host>:<port>` (evals only, never set by the Nix module) exempts exactly that one host and port, so evals can serve an image from `127.0.0.1`. Every other private address is still refused.

**Acceptance**
- W1. A mutating request without `X-Nook: 1`, or with a foreign `Origin`, gets `403` on every route above and changes nothing.
- W2. With `--daily-spend-usd 0.03` and fal mocked as paid (`NOOK_FAL_MOCK_COST=1`, which makes mock runs record their real price), the second $0.02 add is refused with `402` and no call is made.
- W3. From-URL adds of `http://127.0.0.1/…`, `http://[::ffff:127.0.0.1]/…`, `http://169.254.169.254/…`, a redirect to a private address, and `file:///etc/passwd` are all refused without a connection to the private address.
- W4. `GET /library/costs.csv`, `/library/.trash/…` and `/library/<id>/raw/…` return `404`.

### 2.10 Raising items and hanging them on walls (v4)

Paintings, shelves, mirrors and wall lamps need to sit above the floor and against a wall.

**Elevation:**
- A placed item's `position[1]` is the height of its bottom (the item frame's y = 0) above the floor, from 0 to 4 m (clamped). Layouts already store `position` as `[x, y, z]`; v1 layouts have y = 0 and load unchanged.
- **Desktop:** with an item selected, `Shift`+drag (or `PageUp` / `PageDown`, 1 cm, with `Shift` 10 cm) moves it up and down; plain drag still moves it on its own horizontal plane.
- **Phone:** the selected item's panel gains an **Up / Down** control: a vertical drag handle plus `+`/`−` buttons (1 cm per tap, held repeats) and the height in cm, editable.
- The inspector shows the height above the floor. A raised item drops its floor contact shadow (when its bottom is more than 2 cm up) and keeps a faint vertical guide line to the floor while it's selected, so you can see where it is.
- **Drop to floor** puts it back at y = 0.

**Hang on a wall:**
- **Hang on wall** (inspector, or long-press on phone), then a tap on a wall, places the selected item with its **back** (the item's −Z face) against the wall, its front (+Z) facing into the room, and its center at the tapped point:
  - with a measured shell (§2.7, `roomplan_url`): the wall plane from `roomplan.json` gives the exact position and yaw;
  - without one: the tap's hit on the splat gives the point, and the yaw is set so the front faces the camera, snapped to the nearest 15°. The item is pushed back so its back sits at the hit point.
- After hanging, the item stays a normal item: drag moves it **along the wall** (keeping its distance from it) until it's dropped to the floor or hung somewhere else. `mounted: "wall"` is stored on the layout item while it's hung.
- **Library default:** an item may carry `mount: "wall"` (library.schema.json; `nook-add --mount wall`, and the §2.8 meta). Adding such an item starts it in hang mode, at a center height of 1.45 m if placed without a wall tap.

**Hook additions (v4)**

```ts
addItem(id, opts?: { position?: [x, y, z], ... })     // y is the elevation now
moveItem(uid, opts: { position?: [x, y, z], ... })    // y honored, clamped to 0..4
hangItem(uid: string, at: { point: [x, y, z], normal: [x, y, z] }): void   // back against the plane through point with that normal
selectItem(uid: string | null): void                 // as a tap on the item; null clears the selection
getState().items[i].mounted: 'floor' | 'wall'
```

- P23. `moveItem(uid, {position: [x, 1.2, z]})` round-trips through Save and load with y within 1 mm, and `worldBounds.min[1]` is 1.2 ± 0.01.
- P24. `hangItem` with a wall normal of `[0, 0, 1]` gives `rotation_y_deg` 0 and the item's min z at the wall's z ± 1 cm; with `[-1, 0, 0]`, `rotation_y_deg` −90 (or 270).
- P25. At 390 × 844, the Up / Down control raises a selected item by 10 cm in 10 taps.

**Test handles (v4):** the controls evals press carry `data-nook` attributes: `elev-up`, `elev-down`, `elev-value` (§2.10), `hang` (Hang on wall), `drop` (Drop to floor), `shell` (§2.7 shell toggle), `lib-add`, `lib-remove`, `lib-undo` (§2.8), `retrain`, `retrain-go`, `retrain-advanced` (§5.1). A placeholder for a missing item has `data-nook="missing-item"` in its inspector.

---

## 3. Pipeline

A uv project in `pipeline/` (Python 3.12) exposing the console script `nook-add`.

### 3.1 CLI

```
uv run --project pipeline nook-add INPUT --name NAME --dims WxDxH
    [--id SLUG] [--category TEXT] [--engine sam3d|trellis2|glb] [--prompt TEXT]
    [--yaw 0|90|180|270] [--resolution 512|1024|1536] [--library DIR] [--notes TEXT] [--mount floor|wall]
```

- `INPUT`: a local image path or an image URL (`sam3d`, `trellis2`), or a local/URL `.glb`/`.gltf` (`glb`). A `.usdz` input should fail with a clear message ("convert to GLB first") unless conversion is implemented.
- `--dims`: centimeters, `W x D x H`. Accepts `x` or `×`, spaces allowed, decimals allowed. Required.
- `--id`: defaults to a slug of `--name`. Re-running with an existing id **replaces** that item (upsert), and the CLI says so.
- `--engine`: defaults to `sam3d`. `--prompt` defaults to `--category` or else `"furniture"`, and is only used by `sam3d`.
- `--yaw`: extra rotation around Y, applied after the engine's default orientation, to make the front face +Z. Positive is counterclockwise seen from above (right-handed about +Y), so `--yaw 90` turns +X into −Z. The planner's `rotation_y_deg` uses the same sign.
- `--resolution`: `trellis2` only, default `512`.
- `--library`: library directory, default `library` (relative to the repo root). Created if missing.
- Exit code 0 on success. The **last line of stdout** is a single JSON object: `{"id", "engine", "cost_usd", "mock", "paths": {...}, "fit": {"glb_error_pct": {"w","d","h"}, "splat_error_pct": {...} | null}}`.
- Every failure exits non-zero with **one actionable line on stderr**, e.g. `FAL_KEY not set: add FAL_KEY=... to nook/.env`, or `--dims must look like 75x80x95 (cm)`.

### 3.2 Engines

| `--engine` | fal endpoint | Arguments sent | Cost recorded |
|---|---|---|---|
| `sam3d` | `fal-ai/sam-3/3d-objects` | `image_url`, `prompt`, `export_textured_glb: true` | $0.02 |
| `trellis2` | `fal-ai/trellis-2` | `image_url`, `resolution` | $0.25 / $0.30 / $0.35 for 512 / 1024 / 1536 |
| `glb` | none | n/a | $0.00 |

- Local images are uploaded with `fal_client.upload_file`.
- `sam3d` produces both `model.glb` (from `model_glb`, or the first of `individual_glbs`) and `splat.ply` (from `gaussian_splat`, or the first of `individual_splats`). `trellis2` and `glb` produce `model.glb` only.
- The engines' native orientation and frames are documented in `fixtures/fal/NOTES.md` (measured from a real capture). The SAM 3D splat arrives in camera space and must be mapped into its GLB's frame using `metadata[0]` before normalization.

### 3.3 Credentials and mock mode

- Reads `FAL_KEY` from the environment, otherwise from `.env` at the repo root. Set `NOOK_NO_DOTENV=1` to skip `.env` (used by evals).
- **`NOOK_FAL_MOCK=<dir>`**: no network calls to fal at all. Upload returns a fake URL. Each call returns `<dir>/<slug>/response.json`, where slug is `sam-3-3d-objects` or `trellis-2`. Every file URL in the response is resolved to `<dir>/<slug>/files/<basename of the URL path>` and copied rather than downloaded. Mock runs record `mock: true` and `cost_usd: 0`. `FAL_KEY` isn't required in mock mode.

### 3.4 Normalization (both GLB and splat)

1. Apply the engine's default orientation (from `fixtures/fal/NOTES.md`) so the result is Y-up, then apply `--yaw`.
2. Translate so the footprint center is at x = z = 0 and min y = 0.
3. Scale:
   - **GLB**: per axis, to exactly `dims_cm`.
   - **Splat**: uniformly, to match height (see §1).
4. Write the results into the item frame (see §1). Keep the original engine outputs in `raw/`.
5. **Self-check**: after writing, run the §1 checks. On failure, exit non-zero and say which check failed and by how much. Don't upsert a bad item.

### 3.5 Library entry

The pipeline upserts into `library.json` (see `library.schema.json`): `id`, `name`, `category`, `dims_cm`, `assets` (relative paths), `default_render` (`splat` if a splat exists, else `glb`), `source` (`engine`, `input`, `prompt`, `cost_usd`, `mock`, `created` as an ISO-8601 UTC timestamp), and `fit` (the per-axis errors). It then appends a row to `costs.csv`. Writes are atomic (write to a temp file, then rename).

A thumbnail is made from the input image (center crop, 256 × 256 JPEG). For `glb` input, it's skipped.

### 3.6 Acceptance criteria: pipeline

- L1. `npm run eval:pipeline` passes.
- L2. Every library it writes passes `evals/validate_library.py`.
- L3. Upsert: running the same id twice leaves exactly one entry, and the CLI reports the replacement.
- L4. Bad input (missing or malformed `--dims`, unknown engine, missing file, `.usdz`, no `FAL_KEY` outside mock) fails with a non-zero exit and one actionable stderr line, leaving the library untouched.
- L5. GLB textures and materials survive normalization (an input with images still has images).
- L6. Mock mode makes zero network requests.
- L7. `--yaw 90` rotates the result 90° around Y (so W and D of the source are swapped before fitting).

**v4 additions**
- `--engine glb` also accepts a `.zip` holding one `.obj` with its `.mtl` and textures. It's converted to GLB (materials and textures kept, L5) and then normalized as usual. The zip rules of §2.8 apply.
- `nook-add --rescale <id> [--dims WxDxH] [--yaw 0|90|180|270]`: refits an existing item from its normalized assets: no engine, no model call, `cost_usd: 0`, no new cost row. Without `--dims`, the item's dims are kept. `--yaw` is relative to the item's current orientation. Same self-check and last-line JSON as an add.
- `--library DIR` is honored for every read and write, including the lock (`<library>/.lock`, §2.8), which `nook-add` takes for the whole run.
- **Mock mode** accepts a local image (as well as a URL), so the from-URL flow is tested at $0: `serve.py` downloads, then `nook-add` gets a local file.
- `NOOK_FAL_MOCK_COST=1` (evals only): mock runs record the engine's real price, so the spend cap can be tested without spending.
- L12. `npm run eval:library` (`evals/library_api.sh`) passes.

---

## 4. nook-scan: capture format (iOS app → Mac trainer)

The only thing `ios/` (the capture app) and `scan/` (the trainer) share. Plan: [docs/plans/nook-scan.md](../docs/plans/nook-scan.md). Schema: [capture.schema.json](capture.schema.json).

### 4.1 Layout

A capture is a folder named `scan-YYYYMMDD-HHMMSS`, shared as a `.zip` whose single top-level entry is that folder:

```
scan-20261025-153000/
  transforms.json     cameras + frames (Nerfstudio-compatible)
  meta.json           capture metadata
  images/000001.jpg   keyframes: JPEG, quality ≥ 0.85, long side ≤ 1920 px, sensor orientation (landscape, as ARKit delivers it)
  depth/000001.png    optional, LiDAR only: 16-bit grayscale PNG, millimeters, 0 = no data, at depth resolution (e.g. 256 × 192)
  points.ply          optional: seed points in world space (x y z float, red green blue uchar), binary_little_endian or ascii
```

### 4.2 World and cameras

- **World**: ARKit world space with gravity alignment: meters, **+Y up**, right-handed, origin wherever the session started (usually the phone's starting position, so the floor sits at about y = −1.2 … −1.5).
- `transform_matrix` is **camera-to-world**, 4 × 4, row-major nested arrays, in the **OpenGL camera convention**: +X right, +Y up, and the camera looks along −Z. That's exactly ARKit's `ARCamera.transform` and three.js's `camera.matrixWorld`, so no axis flip is needed.
- Intrinsics `fl_x, fl_y, cx, cy` are in pixels for the stored image size `w × h`. They're top-level for a single camera, and a frame may override them. `camera_model` is `"OPENCV"` with no distortion terms (ARKit images are treated as undistorted).
- Depth intrinsics are the image intrinsics scaled by `depth_w / w` and `depth_h / h`.

### 4.3 transforms.json

```json
{
  "camera_model": "OPENCV",
  "fl_x": 1440.2, "fl_y": 1440.2, "cx": 960.1, "cy": 719.6, "w": 1920, "h": 1440,
  "ply_file_path": "points.ply",
  "frames": [
    { "file_path": "images/000001.jpg", "depth_file_path": "depth/000001.png",
      "transform_matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]], "timestamp": 12.345 }
  ]
}
```

### 4.4 meta.json

`{ "version": 1, "app": "nook-scan", "app_version": "0.1.0", "device": "iPhone17,1", "lidar": true, "world": "arkit-gravity-y-up-meters", "created": "<ISO-8601 UTC>", "frame_count": 212, "floor_y": -1.32 | null }`.

`floor_y` is the height of the lowest large horizontal ARKit plane (the floor) if one was detected, otherwise null.

### 4.5 Validity (what `evals/validate_capture.py` and `nook-scan check` enforce)

- `transforms.json` and `meta.json` match the schema. `meta.frame_count` equals the number of frames, and there are at least 30.
- Every referenced file exists, with a relative path that stays inside the capture. Image size equals `w × h` (or the frame's override).
- Every `transform_matrix` is finite. Its rotation part is orthonormal (‖RᵀR − I‖ < 1e-3, det ≈ +1), and its bottom row is `[0,0,0,1]`.
- Camera positions span at least 0.5 m (a capture taken standing still can't be trained).

### 4.6 Trainer CLI (`scan/`, uv project, console script `nook-scan`)

```
uv run --project scan nook-scan check <capture.zip|dir>
uv run --project scan nook-scan train <capture.zip|dir> [--name scan] [--room-dir room] [--steps N] [--holdout-every N] [--max-image-size 1280]
```

- `train` writes `<room-dir>/<name>.ply`, a standard 3DGS PLY (the §1 property set) **in capture world coordinates**. It's cropped (floaters outside the captured volume are removed) but not moved. Alongside it goes `<name>.spz` (v2), the same splats in Niantic's compact format (about 5× smaller, renders identically in Spark). `room.json` points the planner at the `.spz`.
- It then writes or updates `<room-dir>/room.json` (room.schema.json): `splat` is the path of the SPZ relative to the repo root (or to `<room-dir>`'s parent when outside the repo), and `transform` is `position [0, −floor_y, 0]`, `quaternion [0,0,0,1]`, `scale 1`. Other existing keys, such as `look` and `placeholder`, are kept. The same config is also written to `<room-dir>/<name>.room.json` (§2.7), so the room keeps its alignment after a later scan repoints `room.json`.
  - `floor_y` comes from `meta.floor_y`. Otherwise it's estimated from seed or depth points (a low percentile of the y values of near-horizontal dense regions).
- `--holdout-every N` (default 0) excludes frames with `index % N == 0` from training, so that evals can score them.
- The last stdout line is JSON: `{ "name", "ply", "room_json", "splats", "floor_y", "steps", "seconds", "trainer": "<name and version>" }`.
- Failures exit non-zero with one actionable stderr line (no traceback), and write nothing into `<room-dir>`.

### 4.7 Acceptance: nook-scan

- S1. `bash evals/scan_offline.sh` passes. On the synthetic ground-truth capture (`fixtures/make_capture.mjs`), it trains in under 15 minutes on kakapo's RTX 2060 with default steps (the eval trains there over ssh and checks here; see evals/remote.sh). The PLY renders at **mean PSNR ≥ 26 dB on held-out frames, and at least 4 dB above the untrained seed-point baseline** (`evals/seed_splat.py`, which scores about 21 dB on the fixture). Both are judged by `evals/psnr_judge.mjs`, which renders with Spark, the floor lands at 0 ± 5 cm, and room.json validates.
- S2. Bad captures fail cleanly: missing files, a NaN pose, too few frames, a static camera, or a zip with no top-level folder.
- I1. `bash evals/ios_build.sh` passes:
  - XcodeGen generates the project.
  - The app builds for the simulator and for a generic iOS device (unsigned).
  - The unit tests pass.
  - The capture written by the replay test (`ReplayCaptureTests.testReplayWritesValidCapture`, to `<tmp>/nook-eval-capture/`) passes `validate_capture.py` with at least 20 frames.
- I2. The app launches in the simulator with no crash and shows the captures list. Replay mode can produce a capture that appears in the list and can be shared.
- I3. Release basics:
  - bundle id `com.salehtl.nookscan`, team `8CFG28JHP3`, automatic signing
  - version 0.4.0 in v4 (the build number is set at release)
  - `NSCameraUsageDescription`, `ITSAppUsesNonExemptEncryption = NO`, `UIRequiredDeviceCapabilities` containing `arkit`
  - a 1024 px app icon
  - deployment target iOS 18.0

### 4.8 Capture v1.1 additions (all optional, v1 captures stay valid)

- `meta.json`:
  - `"exposure_locked": bool` and `"white_balance_locked": bool`: whether the app locked them for the whole capture. The app locks both once tracking has been `normal` for about 1 s. Keyframes are only kept after the locks are in place.
  - `"lock_iso"`, `"lock_exposure_duration"` (s), and `"lock_white_balance_gains": {"r","g","b"}`: the locked values, for reference.
- Each frame may carry `"exposure_duration"` (s) and `"exposure_offset"` (EV) from `ARCamera`.
- **Guided passes:** each frame may carry `"pass": 1 | 2 | 3`:
  1. loop at chest height
  2. lower loop, phone tilted down
  3. walk through the middle

  The trainer ignores the pass number. It's only for diagnostics.

### 4.9 Trainer v2

- `--quality draft|high` (default `high`):
  - `draft` is the v1 behavior: 10k steps at `--max-image-size 1280`.
  - `high` uses more steps and full resolution, with values set in `scan/` and tuned on a real capture (eval Q1).
  - Explicit `--steps`, `--max-image-size` and `--max-splats` override the preset.
- `room.json` gains **`viewpoints`** (room.schema.json): up to 24 real camera poses from the capture, chosen spread out along the walking path and at least 1.0 m above the floor. They're in **room coordinates**, with the room transform already applied: `{ "position": [x,y,z], "quaternion": [x,y,z,w], "fov_y_deg": n }`. The camera looks along its local −Z, as in three.js.
- Trains on **kakapo only** (Linux x86_64, NVIDIA, CUDA) with **gsplat**, through the `nook-gsplat` executable (`gsplat/nook_gsplat.py`, packaged in `nix/nook-gsplat.nix`; `NOOK_GSPLAT_BIN` overrides it). Brush, the earlier Metal/Vulkan trainer, was retired on 2026-10-26: gsplat gave the same held-out quality on the real scan in half the time (16 vs 33 min) and two thirds of the VRAM. The Mac no longer trains.

**Acceptance**
- **Q1.** `bash evals/scan_quality.sh` passes when the real capture is present (it's skipped, not failed, when absent). It trains `--quality high` with `--holdout-every 10`, and the Spark-judged held-out mean must be **≥ 22.3 dB**, which is the 20.8 dB baseline + 1.5. It must finish in under 40 minutes on kakapo.

### 4.9.1 Trainer v3: settings scaled to the capture (v4)

The v2 preset trains every capture for the same number of steps, so a 1,200-frame scan comes out undertrained. v3 scales them.

**Scaled settings** (`--quality high`, the default):
- `steps = clamp(k × n_train, 20,000, 120,000)`, where `n_train` is the number of training frames (after `--holdout-every`). `k = 60` steps per frame for now; phase 0a of the v4 plan sets it.
- `train_max_splats`: a constant per GPU class (`scan/src/nook_scan/gpu.py`), never computed from free VRAM, so `--dry-run` gives the same answer on any machine. For now: 2,000,000 on a 6–10 GB card (kakapo's RTX 2060), 3,000,000 above 10 GB.
- High-resolution stills (§4.10) train at `stills_max_size` (default: the same as `max_image_size`, 1920; 0a decides whether 2880 pays off). Video frames stay at `max_image_size`.
- `deliver_max_splats` (default 1,500,000): after cropping, splats beyond this are pruned, lowest `opacity × volume` first, before the room's SPZ and PLY are written. The planner and phones load the delivered room. `--keep-full-ply` also writes the unpruned crop as `<name>.full.ply`.
- `--quality draft` stays as v1 (10k steps, 1280 px). Explicit flags beat both presets.

**Flags** (each maps 1:1 to a retrain setting, §5):

| Setting (`settings` key) | Flag | Range |
|---|---|---|
| `steps` | `--steps` | 1,000–200,000 |
| `train_max_splats` | `--max-splats` | 100,000–4,000,000 |
| `deliver_max_splats` | `--deliver-max-splats` | 100,000–4,000,000 (and ≤ `train_max_splats`) |
| `max_image_size` | `--max-image-size` | 640–3840 |
| `stills_max_size` | `--stills-max-size` | 640–4032 |
| `sh_degree` | `--sh-degree` | 0–3 |
| `pose_opt` | `--pose-opt` (a real flag now, not `NOOK_GSPLAT_ARGS`) | bool |
| `holdout_every` | `--holdout-every` | 0 or 2–50 |

`--refine-poses` (`nook-poses`) stays as a CLI flag but isn't offered as a setting: it didn't help.

- `nook-scan train CAPTURE --dry-run` prints the resolved settings as JSON (`{"n_train", "settings": {...}, "eta_s"}`) and exits without training. `eta_s` uses `gpu.py`'s measured speed (seconds per 1,000 steps per million splats on this GPU class, set from 0a).
- The trainer's last-line JSON gains `"settings"` (what actually ran) and `"delivered_splats"`.
- `meta.roomplan` captures (§4.12): `roomplan.json` and `roomplan.usdz` are copied into the room dir as `<name>.roomplan.json` / `.usdz`, with `world_from_roomplan` applied and the room transform **not** applied (the planner applies it, like the splat).

**Acceptance**
- **Q1 (v4).** Replaces the v2 Q1. `bash evals/scan_quality.sh` trains the real capture with the scaled defaults and `--holdout-every 10`. The Spark-judged held-out mean must be **≥ 22.3 dB**, the delivered room at most 1,500,000 splats, and the run within 1.25 × its own `eta_s`.
- **Q2.** `nook-scan train --dry-run` on scan-20261027-112322 prints the same settings on the Mac and on kakapo.

---

## 5. Processing server API (`nook-scan serve`)

A job server that trains captures on the machine it runs on: kakapo in production, the Mac in evals. **Python stdlib only.** It listens on `127.0.0.1`, and remote access comes only through `tailscale serve`.

```
uv run --project scan nook-scan serve [--host 127.0.0.1] [--port 8095] [--data-dir DIR] [--room-dir DIR] [--steps N] [--quality draft|high] [--max-splats N]
```

- `--data-dir` (default `~/.nook-scan`): uploads, job state (`jobs.json`), logs.
- `--room-dir`: where trained rooms go (`<room-dir>/<name>.ply`, plus `room.json` updated as in §4.6). It's the folder the web app serves as `/room/`.
- `--steps`, `--quality` and `--max-splats` are passed to every training run (evals use tiny step counts). v4: `--quality` applies to uploads only; a retrain always starts from the scaled `high` settings, so it matches `/defaults`, and its own `settings` win over `--steps` and `--max-splats`.

All endpoints are under `/api/scan`, and everything is JSON except the upload body. Errors return `{"error": "<one actionable sentence>"}` with a 4xx/5xx status.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/scan/health` | | `200 {"ok": true, "version": "<nook-scan version>", "trainer": "<name version>", "gpu": "<name or null>", "busy": bool, "queued": n}` |
| `POST /api/scan/captures` | Body: the capture `.zip` as produced by the app (contract §4.1), `Content-Type: application/zip`, `Content-Length` required. Optional header `X-Nook-Name: <slug>` for the room name (default: derived from the capture folder). | `202 {job}` for a new job. If a job for the same capture folder name already exists and isn't `failed` or `cancelled`, it's **idempotent**: `200 {job}` with that existing job. Errors: `400` for an invalid zip or capture (the message comes from `nook-scan check`), `411` with no length, `413` over 4 GB. The upload is fully on disk and validated before the response. |
| `GET /api/scan/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/scan/jobs/<id>` | | `200 {job}` or `404` |
| `POST /api/scan/jobs/<id>/cancel` | | `200 {job}` (status becomes `cancelled`, and a running trainer is stopped), or `409` if already finished |

The job object:

```json
{
  "id": "j-20261026-101500-ab12",
  "capture": "scan-20261026-093654",
  "name": "scan-20261026-093654",
  "status": "queued | training | done | failed | cancelled",
  "stage": "waiting | preparing | building trainer | training | finishing | done",
  "progress": 0.0,
  "step": 0, "total_steps": 30000,
  "eta_s": null,
  "created": "<ISO-8601 UTC>", "started": null, "finished": null,
  "message": "human-readable status line",
  "result": null
}
```

When `done`, `result` is the trainer's JSON summary (§4.6) plus `"room_url": "/planner/?room=<name>"` (§2.7), `"ply_url": "/room/<name>.ply"` and `"spz_url": "/room/<name>.spz"`. These are site paths on the same origin the app talked to.

- **One job at a time** (one GPU). The queue is FIFO.
- **Restarts:** job state persists in `jobs.json`. On restart, a job that was running becomes `failed` with the message "server restarted during training: retrain from the planner" (v4, §5.1), and queued jobs stay queued.
- `progress` is between 0 and 1 and only goes up for a running job. The server updates it from the trainer's `step X/Y` lines at least every 5 s.

**Acceptance**
- **A1.** `bash evals/server_api.sh` passes.
- **A2.** `evals/mock_scan_server.py` and the real server answer the same requests with the same shapes. The iOS integration test passes against both.

### 5.1 Captures and retraining (v4)

**Keeping captures:**
- An upload is **kept** as `<data-dir>/captures/<capture>.zip` from the moment it's accepted, whatever its job's outcome (`done`, `failed`, `cancelled`, or interrupted by a restart). Nothing deletes it but `DELETE /api/scan/captures/<name>`.
- A job running at restart becomes `failed` with "server restarted during training: retrain from the planner".
- Re-uploading a capture: the upload dedupe (§5) applies only to jobs of `kind: "upload"`, as before, but the zip is **always** saved as the kept capture (replacing any kept one), even when the answer is the existing job. So "upload again to retrain" works for rooms whose capture wasn't kept.

**Routes:**

| Method and path | Request | Response |
|---|---|---|
| `GET /api/scan/captures` | | `200 {"captures": [{"name", "size_bytes", "created", "rooms": ["<room>", ...], "roomplan": bool}]}`, newest first. `rooms` are the rooms trained from it. |
| `DELETE /api/scan/captures/<name>` | | `200 {"ok": true}`; `409` while a job for it is queued or training. Its rooms stay. |
| `GET /api/scan/captures/<name>/defaults` | | `200 {"n_train", "settings": {...}, "eta_s"}`: the scaled settings (§4.9.1) for this capture, for `holdout_every: 0` |
| `POST /api/scan/captures/<name>/retrain` | JSON `{"settings"?: {...}, "title"?: "<text>"}`, every `settings` key from §4.9.1 optional | `202 {job}`. `400` for an unknown key or a value out of range (the message names it), `404` for an unknown capture |

**Jobs** gain `"kind": "upload" | "retrain"`, `"parent": "<room>" | null` (the room a retrain starts from) and `"settings"` (resolved when the job starts: what actually ran). `GET /api/scan/jobs` lists both kinds.

**Naming a retrain:**
- The parent is the newest room trained from that capture **that still exists** in the room dir (a room deleted in the planner can't be a parent). Its base is its name with any `-r\d+` suffix removed. When no room was ever trained from it (its upload failed or was cancelled), `parent` is null and the base is the upload job's room name.
- The new room is `<base>-r<N>`, where N is 1 + the highest N among existing rooms and queued jobs with that base (so `scan-x` → `scan-x-r1`, then `scan-x-r2`; retraining `scan-x-r1` gives `scan-x-r3` if `-r2` exists).
- The base is truncated so the name stays within the 64-character slug limit.
- `title` (optional) becomes the new room's `title`, never its name, so it can't collide.

**The new room:**
- `<new>.room.json` starts as a copy of the parent's `transform` and `look` (it's the same capture, so the same world frame), with `parent` set, `saved` copied (it is aligned), and its own viewpoints.
- Its layouts start empty. The planner offers to copy the parent's layouts when the room is first opened.
- It doesn't become `current` (`room.json` stays put) unless it's opened.
- Its thumbnail is made by the planner, as for any room.

**Planner (retrain sheet):** **Retrain** on a room whose `capture` is kept opens a sheet with the defaults and time estimate (`/defaults`) and one button; **Advanced** shows every §4.9.1 setting with a plain hint (e.g. "Training splats: more detail, more GPU memory and time"). Hook:

```ts
retrainDefaults(room: string): Promise<{n_train, settings, eta_s}>        // the room's capture's /defaults
retrainRoom(room: string, settings?: object, title?: string): Promise<Job> // POST .../retrain; the job shows with the rooms
```

- P26. `retrainRoom()` on a room with a kept capture adds a queued `<base>-rN` job to the rooms list; on a room with `capture: null` it rejects with the "upload again" message.

**Proxy:** `planner/serve.py --scan-api` proxies every method under `/api/scan`, including `DELETE` and the `X-Nook` header (§2.9).

**GPU lock:** the service's worker holds `/run/nook/gpu.lock` (`flock`, the NixOS module's `RuntimeDirectory`) while training. `evals/remote.sh` takes the same lock, so an eval and a real job never share the card. `--gpu-lock PATH` sets it (default: none, as in evals on the Mac).

**Acceptance**
- **A3.** `bash evals/server_api.sh` covers: a finished job keeps its capture; a restart keeps it; retrain naming (`-r1`, `-r2`, a 64-character base); parent copy; the dedupe applying only to uploads; `DELETE` refused while training; bad settings refused with the key named.
- **A4.** `evals/mock_scan_server.py` answers the §5.1 routes with the same shapes (A2 parity).

### 4.10 Capture v1.2: high-resolution stills (optional)

- A frame may carry a high-resolution still taken at the same moment as its video frame (ARKit `captureHighResolutionFrame`):
  - `"hires_file_path": "images_hi/000001.jpg"`: JPEG, quality ≥ 0.9, sensor orientation
  - `"hires_w"`, `"hires_h"`: its size
  - `"hires_fl_x"`, `"hires_fl_y"`, `"hires_cx"`, `"hires_cy"`: its intrinsics
  - The pose is the frame's `transform_matrix`.
- It's taken under the same exposure and white-balance lock as the video frames.
- `meta.json` adds `"keyframe_spacing": {"meters": 0.04, "degrees": 3}`.
- The trainer uses the still in place of the video frame when one is present, downscaled to the quality preset's long side.

### 4.11 Pose refinement (`nook-poses`, kakapo)

- `nook-poses CAPTURE_DIR --out TRANSFORMS.json [--max-frames N]`:
  - Estimates camera poses from the images with a learned model (VGGT or MASt3R), using the ARKit poses as a prior and for metric scale.
  - Writes a `transforms.json` with the same frames, intrinsics and keys, in the same ARKit world frame (gravity-up, metric, same origin), with refined `transform_matrix` values.
  - The last stdout line is JSON: `{"frames", "shift_cm_median", "shift_cm_max", "rot_deg_median", "seconds"}`.
- It runs on kakapo's RTX 2060 (6 GB): chunking or downscaling as needed.
- `nook-scan train --refine-poses` runs it on the prepared dataset before training.

### 4.12 Capture v1.3: RoomPlan (optional, v4)

A measured shell of the room from Apple's RoomPlan, next to the splat, not in place of it. Only on phones with LiDAR; other phones never write it. Captures without it stay valid.

**Files** (at the capture's top level):
- `roomplan.json` ([roomplan.schema.json](roomplan.schema.json)): `{"version": 1, "walls": [...], "floors": [...], "doors": [...], "windows": [...], "openings": [...], "objects": [...]}`. Each surface is `{"id", "dimensions": [w, h, d] (m), "transform": 4×4 row-major, "confidence": "low" | "medium" | "high"}`; doors, windows and openings add `"parent"` (a wall id); objects add `"category"` (RoomPlan's category name). The transform maps the element's local frame (centered, width along local X, height along local Y) to the frame named below.
- `roomplan.usdz`: RoomPlan's own export, for viewing only. Nothing reads it.

**Frame:**
- `meta.roomplan`: `{"version": "<RoomPlan / iOS version>", "sessions": "shared" | "separate"}`.
- `shared`: RoomPlan ran on the app's own ARKit session, so every transform is already in the `transforms.json` world.
- `separate`: RoomPlan ran its own session. `roomplan.json` then carries `"world_from_roomplan"` (4×4, row-major), solved by the app by matching RoomPlan's floor and walls to the capture's ARKit floor and vertical wall planes (gravity-aligned, so only yaw and a shift are solved). Readers apply it; `roomplan.json` is never assumed to be in the capture frame without it.
- `world_from_roomplan` is required when `sessions` is `separate`, and absent when `shared`.

**Validity** (added to §4.5): when `meta.roomplan` is present, `roomplan.json` exists and matches the schema; every matrix is finite with an orthonormal rotation; at least one wall and one floor.

**Acceptance**
- I4. The replay test writes a v1.3 capture from the RoomPlan fixture (`fixtures/roomplan/`) that passes `validate_capture.py`. Phones without LiDAR show no RoomPlan option.
