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

const SERVE_ARGS = ['--room-file', 'evals/out/planner/room.json', '--layouts-dir', 'evals/out/planner/layouts',
  '--renders-dir', 'evals/out/planner/renders', '--costs-file', 'evals/out/planner/costs.csv']
const childEnv = (extra) => { const e = { ...process.env, NOOK_NO_DOTENV: '1', ...extra }; delete e.FAL_KEY; if (!extra.NOOK_FAL_MOCK) delete e.NOOK_FAL_MOCK; return e }
const server = spawn('python3', ['planner/serve.py', '--port', String(PORT), ...SERVE_ARGS],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ NOOK_FAL_MOCK: 'fixtures/fal' }) })
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
const badPut = await fetch(`${BASE}/api/layouts/Bad%20Name`, { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json', 'X-Nook': '1' } })
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
// Expected 404s: no jobs server behind these test servers (/api/scan/* is "no scans"), and the unknown-room check.
const expected404 = (m) => /\/api\/scan\/|\/api\/rooms\/no-such-room$/.test(m.location()?.url || '')
const openPlanner = async (library, { track = true, base = BASE, query = '' } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(120000) // SwiftShader takes seconds per splat frame and environment bake
  if (track) {
    page.on('console', (m) => { if (m.type() === 'error' && !expected404(m)) consoleErrors.push(`${m.text()} ${m.location()?.url || ''}`) })
    page.on('pageerror', (e) => pageErrors.push(String(e)))
  }
  await page.goto(`${base}/planner/?library=${encodeURIComponent(library)}${query}`)
  await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 120000 })
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
let rs = await page.evaluate(() => window.nook.getRenderSettings())
check('P11 tone mapping is ACES with default exposure 1 and warmth 0', rs.toneMapping === 'aces' && rs.exposure === 1 && rs.warmth === 0, fmt(rs))
check('P12 placeholder room uses the neutral environment', rs.envSource === 'neutral', fmt(rs))
check('P13 contact shadows on by default, none before items', rs.contactShadows === true && rs.shadowCount === 0, fmt(rs))
check('nook.ready resolves with placeholder room', s.room.kind === 'placeholder' && s.room.loaded, fmt(s.room))
check('getLibrary returns the fixture items', (await page.evaluate(() => window.nook.getLibrary().map((i) => i.id))).join() === 'sheen-chair,test-cube')
await settle(page); await shot(page, '01-placeholder-empty')

// P4: dims, floor, placement, rotation
const chairUid = await page.evaluate(() => window.nook.addItem('sheen-chair', { position: [0.5, 0, -0.5], rotation_y_deg: 0 }))   // y is elevation since v4 (§2.10)
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
const nItems = (await state(page)).items.length
rs = await page.evaluate(() => window.nook.getRenderSettings())
check('P13 one contact shadow per placed item', rs.shadowCount === nItems, `shadows ${rs.shadowCount} items ${nItems}`)
await page.evaluate(() => window.nook.setRenderSettings({ contactShadows: false }))
const off = (await page.evaluate(() => window.nook.getRenderSettings())).shadowCount
await page.evaluate(() => window.nook.setRenderSettings({ contactShadows: true }))
const on = (await page.evaluate(() => window.nook.getRenderSettings())).shadowCount
check('P13 toggling contact shadows', off === 0 && on === nItems, `off ${off} on ${on}`)
await page.evaluate(() => window.nook.setRenderSettings({ exposure: 1.4, warmth: 0.3 }))
rs = await page.evaluate(() => window.nook.getRenderSettings())
check('P11 setRenderSettings applies exposure and warmth live', near(rs.exposure, 1.4, 1e-6) && near(rs.warmth, 0.3, 1e-6), fmt(rs))
// True colour (§2.6): bypasses ACES, exposure and warmth, and the image really changes.
const lookShot = async () => { await page.waitForTimeout(400); return (await page.screenshot({ type: 'png' })).toString('base64') }
const beforeTrue = await lookShot()
await page.evaluate(() => window.nook.setTrueColor(true))
const trueRs = await page.evaluate(() => window.nook.getRenderSettings())
const inTrue = await lookShot()
check('P11 True colour turns tone mapping off and changes the image', trueRs.toneMapping === 'none' && trueRs.trueColor === true && inTrue !== beforeTrue, fmt(trueRs))
await page.evaluate(() => window.nook.setTrueColor(false))
const afterTrue = await page.evaluate(() => window.nook.getRenderSettings())
check('P11 True colour off restores ACES and the look', afterTrue.toneMapping === 'aces' && near(afterTrue.exposure, 1.4, 1e-6) && near(afterTrue.warmth, 0.3, 1e-6), fmt(afterTrue))
await page.evaluate(() => window.nook.setRenderSettings({ exposure: 1, warmth: 0 }))
await settle(page); await shot(page, '02-placeholder-items')

// P14: render this view (mock mode: no network, $0)
const meta = await page.evaluate(() => window.nook.renderView({ model: 'kontext' }).then((m) => m, (e) => ({ error: String(e) })))
check('P14 renderView resolves with metadata', meta && !meta.error && meta.mock === true && meta.cost_usd === 0 && /^\/renders\//.test(meta.url), fmt(meta))
if (meta && !meta.error) {
  const img = await fetch(BASE + meta.url)
  check('P14 render image is served', img.ok && /image\//.test(img.headers.get('content-type') || ''), `${img.status} ${img.headers.get('content-type')}`)
  check('P14 render files written (jpg, input, json)', ['.jpg', '-input.jpg', '.json'].every((x) => fs.existsSync(path.join(OUT, 'renders', meta.name + x))))
  const costs = fs.existsSync(path.join(OUT, 'costs.csv')) ? fs.readFileSync(path.join(OUT, 'costs.csv'), 'utf8') : ''
  check('P14 render logs a mock cost row', /^date,id,engine,cost_usd,mock,input/.test(costs) && costs.split('\n').some((l) => l.includes(meta.name) && l.includes('render:kontext') && l.includes(',true,')), costs.slice(-300))
  check('P14 listRenders includes it', (await page.evaluate(() => window.nook.listRenders())).some((r) => r.name === meta.name))
}
check('P14 unknown render model rejects', await page.evaluate(() => window.nook.renderView({ model: 'nope' }).then(() => false, () => true)))
const badRender = await fetch(`${BASE}/api/render`, { method: 'POST', body: JSON.stringify({ image: 'nope' }), headers: { 'content-type': 'application/json', 'X-Nook': '1' } })
check('P14 POST /api/render with a bad image is 400', badRender.status === 400, `status ${badRender.status}`)

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
await page.evaluate(() => window.nook.relight())
rs = await page.evaluate(() => window.nook.getRenderSettings())
check('P12 relight() bakes the environment from the splat room', rs.envSource === 'splat', fmt(rs))
await settle(page); await shot(page, '04-splat-room')

// P8 (server side): a saved alignment is applied on reload
const aligned = { version: 1, splat: 'fixtures/room/test.spz', transform: { position: [0.1, 0.5, -0.2], quaternion: [1, 0, 0, 0], scale: 1.5 }, look: { exposure: 1.5, warmth: -0.2 } }
const put = await fetch(`${BASE}/api/room`, { method: 'PUT', body: JSON.stringify(aligned), headers: { 'content-type': 'application/json', 'X-Nook': '1' } })
check('PUT /api/room accepts a room config', put.ok, `status ${put.status}`)
await page.reload()
await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 30000 })
await page.evaluate(() => window.nook.ready)
s = await state(page)
const t = s.room.transform
check('room transform from /api/room is applied on load', s.room.kind === 'splat' && near(t.scale, 1.5, 1e-6) && t.position.every((v, i) => near(v, aligned.transform.position[i], 1e-6)), fmt(s.room))
rs = await page.evaluate(() => window.nook.getRenderSettings())
check('P11 look from /api/room is applied on load', near(rs.exposure, 1.5, 1e-6) && near(rs.warmth, -0.2, 1e-6), fmt(rs))
await settle(page); await shot(page, '05-splat-room-aligned')
fs.copyFileSync(path.join(REPO, 'fixtures/room/placeholder.json'), path.join(OUT, 'room.json'))

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))
await page.close()

