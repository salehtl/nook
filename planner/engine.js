// nook planner engine: renderer, scene, room, items, tools, views and the API calls. No DOM UI lives here:
// UI modules (planner/ui/) read state through getters, call actions, and listen to `engine.events`.
// Spec: contract/CONTRACT.md §2. Units are meters, Y-up, floor at y = 0. Items are stored in their item frame.
//
// Setup (main.js): engine.mount(el) puts the canvas in `el`; engine.init() opens the room (§2.7: ?room=<name>, else the
// last room opened on this device, else /api/room as in v1), then loads library, layouts and renders.
// Input: planner/input.js (installInput(engine), set up by main.js as engine.input) owns the pointer/keyboard handlers
// and drives the actions below; a UI can turn them off (engine.input.enabled.pointer/keyboard) or add a key filter.
// Selection has no gizmo in the scene: the UI draws the footprint, label and rotate grip from getFootprint(), and
// the selected item moves by dragging it (beginItemDrag / dragTo / endItemDrag; the grip: beginRotateDrag).
//
// Rooms (§2.7): a named room uses /api/rooms/<name> (config, thumb) and /api/layouts?room=<name>. The placeholder, a
// dropped file or a server without /api/rooms (the hosted build) use the v1 endpoints. Opening another room clears
// the placed items.
//
// State getters
//   getRoomName()          the open room's name, or null (placeholder, dropped file, unnamed config)
//   getMissingRoom()       the ?room=<name> that isn't a room (deleted, typo or still training), else null
//   getRoomsApi()          true / false (no /api/rooms: v1 server or hosted build) / null (not asked yet)
//   getRoomsList()         rooms from the last GET /api/rooms (contract §2.7 room objects)
//   getRoomLoad()          { loading, progress: 0–1|null, label } while a scan downloads
//   getRoomSize()          { w, d, h } meters: the scan's 1–99 % world box, or the placeholder size
//   getRoomBox()           { min, max } that box in world space (m), for the Check room dimension lines
//   getFloorTilt()         degrees the room transform tilts the floor (pitch/roll), 0 when level
//   getGridVisible()       50 cm floor grid shown
//   isRoomDirty() / isLayoutDirty() / getDirty() { room, layout }   unsaved alignment/look; items changed since load/save
//   getRoomConfig()        working room config (room.schema.json, normalized; live object, don't mutate)
//   getSavedRoomConfig()   last config read from or written to the server
//   getRoom()              { kind: 'placeholder'|'splat', loaded, failed, error, splatCount, lod, dropped: fileName|null, name }
//                          lod: 'off' | 'building' | 'on', the room splat's level of detail (see buildRoomLod)
//                          error (after a failed load): { kind: 'missing'|'offline'|'bad', file, message }
//   getEyeHeight()         1.15 / 1.6 m in seated / standing, null in orbit
//   getRoomStatus()        status line text ("placeholder 3.5 × 4 × 2.7 m", "loading …", …)
//   getRoomEuler()         { yaw, pitch, roll } degrees, the display decomposition of the room quaternion
//   getItems()             [{ uid, id, name, lib, render, hasGlb, hasSplat, position ([x, elevation, z]), rotation_y_deg,
//                            mounted: 'floor'|'wall', missing (a placeholder box for a piece the library lost, §2.8) }]
//   getItem(uid)           one of the above, or null
//   getItemBounds(uid)     { min, max } world AABB (m), or null
//   getSelected()          selected uid or null;   getDrag() { mode: 'move'|'rotate', uid } while dragging, else null
//   getFootprint(uid)      { corners: [front-left, front-right, back-right, back-left] on the floor, center, box: 8
//                          corners, height } world m (the item's front faces +Z);   hitItemAt(uid, x, y, padPx = 16)
//   getView()              'orbit'|'seated'|'standing'
//   getViewpoints()        { index, count } scan viewpoints (contract §4.9)
//   getMeasure()           { a, b, meters } or null;   getMeasureState() { active, points };   getMeasurePoints() [[x,y,z]…]
//   getPick()              { mode: null|'floor'|'two', points, measured: meters|null, pointList: [[x,y,z]…],
//                            floor: { point, moveCm, tiltDeg, level } | null }  (alignment picks; floor = the preview)
//   getLook()              { exposure, warmth, contactShadows, envSource, envProbe, roomKind }
//   getLibrary()           library.json items, as-is;   assetUrl(rel) resolves a library asset path
//   getLayouts()           saved layout names (last refresh);   getLayoutName() current layout name
//   getLayoutDetails()     [{ name, items?, updated?, legacy? }] (details only from a rooms server)
//   getRenders()           render metadata, newest first;   isRenderMock()
//   getShell()             { available, loaded, visible, walls: [{ id, lengthCm, heightCm }], selected: { id, a, b, lengthCm } | null }
//   getHang()              { uid } while Hang on wall waits for a wall tap, else null;   getElevation(uid) m
//   getState() / getRenderSettings()   the window.nook shapes (contract §2.4, §2.6, §2.7)
//   errors                 string[] of every reported error (window.nook.errors)
//   canvas, three: { scene, camera, renderer, orbit }   for overlays and advanced input
//
// Actions (async ones return Promises that reject with a reported error)
//   init(), mount(el), setViewInset(leftPx, bottomPx = 0, topPx = 0)   (keep the view centred in the uncovered part)
//   listRoomsInternal() (GET /api/rooms → rooms, [] without the API), openRoom(name) (resolves when the scan has loaded),
//   cancelRoomLoad() (stop a scan download: the room open before comes back, phase 'cancelled'), retryRoom(),
//   saveThumbnail(name?) (capture the view, PUT /api/rooms/<name>/thumb), setRoomTitle(title) (after a rename; not dirty)
//   loadRoomInternal(cfg, {fileBytes, fileName, frame, name}), loadScanPath(path), dropScanFile(file),
//   saveRoom() (PUT /api/rooms/<name>, or /api/room without a name), revertRoom(), frameRoom(),
//   setRoomEuler({yaw,pitch,roll}), setRoomPosition(i, v), setRoomScale(v), setPlaceholderSize(key, v), setGridVisible(on)
//   addItemInternal(id, opts), moveItemInternal(uid, opts), removeItemInternal(uid), clearItemsInternal(),
//   toggleRender(uid, 'glb'|'splat'), select(uid|null), rotateSelected(deg), setSnap(on) (Shift: lift drags, 15° grip)
//   beginItemDrag(uid, x, y, { lift }) / beginRotateDrag(uid, x, y) → bool, dragTo(x, y, { snapTo }), endItemDrag()
//   removeItemWithUndo(uid) → snapshot, restoreItem(snapshot) (same uid, place, turn, render; selects it)
//   §2.10: setElevation(uid, m), nudgeElevation(uid, dm), dropToFloor(uid), hangItem(uid, { point, normal }),
//   startHang(uid?) / cancelHang() (the next tap hangs it), wallAt(x, y) → { point, normal, source } | null
//   §2.7 v4: setShell(on), selectWall(id|null);   reloadLibrary() (after a library change, §2.8)
//   setViewInternal(view), gotoViewpoint(i, { glide }), stepViewpoint(+1|-1, { glide }), lookBy(dxPx, dyPx),
//   setMove({forward, side, fast}), walkTo(x, y) (first person: glide to the floor there, chalk target)
//   tap(clientX, clientY) (pick / measure / select, or walk in first person, at a screen point)
//   setMeasureActive(on), clearMeasure(), setMeasurePointAt(i, x, y), pointAt(x, y, 'any'|'scan')
//   startPickMode('floor'|'two'), cancelPickMode(); floor: previewFloorAt(x, y) (a tap does it), applyPickFloor()
//   (levels the scan around the point when it tilts there, then puts the point at y = 0); two: setPickPointAt(i, x, y),
//   resetTwoPoints(), applyTwoPointScale(meters)
//   setLook({exposure, warmth}), setTrueColor(on), setContactShadows(on), relightInternal(pos|null)
//   saveLayoutInternal(name), loadLayoutInternal(name), deleteLayoutInternal(name) (room layouts only),
//   listLayoutsInternal(), refreshLayouts(), setLayoutName(name)
//   captureView({maxPx, aspect, quality}), postRender(shot, model, prompt), renderViewInternal(opts), listRendersInternal(), idle()
//   reportError(msg, err) → Error, toast(text, kind, ms)
// Overlay hooks
//   onFrame(fn) → unsubscribe; fn(dt) runs every frame after rendering
//   worldToScreen(vec3 | [x,y,z]) → { x, y, visible } in CSS px (client coordinates)
//
// Events (engine.events, an EventTarget of CustomEvents; read e.detail)
//   'room'      { phase: 'loading'|'loaded'|'failed'|'cancelled'|'changed'|'edit'|'missing'|'saved'|'title', name }
//               ('edit': a field-level transform edit; 'missing': ?room=<name> isn't a room)
//   'room-progress' { name, loaded, total, progress }   scan download progress (bytes)
//   'rooms'     { rooms }                      after GET /api/rooms
//   'thumb'     { name, url }                  a thumbnail was saved
//   'dirty'     { room, layout }               unsaved state changed
//   'grid'      { visible }
//   'status'    { text }                       room status line
//   'items'     { change: 'add'|'remove'|'move'|'render', uid }
//   'hang'      { active, uid, hung?, source? }        Hang on wall started / ended (hung: it was placed)
//   'shell'     getShell()                             the measured shell loaded, shown, hidden or a wall tapped
//   'selection' { uid, gizmoMode }
//   'drag'      { mode: 'move'|'rotate', uid, phase: 'start'|'end' }
//   'view'      { view };   'viewpoint' { index, count };   'walk' { to }
//   'measure'   { active, points, meters|null }
//   'pick'      { …getPick(), phase: 'start'|'point'|'ready'|'preview'|'applied'|'cancel' }
//   'render'    { phase: 'start'|'done'|'failed', model, meta? }   a paid render in flight
//   'look'      getLook()
//   'library'   { items }
//   'layouts'   { names?, details?, name? }     names (+ details) after a refresh; name after save/load
//   'renders'   { renders }
//   'error'     { text }                        also pushed to errors
//   'toast'     { text, kind: 'info'|'ok'|'error', ms }
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
export const VIEWS = ['orbit', 'seated', 'standing']
const EYE = { seated: 1.15, standing: 1.6 }
export const DEFAULT_PLACEHOLDER = { w: 3.5, d: 4, h: 2.7 }
export const SPLAT_EXT = /\.(spz|ply|splat|ksplat|sog)$/i
const DEG = Math.PI / 180

const params = new URLSearchParams(location.search)
export const LIBRARY_URL = params.get('library') || '/library/library.json'
const libraryBase = new URL(LIBRARY_URL, location.href)

export const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)))
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const fmtCm = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
export const dimsText = (d) => (d ? `${fmtCm(d.w)} × ${fmtCm(d.d)} × ${fmtCm(d.h)} cm` : '')
export const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }
// Fire-and-forget wrapper for UI handlers: failures are already reported, never thrown.
export const quiet = (p) => { Promise.resolve(p).catch(() => {}) }
// §2.9: every POST, PUT, PATCH and DELETE the page makes carries X-Nook: 1 (the server refuses it otherwise).
export function withNook(opts = {}) {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(opts?.method || 'GET')) return opts
  return { ...opts, headers: { ...(opts.headers || {}), 'X-Nook': '1' } }
}
export const MAX_ELEVATION = 4 // m (§2.10)
const clampElev = (y) => Math.min(MAX_ELEVATION, Math.max(0, y))

// --- events, errors + toasts ------------------------------------------------
const events = new EventTarget()
const emit = (name, detail = {}) => { wake(); events.dispatchEvent(new CustomEvent(name, { detail })) }
// On-demand rendering: draw while something changes (camera, input, any engine event) and for a short tail after,
// so Spark's async sort settles. A still phone stops drawing, which saves battery and heat.
let awakeUntil = 0
function wake(ms = 1500) { awakeUntil = Math.max(awakeUntil, performance.now() + ms) }
for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'keyup', 'resize', 'touchmove']) window.addEventListener(t, () => wake(), { passive: true, capture: true })
const errors = []
function toast(text, kind = 'info', ms = 6000) { emit('toast', { text, kind, ms }) }
function reportError(msg, err) {
  const detail = err ? (err.message || String(err)) : ''
  const text = detail && !msg.includes(detail) ? `${msg}: ${detail}` : msg
  errors.push(text)
  emit('error', { text })
  console.warn('[nook]', text)
  return new Error(text)
}
window.addEventListener('error', (e) => { if (e.error || e.message) reportError(`Unexpected error: ${e.message}`) })
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  reportError('Unexpected error', e.reason)
})

// --- three.js scene ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
const canvas = renderer.domElement

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1b1d21)
// lodRaycast: 0 stops Spark's second, coarse LoD traversal for raycasts: room picks test every splat (hitRoomSplat).
// lodRenderScale: 0.5 keeps splats down to half a pixel: at the default 1.0 a real room lost 8-10 % of its Laplacian
// variance at 1280 × 800, at 0.5 under 0.5 %. The splat budget still caps what's drawn.
// onDirty: an LoD selection or sort that lands after the wake tail still gets drawn (one frame, not a new tail).
// sortRadial: false orders splats by camera depth, as gsplat does in training. Spark's default radial order cost 2.4 dB
// against the photos on a real room (evals/psnr_judge.mjs). maxPixelRadius 2048: gsplat doesn't clamp either (+0.36 dB);
// phones keep Spark's default, because large splats near the camera add fill cost that nobody has measured there.
const spark = new SparkRenderer({
  renderer, lodRaycast: 0, lodRenderScale: 0.5, onDirty: () => wake(50), sortRadial: false,
  ...(/iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? {} : { maxPixelRadius: 2048 }),
})
scene.add(spark)

// --- look: the whole frame (scan splats included) is rendered linear into a half-float target, then one
// full-screen pass applies exposure, the warmth tint, ACES Filmic and sRGB (contract §2.6.1). Spark writes
// linear colors into render targets, so splats and meshes go through the same curve and match.
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.outputColorSpace = THREE.SRGBColorSpace
export const LOOK_DEFAULT = { exposure: 1, warmth: 0 }
const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt)
const post = (() => {
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true })
  const mat = new THREE.ShaderMaterial({
    uniforms: { tScene: { value: rt.texture }, uTint: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tScene;', 'uniform vec3 uTint;', 'varying vec2 vUv;',
      'void main() {',
      '  gl_FragColor = vec4(texture2D(tScene, vUv).rgb * uTint, 1.0);',
      '  #include <tonemapping_fragment>', // ACES Filmic with renderer.toneMappingExposure (screen only)
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
  quad.frustumCulled = false
  const s = new THREE.Scene()
  s.add(quad)
  return { rt, mat, scene: s, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) }
})()
const drawSize = new THREE.Vector2()
function resizePost() {
  renderer.getDrawingBufferSize(drawSize)
  post.rt.setSize(Math.max(1, drawSize.x), Math.max(1, drawSize.y))
}
resizePost()
// True colour: the room as trained, for comparing with the photos. No ACES, exposure or warmth (contract §2.6).
// Not saved with the room: it's a way of inspecting it, and furniture is lit for the normal look.
let trueColor = false
function applyTone(on) {
  post.mat.toneMapped = !on
  post.mat.needsUpdate = true
  post.mat.uniforms.uTint.value.copy(on ? new THREE.Vector3(1, 1, 1) : warmthTint(roomConfig.look.warmth))
}
function setTrueColor(on) {
  trueColor = !!on
  applyTone(trueColor)
  wake()
  emitLook()
}
function renderFrame() {
  renderer.setRenderTarget(post.rt)
  renderer.render(scene, camera)
  renderer.setRenderTarget(null)
  renderer.render(post.scene, post.camera)
}
// A gentle white-balance tint, luminance-neutral: warm lifts red and cuts blue, cool the opposite.
function warmthTint(w) {
  const t = new THREE.Vector3(1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w)
  return t.multiplyScalar(1 / (0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z))
}

