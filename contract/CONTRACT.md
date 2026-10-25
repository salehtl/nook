# nook contract

The shared spec between the **planner** (`planner/`) and the **furniture pipeline** (`pipeline/`). The only thing they share is the files described here. Conventions (units, axes, item frame, slugs) are in [CLAUDE.md](../CLAUDE.md) and apply everywhere.

Schemas: [library.schema.json](library.schema.json), [layout.schema.json](layout.schema.json), [room.schema.json](room.schema.json).

---

## 1. Files on disk

```
library/library.json          furniture library (library.schema.json)
library/<id>/model.glb        normalized mesh, always present
library/<id>/splat.ply        normalized 3DGS splat, optional
library/<id>/thumb.jpg        square thumbnail, optional
library/<id>/source.<ext>     the input image or model, as given
library/<id>/raw/             untouched engine outputs (debugging only)
library/costs.csv             one row per pipeline run: date,id,engine,cost_usd,mock,input
room/room.json                room config (room.schema.json)
room/<scan>.spz|.ply|...      the scan itself (git-ignored)
layouts/<name>.json           saved layouts (layout.schema.json)
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
- All `/api` responses are JSON. Static files are served with correct MIME types (`.js` as `text/javascript`, `.wasm`, `.glb`, `.spz`, `.ply`). Cache headers are off so reloads pick up edits.

### 2.2 URL parameters

- `?library=<url>`: library to load (default `/library/library.json`). Asset paths resolve relative to it. A missing library is an empty library, not an error.

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
   - Click an item to select it. A transform gizmo **moves on the floor plane only** (y stays 0) and **rotates around Y only**. Keyboard: `R` rotates by 15°, `Delete`/`Backspace` removes, `Esc` deselects.
   - The selected item shows a label with its name and W×D×H cm.
   - Each placed item has a `render` of `glb` or `splat`. A toggle switches between them when the item has both assets.
5. **Measure tool**: click two points (on the floor, items or splat) to show a line with its distance in m and cm. `Esc` clears it.
6. **Layouts**: a name field plus Save / Load / a list of saved layouts, backed by the `/api/layouts` endpoints. A layout records the room source, item placements and camera.
7. **Views**:
   - **Orbit**: the default, using OrbitControls.
   - **Seated**: eye height 1.15 m.
   - **Standing**: eye height 1.6 m.
   - Seated and standing are first-person views: WASD/arrow keys to move on the floor, drag to look.
8. **Errors**: anything that fails (missing asset, bad file) shows a small non-blocking message in the UI and is pushed to `window.nook.errors`. It never throws an uncaught exception.
9. Usable at 1280 × 800: panels can collapse and don't cover more than about a third of the view.

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

`position[1]` passed to `addItem` / `moveItem` is ignored: items always sit on the floor (y = 0). For `render: 'splat'`, `worldBounds` is computed from splat centers (1st–99th percentile is fine).

### 2.5 Acceptance criteria: planner

- P1. `npm run eval:planner` passes.
- P2. No uncaught exceptions or console errors during normal use with the fixtures.
- P3. A placeholder room renders when there's no splat. The fixture splat room renders when given.
- P4. An added item's `worldBounds` size matches its `dims_cm` within 2 %, with min y = 0 (±1 cm). Rotating 90° swaps the X and Z extents.
- P5. Gizmo dragging keeps y = 0, and rotation is around Y only.
- P6. Layouts round-trip: positions within 1 mm, rotation within 0.1°.
- P7. Seated and standing views put the camera at 1.15 m and 1.6 m (±1 cm).
- P8. Alignment edits (including pick-floor and two-point scale) persist through `PUT /api/room` and survive a reload.
- P9. The measure tool shows the correct distance (e.g. between two placed items' known positions).
- P10. A missing or corrupt asset shows an error message and the rest of the app keeps working.

---

## 3. Pipeline

A uv project in `pipeline/` (Python 3.12) exposing the console script `nook-add`.

### 3.1 CLI

```
uv run --project pipeline nook-add INPUT --name NAME --dims WxDxH
    [--id SLUG] [--category TEXT] [--engine sam3d|trellis2|glb] [--prompt TEXT]
    [--yaw 0|90|180|270] [--resolution 512|1024|1536] [--library DIR] [--notes TEXT]
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
- The engines' native orientation and frames are documented in `fixtures/fal/NOTES.md`. Until a real capture replaces them, the fixtures are synthetic and the frames are assumptions, so keep each engine's orientation in one obvious place in the code.

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
