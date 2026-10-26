// nook planner engine: renderer, scene, room, items, tools, views and the API calls. No DOM UI lives here:
// UI modules (ui-v1.js today) read state through getters, call actions, and listen to `engine.events`.
// Spec: contract/CONTRACT.md §2. Units are meters, Y-up, floor at y = 0. Items are stored in their item frame.
//
// Setup (main.js): engine.mount(el) puts the canvas in `el`; engine.init() loads room, library, layouts, renders.
// Input: planner/input.js (installInput(engine), set up by main.js as engine.input) owns the pointer/keyboard handlers
// and drives the actions below; a UI can turn them off (engine.input.enabled.pointer/keyboard) or add a key filter.
//
// State getters
//   getRoomConfig()        working room config (room.schema.json, normalized; live object, don't mutate)
//   getSavedRoomConfig()   last config read from or written to /api/room
//   getRoom()              { kind: 'placeholder'|'splat', loaded, splatCount, dropped: fileName|null }
//   getRoomStatus()        status line text ("placeholder 3.5 × 4 × 2.7 m", "loading …", …)
//   getRoomEuler()         { yaw, pitch, roll } degrees, the display decomposition of the room quaternion
//   getItems()             [{ uid, id, name, lib, render, hasGlb, hasSplat, position, rotation_y_deg }]
//   getItem(uid)           one of the above, or null
//   getItemBounds(uid)     { min, max } world AABB (m), or null
//   getSelected()          selected uid or null;   getGizmoMode() 'translate'|'rotate'
//   getView()              'orbit'|'seated'|'standing'
//   getViewpoints()        { index, count } scan viewpoints (contract §4.9)
//   getMeasure()           { a, b, meters } or null;   getMeasureState() { active, points }
//   getPick()              { mode: null|'floor'|'two', points, measured: meters|null } (alignment picks)
//   getLook()              { exposure, warmth, contactShadows, envSource, envProbe, roomKind }
//   getLibrary()           library.json items, as-is;   assetUrl(rel) resolves a library asset path
//   getLayouts()           saved layout names (last refresh);   getLayoutName() current layout name
//   getRenders()           render metadata, newest first;   isRenderMock()
//   getState() / getRenderSettings()   the window.nook shapes (contract §2.4, §2.6)
//   errors                 string[] of every reported error (window.nook.errors)
//   canvas, three: { scene, camera, renderer, orbit, gizmo }   for overlays and advanced input
//
// Actions (async ones return Promises that reject with a reported error)
//   init(), mount(el), setViewInset(leftPx)
//   loadRoomInternal(cfg, {fileBytes, fileName, frame}), loadScanPath(path), dropScanFile(file), saveRoom() (PUT /api/room),
//   revertRoom(), frameRoom(), setRoomEuler({yaw,pitch,roll}), setRoomPosition(i, v), setRoomScale(v),
//   setPlaceholderSize(key, v)
//   addItemInternal(id, opts), moveItemInternal(uid, opts), removeItemInternal(uid), clearItemsInternal(),
//   toggleRender(uid, 'glb'|'splat'), select(uid|null), setGizmoMode(mode), rotateSelected(deg)
//   setViewInternal(view), gotoViewpoint(i), stepViewpoint(+1|-1), lookBy(dxPx, dyPx), setMove({forward, side, fast}),
//   setSnap(on), tap(clientX, clientY) (pick / measure / select at a screen point)
//   setMeasureActive(on), clearMeasure(), startPickMode('floor'|'two'), cancelPickMode(), applyTwoPointScale(meters)
//   setLook({exposure, warmth}), setContactShadows(on), relightInternal(pos|null)
//   saveLayoutInternal(name), loadLayoutInternal(name), listLayoutsInternal(), refreshLayouts(), setLayoutName(name)
//   captureView(), postRender(shot, model, prompt), renderViewInternal(opts), listRendersInternal(), idle()
//   reportError(msg, err) → Error, toast(text, kind, ms)
// Overlay hooks
//   onFrame(fn) → unsubscribe; fn(dt) runs every frame after rendering
//   worldToScreen(vec3 | [x,y,z]) → { x, y, visible } in CSS px (client coordinates)
//
// Events (engine.events, an EventTarget of CustomEvents; read e.detail)
//   'room'      { phase: 'loading'|'loaded'|'failed'|'changed'|'edit' }  ('edit': a field-level transform edit)
//   'status'    { text }                       room status line
//   'items'     { change: 'add'|'remove'|'move'|'render', uid }
//   'selection' { uid, gizmoMode }
//   'view'      { view }
//   'measure'   { active, points, meters|null }
//   'pick'      { mode, points, phase: 'start'|'point'|'ready'|'cancel' }
//   'look'      getLook()
//   'library'   { items }
//   'layouts'   { names?, name? }               names after a refresh; name after save/load
//   'renders'   { renders }
//   'error'     { text }                        also pushed to errors
//   'toast'     { text, kind: 'info'|'ok'|'error', ms }
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
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