// --- lighting: neutral studio for the placeholder, an environment baked from the scan otherwise (§2.6.2)
const pmrem = new THREE.PMREMGenerator(renderer)
const neutralEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
const ENV_SIZE = 128 // px per cube face: small, it's blurred by PMREM anyway, and headless SwiftShader is slow
const env = { source: 'neutral', rt: null, probe: null, customProbe: null, chain: Promise.resolve() }
let baking = false
scene.environment = neutralEnv
const sun = new THREE.DirectionalLight(0xffffff, 0.8)
sun.position.set(2, 4, 3)
const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.6)
scene.add(sun, hemi)
function applyLighting() {
  const fromScan = env.source === 'splat'
  // The scan's own light does the work; a faint key light keeps some shape on matte furniture.
  scene.environmentIntensity = fromScan ? 1.0 : 0.75
  sun.intensity = fromScan ? 0.25 : 0.8
  hemi.intensity = fromScan ? 0 : 0.6
}
applyLighting()

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.02, 500)
camera.position.set(3.2, 3.4, 4.6)
const orbit = new OrbitControls(camera, canvas)
orbit.target.set(0, 0.8, 0)
orbit.enableDamping = false
orbit.maxPolarAngle = Math.PI * 0.495
orbit.update()

const grid = new THREE.GridHelper(20, 40, 0x6b6a66, 0x4a4946)
grid.material.transparent = true
grid.material.opacity = 0.35
grid.material.depthWrite = false
grid.position.y = 0.002
grid.renderOrder = -1 // before splats, so scans draw over it
grid.raycast = () => {}
scene.add(grid)
function setGridVisible(on) {
  grid.visible = !!on
  emit('grid', { visible: grid.visible })
}

// Shift the projection center into the part of the view that panels, bars and sheets don't cover (px).
const viewInset = { left: 0, bottom: 0, top: 0 }
function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight
  const { left, bottom, top } = viewInset
  camera.aspect = w / h
  const x = left > 0 && w > 2.5 * left ? -left / 2 : 0
  const y = bottom + top < 0.7 * h ? (bottom - top) / 2 : 0 // a phone half sheet (half the screen) still shifts the view up
  if (x || y) camera.setViewOffset(w, h, x, y, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}
function setViewInset(left, bottom = 0, top = 0) {
  const px = (v) => (isNum(v) && v > 0 ? v : 0)
  Object.assign(viewInset, { left: px(left), bottom: px(bottom), top: px(top) })
  updateViewOffset()
}
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizePost()
  updateViewOffset()
})
updateViewOffset()

function mount(el) {
  el.appendChild(canvas)
}

const noRaycast = (o) => { o.traverse((c) => { c.raycast = () => {} }); return o }

// --- room ---------------------------------------------------------------------
export const IDENTITY = () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 })
let roomConfig = normalizeRoomConfig({ version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } })
let savedRoomConfig = clone(roomConfig)
const room = { kind: 'placeholder', loaded: false, failed: false, error: null, mesh: null, splatCount: 0, lod: 'off', localBox: null, fill: null, dropped: null }
let loadAbort = null // AbortController of the scan download in flight
let roomToken = 0
let roomStatus = 'loading…'
let roomName = null      // the open room (§2.7), null for the placeholder, a dropped file or an unnamed config
let missingRoom = null   // ?room=<name> that isn't a room
let roomsApi = null      // does the server have GET /api/rooms?
let roomsList = []
const roomLoad = { loading: false, progress: null, label: '' }
const LAST_ROOM_KEY = 'nook.lastRoom'
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } },
}

// --- unsaved state: the room (alignment, look, placeholder size vs the last load/save) and the layout (items) ----
const dirty = { room: false, layout: false }
let roomBaseline = ''
let quietItems = 0 // > 0 while the engine itself replaces the items (room switch, layout load)
const roomSig = (c) => JSON.stringify([c.transform.position.map((v) => round(v, 5)), c.transform.quaternion.map((v) => round(v, 6)),
  round(c.transform.scale, 6), c.look.exposure, c.look.warmth, c.placeholder, c.measured?.meters ?? null])
function setDirty(next) {
  if (next.room === dirty.room && next.layout === dirty.layout) return
  Object.assign(dirty, next)
  emit('dirty', { ...dirty })
}
const touchRoom = () => setDirty({ ...dirty, room: roomSig(roomConfig) !== roomBaseline })
const markRoomClean = () => { roomBaseline = roomSig(roomConfig); touchRoom() }
events.addEventListener('items', () => { if (!quietItems) setDirty({ ...dirty, layout: true }) })
async function quietly(fn) { quietItems++; try { return await fn() } finally { quietItems-- } }
const placeholderGroup = new THREE.Group()
scene.add(placeholderGroup)

function normalizeRoomConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('room config must be an object')
  const out = clone(cfg)
  out.version = 1
  const t = out.transform || {}
  out.transform = {
    position: Array.isArray(t.position) && t.position.length === 3 && t.position.every(isNum) ? t.position.slice() : [0, 0, 0],
    quaternion: Array.isArray(t.quaternion) && t.quaternion.length === 4 && t.quaternion.every(isNum) ? t.quaternion.slice() : [0, 0, 0, 1],
    scale: isNum(t.scale) && t.scale > 0 ? t.scale : 1,
  }
  const p = out.placeholder || {}
  out.placeholder = {
    w: isNum(p.w) && p.w > 0 ? p.w : DEFAULT_PLACEHOLDER.w,
    d: isNum(p.d) && p.d > 0 ? p.d : DEFAULT_PLACEHOLDER.d,
    h: isNum(p.h) && p.h > 0 ? p.h : DEFAULT_PLACEHOLDER.h,
  }
  if (typeof out.splat !== 'string' || !out.splat.trim()) out.splat = null
  const l = out.look && typeof out.look === 'object' ? out.look : {}
  out.look = { exposure: clampNum(l.exposure, 0.25, 4, LOOK_DEFAULT.exposure), warmth: clampNum(l.warmth, -1, 1, LOOK_DEFAULT.warmth) }
  const vec = (a, n) => Array.isArray(a) && a.length === n && a.every(isNum)
  out.viewpoints = (Array.isArray(out.viewpoints) ? out.viewpoints : [])
    .filter((v) => v && vec(v.position, 3) && vec(v.quaternion, 4)).slice(0, 64)
  return out
}

function buildPlaceholder({ w, d, h }) {
  for (const c of [...placeholderGroup.children]) {
    placeholderGroup.remove(c)
    c.geometry?.dispose()
    c.material?.dispose()
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0xa8957b, roughness: 0.95 }))
  floor.rotation.x = -Math.PI / 2
  floor.name = 'placeholder-floor'
  placeholderGroup.add(floor)
  // Walls face inward and are single-sided, so the ones between the camera and the room disappear.
  // Opaque so splat items (drawn in the transparent pass without depth writes) always land on top.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 1, side: THREE.FrontSide })
  const walls = [
    [w, [0, h / 2, -d / 2], 0],
    [w, [0, h / 2, d / 2], Math.PI],
    [d, [-w / 2, h / 2, 0], Math.PI / 2],
    [d, [w / 2, h / 2, 0], -Math.PI / 2],
  ]
  for (const [len, pos, ry] of walls) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), wallMat)
    m.position.set(...pos)
    m.rotation.y = ry
    m.name = 'placeholder-wall'
    placeholderGroup.add(m)
  }
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), wallMat)
  ceiling.rotation.x = Math.PI / 2 // faces down: visible from inside only
  ceiling.position.y = h
  ceiling.name = 'placeholder-ceiling'
  placeholderGroup.add(ceiling)
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    new THREE.LineBasicMaterial({ color: 0x8c877d, transparent: true, opacity: 0.6 }))
  edges.position.y = h / 2
  edges.raycast = () => {}
  placeholderGroup.add(edges)
}

function applyRoomTransform() {
  applyShellTransform()
  const m = room.mesh
  if (!m) return
  const t = roomConfig.transform
  m.position.fromArray(t.position)
  m.quaternion.fromArray(t.quaternion).normalize()
  m.scale.setScalar(t.scale)
  m.updateMatrixWorld(true)
}

function disposeRoomSplat() {
  if (!room.mesh) return
  const mesh = room.mesh
  scene.remove(mesh)
  // An environment bake may still be reading this splat; free it once the bake queue is idle.
  env.chain.then(() => { try { mesh.dispose() } catch { /* ignore */ } })
  room.mesh = null
  room.splatCount = 0
  room.lod = 'off'
  room.localBox = null
}

// Level of detail (Spark's tiny-lod tree, built on the device in a worker; contract §2.6). The room opens and bakes its
// light from the plain splats exactly as without LoD; the tree follows when it's ready, and from then on Spark draws a
// selection for the view, at most its platform budget (1 M Android, 1.5 M iOS, 2.5 M desktop). The plain splats stay:
// picks and the floor fit read them. The tree costs far more memory than it saves (about 450 MB at 1.4 M splats, SH 3),
// so a phone builds it only for a room above LOD_PHONE_ABOVE. A device known to be short of memory, ?lod=0 or a failed
// build keep the plain splats.
const LOD_PHONE_ABOVE = 1_500_000
const IS_PHONE = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const LOD_WANTED = params.get('lod') !== '0' && !(navigator.deviceMemory < 4)
function buildRoomLod(mesh) {
  if (!LOD_WANTED || (IS_PHONE && room.splatCount <= LOD_PHONE_ABOVE)) return
  env.chain.then(async () => {
    if (room.mesh !== mesh) return
    room.lod = 'building'
    try {
      await mesh.createLodSplats()
      if (room.mesh === mesh) room.lod = 'on'
    } catch (e) {
      if (room.mesh === mesh) room.lod = 'off'
      console.info('[nook] no level of detail for this room:', e?.message || e)
    }
    wake()
  })
}

function showPlaceholder() {
  disposeRoomSplat()
  buildPlaceholder(roomConfig.placeholder)
  placeholderGroup.visible = true
  room.kind = 'placeholder'
  room.loaded = true
  useNeutralEnv()
}

function setRoomStatus(text) {
  roomStatus = text
  emit('status', { text })
}

// After the room or its config changed: apply the look, tell the UI, and refresh the status line once loaded.
function syncRoom(phase) {
  applyLook()
  touchRoom()
  emit('room', { phase, name: roomName })
  if (!room.loaded) return
  const p = roomConfig.placeholder
  setRoomStatus(room.kind === 'splat'
    ? `${room.dropped || roomConfig.splat} · ${room.splatCount.toLocaleString()} splats${viewpoints().length ? ` · ${viewpoints().length} scan views` : ''}`
    : `placeholder ${p.w} × ${p.d} × ${p.h} m`)
}

