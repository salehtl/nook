// Room level of detail: load, memory, frame time, image, pick and bake measurements with LoD on and off, in the real
// planner, in headless Chromium with software GL (never the real GPU). Times are only relative to each other.
//   node evals/sharpness/lod_bench.mjs --room-dir <dir with the rooms> --rooms a.spz,b.spz --out <dir> [--modes off,on] [--port 18900]
// NOOK_BROWSER = chromium binary. Results: <out>/results.json (one record per room and mode) and PNGs per view.
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '../..')
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
const ROOM_DIR = path.resolve(arg('room-dir'))
const ROOMS = arg('rooms').split(',')
const MODES = arg('modes', 'off,on').split(',')
const OUT = path.resolve(arg('out'))
const PORT = Number(arg('port', 18900))
const SIZE = { width: Number(arg('w', 640)), height: Number(arg('h', 400)) }
const FULL = !process.argv.includes('--quick')
fs.mkdirSync(path.join(OUT, 'layouts'), { recursive: true })

const server = spawn('python3', ['planner/serve.py', '--port', String(PORT), '--room-dir', ROOM_DIR,
  '--room-file', path.join(OUT, 'room.json'), '--layouts-dir', path.join(OUT, 'layouts'), '--renders-dir', path.join(OUT, 'renders'),
  '--costs-file', path.join(OUT, 'costs.csv')], { cwd: REPO, stdio: 'ignore' })