// --- events, errors + toasts ------------------------------------------------
const events = new EventTarget()
const emit = (name, detail = {}) => events.dispatchEvent(new CustomEvent(name, { detail }))
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
const spark = new SparkRenderer({ renderer })
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

const tc = new TransformControls(camera, canvas)
tc.setSize(0.9)
tc.setSpace('world')
scene.add(tc.getHelper())
tc.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value && view === 'orbit' })
tc.addEventListener('objectChange', () => {
  if (!selected) return
  constrainItem(items.get(selected))
  emit('items', { change: 'move', uid: selected })
})

// Shift the projection center into the part of the view a left-side panel doesn't cover (`viewInset` px).
let viewInset = 0
function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight
  const side = viewInset
  camera.aspect = w / h
  if (side > 0 && w > 2.5 * side) camera.setViewOffset(w, h, -side / 2, 0, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}
function setViewInset(px) {
  viewInset = isNum(px) && px > 0 ? px : 0
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
const room = { kind: 'placeholder', loaded: false, mesh: null, splatCount: 0, localBox: null, fill: null, dropped: null }
let roomToken = 0
let roomStatus = 'loading…'
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
  room.localBox = null
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
  emit('room', { phase })
  if (!room.loaded) return
  const p = roomConfig.placeholder
  setRoomStatus(room.kind === 'splat'
    ? `${room.dropped || roomConfig.splat} · ${room.splatCount.toLocaleString()} splats${viewpoints().length ? ` · ${viewpoints().length} scan views` : ''}`
    : `placeholder ${p.w} × ${p.d} × ${p.h} m`)
}