// With `onProgress(loaded, total)`, the body is streamed so a UI can show "Loading 62 %".
async function fetchBytes(url, onProgress, signal) {
  let res
  try { res = await fetch(url, { signal }) } catch (e) {
    if (e.name === 'AbortError') throw e
    const err = new Error(`could not fetch ${url} (${e.message})`); err.offline = true; throw err
  }
  if (!res.ok) { const err = new Error(`${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
  const total = Number(res.headers.get('content-length')) || 0
  if (!onProgress || !total || !res.body?.getReader) return new Uint8Array(await res.arrayBuffer())
  let out = new Uint8Array(total), got = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (got + value.length > out.length) { const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length)); bigger.set(out.subarray(0, got)); out = bigger }
    out.set(value, got)
    got += value.length
    onProgress(got, total)
  }
  return got === out.length ? out : out.slice(0, got)
}

function roomSplatUrl(splat) {
  // Room splat paths are relative to the repo root, which the server serves at "/".
  return new URL(splat, `${location.origin}/`).href
}

// Loads a room config (room.schema.json). With `fileBytes`, the scan comes from a dropped file. `name` is the room it
// belongs to (§2.7); left out, the open room's name is kept when the config shows the same scan, else it's null.
// The loaded config is the new baseline for the unsaved state.
async function loadRoomInternal(cfg, { fileBytes = null, fileName = null, frame = true, name, undo = null } = {}) {
  const token = ++roomToken
  let next
  try { next = normalizeRoomConfig(cfg) } catch (e) { throw reportError('Bad room config', e) }
  // A failed drop must leave the working room (and what Save room would write) as it was.
  const prev = { config: roomConfig, dropped: room.dropped, hadSplat: room.kind === 'splat' && !!room.mesh && room.loaded, name: undo ? undo.name : roomName, baseline: roomBaseline, saved: undo ? undo.saved : savedRoomConfig, failed: room.failed, error: room.error }
  if (name === undefined) name = !fileBytes && !room.dropped && next.splat && next.splat === roomConfig.splat ? roomName : null
  roomName = fileBytes ? null : name
  if (roomName !== shell.room || !roomName) clearShell()
  roomConfig = next
  roomBaseline = roomSig(next)
  vpBase = transformMatrix(roomConfig.transform)
  vpIndex = -1
  room.loaded = false
  room.failed = false
  room.error = null
  room.dropped = fileBytes ? fileName : null
  loadAbort?.abort()
  loadAbort = null
  if (!roomConfig.splat && !fileBytes) {
    roomLoad.loading = false
    showPlaceholder()
    syncRoom('loaded')
    if (frame) frameRoom()
    return
  }
  const label = fileBytes ? fileName : roomConfig.splat
  Object.assign(roomLoad, { loading: true, progress: fileBytes ? 1 : 0, label })
  emit('room', { phase: 'loading', label, name: roomName })
  setRoomStatus(`loading ${label}…`)
  let mesh = null
  const onProgress = (loaded, total) => {
    if (token !== roomToken) return
    roomLoad.progress = total ? loaded / total : null
    emit('room-progress', { name: roomName, loaded, total, progress: roomLoad.progress })
  }
  const abort = fileBytes ? null : new AbortController()
  loadAbort = abort
  try {
    const bytes = fileBytes || await fetchBytes(roomSplatUrl(roomConfig.splat), onProgress, abort.signal)
    if (token !== roomToken) return
    mesh = new SplatMesh({ fileBytes: bytes, fileName: fileName || roomConfig.splat })
    await mesh.initialized
    if (!mesh.numSplats) throw new Error('the file contains no splats')
  } catch (e) {
    try { mesh?.dispose() } catch { /* ignore */ }
    if (loadAbort === abort) loadAbort = null
    if (e?.name === 'AbortError') {
      // Cancelled (cancelRoomLoad): back to the room that was open before, as it was.
      if (token === roomToken) {
        roomLoad.loading = false
        roomConfig = prev.config
        roomName = prev.name
        roomBaseline = prev.baseline
        savedRoomConfig = prev.saved
        room.dropped = prev.dropped
        room.failed = prev.failed
        room.error = prev.error
        if (prev.name) store.set(LAST_ROOM_KEY, prev.name)
        if (prev.hadSplat) room.loaded = true
        else showPlaceholder()
        vpBase = transformMatrix(roomConfig.transform)
        if (prev.name) quiet(loadShell(prev.name, roomsList.find((r) => r.name === prev.name)?.roomplan_url || null))
        syncRoom('cancelled')
        quiet(refreshLayouts())
      }
      const err = new Error('Loading the room was cancelled'); err.cancelled = true; throw err
    }
    if (token === roomToken) roomLoad.loading = false
    if (token === roomToken && fileBytes) {
      roomConfig = prev.config
      roomName = prev.name
      roomBaseline = prev.baseline
      room.dropped = prev.dropped
      if (prev.hadSplat) room.loaded = true
      else showPlaceholder()
      syncRoom('failed')
      throw reportError(`Could not load room scan ${label}; keeping the current room`, e)
    }
    if (token === roomToken) {
      showPlaceholder()
      room.failed = true
      room.error = { kind: e?.status === 404 ? 'missing' : e?.offline ? 'offline' : 'bad', file: label.split('/').pop(), message: e?.message || String(e) }
      syncRoom('failed')
      if (frame) frameRoom()
    }
    throw reportError(`Could not load room scan ${label}; showing the placeholder room`, e)
  }
  if (loadAbort === abort) loadAbort = null
  if (token !== roomToken) { try { mesh.dispose() } catch { /* ignore */ } return }
  disposeRoomSplat()
  room.mesh = mesh
  room.splatCount = mesh.numSplats
  room.fill = new THREE.Color()
  room.localBox = splatCenterBox(mesh, 0.01, 0.99, room.fill)
  room.kind = 'splat'
  room.loaded = true
  roomLoad.loading = false
  roomLoad.progress = 1
  applyRoomTransform()
  scene.add(mesh)
  placeholderGroup.visible = false
  syncRoom('loaded')
  if (frame) frameRoom()
  // A new scan lights the furniture from its center; this doesn't hold up loadRoom().
  env.customProbe = null
  quiet(bakeEnvironment())
  buildRoomLod(mesh)
}

// Axis-aligned box of splat centers, 1st–99th percentile per axis (ignores floaters). With `meanColor` (a
// THREE.Color), also sets it to the scan's mean linear color, weighted by opacity and (damped) splat size: it
// fills the directions the scan doesn't cover when the environment is baked, so holes read as more room, not black.
function splatCenterBox(mesh, lo = 0.01, hi = 0.99, meanColor = null) {
  const n = mesh.numSplats || 0
  if (!n) return null
  const stride = Math.max(1, Math.floor(n / 250000))
  const m = Math.ceil(n / stride)
  const xs = new Float32Array(m), ys = new Float32Array(m), zs = new Float32Array(m)
  const lin = (v) => Math.min(1, Math.max(0, v)) ** 2.2 // Spark's sRGB -> linear
  let k = 0, r = 0, g = 0, b = 0, wsum = 0
  mesh.forEachSplat((i, c, s, q, opacity, color) => {
    if (i % stride !== 0 || k >= m) return
    xs[k] = c.x; ys[k] = c.y; zs[k] = c.z; k++
    if (!meanColor) return
    const w = opacity * Math.sqrt(s.x * s.y + s.y * s.z + s.z * s.x)
    if (!(w > 0) || !Number.isFinite(w)) return
    r += w * lin(color.r); g += w * lin(color.g); b += w * lin(color.b); wsum += w
  })
  if (meanColor) {
    if (wsum > 0) meanColor.setRGB(r / wsum, g / wsum, b / wsum, THREE.LinearSRGBColorSpace)
    else meanColor.setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace)
  }
  if (!k) return null
  const a = xs.subarray(0, k).sort(), bb = ys.subarray(0, k).sort(), cc = zs.subarray(0, k).sort()
  const i0 = Math.floor(lo * (k - 1)), i1 = Math.ceil(hi * (k - 1))
  return new THREE.Box3(new THREE.Vector3(a[i0], bb[i0], cc[i0]), new THREE.Vector3(a[i1], bb[i1], cc[i1]))
}

function roomWorldBox() {
  if (room.kind === 'splat' && room.mesh && room.localBox) {
    room.mesh.updateMatrixWorld(true)
    return room.localBox.clone().applyMatrix4(room.mesh.matrixWorld)
  }
  const { w, d, h } = roomConfig.placeholder
  return new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, h, d / 2))
}

// Measured room size (m): the scan's 1–99 % box in world space, or the placeholder size.
function getRoomSize() {
  if (room.kind !== 'splat') { const { w, d, h } = roomConfig.placeholder; return { w, d, h } }
  const s = roomWorldBox().getSize(new THREE.Vector3())
  return { w: round(s.x, 2), d: round(s.z, 2), h: round(s.y, 2) }
}

function getRoomBox() {
  const b = roomWorldBox()
  return { min: b.min.toArray(), max: b.max.toArray() }
}

// How far the room transform tilts the scan's floor (its pitch/roll), in degrees; 0 when level. A flip reads as level.
function getFloorTilt() {
  if (room.kind !== 'splat') return 0
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(roomConfig.transform.quaternion).normalize())
  const a = Math.acos(Math.max(-1, Math.min(1, up.y))) / DEG
  return round(Math.min(a, 180 - a), 2)
}

function frameRoom() {
  const box = roomWorldBox()
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const target = new THREE.Vector3(center.x, Math.min(Math.max(center.y, 0.4), 1.0), center.z)
  // Far enough for the widest side to fit across, too (a portrait phone has a narrow horizontal field of view).
  const halfH = Math.atan(Math.tan((camera.fov * DEG) / 2) * Math.min(1, camera.aspect))
  const dist = Math.max(Math.max(size.x, size.z, 2) * 1.55 + 1.2, (Math.max(size.x, size.z, 2) * 0.75) / Math.tan(halfH))
  const pos = target.clone().add(new THREE.Vector3(0.55, 0.85, 1).normalize().multiplyScalar(dist))
  if (view === 'orbit') {
    camera.position.copy(pos)
    orbit.target.copy(target)
    orbit.update()
  } else {
    orbitSaved = { pos, target }
  }
}

// --- alignment edits (the Room & alignment panel) ---------------------------------------
// The yaw/pitch/roll shown for the room quaternion: Ry(y)Rx(x)Rz(z) == Ry(y+180)Rx(180-x)Rz(z+180); pick the one
// with the smaller roll (upside-down scans read as pitch 180).
function getRoomEuler() {
  const t = roomConfig.transform
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(t.quaternion).normalize(), 'YXZ')
  let yaw = e.y / DEG, pitch = e.x / DEG, roll = e.z / DEG
  if (Math.abs(roll) > 90) { yaw = wrapDeg(yaw + 180); pitch = wrapDeg(180 - pitch); roll = wrapDeg(roll + 180) }
  return { yaw: round(yaw, 3), pitch: round(pitch, 3), roll: round(roll, 3) }
}
// Field-level edits emit 'room' { phase: 'edit' } (the UI shouldn't rewrite the field being typed in).
function setRoomEuler({ yaw, pitch, roll }) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, yaw * DEG, roll * DEG, 'YXZ'))
  roomConfig.transform.quaternion = [q.x, q.y, q.z, q.w].map((v) => round(v, 8))
  applyRoomTransform()
  touchRoom()
  emit('room', { phase: 'edit', name: roomName })
}
function setRoomPosition(i, v) {
  roomConfig.transform.position[i] = v
  applyRoomTransform()
  touchRoom()
  emit('room', { phase: 'edit', name: roomName })
}
function setRoomScale(v) {
  if (!(v > 0)) return
  roomConfig.transform.scale = v
  applyRoomTransform()
  touchRoom()
  emit('room', { phase: 'edit', name: roomName })
}
function setPlaceholderSize(k, v) {
  if (!(v >= 0.5 && v <= 50)) return
  roomConfig.placeholder[k] = v
  if (room.kind === 'placeholder') { buildPlaceholder(roomConfig.placeholder); syncRoom('changed') } else { touchRoom(); emit('room', { phase: 'edit', name: roomName }) }
}

// Stop a scan download in flight: the room that was open before comes back (phase 'cancelled'). False if none.
function cancelRoomLoad() {
  if (!loadAbort) return false
  loadAbort.abort()
  return true
}

// Try a room that failed to load again (its name, or the same config).
function retryRoom() {
  if (roomName && roomsApi) return openRoom(roomName)
  return loadRoomInternal(roomConfig, { name: roomName })
}

function loadScanPath(path) {
  const cfg = { ...clone(roomConfig), splat: path || null }
  if (!path || path !== roomConfig.splat || room.dropped) { cfg.transform = path === savedRoomConfig.splat ? savedRoomConfig.transform : IDENTITY(); delete cfg.measured }
  return loadRoomInternal(cfg)
}

// Use a dropped scan file as the room for this session.
async function dropScanFile(file) {
  if (!SPLAT_EXT.test(file.name)) { reportError(`${file.name} is not a splat (.spz, .ply, .splat, .ksplat, .sog)`); return }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sameScan = roomConfig.splat && roomConfig.splat.split('/').pop() === file.name
    const cfg = { ...clone(roomConfig), splat: `room/${file.name}`, transform: sameScan ? roomConfig.transform : IDENTITY() }
    delete cfg.measured
    await loadRoomInternal(cfg, { fileBytes: bytes, fileName: file.name })
    toast(`Using ${file.name} for this session. To keep it, copy it to room/${file.name} and press Save room.`, 'ok', 10000)
  } catch (err) {
    if (!errors.length || !errors.at(-1).includes(file.name)) reportError(`Could not open ${file.name}`, err)
    throw err
  }
}

// --- rooms (contract §2.7) ---------------------------------------------------------------
const roomUrl = (name) => `/api/rooms/${encodeURIComponent(name)}`
const splatStem = (p) => (typeof p === 'string' && p ? (p.split(/[?#]/)[0].split('/').pop() || '').replace(/\.[^.]*$/, '') : null)

// GET /api/rooms → the rooms, newest first. A server without the rooms API (v1, the hosted build) gives [].
async function listRoomsInternal() {
  let res, data = null
  try { res = await fetch('/api/rooms') } catch (e) { throw reportError('Could not list the rooms', new Error(`could not reach /api/rooms (${e.message})`)) }
  try { data = await res.json() } catch { /* not JSON: no rooms API */ }
  if (!res.ok || !Array.isArray(data?.rooms)) {
    if (res.ok || res.status === 404 || res.status === 405) { roomsApi = false; roomsList = []; emit('rooms', { rooms: [] }); return [] }
    throw reportError('Could not list the rooms', new Error(data?.error || `/api/rooms returned HTTP ${res.status}`))
  }
  roomsApi = true
  roomsList = data.rooms
  emit('rooms', { rooms: roomsList.slice() })
  return roomsList.slice()
}

function rememberRoom(name) {
  roomName = name
  missingRoom = null
  if (name) store.set(LAST_ROOM_KEY, name)
}

// Opens a room by name: its config, scan and layouts. Placed items are cleared when it's another room.
async function openRoom(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Room names are slugs like "scan-20261026-093654" (got "${name}")`)
  let cfg, list = null
  try {
    [cfg, list] = await Promise.all([apiJson(roomUrl(name)), listRoomsInternal().catch(() => null)])
  } catch (e) {
    throw reportError(e.status === 404 ? `Can't find the room "${name}"` : `Could not open the room "${name}"`, e)
  }
  if (name !== roomName || room.dropped) {
    await quietly(() => clearItemsInternal())
    setLayoutName('')
    layoutNames = []
    layoutDetails = []
  }
  const undo = { name: roomName, saved: savedRoomConfig } // what a cancelled load goes back to
  savedRoomConfig = clone(cfg)
  rememberRoom(name)
  setDirty({ room: false, layout: false })
  await afterRoomChosen(name, list, loadRoomInternal(cfg, { name, undo }))
}

// After a named room was picked: wait for the scan, refresh its layouts, and make its first thumbnail.
async function afterRoomChosen(name, list, loading) {
  const token = roomToken
  quiet(refreshLayouts())
  if (name) quiet(loadShell(name, (list || roomsList).find((r) => r.name === name)?.roomplan_url || null))
  await loading
  const entry = (list || roomsList).find((r) => r.name === name)
  if (name && roomsApi && entry && !entry.thumb_url && token === roomToken && room.kind === 'splat') quiet(saveThumbnail(name))
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))

// A small JPEG of the current (default, framed) view for the rooms list: PUT /api/rooms/<name>/thumb.
async function saveThumbnail(name = roomName) {
  if (!name || !roomsApi) return null
  const token = roomToken
  await env.chain
  for (let i = 0; i < 3; i++) await nextFrame() // let Spark sort for the camera first
  if (token !== roomToken || name !== roomName || view !== 'orbit' || room.kind !== 'splat') return null
  let shot
  try { shot = captureView({ maxPx: 640, aspect: 3 / 2, quality: 0.82 }) } catch (e) { throw reportError('Could not capture a thumbnail', e) }
  let res
  try {
    res = await apiJson(`${roomUrl(name)}/thumb`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: shot.dataUrl }) })
  } catch (e) { throw reportError(`Could not save the thumbnail of "${name}"`, e) }
  const url = res?.thumb_url || `/room/${name}.jpg`
  const entry = roomsList.find((r) => r.name === name)
  if (entry) entry.thumb_url = url
  emit('thumb', { name, url })
  return url
}

// After a rename: the open room's title, so a later Save room keeps it. Not an unsaved change.
function setRoomTitle(title) {
  const t = typeof title === 'string' && title.trim() ? title.trim() : null
  roomConfig.title = t
  savedRoomConfig.title = t
  emit('room', { phase: 'title', name: roomName })
}