// --- P17–P19: rooms (contract §2.7), on a second server with its own room dir and layouts ----------------------
const RPORT = PORT + 2
const RBASE = `http://127.0.0.1:${RPORT}`
const RDIR = 'evals/out/planner/rooms'
const RLAYOUTS = 'evals/out/planner/rooms-layouts'
fs.mkdirSync(path.join(REPO, RDIR), { recursive: true })
fs.mkdirSync(path.join(REPO, RLAYOUTS), { recursive: true })
const now = Date.now() / 1000
for (const [name, age] of [['hall-old', 3], ['reading-room', 2], ['study-new', 1]]) {
  const f = path.join(REPO, RDIR, `${name}.spz`)
  fs.copyFileSync(path.join(REPO, 'fixtures/room/test.spz'), f)
  fs.utimesSync(f, now - age * 86400, now - age * 86400)
}
// A v1 room.json (before per-room files) pointing at reading-room, with alignment and viewpoints (P19)
const v1Room = {
  version: 1, splat: `${RDIR}/reading-room.spz`,
  transform: { position: [0.25, 0.9, -0.5], quaternion: [0, 0.3826834, 0, 0.9238795], scale: 1.25 },
  look: { exposure: 1.3, warmth: -0.2 },
  viewpoints: [{ position: [0.1, 1.5, 0.2], quaternion: [0, 0, 0, 1], fov_y_deg: 60 }, { position: [-1, 1.4, 0.8], quaternion: [0, 0.7071068, 0, 0.7071068], fov_y_deg: 55 }],
}
fs.writeFileSync(path.join(REPO, RDIR, 'room.json'), JSON.stringify(v1Room, null, 2))
// A v1 layout made for reading-room (still listed and loadable there, P18)
fs.writeFileSync(path.join(REPO, RLAYOUTS, 'old-v1.json'), JSON.stringify({ version: 1, name: 'old-v1', room: v1Room,
  items: [{ uid: 'c1', id: 'sheen-chair', render: 'glb', position: [0.3, 0, 0.2], rotation_y_deg: 30 }] }))
