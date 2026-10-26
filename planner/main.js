// nook planner: room splat + furniture placement. Spec: contract/CONTRACT.md §2.
// Units are meters, Y-up, floor at y = 0. Items are stored in their item frame (CLAUDE.md).
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const VIEWS = ['orbit', 'seated', 'standing']
const EYE = { seated: 1.15, standing: 1.6 }
const DEFAULT_PLACEHOLDER = { w: 3.5, d: 4, h: 2.7 }
const SPLAT_EXT = /\.(spz|ply|splat|ksplat|sog)$/i
const DEG = Math.PI / 180

const params = new URLSearchParams(location.search)
const LIBRARY_URL = params.get('library') || '/library/library.json'
const libraryBase = new URL(LIBRARY_URL, location.href)

const $ = (id) => document.getElementById(id)
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)))
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const fmtCm = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const dimsText = (d) => (d ? `${fmtCm(d.w)} × ${fmtCm(d.d)} × ${fmtCm(d.h)} cm` : '')
const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }

// --- errors + toasts ------------------------------------------------------
const errors = []
function toast(text, kind = 'info', ms = 6000) {
  if ([...$('toasts').children].some((t) => t.textContent === text)) return
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = text
  el.onclick = () => el.remove()
  $('toasts').prepend(el)
  while ($('toasts').children.length > 6) $('toasts').lastChild.remove()
  setTimeout(() => el.remove(), ms)
}
function reportError(msg, err) {
  const detail = err ? (err.message || String(err)) : ''
  const text = detail && !msg.includes(detail) ? `${msg}: ${detail}` : msg
  errors.push(text)
  toast(text, 'error', 9000)
  console.warn('[nook]', text)
  return new Error(text)
}
window.addEventListener('error', (e) => { if (e.error || e.message) reportError(`Unexpected error: ${e.message}`) })
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  reportError('Unexpected error', e.reason)
})
// Fire-and-forget wrapper for UI handlers: failures are already reported, never thrown.
const quiet = (p) => { Promise.resolve(p).catch(() => {}) }

// --- three.js scene ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
$('viewport').appendChild(renderer.domElement)
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
const LOOK_DEFAULT = { exposure: 1, warmth: 0 }
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
tc.addEventListener('objectChange', () => { if (selected) constrainItem(items.get(selected)) })

// Shift the projection center into the part of the view the sidebar doesn't cover.
function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight
  const side = $('sidebar').classList.contains('collapsed') ? 0 : $('sidebar').getBoundingClientRect().right
  camera.aspect = w / h
  if (side > 0 && w > 2.5 * side) camera.setViewOffset(w, h, -side / 2, 0, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizePost()
  updateViewOffset()
})
updateViewOffset()

const noRaycast = (o) => { o.traverse((c) => { c.raycast = () => {} }); return o }

// --- room ---------------------------------------------------------------------
const IDENTITY = () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 })
let roomConfig = normalizeRoomConfig({ version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } })
let savedRoomConfig = clone(roomConfig)
const room = { kind: 'placeholder', loaded: false, mesh: null, splatCount: 0, localBox: null, fill: null, dropped: null }
let roomToken = 0
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
    syncRoomUI()
    if (frame) frameRoom()
    return
  }
  const label = fileBytes ? fileName : roomConfig.splat
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
      syncRoomUI()
      throw reportError(`Could not load room scan ${label}; keeping the current room`, e)
    }
    if (token === roomToken) {
      showPlaceholder()
      syncRoomUI()
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
  syncRoomUI()
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

// --- environment from the scan (contract §2.6.2) --------------------------------------
function useNeutralEnv() {
  scene.environment = neutralEnv
  env.source = 'neutral'
  env.probe = null
  if (env.rt) { env.rt.dispose(); env.rt = null }
  applyLighting()
  syncLookUI()
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
      syncLookUI()
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
  syncLookUI()
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
  renderLibraryUI()
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
  renderPlacedUI()
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
  renderPlacedUI()
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

async function toggleRender(rec, render) {
  if (!rec || rec.render === render) return
  if (render === 'splat' && !rec.lib.assets?.splat) return
  try {
    await setRender(rec, render)
  } catch (e) {
    throw reportError(`Could not switch "${rec.lib.name}" to ${render}`, e)
  }
  renderSelectionUI()
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
  $('sel-move').classList.toggle('on', mode === 'translate')
  $('sel-rotate').classList.toggle('on', mode === 'rotate')
}

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
  renderSelectionUI()
  renderPlacedUI()
}

// --- views --------------------------------------------------------------------
let view = 'orbit'
let orbitSaved = null
const fp = { yaw: 0, pitch: 0 }
const keys = new Set()

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
  for (const b of document.querySelectorAll('#toolbar [data-view]')) b.classList.toggle('on', b.dataset.view === view)
}