// Save room: PUT /api/rooms/<name> (or /api/room without a named room) with the alignment, look and (moved)
// viewpoints, then re-bake the light.
async function saveRoom() {
  if (viewpoints().length) {   // save viewpoints where the alignment has moved them, relative to the new transform
    roomConfig.viewpoints = viewpoints().map((v) => {
      const { pos, q } = viewpointPose(v)
      return { ...v, position: pos.toArray().map((x) => round(x, 4)), quaternion: q.toArray().map((x) => round(x, 6)) }
    })
    vpBase = transformMatrix(roomConfig.transform)
  }
  const body = clone(roomConfig)
  if (!body.splat) delete body.transform
  if (!body.measured) delete body.measured
  if (body.title == null) delete body.title
  const named = roomName && roomsApi && !room.dropped
  let res
  try {
    res = await apiJson(named ? roomUrl(roomName) : '/api/room', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (e) { throw reportError(e.status ? 'Could not save the room' : "Not saved: kakapo isn't answering", e) }
  if (named && res?.saved) { body.saved = res.saved; roomConfig.saved = res.saved }
  savedRoomConfig = clone(body)
  markRoomClean()
  const entry = named && roomsList.find((r) => r.name === roomName)
  if (entry) entry.aligned = true
  emit('room', { phase: 'saved', name: roomName })
  toast('Room saved.', 'ok', 2500)
  // The alignment may have moved the scan relative to the furniture: light it again.
  if (room.kind === 'splat') await bakeEnvironment()
}

async function revertRoom() {
  const url = roomName && roomsApi && !room.dropped ? roomUrl(roomName) : '/api/room'
  let cfg
  try { cfg = await apiJson(url) } catch (e) { throw reportError(`Could not read ${url}`, e) }
  savedRoomConfig = clone(cfg)
  await loadRoomInternal(cfg, { frame: false, name: room.dropped ? null : roomName })
}

// --- measured shell (§2.7 v4): walls, floor, doors and windows from <room>.roomplan.json (§4.12), in the room's
// transform like the splat. See-through, drawn over the scan; a tap on a wall shows its length. Hanging an item
// (§2.10) uses its wall planes whether it's shown or not.
const shellGroup = new THREE.Group()
shellGroup.name = 'shell'
shellGroup.visible = false
scene.add(shellGroup)
const shell = { room: null, url: null, loading: null, loaded: false, visible: false, walls: [], center: null, selected: null }
const SHELL_COLOR = { walls: 0xd9a441, floors: 0xece8e0, doors: 0x8cc4a0, windows: 0x8fb8d8, openings: 0x8fb8d8, objects: 0xa39e94 }
function emitShell() { emit('shell', getShell()) }
// roomplan.json matrices are 4 × 4 row-major, nested or flat.
function mat4Of(t) {
  const a = Array.isArray(t?.[0]) ? t.flat() : t
  return Array.isArray(a) && a.length === 16 && a.every(isNum) ? new THREE.Matrix4().set(...a) : null
}
function applyShellTransform() {
  const t = roomConfig.transform
  shellGroup.position.fromArray(t.position)
  shellGroup.quaternion.fromArray(t.quaternion).normalize()
  shellGroup.scale.setScalar(t.scale)
  shellGroup.updateMatrixWorld(true)
}
function clearShell() {
  for (const c of [...shellGroup.children]) {
    shellGroup.remove(c)
    c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.() })
  }
  Object.assign(shell, { room: null, url: null, loading: null, loaded: false, visible: false, walls: [], center: null, selected: null })
  shellGroup.visible = false
}
function buildShell(doc) {
  const add = (obj, m, z = 0) => {
    obj.matrixAutoUpdate = false
    obj.matrix.copy(m)
    if (z) obj.matrix.multiply(new THREE.Matrix4().makeTranslation(0, 0, z))
    obj.renderOrder = 20
    obj.raycast = () => {}
    shellGroup.add(obj)
    return obj
  }
  const centers = []
  for (const kind of ['floors', 'walls', 'doors', 'windows', 'openings', 'objects']) {
    for (const el of Array.isArray(doc?.[kind]) ? doc[kind] : []) {
      const m = mat4Of(el?.transform)
      const d = el?.dimensions
      if (!m || !Array.isArray(d) || !d.slice(0, 2).every((v) => isNum(v) && v > 0)) continue
      const color = SHELL_COLOR[kind]
      if (kind === 'objects') {
        const geo = new THREE.BoxGeometry(d[0], d[1], Math.max(0.01, isNum(d[2]) ? d[2] : 0.01))
        add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false })), m)
        geo.dispose()
        continue
      }
      const geo = new THREE.PlaneGeometry(d[0], d[1])
      const opening = kind === 'doors' || kind === 'windows' || kind === 'openings'
      const fillOpacity = kind === 'walls' ? 0.035 : kind === 'floors' ? 0.03 : 0.08
      const fill = add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: kind === 'walls' ? 0xece8e0 : color, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthWrite: false })), m, opening ? 0.004 : 0)
      const edges = add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: kind === 'floors' ? 0.45 : 0.85, depthWrite: false })), m, opening ? 0.004 : 0)
      if (kind === 'walls') {
        shell.walls.push({ id: String(el.id ?? `wall-${shell.walls.length}`), w: d[0], h: d[1], matrix: m, fill, edges, fillOpacity })
        centers.push(new THREE.Vector3().setFromMatrixPosition(m))
      }
    }
  }
  shell.center = centers.length ? centers.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / centers.length) : null
}
async function loadShell(name, url) {
  if (shell.room === name && shell.url === url && (shell.loaded || shell.loading)) return shell.loading
  const visible = shell.room === name && shell.visible
  clearShell()
  shell.room = name
  shell.url = url
  if (!url) { emitShell(); return null }
  const p = (async () => {
    let doc
    try { doc = await apiJson(url) } catch (e) { if (shell.url === url) shell.loading = null; throw reportError("Could not read this room's measured shell", e) }
    if (shell.url !== url || shell.room !== name) return
    buildShell(doc)
    shell.loaded = true
    applyShellTransform()
    emitShell()
  })()
  shell.loading = p
  shell.visible = visible
  shellGroup.visible = visible
  emitShell()
  return p
}
function setShell(on) {
  if (on && !shell.url) { toast("This room has no measured shell: scan it with RoomPlan (a phone with LiDAR) to get one.", 'info'); on = false }
  shell.visible = !!on
  shellGroup.visible = shell.visible
  if (!shell.visible) selectWall(null)
  emitShell()
}
// The shell wall under the current ray (setRay first): its inner face (toward the room's middle) seen from here
// wins, so from outside the room you reach the far wall through the near one. → { wall, point, normal, distance }
function shellWallHit() {
  if (!shell.walls.length) return null
  shellGroup.updateMatrixWorld(true)
  const center = shell.center ? shell.center.clone().applyMatrix4(shellGroup.matrixWorld) : null
  let inner = null, any = null
  for (const w of shell.walls) {
    const M = shellGroup.matrixWorld.clone().multiply(w.matrix)
    const ray = raycaster.ray.clone().applyMatrix4(M.clone().invert())
    if (Math.abs(ray.direction.z) < 1e-9) continue
    const t = -ray.origin.z / ray.direction.z
    if (!(t > 0)) continue
    const lp = ray.origin.clone().addScaledVector(ray.direction, t)
    if (Math.abs(lp.x) > w.w / 2 || Math.abs(lp.y) > w.h / 2) continue
    const point = lp.setZ(0).applyMatrix4(M)
    const distance = point.distanceTo(raycaster.ray.origin)
    const n = new THREE.Vector3(0, 0, 1).transformDirection(M)
    if (center && n.dot(center.clone().sub(point)) < 0) n.negate()
    const hit = { wall: w, point, normal: n, distance }
    const facing = n.dot(raycaster.ray.origin.clone().sub(point)) > 0
    if (facing && (!inner || distance < inner.distance)) inner = hit
    if (!any || distance < any.distance) any = hit
  }
  if (any && !inner) any.normal.negate() // seen from outside every wall: face the camera
  return inner || any
}
function selectWall(id) {
  if ((shell.selected || null) === (id || null)) return
  shell.selected = id || null
  for (const w of shell.walls) {
    const on = w.id === shell.selected
    w.fill.material.opacity = on ? 0.16 : w.fillOpacity
    w.fill.material.color.setHex(on ? SHELL_COLOR.walls : 0xece8e0)
    w.edges.material.color.setHex(on ? 0xffffff : SHELL_COLOR.walls)
  }
  emitShell()
}
// { available, loaded, visible, walls: [{ id, lengthCm, heightCm }], selected: { id, a, b, lengthCm } | null } (world m)
function getShell() {
  shellGroup.updateMatrixWorld(true)
  const k = roomConfig.transform.scale
  const sel = shell.walls.find((w) => w.id === shell.selected)
  let selected = null
  if (sel) {
    const M = shellGroup.matrixWorld.clone().multiply(sel.matrix)
    const a = new THREE.Vector3(-sel.w / 2, -sel.h / 2, 0).applyMatrix4(M), b = new THREE.Vector3(sel.w / 2, -sel.h / 2, 0).applyMatrix4(M)
    selected = { id: sel.id, a: a.toArray(), b: b.toArray(), lengthCm: Math.round(a.distanceTo(b) * 1000) / 10 }
  }
  return { available: !!shell.url, loaded: shell.loaded, visible: shell.visible, walls: shell.walls.map((w) => ({ id: w.id, lengthCm: Math.round(w.w * k * 1000) / 10, heightCm: Math.round(w.h * k * 1000) / 10 })), selected }
}

// --- environment from the scan (contract §2.6.2) --------------------------------------
function useNeutralEnv() {
  scene.environment = neutralEnv
  env.source = 'neutral'
  env.probe = null
  if (env.rt) { env.rt.dispose(); env.rt = null }
  applyLighting()
  emitLook()
}

function defaultProbe() {
  const c = roomWorldBox().getCenter(new THREE.Vector3())
  return new THREE.Vector3(c.x, 1.0, c.z)
}

// Renders a small cube map of the scan (furniture and helpers hidden) from `probe`, PMREMs it and makes it
// scene.environment. Bakes run one at a time; the view is frozen while one runs (Spark sorts for the probe).
// Only called on room load, on Save room and from relight(): never per frame.
function bakeEnvironment(probe = env.customProbe) {
  const queued = roomToken
  const run = async () => {
    if (queued !== roomToken) return // another room was opened since: its own bake follows
    if (room.kind !== 'splat' || !room.mesh || !room.loaded) { useNeutralEnv(); return }
    const token = roomToken
    const center = probe ? new THREE.Vector3().fromArray(probe) : defaultProbe()
    const hide = [grid, walkTarget.group, placeholderGroup, shellGroup, ...[...items.values()].map((r) => r.group)]
    const background = scene.background
    baking = true
    spark.autoUpdate = false
    try {
      for (let i = 0; spark.sorting && i < 300; i++) await new Promise((r) => setTimeout(r, 10))
      scene.background = room.fill || background
      // renderCubeMap sorts once for all six faces, so they need the view-independent radial order.
      spark.sortRadial = true
      const cube = await spark.renderCubeMap({ scene, worldCenter: center, size: ENV_SIZE, near: 0.05, far: 200, hideObjects: hide, filter: true })
      spark.sortRadial = false
      scene.background = background
      if (token !== roomToken || room.kind !== 'splat') return
      const rt = pmrem.fromCubemap(cube)
      const old = env.rt
      env.rt = rt
      scene.environment = rt.texture
      env.source = 'splat'
      env.probe = center.toArray().map((v) => round(v, 4))
      old?.dispose()
      applyLighting()
      emitLook()
      // Re-sort for the real camera before the frame unfreezes, so furniture splats never blink out.
      await spark.update({ scene, camera })
    } finally {
      spark.sortRadial = false
      scene.background = background
      spark.autoUpdate = true
      baking = false
    }
  }
  const p = env.chain.then(run, run)
  env.chain = p.catch(() => {})
  return p.catch((e) => { throw reportError('Could not light the furniture from the scan', e) })
}

async function relightInternal(position) {
  if (position != null && !(Array.isArray(position) && position.length === 3 && position.every(isNum))) {
    throw reportError('relight: position must be [x, y, z] in meters')
  }
  env.customProbe = position ? position.slice() : null
  await bakeEnvironment(env.customProbe)
}

// --- contact shadows (contract §2.6.3) ------------------------------------------------------
// A soft radial blob on the floor, child of the item group so it follows moves and rotations. It draws after
// all splats (one Spark draw call) so it shows on the scan's floor; splat items get an invisible depth-only box,
// drawn between the two, so their own shadow doesn't paint over them.
const shadowTex = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  // Dark out to about the footprint's edge (r ≈ 0.69 on the sides with the quad size below), then a soft falloff.
  grd.addColorStop(0, 'rgba(0,0,0,0.95)')
  grd.addColorStop(0.45, 'rgba(0,0,0,0.85)')
  grd.addColorStop(0.65, 'rgba(0,0,0,0.55)')
  grd.addColorStop(0.82, 'rgba(0,0,0,0.2)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
})()
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, depthWrite: false, opacity: 0.8 })
const proxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true })
const SHADOW_Y = 0.004
let contactShadows = true

function makeContactShadow(rec) {
  const box = rec.localBox
  const size = box.getSize(new THREE.Vector3())
  const c = box.getCenter(new THREE.Vector3())
  const shadow = new THREE.Mesh(shadowGeo, shadowMat)
  shadow.name = 'contact-shadow'
  shadow.position.set(c.x, SHADOW_Y, c.z)
  shadow.scale.set(size.x * 1.45 + 0.06, 1, size.z * 1.45 + 0.06)
  shadow.renderOrder = 2
  shadow.visible = contactShadows
  noRaycast(shadow)
  let proxy = null
  if (rec.render === 'splat') {
    // Upper body only, inset: a full bounding box also hid the floor seen between legs, leaving a hard-edged pale
    // box in the shadow. Below 30% height the shadow darkens the legs instead, which reads as contact darkening.
    const bottom = box.min.y + size.y * 0.3
    proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x * 0.7, box.max.y - bottom, size.z * 0.7), proxyMat)
    proxy.name = 'shadow-proxy'
    proxy.position.set(c.x, (bottom + box.max.y) / 2, c.z)
    proxy.renderOrder = 1
    proxy.visible = contactShadows
    noRaycast(proxy)
  }
  return { shadow, proxy }
}

function setContactShadows(on) {
  contactShadows = !!on
  for (const r of items.values()) syncShadow(r)
  emitLook()
}
// The blob stays on the floor (it's a child of the item, so it's shifted down by the elevation); a raised item (its
// bottom more than 2 cm up, §2.10) has none.
function syncShadow(rec) {
  const y = rec.group.position.y
  const on = contactShadows && y <= 0.02
  if (rec.shadow) { rec.shadow.visible = on; rec.shadow.position.y = SHADOW_Y - y }
  if (rec.proxy) rec.proxy.visible = on
}