const roomsServer = spawn('python3', ['planner/serve.py', '--port', String(RPORT), '--room-dir', RDIR, '--layouts-dir', RLAYOUTS,
  '--renders-dir', 'evals/out/planner/renders', '--costs-file', 'evals/out/planner/costs.csv'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ NOOK_FAL_MOCK: 'fixtures/fal' }) })
roomsServer.stdout.on('data', (d) => { serverLog += d })
roomsServer.stderr.on('data', (d) => { serverLog += d })
process.on('exit', () => roomsServer.kill())
let rup = false
for (let i = 0; i < 50 && !rup; i++) {
  try { rup = (await fetch(`${RBASE}/api/rooms`)).ok } catch { await new Promise((r) => setTimeout(r, 200)) }
}
check('rooms server starts', rup)
const roomFile = (name) => path.join(REPO, RDIR, `${name}.room.json`)
const readMaybe = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)) } return false }

// First visit, no ?room and nothing remembered: /api/room as in v1, named after the room it points at (P19)
let rp = await openPlanner(LIB_URL, { base: RBASE })
s = await state(rp)
check('P19 v1 room.json opens with its alignment, named after its room', s.room.name === 'reading-room' && s.room.kind === 'splat' &&
  near(s.room.transform.scale, 1.25, 1e-6) && s.room.transform.position.every((v, i) => near(v, v1Room.transform.position[i], 1e-6)) && s.room.viewpoints === 2, fmt(s.room))
