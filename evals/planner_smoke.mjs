// Planner smoke eval: starts planner/serve.py, drives window.nook in headless Helium,
// and checks contract/CONTRACT.md §2. Screenshots land in evals/out/planner/.
// Usage: node evals/planner_smoke.mjs   (or npm run eval:planner)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import Ajv2020 from 'ajv/dist/2020.js'

const REPO = path.resolve(import.meta.dirname, '..')
const OUT = path.join(REPO, 'evals/out/planner')
const PORT = Number(process.env.NOOK_EVAL_PORT || 8799)
const BASE = `http://127.0.0.1:${PORT}`
const BROWSER = process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium'
const LIB_URL = '/fixtures/library/library.json'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol
const relNear = (a, b, tol) => Math.abs(a - b) / b <= tol
const size = (wb) => wb.max.map((v, i) => v - wb.min[i])
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'))
const fmt = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x))

if (!fs.existsSync(path.join(REPO, 'planner/serve.py'))) {
  console.log('FAIL planner/serve.py not found (planner not built yet)')
  process.exit(1)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'layouts'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'fixtures/room/placeholder.json'), path.join(OUT, 'room.json'))

const server = spawn('python3', ['planner/serve.py', '--port', String(PORT),
  '--room-file', 'evals/out/planner/room.json', '--layouts-dir', 'evals/out/planner/layouts'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })
process.on('exit', () => server.kill()) // also covers a failed top-level await

let browser
const finish = async (code) => {
  fs.writeFileSync(path.join(OUT, 'server.log'), serverLog)
  if (browser) await browser.close().catch(() => {})
  server.kill()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(code ?? (failed ? 1 : 0))
}
process.on('unhandledRejection', async (e) => { check('no harness exception', false, e?.stack || String(e)); await finish(1) })

