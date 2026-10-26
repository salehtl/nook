// Judge a trained room splat: render it with Spark (the planner's renderer) from a capture's held-out camera poses
// and compare with the capture's images. Frames with index % every == 0 are the held-out ones (contract §4.6).
// Usage: node evals/psnr_judge.mjs <splat.ply> <capture-dir> [--every 10] [--max 18] [--save evals/out/psnr]
// Prints JSON: { mean_psnr, min_psnr, frames: [{ index, psnr }] }
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'

const [splat, capture] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'))
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const EVERY = Number(arg('every', 10)), MAX = Number(arg('max', 18)), SAVE = arg('save', null)
if (!splat || !capture) { console.error('usage: node evals/psnr_judge.mjs <splat.ply> <capture-dir> [--every 10]'); process.exit(2) }
const t = JSON.parse(fs.readFileSync(path.join(capture, 'transforms.json'), 'utf8'))
const held = t.frames.map((f, index) => ({ ...f, index })).filter((f) => f.index % EVERY === 0)
const pick = held.filter((_, k) => k % Math.max(1, Math.ceil(held.length / MAX)) === 0)

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/","@sparkjsdev/spark":"https://sparkjs.dev/releases/spark/2.4.0/spark.module.js"}}</script>
<script type="module">
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
const { w, h, fl_y, splatUrl } = window.CFG
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1); renderer.setSize(w, h); renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000)
scene.add(new SparkRenderer({ renderer }))
const mesh = new SplatMesh({ url: splatUrl }); scene.add(mesh); await mesh.initialized
const cam = new THREE.PerspectiveCamera(2 * Math.atan(h / 2 / fl_y) * 180 / Math.PI, w / h, 0.02, 50)
const c2 = document.createElement('canvas'); c2.width = w; c2.height = h
const g = c2.getContext('2d', { willReadFrequently: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Per-frame pinhole intrinsics (ARKit autofocus changes them frame to frame) as an exact projection matrix.
function setIntrinsics(fx, fy, cx, cy, n = 0.02, f = 50) {
  cam.projectionMatrix.set(2 * fx / w, 0, 1 - 2 * cx / w, 0,  0, 2 * fy / h, 2 * cy / h - 1, 0,  0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),  0, 0, -1, 0)
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert()
}
window.judge = async (m, imgUrl, K) => {
  new THREE.Matrix4().set(...m.flat()).decompose(cam.position, cam.quaternion, cam.scale); cam.updateMatrixWorld(true)
  setIntrinsics(...K)
  for (let k = 0; k < 12; k++) { renderer.render(scene, cam); await sleep(60) }   // let Spark's async sort settle
  g.drawImage(renderer.domElement, 0, 0); const a = g.getImageData(0, 0, w, h).data
  const img = new Image(); img.src = imgUrl; await img.decode()
  g.drawImage(img, 0, 0, w, h); const b = g.getImageData(0, 0, w, h).data
  let se = 0
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d }
  const mse = se / (w * h * 3)
  return { psnr: mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse), render: renderer.domElement.toDataURL('image/jpeg', 0.85) }
}
window.READY = true
</script></body></html>`

const browser = await chromium.launch({ executablePath: process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', headless: true, args: process.env.NOOK_SOFTWARE_GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: t.w, height: t.h } })
page.on('pageerror', (e) => { console.error('page error:', e); process.exit(1) })
// A local server streams files: page.route/fulfill buffers whole bodies and dies on splats of ~90 MB and up.
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === '/judge.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
  const file = p.replace(/^\/f/, '')
  if (!p.startsWith('/f/') || !fs.existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-length': fs.statSync(file).size })
  fs.createReadStream(file).pipe(res)
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const BASE = `http://127.0.0.1:${server.address().port}`
await page.addInitScript((cfg) => { window.CFG = cfg }, { w: t.w, h: t.h, fl_y: t.fl_y, splatUrl: `/f${path.resolve(splat)}` })
await page.goto(`${BASE}/judge.html`)
await page.waitForFunction(() => window.READY, null, { timeout: 180000 })
if (SAVE) fs.mkdirSync(SAVE, { recursive: true })
const frames = []
for (const f of pick) {
  const K = ['fl_x', 'fl_y', 'cx', 'cy'].map((k) => f[k] ?? t[k])
  const r = await page.evaluate(([m, u, K]) => window.judge(m, u, K), [f.transform_matrix, `/f${path.resolve(capture, f.file_path)}`, K])
  frames.push({ index: f.index, psnr: +r.psnr.toFixed(2) })
  if (SAVE) fs.writeFileSync(path.join(SAVE, `render-${String(f.index).padStart(4, '0')}.jpg`), Buffer.from(r.render.split(',')[1], 'base64'))
}
await browser.close()
server.close()
const ps = frames.map((f) => f.psnr)
console.log(JSON.stringify({ mean_psnr: +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2), min_psnr: Math.min(...ps), frames }))