function updateFp(dt) {
  const fwd = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0)
  const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0)
  if (fwd || side) {
    const speed = (keys.has('shift') ? 2.4 : 1.2) * dt
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

function setRay(e) {
  // Objects added or moved since the last frame have stale world matrices; refresh before picking.
  scene.updateMatrixWorld()
  camera.updateMatrixWorld()
  const r = canvas.getBoundingClientRect()
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
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
function setMeasureActive(on) {
  measure.active = on
  if (on) cancelPickMode()
  $('tool-measure').classList.toggle('on', on)
  updateModeHint()
}
function clearMeasure() {
  measure.points = []
  disposeGroup(measureGroup)
  $('measure-label').hidden = true
}
function addMeasurePoint(p) {
  if (measure.points.length >= 2) clearMeasure()
  measure.points.push(p.clone())
  const m = marker(0xe0b25a); m.position.copy(p); measureGroup.add(m)
  if (measure.points.length === 2) {
    const [a, b] = measure.points
    measureGroup.add(lineBetween(a, b, 0xe0b25a))
    const meters = a.distanceTo(b)
    const el = $('measure-label')
    el.textContent = `${meters.toFixed(3)} m · ${(meters * 100).toFixed(1)} cm`
    el.dataset.meters = String(meters)
    el.hidden = false
  }
  updateModeHint()
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
function startPickMode(mode) {
  if (room.kind !== 'splat' || !room.mesh) { toast('Load a room scan first (alignment works on the splat).', 'info'); return }
  setMeasureActive(false)
  pickMode = mode
  twoPoints = []
  disposeGroup(pickGroup)
  $('al-two-row').hidden = true
  updateModeHint()
}
function cancelPickMode() {
  pickMode = null
  twoPoints = []
  disposeGroup(pickGroup)
  updateModeHint()
}
function updateModeHint() {
  const el = $('mode-hint')
  let text = ''
  if (pickMode === 'floor') text = 'Click a point on the floor of the scan · Esc cancels'
  else if (pickMode === 'two') text = `Click point ${twoPoints.length + 1} of 2 on the scan · Esc cancels`
  else if (measure.active) text = measure.points.length === 1 ? 'Click the second point · Esc clears' : 'Measure: click two points · Esc clears'
  el.textContent = text
  el.hidden = !text
}
function handlePick(e) {
  setRay(e)
  const hit = hitRoomSplat()
  if (!hit) { toast('No scan under the cursor; click on the splat.', 'info', 3000); return }
  const t = roomConfig.transform
  if (pickMode === 'floor') {
    const dy = hit.point.y
    t.position[1] = round(t.position[1] - dy, 6)
    applyRoomTransform()
    syncRoomUI()
    cancelPickMode()
    toast(`Floor set: scan moved ${(-dy * 100).toFixed(1)} cm vertically. Save room to keep it.`, 'ok')
    return
  }
  twoPoints.push(hit.point.clone())
  const m = marker(0x5ac8e0); m.position.copy(hit.point); pickGroup.add(m)
  if (twoPoints.length === 2) {
    pickGroup.add(lineBetween(twoPoints[0], twoPoints[1], 0x5ac8e0))
    pickMode = null
    const d = twoPoints[0].distanceTo(twoPoints[1])
    $('al-two-measured').textContent = `${d.toFixed(3)} m in scan →`
    $('al-two-row').hidden = false
    $('al-two-dist').focus()
  }
  updateModeHint()
}
function applyTwoPointScale() {
  const real = parseFloat($('al-two-dist').value)
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
  $('al-two-row').hidden = true
  syncRoomUI()
  toast(`Scale set to ${t.scale.toFixed(4)} (×${k.toFixed(4)}). Save room to keep it.`, 'ok')
}

// --- pointer + keyboard -----------------------------------------------------------
let down = null
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, gizmo: tc.dragging || tc.axis !== null, moved: false }
  if (view !== 'orbit' && !down.gizmo) canvas.setPointerCapture?.(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!down) return
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true
  if (view !== 'orbit' && !down.gizmo && !tc.dragging) {
    fp.yaw -= (e.clientX - down.lx) * 0.004
    fp.pitch = Math.max(-1.45, Math.min(1.45, fp.pitch - (e.clientY - down.ly) * 0.004))
    applyFpRotation()
  }
  down.lx = e.clientX; down.ly = e.clientY
})
window.addEventListener('pointerup', (e) => {
  const d = down
  down = null
  if (!d || e.button !== 0 || d.moved || d.gizmo || e.target !== canvas) return
  try {
    if (pickMode) return handlePick(e)
    setRay(e)
    if (measure.active) {
      const hit = hitAnything()
      if (hit) addMeasurePoint(hit.point)
      return
    }
    const hit = hitItems()
    select(hit ? hit.uid : null)
  } catch (err) {
    reportError('Click failed', err)
  }
})