// --- server ---------------------------------------------------------------
let up = false
for (let i = 0; i < 50 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/room`)).ok } catch { await new Promise((r) => setTimeout(r, 200)) }
}
check('server starts and serves /api/room', up, serverLog.slice(-500))
if (!up) await finish(1)

const root = await fetch(`${BASE}/`, { redirect: 'manual' })
check('GET / redirects to /planner/', [301, 302, 303, 307, 308].includes(root.status) && /\/planner\/$/.test(root.headers.get('location') || ''),
  `status ${root.status} location ${root.headers.get('location')}`)
const room0 = await (await fetch(`${BASE}/api/room`)).json()
check('GET /api/room returns the room file', room0?.placeholder?.w === 3.5, fmt(room0))
const list0 = await (await fetch(`${BASE}/api/layouts`)).json()
check('GET /api/layouts starts empty', Array.isArray(list0.layouts) && list0.layouts.length === 0, fmt(list0))
check('GET /api/layouts/<missing> is 404', (await fetch(`${BASE}/api/layouts/nope`)).status === 404)
const badPut = await fetch(`${BASE}/api/layouts/Bad%20Name`, { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })
check('PUT /api/layouts/<non-slug> is 400', badPut.status === 400, `status ${badPut.status}`)
const js = await fetch(`${BASE}/evals/planner_smoke.mjs`)
check('static .mjs/.js served as JavaScript', /javascript/.test(js.headers.get('content-type') || ''), js.headers.get('content-type'))

// --- browser --------------------------------------------------------------
browser = await chromium.launch({
  executablePath: BROWSER, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const consoleErrors = []
const pageErrors = []
const openPlanner = async (library, { track = true } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  if (track) {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => pageErrors.push(String(e)))
  }
  await page.goto(`${BASE}/planner/?library=${encodeURIComponent(library)}`)
  await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 30000 })
  await page.evaluate(() => window.nook.ready)
  return page
}
const state = (page) => page.evaluate(() => window.nook.getState())
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
const settle = (page) => page.waitForTimeout(1500)

const lib = readJson('fixtures/library/library.json')
const chair = lib.items.find((i) => i.id === 'sheen-chair').dims_cm
const cube = lib.items.find((i) => i.id === 'test-cube').dims_cm

let page = await openPlanner(LIB_URL)
let s = await state(page)
check('nook.ready resolves with placeholder room', s.room.kind === 'placeholder' && s.room.loaded, fmt(s.room))
check('getLibrary returns the fixture items', (await page.evaluate(() => window.nook.getLibrary().map((i) => i.id))).join() === 'sheen-chair,test-cube')
await settle(page); await shot(page, '01-placeholder-empty')

// P4: dims, floor, placement, rotation
const chairUid = await page.evaluate(() => window.nook.addItem('sheen-chair', { position: [0.5, 0.3, -0.5], rotation_y_deg: 0 }))
s = await state(page)
let it = s.items.find((i) => i.uid === chairUid)
let sz = it && size(it.worldBounds)
check('addItem resolves with a uid present in state', !!it, fmt(s.items))
if (it) {
  check('glb item size matches dims_cm within 2%', relNear(sz[0], chair.w / 100, 0.02) && relNear(sz[1], chair.h / 100, 0.02) && relNear(sz[2], chair.d / 100, 0.02), `size ${fmt(sz)} dims ${fmt(chair)}`)
  check('item sits on the floor (min y = 0 ±1 cm, position y = 0)', near(it.worldBounds.min[1], 0, 0.01) && near(it.position[1], 0, 1e-6), fmt(it))
  const cx = (it.worldBounds.min[0] + it.worldBounds.max[0]) / 2
  const cz = (it.worldBounds.min[2] + it.worldBounds.max[2]) / 2
  check('item footprint is centered on its position', near(cx, 0.5, 0.01) && near(cz, -0.5, 0.01), `center ${fmt([cx, cz])}`)
}
await page.evaluate((uid) => window.nook.moveItem(uid, { rotation_y_deg: 90 }), chairUid)
s = await state(page)
it = s.items.find((i) => i.uid === chairUid)
sz = size(it.worldBounds)
check('rotating 90° swaps X and Z extents', relNear(sz[0], chair.d / 100, 0.02) && relNear(sz[2], chair.w / 100, 0.02), `size ${fmt(sz)}`)
check('rotation_y_deg is reported', near(it.rotation_y_deg, 90, 0.1), fmt(it))

const cubeSplat = await page.evaluate(() => window.nook.addItem('test-cube', { position: [-0.8, 0, 0.6] }))
const cubeGlb = await page.evaluate(() => window.nook.addItem('test-cube', { position: [-0.8, 0, -0.6], render: 'glb' }))
s = await state(page)
const cs = s.items.find((i) => i.uid === cubeSplat)
const cg = s.items.find((i) => i.uid === cubeGlb)
check('default_render splat is used when render not given', cs?.render === 'splat', fmt(cs))
check('splat item height matches dims_cm within 5%', cs && relNear(size(cs.worldBounds)[1], cube.h / 100, 0.05), cs && fmt(size(cs.worldBounds)))
check('render: glb is honoured', cg?.render === 'glb' && relNear(size(cg.worldBounds)[0], cube.w / 100, 0.02), fmt(cg))
check('addItem with unknown id rejects', await page.evaluate(() => window.nook.addItem('no-such-item').then(() => false, () => true)))
await settle(page); await shot(page, '02-placeholder-items')

// P6: layouts round-trip
await page.evaluate(() => window.nook.saveLayout('smoke'))
const layoutPath = path.join(OUT, 'layouts/smoke.json')
check('saveLayout writes layouts/smoke.json', fs.existsSync(layoutPath))
if (fs.existsSync(layoutPath)) {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(readJson('contract/layout.schema.json'))
  const ok = validate(JSON.parse(fs.readFileSync(layoutPath, 'utf8')))
  check('saved layout matches layout.schema.json', ok, fmt(validate.errors))
}
check('listLayouts includes the saved layout', (await page.evaluate(() => window.nook.listLayouts())).includes('smoke'))
const before = (await state(page)).items
await page.reload()
await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 30000 })
await page.evaluate(() => window.nook.ready)
await page.evaluate(() => window.nook.loadLayout('smoke'))
const after = (await state(page)).items
const key = (i) => `${i.id}|${i.render}|${i.position.map((v) => v.toFixed(2)).join(',')}`
const sortK = (a) => [...a].sort((x, y) => key(x).localeCompare(key(y)))
const roundTrip = before.length === after.length && sortK(before).every((b, i) => {
  const a = sortK(after)[i]
  return a.id === b.id && a.render === b.render && a.position.every((v, j) => near(v, b.position[j], 0.001)) && near(a.rotation_y_deg, b.rotation_y_deg, 0.1)
})
check('layout round-trips after reload (1 mm, 0.1°)', roundTrip, `before ${fmt(before.map(key))} after ${fmt(after.map(key))}`)

// P7: views
await page.evaluate(() => window.nook.setView('seated'))
s = await state(page)
check('seated view: camera y = 1.15 m', s.camera.view === 'seated' && near(s.camera.position[1], 1.15, 0.01), fmt(s.camera))
await settle(page); await shot(page, '03-seated')
await page.evaluate(() => window.nook.setView('standing'))
s = await state(page)
check('standing view: camera y = 1.6 m', s.camera.view === 'standing' && near(s.camera.position[1], 1.6, 0.01), fmt(s.camera))
await page.evaluate(() => window.nook.setView('orbit'))
check('orbit view restores', (await state(page)).camera.view === 'orbit')

// P3: splat room
await page.evaluate((room) => window.nook.loadRoom(room), readJson('fixtures/room/splat.json'))
s = await state(page)
check('loadRoom with a splat renders a splat room', s.room.kind === 'splat' && s.room.loaded && s.room.splatCount > 0, fmt(s.room))
await settle(page); await shot(page, '04-splat-room')

// P8 (server side): a saved alignment is applied on reload
const aligned = { version: 1, splat: 'fixtures/room/test.spz', transform: { position: [0.1, 0.5, -0.2], quaternion: [1, 0, 0, 0], scale: 1.5 } }
const put = await fetch(`${BASE}/api/room`, { method: 'PUT', body: JSON.stringify(aligned), headers: { 'content-type': 'application/json' } })
check('PUT /api/room accepts a room config', put.ok, `status ${put.status}`)
await page.reload()
await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 30000 })
await page.evaluate(() => window.nook.ready)
s = await state(page)
const t = s.room.transform
check('room transform from /api/room is applied on load', s.room.kind === 'splat' && near(t.scale, 1.5, 1e-6) && t.position.every((v, i) => near(v, aligned.transform.position[i], 1e-6)), fmt(s.room))
await settle(page); await shot(page, '05-splat-room-aligned')
fs.copyFileSync(path.join(REPO, 'fixtures/room/placeholder.json'), path.join(OUT, 'room.json'))

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))
await page.close()

// P10: broken asset doesn't take the app down (console 404s are expected here, so not tracked)
const broken = await openPlanner('/fixtures/library-broken/library.json', { track: false })
const brokenPageErrors = []
broken.on('pageerror', (e) => brokenPageErrors.push(String(e)))
const rejected = await broken.evaluate(() => window.nook.addItem('missing-asset').then(() => false, () => true))
check('addItem with a missing asset rejects', rejected)
check('missing asset is reported in nook.errors', (await broken.evaluate(() => window.nook.errors.length)) > 0)
const stillWorks = await broken.evaluate(() => window.nook.addItem('sheen-chair').then(() => true, () => false))
check('app keeps working after a failed asset', stillWorks)
check('no uncaught page errors after a failed asset', brokenPageErrors.length === 0, brokenPageErrors.join(' | '))
await shot(broken, '06-broken-asset')

await finish()
