// Render a synthetic room with known camera poses into a nook-scan capture (contract §4): the ground truth for the
// trainer eval and the iOS replay test. The world follows ARKit's convention: meters, +Y up, origin at the phone's
// start, floor at y = FLOOR. Runs three.js in headless Helium on the GPU.
// Usage: node fixtures/make_capture.mjs --out DIR [--frames 180] [--size 960x720] [--seed 1]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const OUT = path.resolve(arg('out', path.join(REPO, 'evals/out/capture-gt')))
const FRAMES = Number(arg('frames', 180))
const [W, H] = arg('size', '960x720').split('x').map(Number)
const SEED = Number(arg('seed', 1))
const DW = 256, DH = 192
const FLOOR = -1.35

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
const { W, H, DW, DH, FLOOR, SEED, FRAMES } = window.CFG
let s = SEED * 9301 + 49297
const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101010)
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x8a7f72, 1.6))
const sun = new THREE.DirectionalLight(0xfff0dd, 1.4); sun.position.set(2, 3, 1); scene.add(sun)

function tex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = 8
  return t
}
const noise = (g, w, h, a) => { for (let i = 0; i < w * h / 40; i++) { g.fillStyle = 'rgba(' + (rnd() < .5 ? '0,0,0' : '255,255,255') + ',' + (rnd() * a) + ')'; g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 6) } }
const wood = tex(512, 512, (g, w, h) => { for (let y = 0; y < h; y += 32) { const b = 110 + rnd() * 50; g.fillStyle = 'rgb(' + (b + 40) + ',' + (b * .7) + ',' + (b * .45) + ')'; g.fillRect(0, y, w, 31); for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(60,30,10,.25)'; g.fillRect(rnd() * w, y + rnd() * 30, 40 + rnd() * 120, 1) } g.fillStyle = 'rgba(40,20,5,.6)'; g.fillRect(rnd() * w, y, 2, 31) } }, [4, 4])
function wall(color, features) {
  return tex(1024, 512, (g, w, h) => {
    g.fillStyle = color; g.fillRect(0, 0, w, h); noise(g, w, h, .08)
    g.fillStyle = '#e8e4dc'; g.fillRect(0, h - 22, w, 22)
    for (const f of features) f(g, w, h)
  })
}
const frame = (x, y, fw, fh, hue) => (g) => { g.fillStyle = '#2b2118'; g.fillRect(x - 8, y - 8, fw + 16, fh + 16); for (let i = 0; i < 14; i++) { g.fillStyle = 'hsl(' + (hue + rnd() * 60) + ',' + (40 + rnd() * 40) + '%,' + (30 + rnd() * 50) + '%)'; g.beginPath(); g.arc(x + rnd() * fw, y + rnd() * fh, 6 + rnd() * fw / 4, 0, 7); g.fill() } }
const windowF = (x, y, ww, wh) => (g) => { g.fillStyle = '#f4f1ea'; g.fillRect(x - 10, y - 10, ww + 20, wh + 20); const sky = g.createLinearGradient(0, y, 0, y + wh); sky.addColorStop(0, '#9cc8ee'); sky.addColorStop(1, '#e0eef8'); g.fillStyle = sky; g.fillRect(x, y, ww, wh); g.fillStyle = '#5d8a4e'; for (let i = 0; i < 9; i++) { g.beginPath(); g.arc(x + rnd() * ww, y + wh, 20 + rnd() * 40, Math.PI, 0); g.fill() } g.fillStyle = '#f4f1ea'; g.fillRect(x + ww / 2 - 4, y, 8, wh); g.fillRect(x, y + wh / 2 - 4, ww, 8) }
const door = (x) => (g, w, h) => { g.fillStyle = '#8a6a4a'; g.fillRect(x, h * .2, 150, h * .8 - 22); g.strokeStyle = '#5a422c'; g.lineWidth = 4; g.strokeRect(x + 15, h * .25, 120, h * .3); g.strokeRect(x + 15, h * .6, 120, h * .3); g.fillStyle = '#d8c070'; g.beginPath(); g.arc(x + 130, h * .6, 7, 0, 7); g.fill() }
const RW = 4.0, RD = 3.6, RH = 2.6
const room = new THREE.Group(); room.position.y = FLOOR; scene.add(room)
const plane = (w, h, map, color) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map, color }))
const floor = plane(RW, RD, wood); floor.rotation.x = -Math.PI / 2; room.add(floor)
const ceil = plane(RW, RD, tex(256, 256, (g, w, h) => { g.fillStyle = '#f2f0ea'; g.fillRect(0, 0, w, h); noise(g, w, h, .05) })); ceil.rotation.x = Math.PI / 2; ceil.position.y = RH; room.add(ceil)
const walls = [
  [RW, 0, RD / 2, Math.PI, wall('#c9d6c3', [windowF(330, 90, 360, 230)])],
  [RW, 0, -RD / 2, 0, wall('#e3d5c0', [frame(120, 120, 180, 130, 10), frame(420, 90, 120, 170, 200), frame(640, 140, 220, 110, 280)])],
  [RD, -RW / 2, 0, Math.PI / 2, wall('#b9c7d4', [door(560), frame(150, 130, 160, 160, 40)])],
  [RD, RW / 2, 0, -Math.PI / 2, wall('#d9c3b5', [frame(380, 100, 260, 160, 120)])],
]
for (const [len, x, z, ry, map] of walls) { const m = plane(len, RH, map); m.position.set(x, RH / 2, z); m.rotation.y = ry; room.add(m) }
const rug = plane(1.9, 1.3, tex(512, 360, (g, w, h) => { g.fillStyle = '#7a2e2e'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e6c88a'; g.lineWidth = 10; g.strokeRect(20, 20, w - 40, h - 40); for (let i = 0; i < 30; i++) { g.fillStyle = 'hsl(' + (20 + rnd() * 30) + ',60%,' + (30 + rnd() * 40) + '%)'; g.beginPath(); g.moveTo(w / 2, h / 2); g.arc(w / 2, h / 2, 40 + rnd() * 120, rnd() * 7, rnd() * 7); g.fill() } noise(g, w, h, .15) }))
rug.rotation.x = -Math.PI / 2; rug.position.set(0.2, 0.004, 0.3); room.add(rug)
const box = (w, h, d, color, x, y, z, map) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, map })); m.position.set(x, y + h / 2, z); room.add(m); return m }
box(1.2, 1.8, 0.35, 0xf0ebe0, -1.2, 0, -1.6)
for (let shelf = 0; shelf < 4; shelf++) { box(1.16, 0.02, 0.33, 0xd8d0c0, -1.2, 0.05 + shelf * 0.44, -1.6); let x = -1.75; while (x < -0.7) { const bw = 0.03 + rnd() * 0.05, bh = 0.22 + rnd() * 0.12; box(bw, bh, 0.24, new THREE.Color().setHSL(rnd(), .5, .25 + rnd() * .4).getHex(), x + bw / 2, 0.07 + shelf * 0.44, -1.58); x += bw + 0.005 } }
const table = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.55, 32), new THREE.MeshLambertMaterial({ color: 0x6b4a2e })); table.position.set(1.1, 0.275, -0.9); room.add(table)
const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.5), new THREE.MeshLambertMaterial({ color: 0x222222 })); lampPole.position.set(1.5, 0.75, 1.3); room.add(lampPole)
const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.3, 32, 1, true), new THREE.MeshLambertMaterial({ color: 0xf6e6c4, side: THREE.DoubleSide })); shade.position.set(1.5, 1.55, 1.3); room.add(shade)
const gltf = await new GLTFLoader().loadAsync('/fixtures/models/SheenChair.glb')
const chair = gltf.scene; chair.scale.setScalar(1.1); chair.position.set(0.3, 0, -0.1); chair.rotation.y = -0.5; room.add(chair)
chair.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: o.material.map, color: o.material.color }) })