const typing = (e) => {
  const t = e.target
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase()
  if (k === 'shift') { tc.setTranslationSnap(0.05); tc.setRotationSnap(15 * DEG) }
  if (!$('render-confirm').hidden || !$('render-view').hidden) { // a dialog is open: only Esc, to close it
    if (e.key === 'Escape') { closeRenderConfirm(); closeRenderViewer() }
    return
  }
  if (typing(e)) {
    if (e.key === 'Escape') e.target.blur()
    return
  }
  keys.add(k)
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (k === 'escape') {
    cancelPickMode()
    clearMeasure()
    setMeasureActive(false)
    select(null)
    $('al-two-row').hidden = true
  } else if (k === 'delete' || k === 'backspace') {
    if (selected) { e.preventDefault(); removeItemInternal(selected) }
  } else if (k === 'r') {
    rotateSelected(e.shiftKey ? -15 : 15)
  } else if (k === 'g') {
    if (selected) setGizmoMode(gizmoMode === 'translate' ? 'rotate' : 'translate')
  } else if (k === 'm') {
    setMeasureActive(!measure.active)
  } else if (k === 'f') {
    if (view === 'orbit') frameRoom()
  } else if (k === '1' || k === '2' || k === '3') {
    setViewInternal(VIEWS[Number(k) - 1])
  } else if (k === '[' || k === ']') {
    gotoViewpoint(vpIndex < 0 ? nearestViewpointToCenter() : vpIndex + (k === ']' ? 1 : -1))
  }
  if (view !== 'orbit' && k.startsWith('arrow')) e.preventDefault()
})
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase()
  keys.delete(k)
  if (k === 'shift') { tc.setTranslationSnap(null); tc.setRotationSnap(null) }
})
window.addEventListener('blur', () => keys.clear())

// Drag-and-drop a scan to use it as the room for this session.
let dragDepth = 0
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false })
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true })
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('drop').hidden = true
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!SPLAT_EXT.test(file.name)) { reportError(`${file.name} is not a splat (.spz, .ply, .splat, .ksplat, .sog)`); return }
  quiet((async () => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sameScan = roomConfig.splat && roomConfig.splat.split('/').pop() === file.name
    const cfg = { ...clone(roomConfig), splat: `room/${file.name}`, transform: sameScan ? roomConfig.transform : IDENTITY() }
    delete cfg.measured
    await loadRoomInternal(cfg, { fileBytes: bytes, fileName: file.name })
    toast(`Using ${file.name} for this session. To keep it, copy it to room/${file.name} and press Save room.`, 'ok', 10000)
  })().catch((err) => { if (!errors.length || !errors.at(-1).includes(file.name)) reportError(`Could not open ${file.name}`, err) }))
})

// --- layouts ------------------------------------------------------------------------
async function apiJson(url, opts) {
  let res
  try { res = await fetch(url, opts) } catch (e) { throw new Error(`could not reach ${url} (${e.message})`) }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) { const err = new Error(data?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
  return data
}

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
  $('layout-name').value = name
  quiet(refreshLayoutList())
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
  $('layout-name').value = name
  if (failed) toast(`Layout "${name}": ${failed} of ${doc.items.length} items could not be placed.`, 'error')
}

async function listLayoutsInternal() {
  const data = await apiJson('/api/layouts')
  return Array.isArray(data?.layouts) ? data.layouts : []
}