async function fetchBytes(url) {
  let res
  try { res = await fetch(url) } catch (e) { throw new Error(`could not fetch ${url} (${e.message})`) }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function roomSplatUrl(splat) {
  // Room splat paths are relative to the repo root, which the server serves at "/".
  return new URL(splat, `${location.origin}/`).href
}

// Loads a room config (room.schema.json). With `fileBytes`, the scan comes from a dropped file.
async function loadRoomInternal(cfg, { fileBytes = null, fileName = null, frame = true } = {}) {
  const token = ++roomToken
  let next
  try { next = normalizeRoomConfig(cfg) } catch (e) { throw reportError('Bad room config', e) }
  // A failed drop must leave the working room (and what Save room would write) as it was.
  const prev = { config: roomConfig, dropped: room.dropped, hadSplat: room.kind === 'splat' && !!room.mesh }
  roomConfig = next
  vpBase = transformMatrix(roomConfig.transform)
  vpIndex = -1
  room.loaded = false
  room.dropped = fileBytes ? fileName : null
  if (!roomConfig.splat && !fileBytes) {
    showPlaceholder()
    syncRoom('loaded')
    if (frame) frameRoom()
    return
  }
  const label = fileBytes ? fileName : roomConfig.splat
  emit('room', { phase: 'loading', label })
  setRoomStatus(`loading ${label}…`)
  let mesh = null
  try {
    const bytes = fileBytes || await fetchBytes(roomSplatUrl(roomConfig.splat))
    if (token !== roomToken) return
    mesh = new SplatMesh({ fileBytes: bytes, fileName: fileName || roomConfig.splat })
    await mesh.initialized
    if (!mesh.numSplats) throw new Error('the file contains no splats')
  } catch (e) {
    try { mesh?.dispose() } catch { /* ignore */ }
    if (token === roomToken && fileBytes) {
      roomConfig = prev.config
      room.dropped = prev.dropped
      if (prev.hadSplat) room.loaded = true
      else showPlaceholder()
      syncRoom('failed')
      throw reportError(`Could not load room scan ${label}; keeping the current room`, e)
    }
    if (token === roomToken) {
      showPlaceholder()
      syncRoom('failed')
      if (frame) frameRoom()
    }
    throw reportError(`Could not load room scan ${label}; showing the placeholder room`, e)
  }
  if (token !== roomToken) { try { mesh.dispose() } catch { /* ignore */ } return }
  disposeRoomSplat()
  room.mesh = mesh
  room.splatCount = mesh.numSplats
  room.fill = new THREE.Color()
  room.localBox = splatCenterBox(mesh, 0.01, 0.99, room.fill)
  room.kind = 'splat'
  room.loaded = true
  applyRoomTransform()
  scene.add(mesh)
  placeholderGroup.visible = false
  syncRoom('loaded')
  if (frame) frameRoom()
  // A new scan lights the furniture from its center; this doesn't hold up loadRoom().
  env.customProbe = null
  quiet(bakeEnvironment())
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

function frameRoom() {
  const box = roomWorldBox()
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const target = new THREE.Vector3(center.x, Math.min(Math.max(center.y, 0.4), 1.0), center.z)
  const dist = Math.max(size.x, size.z, 2) * 1.55 + 1.2
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
  emit('room', { phase: 'edit' })
}
function setRoomPosition(i, v) {
  roomConfig.transform.position[i] = v
  applyRoomTransform()
  emit('room', { phase: 'edit' })
}
function setRoomScale(v) {
  if (!(v > 0)) return
  roomConfig.transform.scale = v
  applyRoomTransform()
  emit('room', { phase: 'edit' })
}
function setPlaceholderSize(k, v) {
  if (!(v >= 0.5 && v <= 50)) return
  roomConfig.placeholder[k] = v
  if (room.kind === 'placeholder') { buildPlaceholder(roomConfig.placeholder); syncRoom('changed') } else emit('room', { phase: 'edit' })
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

// Save room: PUT /api/room with the alignment, look and (moved) viewpoints, then re-bake the light.
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
  try {
    await apiJson('/api/room', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (e) { throw reportError('Could not save the room', e) }
  savedRoomConfig = clone(body)
  toast('Room saved.', 'ok', 2500)
  // The alignment may have moved the scan relative to the furniture: light it again.
  if (room.kind === 'splat') await bakeEnvironment()
}

async function revertRoom() {
  let cfg
  try { cfg = await apiJson('/api/room') } catch (e) { throw reportError('Could not read /api/room', e) }
  savedRoomConfig = clone(cfg)
  await loadRoomInternal(cfg, { frame: false })
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
  const run = async () => {
    if (room.kind !== 'splat' || !room.mesh || !room.loaded) { useNeutralEnv(); return }
    const token = roomToken
    const center = probe ? new THREE.Vector3().fromArray(probe) : defaultProbe()
    const hide = [grid, tc.getHelper(), measureGroup, pickGroup, placeholderGroup, ...[...items.values()].map((r) => r.group)]
    const background = scene.background
    baking = true
    spark.autoUpdate = false
    try {
      for (let i = 0; spark.sorting && i < 300; i++) await new Promise((r) => setTimeout(r, 10))
      scene.background = room.fill || background
      const cube = await spark.renderCubeMap({ scene, worldCenter: center, size: ENV_SIZE, near: 0.05, far: 200, hideObjects: hide, filter: true })
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
  for (const r of items.values()) {
    if (r.shadow) r.shadow.visible = contactShadows
    if (r.proxy) r.proxy.visible = contactShadows
  }
  emitLook()
}

// --- library + items --------------------------------------------------------
let library = []
const items = new Map() // uid -> { uid, id, lib, render, group, child, localBox, rotationDeg, outline }
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

async function buildChild(lib, render) {
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
}

function makeOutline(box) {
  const helper = new THREE.Box3Helper(box, 0xe0b25a)
  helper.material.transparent = true
  helper.material.opacity = 0.7
  helper.material.depthTest = false
  helper.renderOrder = 10
  helper.visible = false
  return noRaycast(helper)
}

async function setRender(rec, render) {
  const { obj, box } = await buildChild(rec.lib, render)
  if (rec.child) {
    rec.group.remove(rec.child)
    disposeChild(rec.child)
  }
  if (rec.outline) rec.group.remove(rec.outline)
  disposeContactShadow(rec)
  rec.child = obj
  rec.localBox = box
  rec.render = render
  rec.outline = makeOutline(box)
  rec.outline.visible = selected === rec.uid
  rec.group.add(obj, rec.outline)
  const { shadow, proxy } = makeContactShadow(rec)
  rec.shadow = shadow
  rec.proxy = proxy
  rec.group.add(shadow)
  if (proxy) rec.group.add(proxy)
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

async function addItemInternal(id, opts = {}) {
  const lib = library.find((i) => i.id === id)
  if (!lib) throw reportError(`Unknown library item "${id}"`)
  opts = opts || {}
  const render = pickRender(lib, opts.render)
  const pos = Array.isArray(opts.position) && opts.position.length >= 3 && isNum(opts.position[0]) && isNum(opts.position[2])
    ? opts.position : defaultSpot()
  const rot = isNum(opts.rotation_y_deg) ? opts.rotation_y_deg : 0
  const uid = typeof opts.uid === 'string' && opts.uid && !items.has(opts.uid) ? opts.uid : newUid(id)
  const gen = itemsGen
  const group = new THREE.Group()
  group.rotation.order = 'YXZ'
  group.position.set(pos[0], 0, pos[2])
  group.rotation.set(0, rot * DEG, 0)
  group.userData.uid = uid
  group.name = `item:${uid}`
  const rec = { uid, id, lib, render, group, child: null, localBox: null, rotationDeg: rot, outline: null, shadow: null, proxy: null }
  try {
    await setRender(rec, render)
  } catch (e) {
    throw reportError(`Could not load "${lib.name || id}" (${render})`, e)
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

function constrainItem(rec) {
  if (!rec) return
  const g = rec.group
  const yaw = new THREE.Euler().setFromQuaternion(g.quaternion, 'YXZ').y
  g.position.y = 0
  g.rotation.set(0, yaw, 0)
  rec.rotationDeg = round(yaw / DEG, 6)
}

function moveItemInternal(uid, opts = {}) {
  const rec = items.get(uid)
  if (!rec) { reportError(`moveItem: no placed item "${uid}"`); return }
  opts = opts || {}
  if (Array.isArray(opts.position)) {
    if (isNum(opts.position[0])) rec.group.position.x = opts.position[0]
    if (isNum(opts.position[2])) rec.group.position.z = opts.position[2]
  }
  rec.group.position.y = 0
  if (isNum(opts.rotation_y_deg)) {
    rec.rotationDeg = opts.rotation_y_deg
    rec.group.rotation.set(0, opts.rotation_y_deg * DEG, 0)
  }
  rec.group.updateMatrixWorld(true)
  emit('items', { change: 'move', uid })
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
    position: [r.group.position.x, 0, r.group.position.z],
    rotation_y_deg: r.rotationDeg,
  }
}

// --- selection + gizmo --------------------------------------------------------
let selected = null
let gizmoMode = 'translate'

function setGizmoMode(mode) {
  gizmoMode = mode
  tc.setMode(mode)
  // Move only on the floor plane (X/Z), rotate only around Y.
  tc.showX = mode === 'translate'
  tc.showZ = mode === 'translate'
  tc.showY = mode === 'rotate'
  emit('selection', { uid: selected, gizmoMode })
}
setGizmoMode('translate')

function select(uid) {
  if (selected && items.get(selected)?.outline) items.get(selected).outline.visible = false
  selected = uid && items.has(uid) ? uid : null
  if (selected) {
    const rec = items.get(selected)
    if (rec.outline) rec.outline.visible = true
    tc.attach(rec.group)
  } else {
    tc.detach()
  }
  emit('selection', { uid: selected, gizmoMode })
}

// Snapping while dragging the gizmo (Shift): 5 cm and 15°.
function setSnap(on) {
  if (on) { tc.setTranslationSnap(0.05); tc.setRotationSnap(15 * DEG) } else { tc.setTranslationSnap(null); tc.setRotationSnap(null) }
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

function gotoViewpoint(i) {
  const n = viewpoints().length
  if (!n) { toast('This room has no scan viewpoints: retrain it with nook-scan v2.'); return false }
  if (view === 'orbit') setViewInternal('standing')
  applyViewpoint(i)
  camera.position.y = EYE[view]
  applyFpRotation()
  toast(`Scan view ${vpIndex + 1} of ${n}`, 'info', 1500)
  return true
}

// Next (+1) or previous (-1) scan viewpoint; the first step goes to the one nearest the room center.
function stepViewpoint(delta) {
  return gotoViewpoint(vpIndex < 0 ? nearestViewpointToCenter() : vpIndex + delta)
}

function setViewInternal(v) {
  if (!VIEWS.includes(v)) { reportError(`Unknown view "${v}"`); return }
  if (v === 'orbit') {
    if (view !== 'orbit' && orbitSaved) {
      camera.position.copy(orbitSaved.pos)
      orbit.target.copy(orbitSaved.target)
    }
    view = 'orbit'
    orbit.enabled = !tc.dragging
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
  if (fwd || side) {
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
  const hits = raycaster.intersectObject(room.mesh, false)
  return hits.length ? { point: hits[0].point.clone(), distance: hits[0].distance } : null
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

function marker(color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
  m.renderOrder = 20
  return noRaycast(m)
}
function lineBetween(a, b, color) {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
  l.renderOrder = 20
  return noRaycast(l)
}
function disposeGroup(g) {
  for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose(); c.material?.dispose() }
}

// Measure tool
const measureGroup = new THREE.Group()
scene.add(measureGroup)
const measure = { active: false, points: [] }
function emitMeasure() {
  const m = getMeasure()
  emit('measure', { active: measure.active, points: measure.points.length, meters: m ? m.meters : null })
}
function setMeasureActive(on) {
  measure.active = on
  if (on) cancelPickMode()
  emitMeasure()
}
function clearMeasure() {
  measure.points = []
  disposeGroup(measureGroup)
  emitMeasure()
}
function addMeasurePoint(p) {
  if (measure.points.length >= 2) clearMeasure()
  measure.points.push(p.clone())
  const m = marker(0xe0b25a); m.position.copy(p); measureGroup.add(m)
  if (measure.points.length === 2) {
    const [a, b] = measure.points
    measureGroup.add(lineBetween(a, b, 0xe0b25a))
  }
  emitMeasure()
}
function getMeasure() {
  if (measure.points.length < 2) return null
  const [a, b] = measure.points
  return { a: a.toArray(), b: b.toArray(), meters: a.distanceTo(b) }
}

// Alignment pick modes: 'floor' (one splat point) or 'two' (two splat points)
const pickGroup = new THREE.Group()
scene.add(pickGroup)
let pickMode = null
let twoPoints = []
function getPick() {
  return { mode: pickMode, points: twoPoints.length, measured: twoPoints.length === 2 ? twoPoints[0].distanceTo(twoPoints[1]) : null }
}
function emitPick(phase) { emit('pick', { ...getPick(), phase }) }
function startPickMode(mode) {
  if (room.kind !== 'splat' || !room.mesh) { toast('Load a room scan first (alignment works on the splat).', 'info'); return }
  setMeasureActive(false)
  pickMode = mode
  twoPoints = []
  disposeGroup(pickGroup)
  emitPick('start')
}
function cancelPickMode() {
  pickMode = null
  twoPoints = []
  disposeGroup(pickGroup)
  emitPick('cancel')
}
function handlePick() {
  const hit = hitRoomSplat()
  if (!hit) { toast('No scan under the cursor; click on the splat.', 'info', 3000); return }
  const t = roomConfig.transform
  if (pickMode === 'floor') {
    const dy = hit.point.y
    t.position[1] = round(t.position[1] - dy, 6)
    applyRoomTransform()
    syncRoom('changed')
    cancelPickMode()
    toast(`Floor set: scan moved ${(-dy * 100).toFixed(1)} cm vertically. Save room to keep it.`, 'ok')
    return
  }
  twoPoints.push(hit.point.clone())
  const m = marker(0x5ac8e0); m.position.copy(hit.point); pickGroup.add(m)
  if (twoPoints.length === 2) {
    pickGroup.add(lineBetween(twoPoints[0], twoPoints[1], 0x5ac8e0))
    pickMode = null
    emitPick('ready')
    return
  }
  emitPick('point')
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
  cancelPickMode()
  syncRoom('changed')
  toast(`Scale set to ${t.scale.toFixed(4)} (×${k.toFixed(4)}). Save room to keep it.`, 'ok')
}

// A click/tap at a screen point: an alignment pick, a measure point, or (de)selecting an item.
function tap(clientX, clientY) {
  setRay(clientX, clientY)
  if (pickMode) return handlePick()
  if (measure.active) {
    const hit = hitAnything()
    if (hit) addMeasurePoint(hit.point)
    return
  }
  const hit = hitItems()
  select(hit ? hit.uid : null)
}

// --- layouts ------------------------------------------------------------------------
async function apiJson(url, opts) {
  let res
  try { res = await fetch(url, opts) } catch (e) { throw new Error(`could not reach ${url} (${e.message})`) }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) { const err = new Error(data?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
  return data
}

let layoutNames = []
let layoutName = '' // the layout name field: what Save writes, and what renders are tagged with
function setLayoutName(name) { layoutName = String(name ?? '') }

function layoutDoc(name) {
  return {
    version: 1,
    name,
    library: LIBRARY_URL,
    room: clone(roomConfig),
    items: [...items.values()].map((r) => ({
      uid: r.uid,
      id: r.id,
      render: r.render,
      position: [round(r.group.position.x, 6), 0, round(r.group.position.z, 6)],
      rotation_y_deg: round(r.rotationDeg, 6),
    })),
    camera: { view, position: camera.position.toArray().map((v) => round(v, 5)), target: cameraTarget().map((v) => round(v, 5)) },
  }
}

async function saveLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug like "reading-corner" (got "${name}")`)
  try {
    await apiJson(`/api/layouts/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutDoc(name)) })
  } catch (e) {
    throw reportError(`Could not save layout "${name}"`, e)
  }
  setLayoutName(name)
  emit('layouts', { name })
  quiet(refreshLayouts())
}

async function loadLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug (got "${name}")`)
  let doc
  try {
    doc = await apiJson(`/api/layouts/${encodeURIComponent(name)}`)
  } catch (e) {
    throw reportError(e.status === 404 ? `No layout named "${name}"` : `Could not load layout "${name}"`, e)
  }
  if (!doc || !Array.isArray(doc.items)) throw reportError(`Layout "${name}" has no items array`)
  if (doc.library && doc.library !== LIBRARY_URL) toast(`Layout "${name}" was made with library ${doc.library}`, 'info')
  // Switch rooms only when the layout names a scan we aren't showing; keep the current alignment otherwise.
  if (doc.room && typeof doc.room === 'object') {
    const want = typeof doc.room.splat === 'string' && doc.room.splat ? doc.room.splat : null
    if (want && (want !== roomConfig.splat || room.dropped || room.kind !== 'splat')) {
      try { await loadRoomInternal(doc.room, { frame: !doc.camera }) } catch { /* reported; keep going with the placeholder */ }
    }
  }
  clearItemsInternal()
  const results = await Promise.allSettled(doc.items.map((it) => addItemInternal(it.id, {
    uid: it.uid, position: it.position, rotation_y_deg: it.rotation_y_deg, render: it.render,
  })))
  const failed = results.filter((r) => r.status === 'rejected').length
  if (doc.camera) restoreCamera(doc.camera)
  setLayoutName(name)
  emit('layouts', { name })
  if (failed) toast(`Layout "${name}": ${failed} of ${doc.items.length} items could not be placed.`, 'error')
}

async function listLayoutsInternal() {
  const data = await apiJson('/api/layouts')
  return Array.isArray(data?.layouts) ? data.layouts : []
}

async function refreshLayouts() {
  let names = []
  try { names = await listLayoutsInternal() } catch (e) { reportError('Could not list layouts', e); return }
  layoutNames = names
  emit('layouts', { names: names.slice() })
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

// The canvas only, without the planning helpers (gizmo, outline, grid, measure/pick markers).
function captureView() {
  const hide = [tc.getHelper(), grid, measureGroup, pickGroup, ...[...items.values()].map((r) => r.outline).filter(Boolean)]
  const vis = hide.map((o) => o.visible)
  for (const o of hide) o.visible = false
  // Center the shot on the camera (the on-screen view is shifted right to clear the sidebar).
  camera.clearViewOffset()
  camera.updateProjectionMatrix()
  try {
    renderFrame() // read back in the same task, before the browser clears the drawing buffer
    const k = Math.min(1, CAPTURE_MAX / Math.max(canvas.width, canvas.height))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(canvas.width * k))
    out.height = Math.max(1, Math.round(canvas.height * k))
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height)
    return { dataUrl: out.toDataURL('image/jpeg', 0.92), width: out.width, height: out.height }
  } finally {
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
  try {
    meta = await apiJson('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: shot.dataUrl, model, prompt: prompt || undefined, view, layout: SLUG.test(layout) ? layout : undefined }),
    })
  } catch (e) {
    throw reportError('Render failed', e)
  }
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
  return { exposure: l.exposure, warmth: l.warmth, contactShadows, envSource: env.source, envProbe: env.probe ? env.probe.slice() : null, roomKind: room.kind }
}
function emitLook() { emit('look', getLook()) }
function applyLook() {
  const l = roomConfig.look
  renderer.toneMappingExposure = l.exposure
  post.mat.uniforms.uTint.value.copy(warmthTint(l.warmth))
  emitLook()
}
function setLook(s) {
  const l = roomConfig.look
  if (isNum(s.exposure)) l.exposure = clampNum(s.exposure, 0.25, 4, 1)
  if (isNum(s.warmth)) l.warmth = clampNum(s.warmth, -1, 1, 0)
  applyLook()
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
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (view === 'orbit') orbit.update()
    else updateFp(dt)
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
      kind: room.kind,
      loaded: room.loaded,
      ...(room.kind === 'splat' ? { splatCount: room.splatCount } : {}),
      transform: { position: t.position.slice(), quaternion: t.quaternion.slice(), scale: t.scale },
      viewpoints: viewpoints().length,
    },
    items: [...items.values()].map((r) => {
      const b = worldBounds(r)
      return {
        uid: r.uid,
        id: r.id,
        render: r.render,
        position: [r.group.position.x, 0, r.group.position.z],
        rotation_y_deg: r.rotationDeg,
        worldBounds: { min: b.min.toArray(), max: b.max.toArray() },
      }
    }),
    camera: { view, position: camera.position.toArray() },
  }
}

function getRenderSettings() {
  return {
    toneMapping: 'aces',
    exposure: roomConfig.look.exposure,
    warmth: roomConfig.look.warmth,
    envSource: env.source,
    contactShadows,
    shadowCount: [...items.values()].filter((r) => r.shadow && r.shadow.visible).length,
  }
}

// Initial load: the room from /api/room (placeholder on failure), the library, layouts and renders.
async function init() {
  const roomP = (async () => {
    let cfg
    try { cfg = await apiJson('/api/room') } catch (e) {
      reportError('Could not read /api/room; using the placeholder room', e)
      cfg = { version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } }
    }
    savedRoomConfig = clone(cfg)
    try { await loadRoomInternal(cfg) } catch { /* reported; placeholder is showing */ }
  })()
  await Promise.allSettled([roomP, loadLibrary(), refreshLayouts(), listRendersInternal()])
}

export const engine = {
  events,
  errors,
  canvas,
  three: { scene, camera, renderer, orbit, gizmo: tc },
  // setup
  init,
  mount,
  setViewInset,
  // state
  getRoomConfig: () => roomConfig,
  getSavedRoomConfig: () => savedRoomConfig,
  getRoom: () => ({ kind: room.kind, loaded: room.loaded, splatCount: room.splatCount, dropped: room.dropped }),
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
  isGizmoActive: () => tc.dragging || tc.axis !== null, // pointer is on (or dragging) the gizmo
  isGizmoDragging: () => tc.dragging,
  getView: () => view,
  getViewpoints: () => ({ index: vpIndex, count: viewpoints().length }),
  getMeasure,
  getMeasureState: () => ({ active: measure.active, points: measure.points.length }),
  getPick,
  getLook,
  getLibrary: () => library.slice(),
  assetUrl,
  getLayouts: () => layoutNames.slice(),
  getLayoutName: () => layoutName,
  getRenders: () => renders.slice(),
  isRenderMock: () => renderMock,
  getState,
  getRenderSettings,
  // room
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
  // look
  setLook,
  setContactShadows,
  relightInternal,
  idle: () => env.chain,
  // layouts
  saveLayoutInternal,
  loadLayoutInternal,
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