// Camera: phone-like FOV (64 deg horizontal on a 4:3 landscape sensor).
const fl = W / (2 * Math.tan((64 * Math.PI / 180) / 2))
const cam = new THREE.PerspectiveCamera(2 * Math.atan(H / 2 / fl) * 180 / Math.PI, W / H, 0.05, 30)
// Depth: view-space distance along -Z, written to a float target at LiDAR resolution.
const depthRT = new THREE.WebGLRenderTarget(DW, DH, { type: THREE.FloatType, format: THREE.RGBAFormat })
const depthMat = new THREE.ShaderMaterial({ vertexShader: 'varying float vz; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }', fragmentShader: 'varying float vz; void main(){ gl_FragColor = vec4(vz, 0.0, 0.0, 1.0); }', side: THREE.DoubleSide })
const small = document.createElement('canvas'); small.width = DW; small.height = DH
const sg = small.getContext('2d', { willReadFrequently: true })

// Path: loop A at standing height looking across the room, loop B lower and pitched down, with jitter.
const center = new THREE.Vector3(0, FLOOR + 1.0, 0)
function pose(i) {
  const a = i < FRAMES * 0.55, k = a ? i / (FRAMES * 0.55) : (i - FRAMES * 0.55) / (FRAMES * 0.45)
  const t = k * Math.PI * 2 + (a ? 0 : 0.6)
  const p = new THREE.Vector3(Math.cos(t) * (a ? 1.05 : 0.8), a ? 0 : -0.55, Math.sin(t) * (a ? 0.85 : 0.65))
  p.x += (rnd() - .5) * 0.06; p.y += (rnd() - .5) * 0.05; p.z += (rnd() - .5) * 0.06
  const look = a ? center.clone().multiplyScalar(1).add(new THREE.Vector3(-Math.cos(t) * 0.8, 0.1, -Math.sin(t) * 0.7))
                 : new THREE.Vector3(-Math.cos(t + 0.7) * 1.6, FLOOR + 0.4, -Math.sin(t + 0.7) * 1.4)
  cam.position.copy(p); cam.up.set(0, 1, 0); cam.lookAt(look); cam.updateMatrixWorld(true)
}
window.FL = fl
window.renderFrame = (i) => {
  pose(i)
  renderer.setRenderTarget(null); renderer.render(scene, cam)
  const jpg = renderer.domElement.toDataURL('image/jpeg', 0.92)
  sg.drawImage(renderer.domElement, 0, 0, DW, DH)
  const rgb = sg.getImageData(0, 0, DW, DH).data
  scene.overrideMaterial = depthMat; renderer.setRenderTarget(depthRT); renderer.render(scene, cam)
  const buf = new Float32Array(DW * DH * 4); renderer.readRenderTargetPixels(depthRT, 0, 0, DW, DH, buf)
  renderer.setRenderTarget(null); scene.overrideMaterial = null
  const depth = new Array(DW * DH), pts = []
  const fx = fl * DW / W, fy = fl * DH / H, cxd = DW / 2, cyd = DH / 2
  for (let v = 0; v < DH; v++) for (let u = 0; u < DW; u++) {
    const d = buf[((DH - 1 - v) * DW + u) * 4]   // render targets are bottom-up
    depth[v * DW + u] = d > 0 && d < 25 ? Math.round(d * 1000) : 0
    if (i % 6 === 0 && u % 4 === 0 && v % 4 === 0 && d > 0 && d < 25) {
      const pc = new THREE.Vector3((u + .5 - cxd) / fx * d, -(v + .5 - cyd) / fy * d, -d).applyMatrix4(cam.matrixWorld)
      const o = (v * DW + u) * 4
      pts.push(pc.x, pc.y, pc.z, rgb[o], rgb[o + 1], rgb[o + 2])
    }
  }
  return { jpg, depth, pts, m: cam.matrixWorld.elements.slice() }
}
window.READY = true
</script></body></html>`

function png16(width, height, mm) {
  const raw = Buffer.alloc((width * 2 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 2 + 1)] = 0
    for (let x = 0; x < width; x++) raw.writeUInt16BE(Math.min(65535, mm[y * width + x]), y * (width * 2 + 1) + 1 + x * 2)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 16; ihdr[9] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'images'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'depth'), { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', headless: true, args: process.env.NOOK_SOFTWARE_GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on('pageerror', (e) => { console.error('page error:', e); process.exit(1) })
await page.route('http://nook.local/**', (route) => {
  const p = new URL(route.request().url()).pathname
  if (p === '/gen.html') return route.fulfill({ contentType: 'text/html', body: PAGE })
  route.fulfill({ path: path.join(REPO, p) })
})
await page.addInitScript((cfg) => { window.CFG = cfg }, { W, H, DW, DH, FLOOR, SEED, FRAMES })
await page.goto('http://nook.local/gen.html')
await page.waitForFunction(() => window.READY, null, { timeout: 60000 })
const fl = await page.evaluate(() => window.FL)
const frames = [], points = []
for (let i = 0; i < FRAMES; i++) {
  const r = await page.evaluate((i) => window.renderFrame(i), i)
  const n = String(i + 1).padStart(6, '0')
  fs.writeFileSync(path.join(OUT, `images/${n}.jpg`), Buffer.from(r.jpg.split(',')[1], 'base64'))
  fs.writeFileSync(path.join(OUT, `depth/${n}.png`), png16(DW, DH, r.depth))
  points.push(...r.pts)
  const e = r.m  // column-major -> row-major
  frames.push({ file_path: `images/${n}.jpg`, depth_file_path: `depth/${n}.png`, timestamp: +(i * 0.1).toFixed(3),
    transform_matrix: [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((col) => +e[col * 4 + row].toFixed(6))) })
  if ((i + 1) % 30 === 0) console.log(`  ${i + 1}/${FRAMES}`)
}
await browser.close()

const nPts = points.length / 6
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${nPts}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`
const body = Buffer.alloc(nPts * 15)
for (let k = 0; k < nPts; k++) {
  body.writeFloatLE(points[k * 6], k * 15); body.writeFloatLE(points[k * 6 + 1], k * 15 + 4); body.writeFloatLE(points[k * 6 + 2], k * 15 + 8)
  body[k * 15 + 12] = points[k * 6 + 3]; body[k * 15 + 13] = points[k * 6 + 4]; body[k * 15 + 14] = points[k * 6 + 5]
}
fs.writeFileSync(path.join(OUT, 'points.ply'), Buffer.concat([Buffer.from(header), body]))
fs.writeFileSync(path.join(OUT, 'transforms.json'), JSON.stringify({
  camera_model: 'OPENCV', fl_x: +fl.toFixed(4), fl_y: +fl.toFixed(4), cx: W / 2, cy: H / 2, w: W, h: H, ply_file_path: 'points.ply', frames,
}, null, 1))
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
  version: 1, app: 'nook-scan', app_version: 'fixture', device: 'synthetic', lidar: true, world: 'arkit-gravity-y-up-meters',
  created: '2026-10-25T00:00:00Z', frame_count: FRAMES, floor_y: FLOOR,
}, null, 2))
console.log(`wrote ${FRAMES} frames, ${nPts} seed points -> ${path.relative(REPO, OUT)}`)