async function refreshLayoutList() {
  let names = []
  try { names = await listLayoutsInternal() } catch (e) { reportError('Could not list layouts', e); return }
  const ul = $('layout-list')
  ul.replaceChildren(...names.map((n) => {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.textContent = n
    b.title = `Load layout ${n}`
    b.onclick = () => quiet(loadLayoutInternal(n).then(() => toast(`Loaded layout "${n}"`, 'ok', 2500)))
    li.append(b)
    return li
  }))
}

// --- render this view (contract §2.6.5) ---------------------------------------------------
// First entry is the default. Nano Banana kept the camera and layout exactly in the live comparison (evals/golden/RESULTS.md);
// Kontext re-framed the shot and Qwen restyled the floor (and is ~6x slower).
const RENDER_MODELS = {
  'nano-banana': { label: 'Nano Banana edit', price: () => 0.0398 },
  kontext: { label: 'FLUX.1 Kontext [pro]', price: () => 0.04 },
  qwen: { label: 'Qwen Image Edit', price: (mp) => 0.03 * mp },
}
const DEFAULT_RENDER_PROMPT = 'Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, soft natural daylight, subtle contact shadows. Do not add, remove or move anything.'
const CAPTURE_MAX = 1536 // px on the long side
let renders = []
let renderMock = false
const fmtUsd = (v) => `$${Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)}`

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

function renderPrice(model, shot) {
  return RENDER_MODELS[model].price(shot ? (shot.width * shot.height) / 1e6 : 1)
}

async function postRender(shot, model, prompt) {
  const layout = $('layout-name').value.trim()
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
  renderRendersUI()
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
  renderRendersUI()
  return renders.slice()
}

// Confirm dialog: capture first, so the preview is exactly what gets sent.
let pendingShot = null
function openRenderConfirm() {
  try { pendingShot = captureView() } catch (e) { reportError('Could not capture the view', e); return }
  $('rc-preview').src = pendingShot.dataUrl
  if (!$('rc-prompt').value.trim()) $('rc-prompt').value = DEFAULT_RENDER_PROMPT
  $('rc-go').disabled = false
  updateRenderPrice()
  $('render-confirm').hidden = false
}
function closeRenderConfirm() {
  $('render-confirm').hidden = true
  pendingShot = null
}
function updateRenderPrice() {
  const model = $('rc-model').value
  const price = renderPrice(model, pendingShot)
  const size = pendingShot ? `${pendingShot.width} × ${pendingShot.height} px` : ''
  $('rc-price').textContent = renderMock ? 'mock mode: $0' : `about ${fmtUsd(price)}`
  $('rc-note').textContent = `${size} JPEG to fal (${RENDER_MODELS[model].label}). ${renderMock ? 'NOOK_FAL_MOCK is set: the result is a copy of the input.' : 'The FAL key stays on the server.'}`
  $('rc-go').textContent = renderMock ? 'Render (mock, $0)' : `Render · ${fmtUsd(price)}`
}
function confirmRender() {
  if (!pendingShot) return
  const shot = pendingShot
  const model = $('rc-model').value
  const prompt = $('rc-prompt').value.trim()
  $('rc-go').disabled = true
  $('rc-go').textContent = 'Rendering…'
  $('tool-render').disabled = true
  $('tool-render').textContent = 'Rendering…'
  quiet(postRender(shot, model, prompt && prompt !== DEFAULT_RENDER_PROMPT ? prompt : undefined)
    .then((meta) => {
      closeRenderConfirm()
      openRenderViewer(meta)
      $('sec-renders').open = true
    })
    .finally(() => {
      $('rc-go').disabled = false
      updateRenderPrice()
      $('tool-render').disabled = false
      $('tool-render').textContent = 'Render'
    }))
}

function openRenderViewer(meta) {
  $('rv-title').textContent = meta.name
  const bits = [RENDER_MODELS[meta.model]?.label || meta.model, meta.mock ? 'mock, $0' : fmtUsd(meta.cost_usd || 0)]
  if (meta.view) bits.push(meta.view)
  if (meta.layout) bits.push(`layout ${meta.layout}`)
  $('rv-meta').textContent = bits.join(' · ')
  $('rv-input').src = meta.input_url
  $('rv-result').src = meta.url
  $('rv-open').href = meta.url
  $('render-view').hidden = false
}
function closeRenderViewer() { $('render-view').hidden = true }