// --- library + items --------------------------------------------------------
let library = []
const items = new Map() // uid -> { uid, id, lib, render, group, child, localBox, rotationDeg, shadow, proxy }
let itemsGen = 0
let uidCounter = 0
const THREE_LIBS = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/'
const gltfLoader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath(`${THREE_LIBS}draco/gltf/`))
  .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${THREE_LIBS}basis/`).detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder)
const glbCache = new Map() // url -> Promise<{ scene, box }>
const splatCache = new Map() // url -> Promise<Uint8Array>
const splatBoxCache = new Map() // url -> Box3

const assetUrl = (rel) => new URL(rel, libraryBase).href

async function loadLibrary() {
  let list = []
  try {
    const res = await fetch(LIBRARY_URL)
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data || !Array.isArray(data.items)) throw new Error('missing "items" array')
      list = data.items.filter((i) => i && typeof i.id === 'string')
    }
  } catch (e) {
    reportError(`Could not read library ${LIBRARY_URL}`, e)
  }
  library = list
  emit('library', { items: library.slice() })
}

function loadGlbTemplate(url) {
  if (!glbCache.has(url)) {
    const p = (async () => {
      const bytes = await fetchBytes(url)
      const base = url.slice(0, url.lastIndexOf('/') + 1)
      const gltf = await new Promise((resolve, reject) => gltfLoader.parse(bytes.buffer, base, resolve, reject))
      const root = gltf.scene || gltf.scenes?.[0]
      if (!root) throw new Error('GLB has no scene')
      root.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(root, true)
      if (box.isEmpty()) throw new Error('GLB has no geometry')
      return { scene: root, box }
    })()
    glbCache.set(url, p)
    p.catch(() => glbCache.delete(url))
  }
  return glbCache.get(url)
}

function loadSplatBytes(url) {
  if (!splatCache.has(url)) {
    const p = fetchBytes(url)
    splatCache.set(url, p)
    p.catch(() => splatCache.delete(url))
  }
  return splatCache.get(url)
}

// A piece the library doesn't have any more (§2.8): a dashed box at its dims, so the layout keeps its place.
const MISSING_DIMS = { w: 50, d: 50, h: 50 }
const missingFill = new THREE.MeshBasicMaterial({ color: 0xe8735a, transparent: true, opacity: 0.14, depthWrite: false })
const missingEdge = new THREE.LineDashedMaterial({ color: 0xe8735a, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95 })
function missingChild(dims) {
  const w = dims.w / 100, d = dims.d / 100, hgt = dims.h / 100
  const geo = new THREE.BoxGeometry(w, hgt, d).translate(0, hgt / 2, 0)
  const g = new THREE.Group()
  g.name = 'missing-item'
  const fillMesh = new THREE.Mesh(geo, missingFill)
  fillMesh.renderOrder = 3
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), missingEdge)
  edges.computeLineDistances()
  edges.raycast = () => {}
  g.add(fillMesh, edges)
  return { obj: g, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, hgt, d / 2)) }
}
const validDims = (d) => d && typeof d === 'object' && ['w', 'd', 'h'].every((k) => isNum(d[k]) && d[k] > 0)

async function buildChild(lib, render) {
  if (lib.missing) return missingChild(lib.dims_cm)
  if (render === 'splat') {
    const url = assetUrl(lib.assets.splat)
    const bytes = await loadSplatBytes(url)
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: url })
    try {
      await mesh.initialized
      if (!mesh.numSplats) throw new Error('splat has no points')
    } catch (e) {
      try { mesh.dispose() } catch { /* ignore */ }
      throw e
    }
    if (!splatBoxCache.has(url)) splatBoxCache.set(url, splatCenterBox(mesh))
    return { obj: mesh, box: splatBoxCache.get(url).clone() }
  }
  const url = assetUrl(lib.assets.glb)
  const t = await loadGlbTemplate(url)
  return { obj: t.scene.clone(true), box: t.box.clone() }
}

// GLB clones share geometry/materials with the cached template, so only splat meshes are disposed.
function disposeChild(obj) {
  if (obj instanceof SplatMesh) { try { obj.dispose() } catch { /* ignore */ } }
  if (obj?.name === 'missing-item') obj.traverse((c) => c.geometry?.dispose())
}

async function setRender(rec, render) {
  const { obj, box } = await buildChild(rec.lib, render)
  if (rec.child) {
    rec.group.remove(rec.child)
    disposeChild(rec.child)
  }
  disposeContactShadow(rec)
  rec.child = obj
  rec.localBox = box
  rec.render = render
  rec.group.add(obj)
  const { shadow, proxy } = makeContactShadow(rec)
  rec.shadow = shadow
  rec.proxy = proxy
  rec.group.add(shadow)
  if (proxy) rec.group.add(proxy)
  syncShadow(rec)
}

function disposeContactShadow(rec) {
  if (rec.shadow) rec.group.remove(rec.shadow)
  if (rec.proxy) { rec.group.remove(rec.proxy); rec.proxy.geometry.dispose() }
  rec.shadow = null
  rec.proxy = null
}

function pickRender(lib, wanted) {
  const hasSplat = !!lib.assets?.splat
  let r = wanted ?? lib.default_render ?? 'glb'
  if (r !== 'glb' && r !== 'splat') r = 'glb'
  if (r === 'splat' && !hasSplat) r = 'glb'
  if (r === 'glb' && !lib.assets?.glb && hasSplat) r = 'splat'
  return r
}

function defaultSpot() {
  let base
  if (view === 'orbit') base = new THREE.Vector2(orbit.target.x, orbit.target.z)
  else {
    const f = new THREE.Vector3(); camera.getWorldDirection(f)
    f.y = 0
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1)
    f.normalize().multiplyScalar(1.3)
    base = new THREE.Vector2(camera.position.x + f.x, camera.position.z + f.z)
  }
  const taken = [...items.values()].map((r) => new THREE.Vector2(r.group.position.x, r.group.position.z))
  const step = 0.6
  for (let ring = 0; ring < 6; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const a = (k / Math.max(1, ring * 8)) * Math.PI * 2
      const p = new THREE.Vector2(base.x + Math.cos(a) * ring * step, base.y + Math.sin(a) * ring * step)
      if (taken.every((q) => q.distanceTo(p) > 0.45)) return [p.x, 0, p.y]
    }
  }
  return [base.x, 0, base.y]
}

function newUid(id) {
  uidCounter += 1
  return `${id}-${Date.now().toString(36)}${uidCounter.toString(36)}`
}

// opts: { position: [x, elevation, z], rotation_y_deg, render, uid, mounted: 'floor'|'wall',
//         missing: dims_cm (a layout's piece the library doesn't have: a placeholder box at those dims, §2.8) }
async function addItemInternal(id, opts = {}) {
  opts = opts || {}
  let lib = library.find((i) => i.id === id)
  if (!lib && opts.missing && typeof id === 'string' && id) {
    lib = { id, name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), dims_cm: validDims(opts.missing) ? { ...opts.missing } : { ...MISSING_DIMS }, assets: {}, missing: true }
  }
  if (!lib) throw reportError(`Unknown library item "${id}"`)
  const render = lib.missing ? 'glb' : pickRender(lib, opts.render)
  const given = Array.isArray(opts.position) && opts.position.length >= 3 && isNum(opts.position[0]) && isNum(opts.position[2])
  const pos = given ? opts.position : defaultSpot()
  const rot = isNum(opts.rotation_y_deg) ? opts.rotation_y_deg : 0
  const uid = typeof opts.uid === 'string' && opts.uid && !items.has(opts.uid) ? opts.uid : newUid(id)
  const gen = itemsGen
  const group = new THREE.Group()
  group.rotation.order = 'YXZ'
  group.position.set(pos[0], given && isNum(pos[1]) ? clampElev(pos[1]) : 0, pos[2])
  group.rotation.set(0, rot * DEG, 0)
  group.userData.uid = uid
  group.name = `item:${uid}`
  const rec = { uid, id, lib, render, group, child: null, localBox: null, rotationDeg: rot, shadow: null, proxy: null,
    mounted: opts.mounted === 'wall' ? 'wall' : 'floor', missing: !!lib.missing }
  try {
    await setRender(rec, render)
  } catch (e) {
    throw reportError(`Could not load "${lib.name || id}" (${render})`, e)
  }
  // A wall piece (library mount: "wall") placed without a spot starts at a center height of 1.45 m (§2.10).
  if (!given && lib.mount === 'wall' && rec.localBox) {
    group.position.y = clampElev(round(1.45 - (rec.localBox.max.y + rec.localBox.min.y) / 2, 6))
    syncShadow(rec)
  }
  if (gen !== itemsGen) {
    disposeChild(rec.child)
    disposeContactShadow(rec)
    throw new Error(`adding "${id}" was cancelled because the items were cleared`)
  }
  scene.add(group)
  items.set(uid, rec)
  emit('items', { change: 'add', uid })
  return uid
}

// position[1] is the elevation (§2.10): the item's bottom above the floor, clamped to 0..4 m. `mounted` 'floor'
// unhooks a hung item (Drop to floor does that).
function moveItemInternal(uid, opts = {}) {
  const rec = items.get(uid)
  if (!rec) { reportError(`moveItem: no placed item "${uid}"`); return }
  opts = opts || {}
  if (Array.isArray(opts.position)) {
    if (isNum(opts.position[0])) rec.group.position.x = opts.position[0]
    if (isNum(opts.position[1])) rec.group.position.y = clampElev(opts.position[1])
    if (isNum(opts.position[2])) rec.group.position.z = opts.position[2]
  }
  if (isNum(opts.rotation_y_deg)) {
    rec.rotationDeg = opts.rotation_y_deg
    rec.group.rotation.set(0, opts.rotation_y_deg * DEG, 0)
  }
  if (opts.mounted === 'floor' || opts.mounted === 'wall') rec.mounted = opts.mounted
  rec.group.updateMatrixWorld(true)
  syncShadow(rec)
  emit('items', { change: 'move', uid })
}

// --- elevation and hanging (§2.10) ---------------------------------------------------------------------------
function getElevation(uid) { const rec = items.get(uid); return rec ? rec.group.position.y : null }
function setElevation(uid, y) {
  const rec = items.get(uid)
  if (!rec || !isNum(y)) return
  moveItemInternal(uid, { position: [rec.group.position.x, round(clampElev(y), 6), rec.group.position.z] })
}
function nudgeElevation(uid, dy) { const y = getElevation(uid); if (y != null) setElevation(uid, Math.round((y + dy) * 1000) / 1000) }
function dropToFloor(uid) {
  const rec = items.get(uid)
  if (!rec) return
  moveItemInternal(uid, { position: [rec.group.position.x, 0, rec.group.position.z], mounted: 'floor' })
}
// The item's frame turned to `yawDeg`: R · local
const yawVec = (v, yawDeg) => v.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawDeg * DEG)
// Puts the item's back (its −Z face) on the plane through `point` with `normal` (its front faces that way), its
// center at the point. The normal is made horizontal. The item stays hung (mounted 'wall') until dropped.
function hangItem(uid, at) {
  const rec = items.get(uid)
  if (!rec) { reportError(`hangItem: no placed item "${uid}"`); return }
  const point = at?.point, normal = at?.normal
  if (!(Array.isArray(point) && point.length === 3 && point.every(isNum) && Array.isArray(normal) && normal.length === 3 && normal.every(isNum))) {
    reportError('hangItem needs { point: [x, y, z], normal: [x, y, z] }')
    return
  }
  const n = new THREE.Vector3(normal[0], 0, normal[2])
  if (n.lengthSq() < 1e-9) { reportError('hangItem: the wall normal must not point straight up or down'); return }
  n.normalize()
  const yaw = round(Math.atan2(n.x, n.z) / DEG, 6)
  const b = rec.localBox
  const back = yawVec(new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z), yaw)
  const p = new THREE.Vector3().fromArray(point).sub(back)
  moveItemInternal(uid, { position: [round(p.x, 6), round(clampElev(p.y), 6), round(p.z, 6)], rotation_y_deg: yaw, mounted: 'wall' })
}
// The plane a hung item slides on: through its back face, facing where its front faces.
function wallPlaneOf(rec) {
  rec.group.updateMatrixWorld(true)
  const n = yawVec(new THREE.Vector3(0, 0, 1), rec.rotationDeg)
  const back = new THREE.Vector3(0, 0, rec.localBox.min.z).applyMatrix4(rec.group.matrixWorld)
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, back)
}

// Hang mode: Hang on wall (or a long-press on the phone), then a tap on a wall hangs the selected item there.
let hang = null // { uid }
function startHang(uid = selected) {
  if (!uid || !items.has(uid)) { toast('Select a piece first, then Hang on wall.', 'info', 3000); return false }
  measure.active = false
  measure.points = []
  cancelPickMode()
  if (selected !== uid) select(uid)
  hang = { uid }
  emit('hang', { active: true, uid })
  return true
}
function cancelHang() {
  if (!hang) return
  hang = null
  emit('hang', { active: false, uid: selected })
}
// Where a screen point meets a wall: the measured shell's wall plane (exact), a placeholder wall, else the scan with
// the front turned to face the camera (snapped to 15°). → { point, normal, source: 'shell'|'placeholder'|'scan' } | null
function wallAt(clientX, clientY) {
  setRay(clientX, clientY)
  const sw = shellWallHit()
  if (sw) return { point: sw.point.toArray(), normal: sw.normal.toArray(), source: 'shell', wall: sw.wall.id }
  if (placeholderGroup.visible) {
    const ph = raycaster.intersectObjects(placeholderGroup.children.filter((c) => c.name === 'placeholder-wall'), false)[0]
    if (ph) {
      const n = ph.face.normal.clone().transformDirection(ph.object.matrixWorld)
      return { point: ph.point.toArray(), normal: n.toArray(), source: 'placeholder' }
    }
  }
  const sp = hitRoomSplat()
  if (!sp) return null
  const toCam = camera.position.clone().sub(sp.point)
  const yaw = Math.round(Math.atan2(toCam.x, toCam.z) / DEG / 15) * 15
  const n = yawVec(new THREE.Vector3(0, 0, 1), yaw)
  return { point: sp.point.toArray(), normal: [round(n.x, 9), 0, round(n.z, 9)], source: 'scan' }
}
function hangAt(clientX, clientY) {
  const uid = hang?.uid
  if (!uid || !items.has(uid)) { cancelHang(); return false }
  const at = wallAt(clientX, clientY)
  if (!at) { toast(shell.walls.length ? 'No wall there: tap a wall.' : 'No scan there: tap a wall.', 'info', 3000); return false }
  hangItem(uid, at)
  hang = null
  emit('hang', { active: false, uid, hung: true, source: at.source })
  return true
}

function rotateSelected(deg) {
  const rec = selected && items.get(selected)
  if (!rec) return
  moveItemInternal(rec.uid, { rotation_y_deg: round(wrapDeg(rec.rotationDeg + deg), 6) })
}

function removeItemInternal(uid) {
  const rec = items.get(uid)
  if (!rec) return
  if (selected === uid) select(null)
  scene.remove(rec.group)
  disposeChild(rec.child)
  disposeContactShadow(rec)
  items.delete(uid)
  emit('items', { change: 'remove', uid })
}

function clearItemsInternal() {
  itemsGen += 1
  select(null)
  for (const uid of [...items.keys()]) removeItemInternal(uid)
}

function worldBounds(rec) {
  rec.group.updateMatrixWorld(true)
  return rec.localBox.clone().applyMatrix4(rec.group.matrixWorld)
}

async function toggleRender(uid, render) {
  const rec = items.get(uid)
  if (!rec || rec.render === render) return
  if (render === 'splat' && !rec.lib.assets?.splat) return
  try {
    await setRender(rec, render)
  } catch (e) {
    throw reportError(`Could not switch "${rec.lib.name}" to ${render}`, e)
  }
  emit('items', { change: 'render', uid })
}

function itemInfo(r) {
  return {
    uid: r.uid,
    id: r.id,
    name: r.lib.name || r.id,
    lib: r.lib,
    render: r.render,
    hasGlb: !!r.lib.assets?.glb,
    hasSplat: !!r.lib.assets?.splat,
    position: [r.group.position.x, r.group.position.y, r.group.position.z],
    rotation_y_deg: r.rotationDeg,
    mounted: r.mounted,
    missing: !!r.missing,
  }
}

// --- selection: drag the item itself on the floor, a grip on its footprint rotates it (contract §2.3.4) ----------
// The footprint, label and grip are drawn by the UI (DOM over the canvas) from getFootprint(); no gizmo in the scene.
let selected = null
let gizmoMode = 'translate' // kept for older callers; there is one move model now
let snap = false            // Shift on desktop: moves snap to 5 cm, the grip to 15°
const drag = { mode: null, uid: null, off: new THREE.Vector3(), a0: 0, rot0: 0, plane: new THREE.Plane() }

function setGizmoMode(mode) {
  gizmoMode = mode === 'rotate' ? 'rotate' : 'translate'
  emit('selection', { uid: selected, gizmoMode })
}

function select(uid) {
  const next = uid && items.has(uid) ? uid : null
  if (drag.mode && drag.uid !== next) endItemDrag()
  if (hang && hang.uid !== next) cancelHang()
  selected = next
  emit('selection', { uid: selected, gizmoMode })
}

function setSnap(on) { snap = !!on }

// Footprint of a placed item in world space: corners [front-left, front-right, back-right, back-left] on the floor
// (the item's front faces +Z), its center, and the 8 corners of its box (for hit tests).
function getFootprint(uid) {
  const rec = items.get(uid)
  if (!rec?.localBox) return null
  rec.group.updateMatrixWorld(true)
  const { min, max } = rec.localBox
  const m = rec.group.matrixWorld
  const pt = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m)
  const floor = [[min.x, max.z], [max.x, max.z], [max.x, min.z], [min.x, min.z]].map(([x, z]) => pt(x, 0, z))
  const box = []
  for (const y of [Math.max(0, min.y), max.y]) for (const [x, z] of [[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z]]) box.push(pt(x, y, z))
  const center = floor.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(0.25)
  return { corners: floor.map((v) => v.toArray()), center: center.toArray(), box: box.map((v) => v.toArray()), height: max.y }
}

// Is a screen point on the item (its box seen from here, plus the footprint) or within `pad` px of it?
function hitItemAt(uid, clientX, clientY, pad = 16) {
  const f = getFootprint(uid)
  if (!f) return false
  const pts = f.box.map((p) => worldToScreen(p))
  if (pts.some((p) => !p.visible)) { setRay(clientX, clientY); return hitItems()?.uid === uid }
  const hull = convexHull(pts)
  return pointInHull(hull, clientX, clientY) || distToHull(hull, clientX, clientY) <= pad
}
function convexHull(ps) {
  const p = ps.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = [], hi = []
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q) }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}
function pointInHull(h, x, y) {
  if (h.length < 3) return false
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false
  }
  return true
}
function distToHull(h, x, y) {
  let best = Infinity
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return best
}

// Where a screen point's ray meets the floor (y = 0), or null.
function floorPointAt(clientX, clientY) {
  setRay(clientX, clientY)
  const p = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3())
  return p && p.distanceTo(raycaster.ray.origin) < 60 ? p : null
}

// Where a screen point's ray meets a plane, or null (behind the camera or too far).
function planePointAt(plane, clientX, clientY) {
  setRay(clientX, clientY)
  const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  return p && p.distanceTo(raycaster.ray.origin) < 60 ? p : null
}
// Drag to move: the item keeps its offset from the finger and doesn't rotate. It slides on its own horizontal plane
// (y stays its elevation); a hung item slides along its wall; with `lift` (Shift on desktop) it moves up and down only.
function beginItemDrag(uid, clientX, clientY, { lift = snap } = {}) {
  const rec = items.get(uid)
  if (!rec) return false
  let mode = 'move'
  const plane = new THREE.Plane()
  if (rec.mounted === 'wall') { mode = 'wall'; plane.copy(wallPlaneOf(rec)) } else if (lift) {
    mode = 'lift'
    const n = camera.getWorldDirection(new THREE.Vector3()).setY(0)
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
    plane.setFromNormalAndCoplanarPoint(n.normalize(), rec.group.position)
  } else plane.set(new THREE.Vector3(0, 1, 0), -rec.group.position.y)
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (selected !== uid) select(uid)
  Object.assign(drag, { mode, uid, off: rec.group.position.clone().sub(p) })
  drag.plane.copy(plane)
  orbit.enabled = false
  emit('drag', { mode, uid, phase: 'start' })
  return true
}
// The grip: the item turns by the angle the finger sweeps around its center (15° steps with `snapTo`).
function beginRotateDrag(uid, clientX, clientY) {
  const rec = items.get(uid)
  const p = rec && floorPointAt(clientX, clientY)
  if (!p) return false
  const c = rec.group.position
  Object.assign(drag, { mode: 'rotate', uid, a0: Math.atan2(p.x - c.x, p.z - c.z), rot0: rec.rotationDeg })
  orbit.enabled = false
  emit('drag', { mode: 'rotate', uid, phase: 'start' })
  return true
}
function dragTo(clientX, clientY, { snapTo = false } = {}) {
  const rec = drag.mode && items.get(drag.uid)
  if (!rec) return
  const p = drag.mode === 'rotate' ? floorPointAt(clientX, clientY) : planePointAt(drag.plane, clientX, clientY)
  if (!p) return
  const g = rec.group.position
  if (drag.mode === 'move') {
    moveItemInternal(drag.uid, { position: [round(p.x + drag.off.x, 6), g.y, round(p.z + drag.off.z, 6)] })
  } else if (drag.mode === 'lift') {
    let y = clampElev(p.y + drag.off.y)
    if (snap) y = Math.round(y / 0.01) * 0.01
    moveItemInternal(drag.uid, { position: [g.x, round(y, 6), g.z] })
  } else if (drag.mode === 'wall') {
    const q = p.add(drag.off)
    moveItemInternal(drag.uid, { position: [round(q.x, 6), round(clampElev(q.y), 6), round(q.z, 6)] })
  } else {
    const c = rec.group.position
    let deg = drag.rot0 + (Math.atan2(p.x - c.x, p.z - c.z) - drag.a0) / DEG
    if (snapTo || snap) deg = Math.round(deg / 15) * 15
    moveItemInternal(drag.uid, { rotation_y_deg: round(wrapDeg(deg), 6) })
  }
}
function endItemDrag() {
  if (!drag.mode) return
  const d = { mode: drag.mode, uid: drag.uid }
  drag.mode = null
  drag.uid = null
  orbit.enabled = view === 'orbit'
  emit('drag', { ...d, phase: 'end' })
}

// Remove with a way back: returns what restoreItem() needs to put it back (same uid, place, turn and render).
function removeItemWithUndo(uid) {
  const rec = items.get(uid)
  if (!rec) return null
  const snapItem = { uid, id: rec.id, name: rec.lib.name || rec.id, position: rec.group.position.toArray(), rotation_y_deg: rec.rotationDeg, render: rec.render,
    mounted: rec.mounted, missing: rec.missing ? { ...rec.lib.dims_cm } : undefined }
  removeItemInternal(uid)
  return snapItem
}
async function restoreItem(s) {
  const uid = await addItemInternal(s.id, { uid: s.uid, position: s.position, rotation_y_deg: s.rotation_y_deg, render: s.render, mounted: s.mounted, missing: s.missing })
  select(uid)
  return uid
}

// --- views --------------------------------------------------------------------
let view = 'orbit'
let orbitSaved = null
const fp = { yaw: 0, pitch: 0 }
const fpMove = { forward: 0, side: 0, fast: false } // first-person walking input, -1…1 (set by input.js)

function applyFpRotation() {
  camera.rotation.order = 'YXZ'
  camera.rotation.set(fp.pitch, fp.yaw, 0)
}

// Scan viewpoints (contract §4.9): real camera poses from the capture, in room coordinates as of `vpBase` (the room
// transform when they were loaded). Alignment edits since then move them along: world = now * vpBase^-1 * pose.
let vpBase = new THREE.Matrix4()
let vpIndex = -1
const transformMatrix = (t) => new THREE.Matrix4().compose(new THREE.Vector3(...t.position),
  new THREE.Quaternion(...t.quaternion), new THREE.Vector3(t.scale, t.scale, t.scale))
const viewpoints = () => roomConfig.viewpoints || []

function viewpointPose(v) {
  const delta = transformMatrix(roomConfig.transform).multiply(vpBase.clone().invert())
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...v.position), new THREE.Quaternion(...v.quaternion),
    new THREE.Vector3(1, 1, 1)).premultiply(delta)
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
  m.decompose(pos, q, sc)
  return { pos, q }
}

// Stand at a scan viewpoint (eye height stays the view's), looking where the phone looked.
function applyViewpoint(i) {
  const vps = viewpoints()
  if (!vps.length) return false
  vpIndex = ((i % vps.length) + vps.length) % vps.length
  const { pos, q } = viewpointPose(vps[vpIndex])
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  camera.position.set(pos.x, camera.position.y, pos.z)
  fp.yaw = Math.atan2(-d.x, -d.z)
  fp.pitch = Math.max(-0.35, Math.min(0.15, Math.asin(Math.max(-1, Math.min(1, d.y)))))
  return true
}

function nearestViewpointToCenter() {
  const c = room.kind === 'splat' ? roomWorldBox().getCenter(new THREE.Vector3()) : new THREE.Vector3()
  let best = 0, bestD = Infinity
  viewpoints().forEach((v, i) => {
    const { pos } = viewpointPose(v)
    const d = (pos.x - c.x) ** 2 + (pos.z - c.z) ** 2
    if (d < bestD) { bestD = d; best = i }
  })
  return best
}

// With { glide: true } (the walk bar) the camera glides there instead of jumping.
function gotoViewpoint(i, { glide: smooth = false } = {}) {
  const n = viewpoints().length
  if (!n) { toast('This room has no scan viewpoints: retrain it with nook-scan v2.'); return false }
  if (view === 'orbit') { setViewInternal('standing'); smooth = false }
  const from = { x: camera.position.x, z: camera.position.z, yaw: fp.yaw, pitch: fp.pitch }
  applyViewpoint(i)
  if (smooth) {
    const to = { x: camera.position.x, z: camera.position.z, yaw: fp.yaw, pitch: fp.pitch }
    Object.assign(fp, { yaw: from.yaw, pitch: from.pitch })
    camera.position.x = from.x
    camera.position.z = from.z
    startGlide(to)
  }
  camera.position.y = EYE[view]
  applyFpRotation()
  emit('viewpoint', { index: vpIndex, count: n })
  return true
}

// Next (+1) or previous (-1) scan viewpoint; the first step goes to the one nearest the room center.
function stepViewpoint(delta, opts) {
  return gotoViewpoint(vpIndex < 0 ? nearestViewpointToCenter() : vpIndex + delta, opts)
}

// First-person glides (tap the floor to walk there, viewpoint steps): about 0.6 s, eased; WASD cancels one.
const glide = { active: false, t: 0, dur: 0.6, from: null, to: null }
function startGlide(to, dur = 0.6) {
  Object.assign(glide, { active: true, t: 0, dur, from: { x: camera.position.x, z: camera.position.z, yaw: fp.yaw, pitch: fp.pitch }, to: { yaw: fp.yaw, pitch: fp.pitch, ...to } })
}
function stepGlide(dt) {
  glide.t += dt
  const k = Math.min(1, glide.t / glide.dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
  const { from: a, to: b } = glide
  const dyaw = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw))
  camera.position.x = a.x + (b.x - a.x) * e
  camera.position.z = a.z + (b.z - a.z) * e
  fp.yaw = a.yaw + dyaw * e
  fp.pitch = a.pitch + (b.pitch - a.pitch) * e
  if (k >= 1) { glide.active = false; walkTarget.fade = 0.6 }
}

// The chalk walk target: a flat marker on the floor where a tap sends you; it fades once you arrive.
const walkTarget = (() => {
  const g = new THREE.Group()
  const add = (geo, opacity) => {
    const m = new THREE.Mesh(geo.rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xece8e0, transparent: true, opacity, depthTest: false, depthWrite: false }))
    m.renderOrder = 30
    g.add(m)
  }
  add(new THREE.RingGeometry(0.27, 0.282, 64), 0.35)
  add(new THREE.CircleGeometry(0.15, 48), 0.12)
  add(new THREE.RingGeometry(0.14, 0.156, 48), 1)
  add(new THREE.CircleGeometry(0.022, 20), 1)
  g.position.y = 0.006
  g.visible = false
  scene.add(noRaycast(g))
  return { group: g, base: g.children.map((c) => c.material.opacity), fade: 0 }
})()
function tickWalkTarget(dt) {
  if (!walkTarget.group.visible || glide.active || !(walkTarget.fade > 0)) return
  walkTarget.fade -= dt
  const k = Math.max(0, walkTarget.fade / 0.6)
  walkTarget.group.children.forEach((c, i) => { c.material.opacity = walkTarget.base[i] * k })
  if (k <= 0) walkTarget.group.visible = false
}

// Walk (glide) to a floor point in first person; kept inside the room. Returns false if there's no floor there.
function walkTo(clientX, clientY) {
  if (view === 'orbit') return false
  const p = floorPointAt(clientX, clientY)
  if (!p || p.distanceTo(camera.position) > 15) return false
  const box = roomWorldBox()
  p.x = Math.min(box.max.x - 0.2, Math.max(box.min.x + 0.2, p.x))
  p.z = Math.min(box.max.z - 0.2, Math.max(box.min.z + 0.2, p.z))
  walkTarget.group.position.set(p.x, 0.006, p.z)
  walkTarget.group.children.forEach((c, i) => { c.material.opacity = walkTarget.base[i] })
  walkTarget.group.visible = true
  walkTarget.fade = 0
  startGlide({ x: p.x, z: p.z })
  emit('walk', { to: [p.x, 0, p.z] })
  return true
}

function setViewInternal(v) {
  if (!VIEWS.includes(v)) { reportError(`Unknown view "${v}"`); return }
  glide.active = false
  walkTarget.group.visible = false
  if (v === 'orbit') {
    if (view !== 'orbit' && orbitSaved) {
      camera.position.copy(orbitSaved.pos)
      orbit.target.copy(orbitSaved.target)
    }
    view = 'orbit'
    orbit.enabled = !drag.mode
    orbit.update()
  } else {
    if (view === 'orbit') {
      orbitSaved = { pos: camera.position.clone(), target: orbit.target.clone() }
      const rec = selected && items.get(selected)
      fp.pitch = v === 'seated' ? -0.05 : -0.12
      if (rec) {
        // Sit in (or stand at) the selected piece, looking where its front (+Z) faces.
        camera.position.set(rec.group.position.x, 0, rec.group.position.z)
        fp.yaw = rec.rotationDeg * DEG + Math.PI
      } else if (viewpoints().length) {
        // Start where the phone actually was: the splat is sharpest from there.
        applyViewpoint(nearestViewpointToCenter())
      } else {
        const t = orbit.target
        const dir = new THREE.Vector3(camera.position.x - t.x, 0, camera.position.z - t.z)
        const len = dir.length()
        if (len < 1e-6) dir.set(0, 0, 1); else dir.divideScalar(len)
        const back = Math.min(1.2, len)
        camera.position.set(t.x + dir.x * back, 0, t.z + dir.z * back)
        fp.yaw = Math.atan2(dir.x, dir.z)
      }
    }
    view = v
    orbit.enabled = false
    camera.position.y = EYE[v]
    applyFpRotation()
  }
  emit('view', { view })
}

// First-person look by a pointer delta in px (drag to look).
function lookBy(dx, dy) {
  if (view === 'orbit') return
  fp.yaw -= dx * 0.004
  fp.pitch = Math.max(-1.45, Math.min(1.45, fp.pitch - dy * 0.004))
  applyFpRotation()
}

function setMove({ forward = 0, side = 0, fast = false } = {}) {
  fpMove.forward = forward
  fpMove.side = side
  fpMove.fast = !!fast
}

function updateFp(dt) {
  const fwd = fpMove.forward
  const side = fpMove.side
  if ((fwd || side) && glide.active) { glide.active = false; walkTarget.fade = 0.6 }
  if (glide.active) stepGlide(dt)
  else if (fwd || side) {
    const speed = (fpMove.fast ? 2.4 : 1.2) * dt
    const f = new THREE.Vector3(-Math.sin(fp.yaw), 0, -Math.cos(fp.yaw))
    const r = new THREE.Vector3(Math.cos(fp.yaw), 0, -Math.sin(fp.yaw))
    camera.position.addScaledVector(f, fwd * speed).addScaledVector(r, side * speed)
  }
  camera.position.y = EYE[view]
  applyFpRotation()
}

function cameraTarget() {
  if (view === 'orbit') return orbit.target.toArray()
  const d = new THREE.Vector3(); camera.getWorldDirection(d)
  return camera.position.clone().add(d).toArray()
}

function restoreCamera(cam) {
  if (!cam || !VIEWS.includes(cam.view)) return
  const pos = Array.isArray(cam.position) && cam.position.length === 3 && cam.position.every(isNum) ? cam.position : null
  const tgt = Array.isArray(cam.target) && cam.target.length === 3 && cam.target.every(isNum) ? cam.target : null
  if (cam.view === 'orbit') {
    setViewInternal('orbit')
    if (pos) camera.position.fromArray(pos)
    if (tgt) orbit.target.fromArray(tgt)
    orbit.update()
  } else {
    setViewInternal(cam.view)
    if (pos) camera.position.set(pos[0], EYE[cam.view], pos[2])
    if (pos && tgt) {
      const d = new THREE.Vector3().fromArray(tgt).sub(new THREE.Vector3().fromArray(pos))
      if (d.lengthSq() > 1e-9) {
        d.normalize()
        fp.yaw = Math.atan2(-d.x, -d.z)
        fp.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)))
      }
    }
    applyFpRotation()
  }
}

// --- raycasting, tools ----------------------------------------------------------
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

function setRay(clientX, clientY) {
  // Objects added or moved since the last frame have stale world matrices; refresh before picking.
  scene.updateMatrixWorld()
  camera.updateMatrixWorld()
  const r = canvas.getBoundingClientRect()
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
}
function uidOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData?.uid) return o.userData.uid
  return null
}
function hitItems() {
  const hits = raycaster.intersectObjects([...items.values()].map((r) => r.group), true)
  for (const h of hits) { const uid = uidOf(h.object); if (uid) return { uid, point: h.point.clone(), distance: h.distance } }
  return null
}
function hitRoomSplat() {
  if (!room.mesh || room.kind !== 'splat') return null
  // Test every splat of the scan, not the view's LoD selection, so that a pick doesn't depend on the camera. Spark has
  // no option for this: raycast() follows these two context values, set by each update (pinned Spark, see index.html).
  const c = room.mesh.context, lod = c.enableLod.value, drawn = c.numSplats.value
  if (lod) { c.enableLod.value = false; c.numSplats.value = room.mesh.packedSplats.numSplats }
  try {
    const hits = raycaster.intersectObject(room.mesh, false)
    return hits.length ? { point: hits[0].point.clone(), distance: hits[0].distance } : null
  } finally {
    if (lod) { c.enableLod.value = true; c.numSplats.value = drawn }
  }
}
function hitAnything() {
  const cands = []
  const it = hitItems(); if (it) cands.push(it)
  const sp = hitRoomSplat(); if (sp) cands.push(sp)
  if (placeholderGroup.visible) {
    const ph = raycaster.intersectObjects(placeholderGroup.children, false)[0]
    if (ph) cands.push({ point: ph.point.clone(), distance: ph.distance })
  }
  const fl = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3())
  if (fl) cands.push({ point: fl, distance: fl.distanceTo(raycaster.ray.origin) })
  cands.sort((a, b) => a.distance - b.distance)
  return cands[0] || null
}

// Measure tool: two points (floor, items or scan). The UI draws the points, line and distance (DOM) and lets you drag
// a point; a third tap starts again.
const measure = { active: false, points: [] }
function emitMeasure() {
  const m = getMeasure()
  emit('measure', { active: measure.active, points: measure.points.length, meters: m ? m.meters : null })
}
function setMeasureActive(on) {
  measure.active = !!on
  if (on) { cancelPickMode(); select(null) }
  emitMeasure()
}
function clearMeasure() {
  measure.points = []
  emitMeasure()
}
function addMeasurePoint(p) {
  if (measure.points.length >= 2) measure.points = []
  measure.points.push(p.clone())
  emitMeasure()
}
function getMeasure() {
  if (measure.points.length < 2) return null
  const [a, b] = measure.points
  return { a: a.toArray(), b: b.toArray(), meters: a.distanceTo(b) }
}
// The world point under a screen point: 'any' (items, scan, placeholder, floor) or 'scan' (the room splat only).
function pointAt(clientX, clientY, what = 'any') {
  setRay(clientX, clientY)
  const hit = what === 'scan' ? hitRoomSplat() : hitAnything()
  return hit ? hit.point : null
}
// Move measure point i (0 or 1) to what's under a screen point; false if nothing is there.
function setMeasurePointAt(i, clientX, clientY) {
  const p = pointAt(clientX, clientY)
  if (!p || !measure.points[i]) return false
  measure.points[i] = p
  emitMeasure()
  return true
}

// Alignment pick modes. 'floor': a tap previews (getPick().floor: how far the room moves and, from the scan around
// the point, how much it tilts there) and applyPickFloor() applies it. 'two': two scan points (draggable), then
// applyTwoPointScale(meters).
let pickMode = null
let twoPoints = []
let floorPick = null // { point, fit: { quaternion, tilt } | null }
function getPick() {
  return {
    mode: pickMode, points: twoPoints.length,
    measured: twoPoints.length === 2 ? twoPoints[0].distanceTo(twoPoints[1]) : null,
    pointList: twoPoints.map((p) => p.toArray()),
    floor: floorPick ? { point: floorPick.point.toArray(), moveCm: round(-floorPick.point.y * 100, 1), tiltDeg: floorPick.fit ? round(floorPick.fit.tilt, 2) : 0, level: !!floorPick.fit } : null,
  }
}
function emitPick(phase) { emit('pick', { ...getPick(), phase }) }
function startPickMode(mode) {
  if (room.kind !== 'splat' || !room.mesh) { toast('Load a room scan first (alignment works on the splat).', 'info'); return }
  measure.active = false
  emitMeasure()
  select(null)
  pickMode = mode
  twoPoints = []
  floorPick = null
  emitPick('start')
}
function cancelPickMode() {
  if (!pickMode && !twoPoints.length && !floorPick) return
  pickMode = null
  twoPoints = []
  floorPick = null
  emitPick('cancel')
}
// The scan's floor around a point: a plane fitted to splat centers within 60 cm (two passes, outliers dropped).
// Returns the rotation that levels it, or null when it's already level (< 0.3°), too steep (> 12°) or too sparse.
function fitFloorAt(p) {
  if (!room.mesh) return null
  const m = room.mesh.matrixWorld, v = new THREE.Vector3()
  const xs = [], ys = [], zs = []
  const n = room.splatCount // not mesh.numSplats: with LoD on, that's the view's selection
  const stride = Math.max(1, Math.floor(n / 400000))
  room.mesh.forEachSplat((i, c) => {
    if (i % stride) return
    v.copy(c).applyMatrix4(m)
    const dx = v.x - p.x, dz = v.z - p.z, dy = v.y - p.y
    if (dx * dx + dz * dz < 0.36 && Math.abs(dy) < 0.12) { xs.push(dx); ys.push(dy); zs.push(dz) }
  })
  let keep = xs.map((_, i) => i), plane = null
  for (let pass = 0; pass < 2; pass++) {
    if (keep.length < 60) return null
    // least squares dy = a dx + b dz + c
    let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sxy = 0, szy = 0, sy = 0
    for (const i of keep) { const x = xs[i], z = zs[i], y = ys[i]; sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z; sxy += x * y; szy += z * y; sy += y }
    const N = keep.length
    const A = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, N]], B = [sxy, szy, sy]
    const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
    const D = det(A)
    if (Math.abs(D) < 1e-12) return null
    const col = (k) => A.map((row, r) => row.map((x, c) => (c === k ? B[r] : x)))
    plane = { a: det(col(0)) / D, b: det(col(1)) / D, c: det(col(2)) / D }
    keep = keep.filter((i) => Math.abs(ys[i] - (plane.a * xs[i] + plane.b * zs[i] + plane.c)) < 0.025)
  }
  const normal = new THREE.Vector3(-plane.a, 1, -plane.b).normalize()
  const tilt = Math.acos(Math.min(1, normal.y)) / DEG
  if (tilt < 0.3 || tilt > 12) return null
  return { quaternion: new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0)), tilt }
}
function previewFloorAt(clientX, clientY) {
  const p = pointAt(clientX, clientY, 'scan')
  if (!p) { toast('No scan there: tap open floor.', 'info', 3000); return false }
  floorPick = { point: p, fit: fitFloorAt(p) }
  emitPick('preview')
  return true
}
// Pick floor: level the scan around the point (when it tilts there), then shift it so the point is at y = 0.
function applyPickFloor() {
  if (!floorPick) return
  const { point: P, fit } = floorPick
  const t = roomConfig.transform
  const pos = new THREE.Vector3().fromArray(t.position)
  if (fit) {
    pos.sub(P).applyQuaternion(fit.quaternion).add(P)
    const q = fit.quaternion.clone().multiply(new THREE.Quaternion().fromArray(t.quaternion)).normalize()
    t.quaternion = q.toArray().map((v) => round(v, 8))
  }
  pos.y -= P.y
  t.position = pos.toArray().map((v) => round(v, 6))
  applyRoomTransform()
  pickMode = null
  floorPick = null
  syncRoom('changed')
  emitPick('applied')
  toast(`Floor set${fit ? ` and levelled (${round(fit.tilt, 1)}°)` : ''}: the room moved ${Math.abs(P.y * 100).toFixed(1)} cm. Save room to keep it.`, 'ok')
}
function addTwoPoint(p) {
  if (twoPoints.length >= 2) return
  twoPoints.push(p.clone())
  emitPick(twoPoints.length === 2 ? 'ready' : 'point')
}
// Move check-size point i to what's under a screen point (the scan only).
function setPickPointAt(i, clientX, clientY) {
  const p = pointAt(clientX, clientY, 'scan')
  if (!p || !twoPoints[i]) return false
  twoPoints[i] = p
  emitPick(twoPoints.length === 2 ? 'ready' : 'point')
  return true
}
function resetTwoPoints() {
  twoPoints = []
  pickMode = 'two'
  emitPick('start')
}
function applyTwoPointScale(real) {
  if (twoPoints.length !== 2 || !room.mesh) return
  if (!(real > 0)) { toast('Enter the real distance in meters.', 'info'); return }
  const [a, b] = twoPoints
  const cur = a.distanceTo(b)
  if (cur < 1e-6) { toast('The two points are the same; pick again.', 'info'); return }
  const k = real / cur
  const t = roomConfig.transform
  // Scale about the floor point under A, so the floor (y = 0) stays put.
  const pivot = new THREE.Vector3(a.x, 0, a.z)
  const pos = new THREE.Vector3().fromArray(t.position).sub(pivot).multiplyScalar(k).add(pivot)
  const la = room.mesh.worldToLocal(a.clone()), lb = room.mesh.worldToLocal(b.clone())
  t.position = pos.toArray().map((v) => round(v, 6))
  t.scale = round(t.scale * k, 6)
  roomConfig.measured = { a: la.toArray().map((v) => round(v, 5)), b: lb.toArray().map((v) => round(v, 5)), meters: real }
  applyRoomTransform()
  pickMode = null
  twoPoints = []
  syncRoom('changed')
  emitPick('applied')
  toast(`Scale set to ${t.scale.toFixed(4)} (×${k.toFixed(4)}). Save room to keep it.`, 'ok')
}

// A click/tap at a screen point: an alignment pick, a measure point, walking (first person) or (de)selecting an item.
function tap(clientX, clientY) {
  setRay(clientX, clientY)
  if (hang) return hangAt(clientX, clientY)
  if (pickMode === 'floor') return previewFloorAt(clientX, clientY)
  if (pickMode === 'two') {
    const hit = hitRoomSplat()
    if (!hit) { toast('No scan there: tap something in the scan.', 'info', 3000); return }
    return addTwoPoint(hit.point)
  }
  if (measure.active) {
    const hit = hitAnything()
    if (hit) addMeasurePoint(hit.point)
    return
  }
  const hit = hitItems()
  if (hit) { select(hit.uid); return }
  // The see-through shell: a tap on a wall shows its length (§2.7 v4)
  if (shell.visible && !selected) {
    const sw = shellWallHit()
    selectWall(sw ? sw.wall.id : null)
    if (sw) return
  } else if (shell.selected) selectWall(null)
  select(null)
  if (view !== 'orbit') walkTo(clientX, clientY)
}

// --- layouts ------------------------------------------------------------------------
async function apiJson(url, opts) {
  let res
  try { res = await fetch(url, withNook(opts)) } catch (e) { throw new Error(`could not reach ${url} (${e.message})`) }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) { const err = new Error(data?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
  return data
}

let layoutNames = []
let layoutDetails = [] // [{ name, items, updated, legacy }] from a rooms server, else [{ name }]
let layoutName = '' // the layout name field: what Save writes, and what renders are tagged with
function setLayoutName(name) { layoutName = String(name ?? '') }
// Layouts belong to the open room (?room=<name>); the placeholder and dropped files use the flat v1 list.
const layoutQuery = () => (roomName && roomsApi && !room.dropped ? `?room=${encodeURIComponent(roomName)}` : '')

function layoutDoc(name) {
  return {
    version: 1,
    name,
    ...(layoutQuery() ? { room_name: roomName } : {}),
    library: LIBRARY_URL,
    room: clone(roomConfig),
    items: [...items.values()].map((r) => ({
      uid: r.uid,
      id: r.id,
      render: r.render,
      position: [round(r.group.position.x, 6), round(r.group.position.y, 6), round(r.group.position.z, 6)],
      rotation_y_deg: round(r.rotationDeg, 6),
      ...(r.mounted === 'wall' ? { mounted: 'wall' } : {}),
      ...(validDims(r.lib.dims_cm) ? { dims_cm: { ...r.lib.dims_cm } } : {}), // a placeholder's size if the piece goes missing (§2.8)
    })),
    camera: { view, position: camera.position.toArray().map((v) => round(v, 5)), target: cameraTarget().map((v) => round(v, 5)) },
  }
}

async function saveLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug like "reading-corner" (got "${name}")`)
  try {
    await apiJson(`/api/layouts/${name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutDoc(name)) })
  } catch (e) {
    throw reportError(e.status ? `Could not save layout "${name}"` : `Layout "${name}" not saved: kakapo isn't answering`, e)
  }
  setLayoutName(name)
  setDirty({ ...dirty, layout: false })
  emit('layouts', { name })
  quiet(refreshLayouts())
}