const listed = await rp.evaluate(() => window.nook.listRooms())
check('P17 listRooms() returns the rooms newest first', listed.map((r) => r.name).join() === 'study-new,reading-room,hall-old', fmt(listed.map((r) => r.name)))
check('P17 listRooms() marks the current room', listed.find((r) => r.current)?.name === 'reading-room', fmt(listed))
for (const name of ['study-new', 'hall-old', 'reading-room']) {
  await rp.evaluate((n) => window.nook.openRoom(n), name)
  s = await state(rp)
  check(`P17 openRoom("${name}") loads it`, s.room.name === name && s.room.kind === 'splat' && s.room.loaded && s.room.splatCount > 0, fmt(s.room))
}
check('P19 reading-room keeps its alignment and viewpoints after a switch', near(s.room.transform.scale, 1.25, 1e-6) && s.room.viewpoints === 2, fmt(s.room))
check('openRoom of an unknown room rejects', await rp.evaluate(() => window.nook.openRoom('no-such-room').then(() => false, () => true)))
// (SwiftShader takes seconds per splat frame and per environment bake, so this waits a while.)
check('a first open saves a thumbnail', await waitFor(() => fs.existsSync(path.join(REPO, RDIR, 'reading-room.jpg')), 120000))
check('the thumbnail is listed', (await rp.evaluate(() => window.nook.listRooms())).find((r) => r.name === 'reading-room')?.thumb_url === '/room/reading-room.jpg')
await settle(rp); await shot(rp, '07-rooms-reading-room')

// Save the alignment of one room through the hook; the others' configs stay as they were (P17)
await rp.evaluate(() => window.nook.openRoom('study-new'))
const cfgBefore = { hall: readMaybe(roomFile('hall-old')), reading: readMaybe(roomFile('reading-room')), v1: readMaybe(path.join(REPO, RDIR, 'room.json')) }
const studyAligned = { version: 1, splat: `${RDIR}/study-new.spz`, transform: { position: [0.2, 0.4, 0.1], quaternion: [0, 0, 0, 1], scale: 1.1 }, look: { exposure: 1.2, warmth: 0.1 } }
await rp.evaluate((cfg) => window.nook.loadRoom(cfg), studyAligned)
check('loadRoom() with the open room\'s scan keeps its name', (await state(rp)).room.name === 'study-new')
await rp.evaluate(() => window.nook.saveRoom())
const studyCfg = JSON.parse(readMaybe(roomFile('study-new')) || '{}')
check('P17 saveRoom() writes the open room\'s config', near(studyCfg.transform?.scale, 1.1, 1e-6) && typeof studyCfg.saved === 'string', fmt(studyCfg))
check('P17 the other rooms\' configs are unchanged', readMaybe(roomFile('hall-old')) === cfgBefore.hall && readMaybe(roomFile('reading-room')) === cfgBefore.reading &&
  readMaybe(path.join(REPO, RDIR, 'room.json')) === cfgBefore.v1, `hall ${!!cfgBefore.hall} reading ${!!cfgBefore.reading}`)
check('P17 listRooms() shows it aligned', (await rp.evaluate(() => window.nook.listRooms())).find((r) => r.name === 'study-new')?.aligned === true)

// Layouts belong to a room (P18)
await rp.evaluate(() => window.nook.addItem('sheen-chair', { position: [0.4, 0, -0.3] }))
await rp.evaluate(() => window.nook.saveLayout('a-only'))
check('P18 a room layout is written under layouts/<room>/', fs.existsSync(path.join(REPO, RLAYOUTS, 'study-new/a-only.json')) &&
  JSON.parse(fs.readFileSync(path.join(REPO, RLAYOUTS, 'study-new/a-only.json'), 'utf8')).room_name === 'study-new')