function renderRendersUI() {
  $('render-count').textContent = renders.length ? `(${renders.length})` : ''
  $('render-empty').hidden = renders.length > 0
  $('render-list').replaceChildren(...renders.map((m) => {
    const li = document.createElement('li')
    li.title = `Open ${m.name}`
    const img = document.createElement('img')
    img.className = 'thumb'
    img.alt = ''
    img.loading = 'lazy'
    img.src = m.url
    const meta = document.createElement('div'); meta.className = 'meta'
    const nm = document.createElement('span'); nm.className = 'name'
    nm.textContent = (m.created || m.name).replace('T', ' ').replace(/(\d\d:\d\d):\d\d.*$/, '$1')
    const dm = document.createElement('span'); dm.className = 'dims'
    dm.textContent = `${m.model}${m.view ? ` · ${m.view}` : ''} · ${m.mock ? 'mock' : fmtUsd(m.cost_usd || 0)}`
    meta.append(nm, dm)
    li.append(img, meta)
    li.onclick = () => openRenderViewer(m)
    return li
  }))
}

// --- UI -----------------------------------------------------------------------------
function setRoomStatus(text) { $('room-status').textContent = text }

function initials(name) {
  return (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}

function renderLibraryUI() {
  const ul = $('library-list')
  $('lib-count').textContent = library.length ? `(${library.length})` : ''
  $('library-empty').hidden = library.length > 0
  ul.replaceChildren(...library.map((it) => {
    const li = document.createElement('li')
    li.title = `Add ${it.name} to the room`
    let thumb
    if (it.assets?.thumb) {
      thumb = document.createElement('img')
      thumb.className = 'thumb'
      thumb.alt = ''
      thumb.src = assetUrl(it.assets.thumb)
      thumb.onerror = () => {
        const ph = document.createElement('div'); ph.className = 'thumb'; ph.textContent = initials(it.name)
        thumb.replaceWith(ph)
        reportError(`Missing thumbnail for "${it.name}" (${it.assets.thumb})`)
      }
    } else {
      thumb = document.createElement('div'); thumb.className = 'thumb'; thumb.textContent = initials(it.name)
    }
    const meta = document.createElement('div'); meta.className = 'meta'
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = it.name || it.id
    const dm = document.createElement('span'); dm.className = 'dims'; dm.textContent = dimsText(it.dims_cm)
    meta.append(nm, dm)
    const badge = document.createElement('span'); badge.className = 'badge'
    badge.textContent = it.assets?.splat ? 'glb · splat' : 'glb'
    li.append(thumb, meta, badge)
    li.onclick = () => quiet(addItemInternal(it.id).then((uid) => select(uid)))
    return li
  }))
}

function renderPlacedUI() {
  const ul = $('placed-list')
  $('placed-count').textContent = items.size ? `(${items.size})` : ''
  ul.replaceChildren(...[...items.values()].map((r) => {
    const li = document.createElement('li')
    if (r.uid === selected) li.className = 'sel'
    const nm = document.createElement('span'); nm.textContent = r.lib.name || r.id
    const rd = document.createElement('span'); rd.className = 'badge'; rd.textContent = r.render
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove'
    x.onclick = (e) => { e.stopPropagation(); removeItemInternal(r.uid) }
    li.append(nm, rd, x)
    li.onclick = () => select(r.uid)
    return li
  }))
}

function renderSelectionUI() {
  const rec = selected && items.get(selected)
  $('selbar').hidden = !rec
  $('item-label').hidden = !rec
  $('sel-relight').hidden = room.kind !== 'splat'
  if (!rec) return
  $('sel-name').textContent = rec.lib.name || rec.id
  const both = !!(rec.lib.assets?.glb && rec.lib.assets?.splat)
  $('sel-render-seg').hidden = !both
  $('sel-glb').classList.toggle('on', rec.render === 'glb')
  $('sel-splat').classList.toggle('on', rec.render === 'splat')
  const lab = $('item-label')
  lab.replaceChildren(document.createTextNode(rec.lib.name || rec.id))
  const dm = document.createElement('span'); dm.className = 'dims'; dm.textContent = dimsText(rec.lib.dims_cm)
  lab.append(dm)
}

// Alignment panel
const align = { yaw: 0, pitch: 0, roll: 0 }
function syncRoomUI() {
  const t = roomConfig.transform
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(t.quaternion).normalize(), 'YXZ')
  let yaw = e.y / DEG, pitch = e.x / DEG, roll = e.z / DEG
  // Ry(y)Rx(x)Rz(z) == Ry(y+180)Rx(180-x)Rz(z+180); show the one with the smaller roll (upside-down scans read as pitch 180).
  if (Math.abs(roll) > 90) { yaw = wrapDeg(yaw + 180); pitch = wrapDeg(180 - pitch); roll = wrapDeg(roll + 180) }
  align.yaw = round(yaw, 3); align.pitch = round(pitch, 3); align.roll = round(roll, 3)
  $('al-yaw').value = align.yaw; $('al-pitch').value = align.pitch; $('al-roll').value = align.roll
  $('al-x').value = round(t.position[0], 4); $('al-y').value = round(t.position[1], 4); $('al-z').value = round(t.position[2], 4)
  $('al-scale').value = round(t.scale, 5)
  const p = roomConfig.placeholder
  $('ph-w').value = p.w; $('ph-d').value = p.d; $('ph-h').value = p.h
  if (document.activeElement !== $('scan-url')) $('scan-url').value = roomConfig.splat || ''
  const isSplat = room.kind === 'splat'
  for (const id of ['al-floor', 'al-two', 'al-flip']) $(id).disabled = !isSplat
  $('ph-row').hidden = isSplat
  applyLook()
  renderSelectionUI()
  if (!room.loaded) return
  setRoomStatus(isSplat
    ? `${room.dropped || roomConfig.splat} · ${room.splatCount.toLocaleString()} splats${viewpoints().length ? ` · ${viewpoints().length} scan views` : ''}`
    : `placeholder ${p.w} × ${p.d} × ${p.h} m`)
}
// Look (exposure, warmth) lives in roomConfig.look, so Save room persists it.
function applyLook() {
  const l = roomConfig.look
  renderer.toneMappingExposure = l.exposure
  post.mat.uniforms.uTint.value.copy(warmthTint(l.warmth))
  syncLookUI()
}
function setLook(s) {
  const l = roomConfig.look
  if (isNum(s.exposure)) l.exposure = clampNum(s.exposure, 0.25, 4, 1)
  if (isNum(s.warmth)) l.warmth = clampNum(s.warmth, -1, 1, 0)
  applyLook()
}
function syncLookUI() {
  const l = roomConfig.look
  const ev = Math.log2(l.exposure)
  if (document.activeElement !== $('look-exposure')) $('look-exposure').value = String(round(ev, 3))
  if (document.activeElement !== $('look-warmth')) $('look-warmth').value = String(l.warmth)
  $('look-exposure-val').textContent = `${l.exposure.toFixed(2)}×`
  $('look-warmth-val').textContent = l.warmth === 0 ? 'neutral' : `${l.warmth > 0 ? 'warm' : 'cool'} ${Math.abs(l.warmth).toFixed(2)}`
  $('look-shadows').checked = contactShadows
  $('look-relight').disabled = room.kind !== 'splat'
  $('look-env').textContent = env.source === 'splat'
    ? `lit by the scan from ${env.probe.map((v) => v.toFixed(1)).join(', ')}`
    : room.kind === 'splat' ? 'baking light from the scan…' : 'neutral studio light'
  $('look-env').title = env.source === 'splat' ? 'Furniture is lit by a cube map of the scan taken from this point (m). Relight here moves it.' : ''
}
function setQuatFromAlign() {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(align.pitch * DEG, align.yaw * DEG, align.roll * DEG, 'YXZ'))
  roomConfig.transform.quaternion = [q.x, q.y, q.z, q.w].map((v) => round(v, 8))
  applyRoomTransform()
}
function bindNumber(id, apply) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value)
    if (Number.isFinite(v)) apply(v)
  })
}
bindNumber('al-yaw', (v) => { align.yaw = v; setQuatFromAlign() })
bindNumber('al-pitch', (v) => { align.pitch = v; setQuatFromAlign() })
bindNumber('al-roll', (v) => { align.roll = v; setQuatFromAlign() })
bindNumber('al-x', (v) => { roomConfig.transform.position[0] = v; applyRoomTransform() })
bindNumber('al-y', (v) => { roomConfig.transform.position[1] = v; applyRoomTransform() })
bindNumber('al-z', (v) => { roomConfig.transform.position[2] = v; applyRoomTransform() })
bindNumber('al-scale', (v) => { if (v > 0) { roomConfig.transform.scale = v; applyRoomTransform() } })
for (const k of ['w', 'd', 'h']) {
  bindNumber(`ph-${k}`, (v) => {
    if (!(v >= 0.5 && v <= 50)) return
    roomConfig.placeholder[k] = v
    if (room.kind === 'placeholder') { buildPlaceholder(roomConfig.placeholder); syncRoomUI() }
  })
}
$('al-flip').onclick = () => {
  align.pitch = wrapDeg(align.pitch + 180)
  setQuatFromAlign()
  syncRoomUI()
}
$('al-floor').onclick = () => startPickMode('floor')
$('al-two').onclick = () => startPickMode('two')
$('al-two-apply').onclick = () => applyTwoPointScale()
$('al-two-dist').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyTwoPointScale() })
$('room-save').onclick = () => quiet((async () => {
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
})())
$('room-revert').onclick = () => quiet((async () => {
  let cfg
  try { cfg = await apiJson('/api/room') } catch (e) { throw reportError('Could not read /api/room', e) }
  savedRoomConfig = clone(cfg)
  await loadRoomInternal(cfg, { frame: false })
})())
const loadScanFromField = () => {
  const path = $('scan-url').value.trim()
  const cfg = { ...clone(roomConfig), splat: path || null }
  if (!path || path !== roomConfig.splat || room.dropped) { cfg.transform = path === savedRoomConfig.splat ? savedRoomConfig.transform : IDENTITY(); delete cfg.measured }
  quiet(loadRoomInternal(cfg))
}
$('scan-load').onclick = loadScanFromField
$('scan-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadScanFromField() })
$('look-exposure').addEventListener('input', () => { const v = parseFloat($('look-exposure').value); if (Number.isFinite(v)) setLook({ exposure: round(2 ** v, 4) }) })
$('look-warmth').addEventListener('input', () => { const v = parseFloat($('look-warmth').value); if (Number.isFinite(v)) setLook({ warmth: round(v, 3) }) })
$('look-shadows').addEventListener('change', () => setContactShadows($('look-shadows').checked))
$('look-reset').onclick = () => setLook({ ...LOOK_DEFAULT })
$('look-relight').onclick = () => quiet(relightInternal(null).then(() => toast('Lit the furniture from the room center.', 'ok', 2500)))

// Library / layouts / toolbar / selection bar
$('layout-save').onclick = () => {
  const name = $('layout-name').value.trim()
  quiet(saveLayoutInternal(name).then(() => toast(`Saved layout "${name}"`, 'ok', 2500)))
}
$('layout-load').onclick = () => {
  const name = $('layout-name').value.trim()
  quiet(loadLayoutInternal(name).then(() => toast(`Loaded layout "${name}"`, 'ok', 2500)))
}
$('layout-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('layout-save').click() })
for (const b of document.querySelectorAll('#toolbar [data-view]')) b.onclick = () => setViewInternal(b.dataset.view)
$('tool-measure').onclick = () => setMeasureActive(!measure.active)
$('tool-frame').onclick = () => { setViewInternal('orbit'); frameRoom() }
$('sel-move').onclick = () => setGizmoMode('translate')
$('sel-rotate').onclick = () => setGizmoMode('rotate')
$('sel-ccw').onclick = () => rotateSelected(15)
$('sel-cw').onclick = () => rotateSelected(-15)
$('sel-glb').onclick = () => quiet(toggleRender(items.get(selected), 'glb'))
$('sel-splat').onclick = () => quiet(toggleRender(items.get(selected), 'splat'))
$('sel-remove').onclick = () => { if (selected) removeItemInternal(selected) }
$('sel-relight').onclick = () => {
  const rec = selected && items.get(selected)
  if (!rec) return
  const p = [round(rec.group.position.x, 4), 1.0, round(rec.group.position.z, 4)]
  quiet(relightInternal(p).then(() => toast(`Lit the furniture from ${rec.lib.name || rec.id}'s spot.`, 'ok', 2500)))
}
$('tool-render').onclick = () => quiet(env.chain.then(openRenderConfirm))
$('rc-model').replaceChildren(...Object.entries(RENDER_MODELS).map(([k, m]) => {
  const o = document.createElement('option')
  o.value = k
  o.textContent = `${m.label} (${k === 'qwen' ? '$0.03/MP' : fmtUsd(m.price(1))})`
  return o
}))
$('rc-model').onchange = updateRenderPrice
$('rc-cancel').onclick = closeRenderConfirm
$('rc-go').onclick = confirmRender
$('rv-close').onclick = closeRenderViewer
for (const id of ['render-confirm', 'render-view']) {
  $(id).addEventListener('pointerdown', (e) => { if (e.target === $(id)) (id === 'render-view' ? closeRenderViewer : closeRenderConfirm)() })
}
$('collapse').onclick = () => { $('sidebar').classList.add('collapsed'); $('expand').hidden = false; updateViewOffset() }
$('expand').onclick = () => { $('sidebar').classList.remove('collapsed'); $('expand').hidden = true; updateViewOffset() }
setGizmoMode('translate')

// --- render loop + overlays -------------------------------------------------------
const tmpV = new THREE.Vector3()
function placeTag(el, world, lift = 0) {
  tmpV.copy(world).project(camera)
  const behind = tmpV.z > 1 || tmpV.z < -1
  el.style.visibility = behind ? 'hidden' : 'visible'
  if (behind) return
  const x = (tmpV.x * 0.5 + 0.5) * window.innerWidth
  const y = (-tmpV.y * 0.5 + 0.5) * window.innerHeight - lift
  el.style.left = `${x}px`
  el.style.top = `${y}px`
}
function updateOverlays() {
  const rec = selected && items.get(selected)
  if (rec && !$('item-label').hidden) {
    const b = worldBounds(rec)
    placeTag($('item-label'), new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2), 10)
  }
  if (measure.points.length === 2) {
    placeTag($('measure-label'), measure.points[0].clone().add(measure.points[1]).multiplyScalar(0.5))
  }
}

const clock = new THREE.Clock()
let renderErrorReported = false
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (view === 'orbit') orbit.update()
    else updateFp(dt)
    if (!baking) renderFrame() // frozen while the environment bakes (Spark is sorted for the probe then)
    updateOverlays()
  } catch (e) {
    if (!renderErrorReported) reportError('Rendering failed', e)
    renderErrorReported = true
  }
})

