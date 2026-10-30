// Judge a trained room splat: render it with Spark (the planner's renderer) from a capture's held-out camera poses
// and compare with the capture's images. Frames with index % every == 0 are the held-out ones (contract §4.6).
// Usage: node evals/psnr_judge.mjs <splat.ply> <capture-dir> [--every 10] [--max 18] [--save evals/out/psnr]
//   --val          the held-out frames are transforms_val.json's, all of them (a prepared dataset), not every Nth
//   --ext-splats   the mesh keeps its splats as ExtSplats (float32 centers), not PackedSplats (float16 centers)
//   --accum-ext    SparkRenderer's accumulator does too (accumExtSplats): without it, every splat passes through a
//                  packed form on its way to the screen, whatever the mesh keeps
//   --save DIR     writes render-NNNN.jpg and side-NNNN.jpg (render | photo)
//   --png          with --save, also render-NNNN.png (lossless, for pixel diffs)
//   --frames A,B   only these frames (file numbers with --val, list indices otherwise), instead of --every and --max
//   --max-sh N     evaluate spherical harmonics only up to degree N (mesh.maxSh)
// Prints JSON: { mean_psnr, min_psnr, frames: [{ index, psnr }], spark: { ... } }
// Browser: $NOOK_BROWSER. NOOK_SOFTWARE_GL=1 forces SwiftShader and fails if it gets anything else (never the real
// GPU); NOOK_NO_SANDBOX=1 passes --no-sandbox.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'

const BOOLEAN = ['--val', '--ext-splats', '--accum-ext', '--png']
const [splat, capture] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && (!(all[i - 1] || '').startsWith('--') || BOOLEAN.includes(all[i - 1])))
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const flag = (k) => process.argv.includes(`--${k}`)
const EVERY = Number(arg('every', 10)), MAX = Number(arg('max', 18)), SAVE = arg('save', null)
const MAX_SH = arg('max-sh', null), ONLY = arg('frames', null)?.split(',').map(Number)
const VAL = flag('val'), EXT = flag('ext-splats'), ACCUM_EXT = flag('accum-ext'), PNG = flag('png'), SOFTWARE = !!process.env.NOOK_SOFTWARE_GL
if (!splat || !capture) { console.error('usage: node evals/psnr_judge.mjs <splat.ply> <capture-dir> [--every 10]'); process.exit(2) }
const t = JSON.parse(fs.readFileSync(path.join(capture, VAL ? 'transforms_val.json' : 'transforms.json'), 'utf8'))
const held = VAL
  ? t.frames.map((f) => ({ ...f, index: Number(path.parse(f.file_path).name) }))
  : t.frames.map((f, index) => ({ ...f, index })).filter((f) => f.index % EVERY === 0)
const pick = ONLY ? held.filter((f) => ONLY.includes(f.index)) : held.filter((_, k) => k % Math.max(1, Math.ceil(held.length / MAX)) === 0)

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/","@sparkjsdev/spark":"https://sparkjs.dev/releases/spark/2.4.0/spark.module.js"}}</script>
<script type="module">
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
const { w, h, fl_y, splatUrl, ext, accumExt, png, maxSh } = window.CFG
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1); renderer.setSize(w, h); renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000)
const spark = new SparkRenderer({ renderer, accumExtSplats: accumExt }); scene.add(spark)
const mesh = new SplatMesh(ext ? { url: splatUrl, extSplats: true } : { url: splatUrl }); scene.add(mesh); await mesh.initialized
if (maxSh !== null) mesh.maxSh = maxSh
const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info')
window.SPARK = { gl_renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown', mesh: mesh.extSplats ? 'ExtSplats' : 'PackedSplats', accum: accumExt ? 'ext' : 'packed', splats: mesh.numSplats }
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
  // A picture counts only once Spark has sorted for this very camera. A fixed number of renders is not enough: a slow
  // sort (software GL takes many seconds) leaves the previous frame's order on screen, which looks like smear and blur.
  renderer.render(scene, cam); await spark.update({ scene, camera: cam })
  const deadline = performance.now() + 600000
  while (spark.sorting || spark.sortDirty || spark.sortedCenter.distanceTo(cam.position) > 1e-4) {
    if (performance.now() > deadline) throw new Error('Spark did not finish sorting')
    await sleep(100)
    if (!spark.sorting) renderer.render(scene, cam)   // drives an update that was refused while another sort ran
  }
  renderer.render(scene, cam)
  g.drawImage(renderer.domElement, 0, 0); const a = g.getImageData(0, 0, w, h).data
  const img = new Image(); img.src = imgUrl; await img.decode()
  g.drawImage(img, 0, 0, w, h); const b = g.getImageData(0, 0, w, h).data
  const both = document.createElement('canvas'); both.width = 2 * w; both.height = h
  const bg = both.getContext('2d'); bg.drawImage(renderer.domElement, 0, 0); bg.drawImage(img, w, 0, w, h)
  let se = 0
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d }
  const mse = se / (w * h * 3)
  return { psnr: mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse), render: renderer.domElement.toDataURL('image/jpeg', 0.85), side: both.toDataURL('image/jpeg', 0.92), png: png ? renderer.domElement.toDataURL('image/png') : null }
}
window.READY = true
</script></body></html>`

const browser = await chromium.launch({ executablePath: process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', headless: true, args: [...(SOFTWARE ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=metal', '--ignore-gpu-blocklist']), ...(process.env.NOOK_NO_SANDBOX ? ['--no-sandbox'] : [])] })
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
await page.addInitScript((cfg) => { window.CFG = cfg }, { w: t.w, h: t.h, fl_y: t.fl_y, splatUrl: `/f${path.resolve(splat)}`, ext: EXT, accumExt: ACCUM_EXT, png: PNG, maxSh: MAX_SH === null ? null : Number(MAX_SH) })
await page.goto(`${BASE}/judge.html`)
await page.waitForFunction(() => window.READY, null, { timeout: 180000 })
const spark = await page.evaluate(() => window.SPARK)
if (SOFTWARE && !/swiftshader/i.test(spark.gl_renderer)) { console.error(`NOOK_SOFTWARE_GL=1 but WebGL runs on: ${spark.gl_renderer}`); process.exit(1) }
if (SAVE) fs.mkdirSync(SAVE, { recursive: true })
const frames = []
for (const f of pick) {
  const K = ['fl_x', 'fl_y', 'cx', 'cy'].map((k) => f[k] ?? t[k])
  const r = await page.evaluate(([m, u, K]) => window.judge(m, u, K), [f.transform_matrix, `/f${path.resolve(capture, f.file_path)}`, K])
  frames.push({ index: f.index, psnr: +r.psnr.toFixed(2) })
  if (SAVE) {
    const out = (name, url) => fs.writeFileSync(path.join(SAVE, `${name}-${String(f.index).padStart(4, '0')}.${url.startsWith('data:image/png') ? 'png' : 'jpg'}`), Buffer.from(url.split(',')[1], 'base64'))
    out('render', r.render); out('side', r.side)
    if (r.png) out('render', r.png)
  }
}
await browser.close()
server.close()
const ps = frames.map((f) => f.psnr)
console.log(JSON.stringify({ mean_psnr: +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2), min_psnr: Math.min(...ps), frames, spark }))