check('P18 it is listed in its room', (await rp.evaluate(() => window.nook.listLayouts())).includes('a-only'))
await rp.evaluate(() => window.nook.openRoom('hall-old'))
check('P18 opening another room clears the placed items', (await state(rp)).items.length === 0)
check('P18 a layout saved in room A is not listed in room B', !(await rp.evaluate(() => window.nook.listLayouts())).includes('a-only'))
await rp.evaluate(() => window.nook.openRoom('reading-room'))
check('P18 a v1 layout is listed under the room it was made for', (await rp.evaluate(() => window.nook.listLayouts())).includes('old-v1'))
await rp.evaluate(() => window.nook.loadLayout('old-v1'))
s = await state(rp)
check('P18 a v1 layout still loads', s.room.name === 'reading-room' && s.items.length === 1 && s.items[0].id === 'sheen-chair' && near(s.items[0].rotation_y_deg, 30, 0.1), fmt(s.items))

// The last room opened on this device opens next time; ?room=<name> wins
await rp.evaluate(() => window.nook.openRoom('hall-old'))
await rp.reload()
await rp.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 120000 })
await rp.evaluate(() => window.nook.ready)
check('a reload opens the room last opened on this device', (await state(rp)).room.name === 'hall-old', fmt((await state(rp)).room))
await rp.close()
rp = await openPlanner(LIB_URL, { base: RBASE, query: '&room=study-new' })
s = await state(rp)
check('P17 ?room=<name> opens that room on load', s.room.name === 'study-new' && s.room.kind === 'splat' && near(s.room.transform.scale, 1.1, 1e-6), fmt(s.room))
await rp.close()
rp = await openPlanner(LIB_URL, { base: RBASE, query: '&room=gone-room' })
s = await state(rp)
check('?room=<unknown> shows the placeholder, no room name', s.room.name === null && s.room.kind === 'placeholder', fmt(s.room))
await rp.close()
// A server without the rooms API (the hosted build): v1 behaviour
rp = await browser.newPage({ viewport: { width: 1280, height: 800 } })
rp.setDefaultTimeout(120000)
const noRoomsErrors = []
rp.on('pageerror', (e) => noRoomsErrors.push(String(e)))
await rp.route('**/api/rooms**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no"}' }))
await rp.goto(`${RBASE}/planner/?library=${encodeURIComponent(LIB_URL)}&room=study-new`)
await rp.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 120000 })
await rp.evaluate(() => window.nook.ready)
s = await state(rp)
check('without /api/rooms the planner loads /api/room as in v1', s.room.name === null && s.room.kind === 'splat' && near(s.room.transform.scale, 1.25, 1e-6) && noRoomsErrors.length === 0, fmt(s.room))
check('without /api/rooms layouts use the flat v1 list', (await rp.evaluate(() => window.nook.listLayouts())).includes('old-v1'))
await rp.close()
check('no uncaught page errors (rooms)', pageErrors.length === 0, pageErrors.join(' | '))
check('no console errors (rooms)', consoleErrors.length === 0, consoleErrors.join(' | '))
roomsServer.kill()

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

// P15: no key and not in mock mode -> 503 with an actionable message
const keyless = spawn('python3', ['planner/serve.py', '--port', String(PORT + 1), ...SERVE_ARGS], { cwd: REPO, stdio: 'ignore', env: childEnv({}) })
process.on('exit', () => keyless.kill())
let r503 = null
for (let i = 0; i < 50 && !r503; i++) {
  try {
    const tiny = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg')).toString('base64')
    r503 = await fetch(`http://127.0.0.1:${PORT + 1}/api/render`, { method: 'POST', body: JSON.stringify({ image: tiny }), headers: { 'content-type': 'application/json', 'X-Nook': '1' } })
  } catch { await new Promise((r) => setTimeout(r, 200)) }
}
const body503 = r503 ? await r503.json().catch(() => ({})) : {}
check('P15 /api/render without FAL_KEY is 503 with a FAL_KEY hint', r503?.status === 503 && /FAL_KEY/.test(body503.error || ''), `${r503?.status} ${fmt(body503)}`)
keyless.kill()

await finish()