async function loadLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug (got "${name}")`)
  let doc
  try {
    doc = await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`)
  } catch (e) {
    throw reportError(e.status === 404 ? `No layout named "${name}"` : `Could not load layout "${name}"`, e)
  }
  if (!doc || !Array.isArray(doc.items)) throw reportError(`Layout "${name}" has no items array`)
  if (doc.library && doc.library !== LIBRARY_URL) toast(`Layout "${name}" was made with library ${doc.library}`, 'info')
  // Switch rooms only when the layout names a scan we aren't showing; keep the current alignment otherwise.
  if (doc.room && typeof doc.room === 'object') {
    const want = typeof doc.room.splat === 'string' && doc.room.splat ? doc.room.splat : null
    // A layout of the open room (its room_name, or the same scan file name) keeps the room as it is.
    const ours = !!roomName && !room.dropped && room.kind === 'splat' && (doc.room_name === roomName || (!doc.room_name && splatStem(want) === roomName))
    if (want && !ours && (want !== roomConfig.splat || room.dropped || room.kind !== 'splat')) {
      const other = typeof doc.room_name === 'string' && doc.room_name !== roomName && roomsApi ? doc.room_name : null
      try {
        if (other) await openRoom(other)
        else await loadRoomInternal(doc.room, { frame: !doc.camera })
      } catch { /* reported; keep going with the placeholder */ }
    }
  }
  await quietly(async () => {
    clearItemsInternal()
    const missing = doc.items.filter((it) => it && typeof it.id === 'string' && !library.some((l) => l.id === it.id))
    const results = await Promise.allSettled(doc.items.map((it) => addItemInternal(it.id, {
      uid: it.uid, position: it.position, rotation_y_deg: it.rotation_y_deg, render: it.render, mounted: it.mounted,
      missing: missing.includes(it) ? (validDims(it.dims_cm) ? it.dims_cm : MISSING_DIMS) : undefined,
    })))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast(`Layout "${name}": ${failed} of ${doc.items.length} items could not be placed.`, 'error')
    if (missing.length) {
      const n = missing.length
      toast(`${n === 1 ? 'One piece in' : `${n} pieces in`} "${name}" ${n === 1 ? "isn't" : "aren't"} in the library any more: shown as ${n === 1 ? 'a box' : 'boxes'}. Restore ${n === 1 ? 'it' : 'them'} from the Library, or remove ${n === 1 ? 'it' : 'them'}.`, 'info', 9000)
    }
  })
  if (doc.camera) restoreCamera(doc.camera)
  setLayoutName(name)
  setDirty({ ...dirty, layout: false })
  emit('layouts', { name })
}

