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
- `--scan-api URL` (optional, v2): reverse-proxy `/api/scan/*` to the nook-scan jobs server at `URL` (§5), streaming request and response bodies, so one origin serves both the web app and the jobs API.
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
- P11–P16: see §2.6.

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

- `train` writes `<room-dir>/<name>.ply`, a standard 3DGS PLY (the §1 property set) **in capture world coordinates**. It's cropped (floaters outside the captured volume are removed) but not moved.
- It then writes or updates `<room-dir>/room.json` (room.schema.json): `splat` is the path of the PLY relative to the repo root (or to `<room-dir>`'s parent when outside the repo), and `transform` is `position [0, −floor_y, 0]`, `quaternion [0,0,0,1]`, `scale 1`. Other existing keys, such as `look` and `placeholder`, are kept.
  - `floor_y` comes from `meta.floor_y`. Otherwise it's estimated from seed or depth points (a low percentile of the y values of near-horizontal dense regions).
- `--holdout-every N` (default 0) excludes frames with `index % N == 0` from training, so that evals can score them.
- The last stdout line is JSON: `{ "name", "ply", "room_json", "splats", "floor_y", "steps", "seconds", "trainer": "<name and version>" }`.
- Failures exit non-zero with one actionable stderr line (no traceback), and write nothing into `<room-dir>`.

### 4.7 Acceptance: nook-scan

- S1. `bash evals/scan_offline.sh` passes. On the synthetic ground-truth capture (`fixtures/make_capture.mjs`), it trains in under 15 minutes on the M3 Max with default steps. The PLY renders at **mean PSNR ≥ 26 dB on held-out frames, and at least 4 dB above the untrained seed-point baseline** (`evals/seed_splat.py`, which scores about 21 dB on the fixture). Both are judged by `evals/psnr_judge.mjs`, which renders with Spark, the floor lands at 0 ± 5 cm, and room.json validates.
- S2. Bad captures fail cleanly: missing files, a NaN pose, too few frames, a static camera, or a zip with no top-level folder.
- I1. `bash evals/ios_build.sh` passes:
  - XcodeGen generates the project.
  - The app builds for the simulator and for a generic iOS device (unsigned).
  - The unit tests pass.
  - The capture written by the replay test (`ReplayCaptureTests.testReplayWritesValidCapture`, to `<tmp>/nook-eval-capture/`) passes `validate_capture.py` with at least 20 frames.
- I2. The app launches in the simulator with no crash and shows the captures list. Replay mode can produce a capture that appears in the list and can be shared.
- I3. Release basics:
  - bundle id `com.salehtl.nookscan`, team `8CFG28JHP3`, automatic signing
  - version 0.1.0 (build 1)
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
- Works on macOS (Metal) and on Linux with an NVIDIA GPU (Vulkan). On Linux the Vulkan driver is found through `VK_ICD_FILENAMES`, or `/run/opengl-driver/share/vulkan/icd.d` on NixOS.

**Acceptance**
- **Q1.** `bash evals/scan_quality.sh` passes when the real capture is present (it's skipped, not failed, when absent). It trains `--quality high` with `--holdout-every 10`, and the Spark-judged held-out mean must be **≥ 22.3 dB**, which is the 20.8 dB baseline + 1.5. It must finish in under 40 minutes on the M3 Max.

---

## 5. Processing server API (`nook-scan serve`)

A job server that trains captures on the machine it runs on: kakapo in production, the Mac in evals. **Python stdlib only.** It listens on `127.0.0.1`, and remote access comes only through `tailscale serve`.

```
uv run --project scan nook-scan serve [--host 127.0.0.1] [--port 8095] [--data-dir DIR] [--room-dir DIR] [--steps N] [--quality draft|high] [--max-splats N]
```

- `--data-dir` (default `~/.nook-scan`): uploads, job state (`jobs.json`), logs.
- `--room-dir`: where trained rooms go (`<room-dir>/<name>.ply`, plus `room.json` updated as in §4.6). It's the folder the web app serves as `/room/`.
- `--steps`, `--quality` and `--max-splats` are passed to every training run (evals use tiny step counts).

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

When `done`, `result` is the trainer's JSON summary (§4.6) plus `"room_url": "/planner/"` and `"ply_url": "/room/<name>.ply"`. These are site paths on the same origin the app talked to.

- **One job at a time** (one GPU). The queue is FIFO.
- **Restarts:** job state persists in `jobs.json`. On restart, a job that was running becomes `failed` with the message "server restarted during training: upload again", and queued jobs stay queued.
- `progress` is between 0 and 1 and only goes up for a running job. The server updates it from the trainer's `step X/Y` lines at least every 5 s.

**Acceptance**
- **A1.** `bash evals/server_api.sh` passes.
- **A2.** `evals/mock_scan_server.py` and the real server answer the same requests with the same shapes. The iOS integration test passes against both.