// --- window.nook test hook (contract §2.4) -------------------------------------------
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

let readyResolve
const ready = new Promise((r) => { readyResolve = r })

window.nook = {
  ready,
  errors,
  getLibrary: () => library.slice(),
  loadRoom: (cfg) => loadRoomInternal(cfg),
  addItem: (id, opts) => {
    const o = opts || {}
    return addItemInternal(id, { position: o.position, rotation_y_deg: o.rotation_y_deg, render: o.render })
  },
  moveItem: (uid, opts) => moveItemInternal(uid, opts),
  removeItem: (uid) => removeItemInternal(uid),
  clearItems: () => clearItemsInternal(),
  saveLayout: (name) => saveLayoutInternal(name),
  loadLayout: (name) => loadLayoutInternal(name),
  listLayouts: () => listLayoutsInternal().catch((e) => { throw reportError('Could not list layouts', e) }),
  setView: (v) => setViewInternal(v),
  gotoViewpoint: (i) => gotoViewpoint(i),
  getState,
  // §2.6
  getRenderSettings: () => ({
    toneMapping: 'aces',
    exposure: roomConfig.look.exposure,
    warmth: roomConfig.look.warmth,
    envSource: env.source,
    contactShadows,
    shadowCount: [...items.values()].filter((r) => r.shadow && r.shadow.visible).length,
  }),
  setRenderSettings: (s) => {
    if (!s || typeof s !== 'object') { reportError('setRenderSettings needs an object'); return }
    if (s.exposure !== undefined || s.warmth !== undefined) setLook(s)
    if (typeof s.contactShadows === 'boolean') setContactShadows(s.contactShadows)
  },
  relight: (position) => relightInternal(position),
  renderView: (opts) => renderViewInternal(opts),
  listRenders: () => listRendersInternal(),
  // Extras beyond the contract, for manual checks (P5, P9): current measurement and world -> screen pixels.
  getMeasure,
  worldToScreen: (p) => {
    camera.updateMatrixWorld()
    const v = new THREE.Vector3().fromArray(p).project(camera)
    const r = canvas.getBoundingClientRect()
    return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height]
  },
}

async function init() {
  syncRoomUI()
  const roomP = (async () => {
    let cfg
    try { cfg = await apiJson('/api/room') } catch (e) {
      reportError('Could not read /api/room; using the placeholder room', e)
      cfg = { version: 1, placeholder: { ...DEFAULT_PLACEHOLDER } }
    }
    savedRoomConfig = clone(cfg)
    try { await loadRoomInternal(cfg) } catch { /* reported; placeholder is showing */ }
  })()
  await Promise.allSettled([roomP, loadLibrary(), refreshLayoutList(), listRendersInternal()])
}
init().catch((e) => reportError('Startup failed', e)).finally(() => readyResolve())