const stop = () => { try { server.kill() } catch { /* gone */ } }
process.on('exit', stop)
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/room`)).ok) break } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250))
}

// PSS (MB) of the browser's processes by type: SwiftShader's "GPU memory" is ordinary memory of the gpu-process here.
function pss(rootPid) {
  const out = { renderer: 0, gpu: 0, other: 0 }
  const kids = execSync(`ps -eo pid=,ppid=,args=`).toString().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  const inTree = new Set([rootPid])
  for (let pass = 0; pass < 4; pass++) for (const m of kids) if (inTree.has(Number(m[2]))) inTree.add(Number(m[1]))
  for (const m of kids) {
    const pid = Number(m[1])
    if (!inTree.has(pid)) continue
    let kb = 0
    try { kb = Number(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)?.[1] || 0) } catch { continue }
    const type = m[3].includes('--type=renderer') ? 'renderer' : m[3].includes('--type=gpu-process') ? 'gpu' : 'other'
    out[type] += kb / 1024
  }
  return out
}

// Runs in the page: helpers on window.B.
const PAGE_HELPERS = () => {
  const { engine } = window.nookCtx
  const { scene, camera, renderer, orbit } = engine.three
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const find = (f) => { let o = null; scene.traverse((c) => { if (!o && f(c)) o = c }); return o }
  const spark = () => find((c) => typeof c.renderCubeMap === 'function')
  const mesh = () => find((c) => c.packedSplats && c.parent === scene)
  const setCam = (pos, target) => { orbit.target.set(...target); camera.position.set(...pos); orbit.update(); camera.updateMatrixWorld() }
  // Keep rendering until the selection and the sort stop changing.
  const settle = async (ms = 1500, maxMs = 240000) => {
    const t0 = performance.now(); let last = -1, stable = performance.now()
    while (performance.now() - t0 < maxMs) {
      window.dispatchEvent(new Event('touchmove')) // wakes the on-demand loop
      await new Promise((r) => requestAnimationFrame(r))
      const m = mesh(), s = spark(), n = m ? m.numSplats : 0
      if (n !== last || s.sorting) { last = n; stable = performance.now() }
      if (window.B.trace) console.log('B:', Math.round(performance.now() - t0), n, s.sorting, s.lodDirty)
      if (performance.now() - stable > ms) break
      await sleep(30)
    }
    return mesh()?.numSplats
  }
  const frameMs = (k = 3) => {
    const gl = renderer.getContext(), ts = [], px = new Uint8Array(4)
    for (let i = 0; i < k; i++) { const t = performance.now(); renderer.setRenderTarget(null); renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now() - t) }
    return ts.sort((a, b) => a - b)[k >> 1]
  }
  const shot = () => { engine.three.renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png') }
  const imageData = async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0)
    return x.getImageData(0, 0, img.width, img.height).data
  }
  // PSNR between two PNGs; Laplacian variance (a sharpness number) of each.
  const lapVar = (d, w, h) => {
    const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
    let s = 0, s2 = 0, n = 0
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++ }
    return s2 / n - (s / n) ** 2
  }
  const compare = async (a, b, w, h) => {
    const da = await imageData(a), db = await imageData(b)
    let e = 0, n = 0
    for (let i = 0; i < da.length; i += 4) for (let c = 0; c < 3; c++) { const v = da[i + c] - db[i + c]; e += v * v; n++ }
    return { psnr: e ? 10 * Math.log10(255 * 255 / (e / n)) : Infinity, lapA: lapVar(da, w, h), lapB: lapVar(db, w, h) }
  }
  window.B = { trace: location.hash === '#trace', engine, scene, camera, renderer, orbit, sleep, spark, mesh, setCam, settle, frameMs, shot, compare }
}

const results = []
const persist = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1))
const byKey = {}

for (const roomFile of ROOMS) for (const mode of MODES) {
  const marker = `--nook-lod-bench=${process.pid}-${Date.now()}`
  const browser = await chromium.launch({ executablePath: process.env.NOOK_BROWSER, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', marker] })
  const page = await browser.newPage({ viewport: SIZE })
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); if (/LoD|lod|^B:/.test(m.text())) console.log('  page:', m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  const pid = Number(execSync(`pgrep -o -f -- '${marker}'`).toString().trim())
  let peak = { renderer: 0, gpu: 0 }
  const sampler = setInterval(() => { try { const m = pss(pid); peak = { renderer: Math.max(peak.renderer, m.renderer), gpu: Math.max(peak.gpu, m.gpu) } } catch { /* gone */ } }, 300)
  const rec = { room: roomFile, mode, bytes: fs.statSync(path.join(ROOM_DIR, roomFile)).size }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const heap = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); const g = (n) => metrics.find((m) => m.name === n)?.value; return { used: g('JSHeapUsedSize') / 1e6, total: g('JSHeapTotalSize') / 1e6 } }

  await page.goto(`http://127.0.0.1:${PORT}/planner/?lod=${mode.startsWith('on') ? '1' : '0'}${process.env.BENCH_TRACE ? '#trace' : ''}`)
  await page.waitForFunction(() => window.nook && window.nookCtx)
  await page.evaluate(() => window.nook.ready)
  await page.evaluate(PAGE_HELPERS)
  // on@1500000: Spark's iOS budget on this desktop (1 M: Android). Not phone measurements: only what that budget selects.
  const budget = Number(mode.split('@')[1]?.split('~')[0] || 0)
  if (budget) await page.evaluate((n) => { window.B.spark().lodSplatCount = n }, budget)
  // on~0.5: lodRenderScale. off#2: a second plain run, the noise floor of the image comparison.
  const pixelScale = Number(mode.split('~')[1] || 0)
  if (pixelScale) await page.evaluate((k) => { window.B.spark().lodRenderScale = k }, pixelScale)
  // Mean brightness of every drawn frame, with the splats drawn: does the switch to LoD blink?
  await page.evaluate(() => {
    const B = window.B, gl = B.renderer.getContext(), px = new Uint8Array(4 * 32 * 32)
    B.series = []
    B.engine.onFrame(() => {
      const m = B.mesh(); if (!m) return
      gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px)
      let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]
      B.series.push([Math.round(performance.now()), m.numSplats, Math.round(s / (32 * 32 * 3) * 10) / 10, B.engine.getRoom().lod])
    })
  })
  rec.memEmpty = { ...pss(pid), heap: await heap() }

  // --- load ------------------------------------------------------------------------------------------------------
  Object.assign(rec, await page.evaluate(async (splat) => {
    const { engine } = window.B
    const t0 = performance.now()
    await window.nook.loadRoom({ version: 1, splat, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 } })
    const loadMs = performance.now() - t0
    let lodMs = null
    while (engine.getRoom().lod === 'building' || (performance.now() - t0 < 200)) await window.B.sleep(20)
    if (engine.getRoom().lod === 'on') lodMs = performance.now() - t0 - loadMs
    return { loadMs, lodMs, lodState: engine.getRoom().lod, splatCount: engine.getRoom().splatCount, box: engine.getRoomBox() }
  }, `/room/${roomFile}`))
  // The tree build starts once the first bake is over: wait for it.
  await page.evaluate(async (mode) => {
    const { engine, sleep } = window.B
    const t0 = performance.now()
    if (mode.startsWith('on')) {
      while (engine.getRoom().lod !== 'on' && performance.now() - t0 < 600000) await sleep(50)
      window.B.lodReadyMs = performance.now() - t0
    }
  }, mode)
  rec.afterLodWaitMs = await page.evaluate(() => window.B.lodReadyMs ?? null)
  const b = rec.box
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)
  const hw = [0, 1, 2].map((i) => (b.max[i] - b.min[i]) / 2)
  const eyeY = b.min[1] + 1.2
  const ALL_VIEWS = {
    outside: { pos: [c[0] + hw[0] * 2.2, b.max[1] + hw[1] * 2.5, c[2] + hw[2] * 2.2], target: c },
    center_x: { pos: [c[0], eyeY, c[2]], target: [c[0] + 1, eyeY, c[2]] },
    center_z: { pos: [c[0], eyeY, c[2]], target: [c[0], eyeY - 0.1, c[2] - 1] },
    corner: { pos: [c[0] + hw[0] * 0.7, eyeY, c[2] + hw[2] * 0.7], target: c },
    close: { pos: [c[0] + hw[0] * 0.4, b.min[1] + 0.6, c[2] - hw[2] * 0.3], target: [c[0] + hw[0] * 0.8, b.min[1] + 0.2, c[2] - hw[2] * 0.3] },
  }
  const VIEWS = process.env.BENCH_VIEWS ? Object.fromEntries(process.env.BENCH_VIEWS.split(',').map((k) => [k, ALL_VIEWS[k]])) : ALL_VIEWS
  rec.seriesBeforeViews = await page.evaluate(async () => { await window.B.settle(); return window.B.series.slice() })
  rec.memLoaded = { ...pss(pid), heap: await heap() }

  // --- fixed views: splats drawn, frame time, image ------------------------------------------------------------------
  rec.views = {}
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })
  for (const [name, v] of Object.entries(VIEWS)) {
    const r = await page.evaluate(async ({ v }) => {
      const B = window.B
      B.setCam(v.pos, v.target)
      const t0 = performance.now()
      const drawn = await B.settle()
      const settleMs = performance.now() - t0
      const frameMs = B.frameMs(3)
      return { drawn, settleMs, frameMs, png: B.shot() }
    }, { v })
    const key = `${roomFile}/${name}`
    fs.writeFileSync(path.join(OUT, 'shots', `${roomFile}-${name}-${mode}.png`), Buffer.from(r.png.split(',')[1], 'base64'))
    byKey[key] ??= {}
    byKey[key][mode] = r.png
    rec.views[name] = { drawn: r.drawn, settleMs: r.settleMs, frameMs: r.frameMs }
    // --baseline <dir>: the plain run's PNGs from an earlier run of this script.
    const saved = arg('baseline') && path.join(path.resolve(arg('baseline')), 'shots', `${roomFile}-${name}-off.png`)
    if (saved && fs.existsSync(saved)) byKey[key].off ??= `data:image/png;base64,${fs.readFileSync(saved).toString('base64')}`
    if (mode !== 'off' && byKey[key].off) {
      Object.assign(rec.views[name], await page.evaluate(({ a, b, w, h }) => window.B.compare(a, b, w, h), { a: byKey[key].off, b: byKey[key][mode], w: SIZE.width, h: SIZE.height }))
    }
    console.log(' ', roomFile, mode, name, JSON.stringify(rec.views[name]))
    persist()
  }

  // --- moving camera: rAF time and how long the selection lags -------------------------------------------------------
  rec.moving = await page.evaluate(async ({ v }) => {
    const B = window.B, ts = []
    const t0 = performance.now(); let last = t0, k = 0
    while (performance.now() - t0 < 30000 || ts.length < 4) {
      k++
      const a = k * 0.05
      B.setCam([v.target[0] + 1.2 * Math.cos(a), v.pos[1], v.target[2] + 1.2 * Math.sin(a)], v.target)
      await new Promise((r) => requestAnimationFrame(r))
      const now = performance.now(); ts.push(now - last); last = now
    }
    ts.sort((a, b) => a - b)
    return { frames: ts.length, medianMs: ts[ts.length >> 1], p95Ms: ts[Math.floor(ts.length * 0.95)] }
  }, { v: ALL_VIEWS.corner })
  console.log(' ', roomFile, mode, 'moving', JSON.stringify(rec.moving))

  if (FULL) {
    // --- on-demand loop still goes to sleep ----------------------------------------------------------------------
    rec.idle = await page.evaluate(async () => {
      const B = window.B
      await B.sleep(3000)
      const f0 = B.renderer.info.render.frame
      await B.sleep(5000)
      return { framesIn5sIdle: B.renderer.info.render.frame - f0 }
    })

    // --- picks: every splat (the engine's path), the view's selection, Spark's default coarse raycast set ------------
    rec.picks = await page.evaluate(async ({ v, w, h }) => {
      const B = window.B
      const three = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js')
      B.setCam(v.pos, v.target)
      await B.settle()
      const rc = new three.Raycaster()
      const m = B.mesh(), s = B.spark()
      const rect = B.renderer.domElement.getBoundingClientRect()
      const pts = []
      for (let j = 1; j <= 5; j++) for (let i = 1; i <= 7; i++) pts.push([rect.left + rect.width * i / 8, rect.top + rect.height * j / 6])
      const engineHits = [], selHits = [], coarseHits = []
      const t0 = performance.now()
      for (const [x, y] of pts) { const p = B.engine.pointAt(x, y, 'scan'); engineHits.push(p ? p.toArray() : null) }
      const pickMs = (performance.now() - t0) / pts.length
      const castAll = (out) => {
        B.camera.updateMatrixWorld()
        for (const [x, y] of pts) {
          rc.setFromCamera(new three.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), B.camera)
          const hits = []; m.raycast(rc, hits); hits.sort((a, b) => a.distance - b.distance)
          out.push(hits[0] ? hits[0].point.toArray() : null)
        }
      }
      let coarseN = null
      if (m.context.enableLod.value) {
        castAll(selHits)
        s.lodRaycast = 25000; s.lodDirty = true; s.lastLodRaycastTime = 0 // what Spark does by default on desktop
        await B.settle(800)
        s.lodDirty = true
        await B.settle(800)
        coarseN = m.raycastIndices?.numSplats ?? null
        castAll(coarseHits)
        s.lodRaycast = 0; m.raycastIndices = undefined
      }
      return { pts: pts.length, pickMs, engineHits, selHits, coarseHits, coarseN, selN: m.numSplats }
    }, { v: ALL_VIEWS.corner, w: SIZE.width, h: SIZE.height })

    rec.floorPick = await page.evaluate(async ({ v }) => {
      const B = window.B
      B.setCam(v.pos, v.target)
      await B.settle()
      const rect = B.renderer.domElement.getBoundingClientRect()
      const out = []
      B.engine.startPickMode('floor')
      for (const [fx, fy] of [[0.5, 0.8], [0.3, 0.85], [0.7, 0.75]]) {
        B.engine.previewFloorAt(rect.left + rect.width * fx, rect.top + rect.height * fy)
        const f = B.engine.getPick().floor
        out.push(f ? { point: f.point, moveCm: f.moveCm, tiltDeg: f.tiltDeg, level: f.level } : null)
      }
      B.engine.cancelPickMode()
      return out
    }, { v: { pos: ALL_VIEWS.center_z.pos, target: [c[0], b.min[1] + 0.2, c[2] - 1] } })

    // --- bake ------------------------------------------------------------------------------------------------------
    rec.bake = await page.evaluate(async ({ near, far, probe }) => {
      const B = window.B
      const faces = async () => {
        const buf = await B.spark().readCubeTargets()
        // 16 × 16 means per face, enough to compare the light
        return buf.map((b) => { const n = 128, out = []; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { let s = [0, 0, 0]; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = 4 * ((y * 8 + j) * n + x * 8 + i); for (let c = 0; c < 3; c++) s[c] += b[k + c] } out.push(...s.map((v) => v / 64)) } return out })
      }
      const res = {}
      for (const [name, v] of Object.entries({ near, far })) {
        B.setCam(v.pos, v.target)
        await B.settle()
        const t0 = performance.now()
        await window.nook.relight(probe)
        res[name] = { ms: performance.now() - t0, faces: await faces(), env: window.nook.getRenderSettings().envSource, drawnAfter: B.mesh().numSplats }
        res[name].drawnSettled = await B.settle()
      }
      return res
    }, { near: ALL_VIEWS.corner, far: ALL_VIEWS.outside, probe: [c[0], eyeY, c[2]] })

    // --- preview capture -----------------------------------------------------------------------------------------
    rec.capture = await page.evaluate(() => { const s = window.B.engine.captureView({ maxPx: 640, aspect: 3 / 2 }); return { w: s.width, h: s.height, kb: s.dataUrl.length / 1370 } })
  }

  // --- what's allocated --------------------------------------------------------------------------------------------
  rec.alloc = await page.evaluate(() => {
    const B = window.B, m = B.mesh(), s = B.spark()
    const bytes = (x) => (x ? x.byteLength : 0)
    const sh = (p) => Object.values(p?.extra || {}).reduce((a, v) => a + (v?.byteLength || 0), 0)
    const ps = m.packedSplats, l = ps.lodSplats
    const acc = new Set([s.display, s.current, ...s.accumulators])
    return {
      nPlain: ps.numSplats, nTree: l?.numSplats ?? 0,
      plainMB: bytes(ps.packedArray) / 1e6, plainShMB: sh(ps) / 1e6,
      treeMB: bytes(l?.packedArray) / 1e6, treeShMB: sh(l) / 1e6,
      extraKeys: Object.keys(ps.extra || {}), treeExtraKeys: Object.keys(l?.extra || {}),
      lodTreeMB: bytes(l?.extra?.lodTree) / 1e6,
      accumulators: [...acc].map((a) => a.maxSplats),
      sparkMaxStd: s.defaultSplatTarget?.(), maxSh: s.maxSh,
    }
  })
  rec.memEnd = { ...pss(pid), heap: await heap() }
  rec.peak = peak
  rec.errors = await page.evaluate(() => window.nook.errors)
  rec.consoleErrors = consoleErrors
  clearInterval(sampler)
  await browser.close()
  results.push(rec)
  persist()
  console.log(roomFile, mode, 'load', Math.round(rec.loadMs), 'lodWait', rec.afterLodWaitMs && Math.round(rec.afterLodWaitMs), JSON.stringify(rec.alloc), 'peak', JSON.stringify(peak), 'errors', rec.errors.length, consoleErrors.length)
}
stop()
process.exit(0)