// Deletes one of the open room's layouts (v1 layouts can't be deleted).
async function deleteLayoutInternal(name) {
  if (!layoutQuery()) throw reportError('Only a room\'s own layouts can be deleted; open a room first')
  try {
    await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`, { method: 'DELETE' })
  } catch (e) { throw reportError(`Could not delete layout "${name}"`, e) }
  if (layoutName === name) setLayoutName('')
  await refreshLayouts()
}

async function listLayoutsInternal() {
  const data = await apiJson(`/api/layouts${layoutQuery()}`)
  const names = Array.isArray(data?.layouts) ? data.layouts : []
  layoutDetails = Array.isArray(data?.details) ? data.details : names.map((n) => ({ name: n }))
  return names
}

async function refreshLayouts() {
  let names = []
  try { names = await listLayoutsInternal() } catch (e) { reportError('Could not list layouts', e); return }
  layoutNames = names
  emit('layouts', { names: names.slice(), details: layoutDetails.slice() })
}

// --- render this view (contract §2.6.5) ---------------------------------------------------
// First entry is the default. Nano Banana kept the camera and layout exactly in the live comparison (evals/golden/RESULTS.md);
// Kontext re-framed the shot and Qwen restyled the floor (and is ~6x slower).
export const RENDER_MODELS = {
  'nano-banana': { label: 'Nano Banana edit', price: () => 0.0398 },
  kontext: { label: 'FLUX.1 Kontext [pro]', price: () => 0.04 },
  qwen: { label: 'Qwen Image Edit', price: (mp) => 0.03 * mp },
}
export const DEFAULT_RENDER_PROMPT = 'Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, soft natural daylight, subtle contact shadows. Do not add, remove or move anything.'
const CAPTURE_MAX = 1536 // px on the long side
let renders = []
let renderMock = false
export const fmtUsd = (v) => `$${Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)}`

// The canvas only, without the planning helpers (grid, walk target; the selection and markers are DOM). `maxPx` caps the long
// side; `aspect` (w/h) crops the centre to that shape (thumbnails).
function captureView({ maxPx = CAPTURE_MAX, aspect = null, quality = 0.92 } = {}) {
  const hide = [grid, walkTarget.group, shellGroup]
  const vis = hide.map((o) => o.visible)
  for (const o of hide) o.visible = false
  // Center the shot on the camera (the on-screen view is shifted right to clear the sidebar).
  camera.clearViewOffset()
  camera.updateProjectionMatrix()
  if (trueColor) applyTone(false) // renders and thumbnails always use the normal look
  try {
    renderFrame() // read back in the same task, before the browser clears the drawing buffer
    let sw = canvas.width, sh = canvas.height
    if (aspect > 0) { if (sw / sh > aspect) sw = Math.round(sh * aspect); else sh = Math.round(sw / aspect) }
    const k = Math.min(1, maxPx / Math.max(sw, sh))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(sw * k))
    out.height = Math.max(1, Math.round(sh * k))
    out.getContext('2d').drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, out.width, out.height)
    return { dataUrl: out.toDataURL('image/jpeg', quality), width: out.width, height: out.height }
  } finally {
    if (trueColor) applyTone(true)
    hide.forEach((o, i) => { o.visible = vis[i] })
    updateViewOffset()
  }
}

export function renderPrice(model, shot) {
  return RENDER_MODELS[model].price(shot ? (shot.width * shot.height) / 1e6 : 1)
}

async function postRender(shot, model, prompt) {
  const layout = layoutName.trim()
  let meta
  emit('render', { phase: 'start', model })
  try {
    meta = await apiJson('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: shot.dataUrl, model, prompt: prompt || undefined, view, layout: SLUG.test(layout) ? layout : undefined }),
    })
  } catch (e) {
    emit('render', { phase: 'failed', model })
    throw reportError('Render failed', e)
  }
  emit('render', { phase: 'done', model, meta })
  renders = [meta, ...renders.filter((r) => r.name !== meta.name)]
  emit('renders', { renders: renders.slice() })
  return meta
}

async function renderViewInternal(opts = {}) {
  const o = opts || {}
  const model = o.model ?? 'nano-banana'
  if (!Object.hasOwn(RENDER_MODELS, model)) throw reportError(`Unknown render model "${model}" (use ${Object.keys(RENDER_MODELS).join(', ')})`)
  if (o.prompt != null && typeof o.prompt !== 'string') throw reportError('Render prompt must be a string')
  await env.chain // never capture mid-bake (the splats are sorted for the probe then)
  let shot
  try { shot = captureView() } catch (e) { throw reportError('Could not capture the view', e) }
  return postRender(shot, model, o.prompt)
}

async function listRendersInternal() {
  let data
  try { data = await apiJson('/api/renders') } catch (e) { throw reportError('Could not list renders', e) }
  renders = Array.isArray(data?.renders) ? data.renders : []
  renderMock = data?.mock === true
  emit('renders', { renders: renders.slice() })
  return renders.slice()
}

// --- look ------------------------------------------------------------------------------------
// Look (exposure, warmth) lives in roomConfig.look, so Save room persists it.
function getLook() {
  const l = roomConfig.look
  return { exposure: l.exposure, warmth: l.warmth, trueColor, contactShadows, envSource: env.source, envProbe: env.probe ? env.probe.slice() : null, roomKind: room.kind }
}
function emitLook() { emit('look', getLook()) }
function applyLook() {
  const l = roomConfig.look
  renderer.toneMappingExposure = l.exposure
  post.mat.uniforms.uTint.value.copy(trueColor ? new THREE.Vector3(1, 1, 1) : warmthTint(l.warmth))
  emitLook()
}
function setLook(s) {
  const l = roomConfig.look
  if (isNum(s.exposure)) l.exposure = clampNum(s.exposure, 0.25, 4, 1)
  if (isNum(s.warmth)) l.warmth = clampNum(s.warmth, -1, 1, 0)
  applyLook()
  touchRoom()
}

// --- render loop + overlay hooks -------------------------------------------------------
const frameFns = new Set()
function onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn) }

// World point (Vector3 or [x, y, z]) to client px; `visible` is false when it's behind the camera.
const tmpV = new THREE.Vector3()
function worldToScreen(p) {
  if (Array.isArray(p)) tmpV.fromArray(p); else tmpV.copy(p)
  camera.updateMatrixWorld()
  tmpV.project(camera)
  const visible = !(tmpV.z > 1 || tmpV.z < -1)
  const r = canvas.getBoundingClientRect()
  return { x: r.left + (tmpV.x * 0.5 + 0.5) * r.width, y: r.top + (-tmpV.y * 0.5 + 0.5) * r.height, visible }
}

const clock = new THREE.Clock()
let renderErrorReported = false
const lastCam = new THREE.Matrix4()
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (view === 'orbit') orbit.update()
    else updateFp(dt)
    tickWalkTarget(dt)
    camera.updateMatrixWorld()
    if (!lastCam.equals(camera.matrixWorld)) { lastCam.copy(camera.matrixWorld); wake() }
    if (performance.now() > awakeUntil) return
    if (!baking) renderFrame() // frozen while the environment bakes (Spark is sorted for the probe then)
    for (const fn of frameFns) fn(dt)
  } catch (e) {
    if (!renderErrorReported) reportError('Rendering failed', e)
    renderErrorReported = true
  }
})

// --- state for window.nook (contract §2.4, §2.6) ------------------------------------------
function getState() {
  const t = roomConfig.transform
  return {
    room: {
      name: roomName,
      kind: room.kind,
      loaded: room.loaded,
      ...(room.kind === 'splat' ? { splatCount: room.splatCount, lod: room.lod } : {}),
      transform: { position: t.position.slice(), quaternion: t.quaternion.slice(), scale: t.scale },
      viewpoints: viewpoints().length,
      roomplan: !!shell.url,
    },
    items: [...items.values()].map((r) => {
      const b = worldBounds(r)
      return {
        uid: r.uid,
        id: r.id,
        render: r.render,
        position: [r.group.position.x, r.group.position.y, r.group.position.z],
        rotation_y_deg: r.rotationDeg,
        mounted: r.mounted,
        ...(r.missing ? { missing: true } : {}),
        worldBounds: { min: b.min.toArray(), max: b.max.toArray() },
      }
    }),
    camera: { view, position: camera.position.toArray() },
    shell: shell.visible,
  }
}

function getRenderSettings() {
  return {
    toneMapping: trueColor ? 'none' : 'aces',
    trueColor,
    exposure: roomConfig.look.exposure,
    warmth: roomConfig.look.warmth,
    envSource: env.source,
    contactShadows,
    shadowCount: [...items.values()].filter((r) => r.shadow && r.shadow.visible).length,
  }
}

// The first room (§2.7): ?room=<name>; else the room last opened on this device, if it still exists; else /api/room
// as in v1 (named after the room it points at). A ?room that isn't a room shows the placeholder (getMissingRoom()).
async function startRoom() {
  const want = params.get('room')
  const list = await listRoomsInternal().catch(() => null)
  const has = (n) => !!n && !!list && list.some((r) => r.name === n)
  if (has(want)) return openRoom(want).catch(() => {})
  if (want && list && roomsApi) {
    missingRoom = want
    emit('room', { phase: 'missing', name: want })
    try { await loadRoomInternal({ version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } }, { name: null }) } catch { /* reported */ }
    return refreshLayouts()
  }
  const last = store.get(LAST_ROOM_KEY)
  if (has(last)) return openRoom(last).catch(() => {})
  let cfg
  try { cfg = await apiJson('/api/room') } catch (e) {
    reportError('Could not read /api/room; using the placeholder room', e)
    cfg = { version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } }
  }
  const current = list && list.find((r) => r.current)
  const name = current && splatStem(cfg?.splat) === current.name ? current.name : null
  savedRoomConfig = clone(cfg)
  if (name) rememberRoom(name)
  await afterRoomChosen(name, list, loadRoomInternal(cfg, { name }).catch(() => {}))
}

// Initial load: the room, the library, layouts and renders.
async function init() {
  await Promise.allSettled([startRoom(), loadLibrary(), listRendersInternal()])
}

export const engine = {
  events,
  errors,
  canvas,
  three: { scene, camera, renderer, orbit },
  // setup
  init,
  mount,
  setViewInset,
  // state
  getRoomName: () => roomName,
  getMissingRoom: () => missingRoom,
  getRoomsApi: () => roomsApi,
  getRoomsList: () => roomsList.slice(),
  getRoomLoad: () => ({ ...roomLoad }),
  getRoomSize,
  getRoomBox,
  getFloorTilt,
  getGridVisible: () => grid.visible,
  isRoomDirty: () => dirty.room,
  isLayoutDirty: () => dirty.layout,
  getDirty: () => ({ ...dirty }),
  getRoomConfig: () => roomConfig,
  getSavedRoomConfig: () => savedRoomConfig,
  getRoom: () => ({ kind: room.kind, loaded: room.loaded, failed: room.failed, error: room.error ? { ...room.error } : null, splatCount: room.splatCount, lod: room.lod, dropped: room.dropped, name: roomName }),
  getEyeHeight: () => EYE[view] ?? null,
  getRoomStatus: () => roomStatus,
  getRoomEuler,
  getItems: () => [...items.values()].map(itemInfo),
  getItem: (uid) => (items.has(uid) ? itemInfo(items.get(uid)) : null),
  getItemBounds: (uid) => {
    const rec = items.get(uid)
    if (!rec) return null
    const b = worldBounds(rec)
    return { min: b.min.toArray(), max: b.max.toArray() }
  },
  getSelected: () => selected,
  getGizmoMode: () => gizmoMode,
  isGizmoActive: () => !!drag.mode, // older name: an item is being dragged or turned
  isGizmoDragging: () => !!drag.mode,
  getDrag: () => (drag.mode ? { mode: drag.mode, uid: drag.uid } : null),
  getFootprint,
  hitItemAt,
  getView: () => view,
  getViewpoints: () => ({ index: vpIndex, count: viewpoints().length }),
  getMeasure,
  getMeasureState: () => ({ active: measure.active, points: measure.points.length }),
  getMeasurePoints: () => measure.points.map((p) => p.toArray()),
  getPick,
  getLook,
  getLibrary: () => library.slice(),
  assetUrl,
  getLayouts: () => layoutNames.slice(),
  getLayoutDetails: () => layoutDetails.map((d) => ({ ...d })),
  getLayoutName: () => layoutName,
  getRenders: () => renders.slice(),
  isRenderMock: () => renderMock,
  getState,
  getRenderSettings,
  getShell,
  getHang: () => (hang ? { uid: hang.uid } : null),
  getElevation,
  // room
  listRoomsInternal,
  openRoom,
  cancelRoomLoad,
  retryRoom,
  saveThumbnail,
  setRoomTitle,
  setGridVisible,
  loadRoomInternal,
  loadScanPath,
  dropScanFile,
  saveRoom,
  revertRoom,
  frameRoom,
  setRoomEuler,
  setRoomPosition,
  setRoomScale,
  setPlaceholderSize,
  // items + selection
  addItemInternal,
  moveItemInternal,
  removeItemInternal,
  clearItemsInternal,
  toggleRender,
  select,
  setGizmoMode,
  rotateSelected,
  setSnap,
  beginItemDrag,
  beginRotateDrag,
  dragTo,
  endItemDrag,
  removeItemWithUndo,
  restoreItem,
  setElevation,
  nudgeElevation,
  dropToFloor,
  hangItem,
  startHang,
  cancelHang,
  wallAt,
  setShell,
  selectWall,
  reloadLibrary: () => loadLibrary(),
  // views + input
  setViewInternal,
  gotoViewpoint,
  stepViewpoint,
  lookBy,
  setMove,
  tap,
  // tools
  setMeasureActive,
  clearMeasure,
  startPickMode,
  cancelPickMode,
  applyTwoPointScale,
  applyPickFloor,
  previewFloorAt,
  setPickPointAt,
  resetTwoPoints,
  setMeasurePointAt,
  pointAt,
  walkTo,
  // look
  setLook,
  setContactShadows,
  setTrueColor,
  relightInternal,
  idle: () => env.chain,
  // layouts
  saveLayoutInternal,
  loadLayoutInternal,
  deleteLayoutInternal,
  listLayoutsInternal,
  refreshLayouts,
  setLayoutName,
  // renders
  captureView,
  postRender,
  renderViewInternal,
  listRendersInternal,
  // errors + overlays
  reportError,
  toast,
  onFrame,
  worldToScreen,
}
