// Planner v4 UI smoke eval (contract §2.7 v4, §2.8, §2.10, §5.1 planner): the planner behind the mock library server
// (evals/mock_library_server.py), which forwards everything else to planner/serve.py, which proxies /api/scan to the mock
// jobs server. Checks the library manager hook, the missing-item placeholder, elevation and hanging, the measured shell,
// retrain, that every mutation carries X-Nook (the mocks answer 403 otherwise), and page/console errors, at phone
// (390 × 844, touch) and desktop (1280 × 800) size in headless Helium. Screenshots: evals/out/planner-v4/shots/.
// Usage: node evals/planner_v4_smoke.mjs   (or npm run eval:planner-v4)
// Harness nudge: when the mock upload job for ROOM_A's capture is done, nothing is copied (ROOM_A is already on disk).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const OUT = path.join(REPO, 'evals/out/planner-v4')
const DATA = path.join(OUT, 'data')
const ROOM_DIR = path.join(DATA, 'room')
const SHOTS = path.join(OUT, 'shots')
const PORT = Number(process.env.NOOK_EVAL_PORT || 8843)
const UP = PORT + 1, SCAN_PORT = PORT + 2
const BASE = `http://127.0.0.1:${PORT}`
const SCAN = `http://127.0.0.1:${SCAN_PORT}`
const BROWSER = process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium'
const T0 = Date.now()
const secs = () => ((Date.now() - T0) / 1000).toFixed(0)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${secs()}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const fmt = (v) => JSON.stringify(v)

// --- seed: room A (kept capture, measured shell), A-r1 (retrained from A), room B (capture not kept) ----------------------------
const A = 'scan-20261027-112322', A1 = `${A}-r1`, B = 'scan-20261020-090000'
fs.rmSync(OUT, { recursive: true, force: true })
for (const d of [ROOM_DIR, SHOTS, path.join(DATA, 'layouts', A)]) fs.mkdirSync(d, { recursive: true })
const SPZ = path.join(REPO, 'fixtures/room/test.spz')
const now = Date.now()
for (const [name, age] of [[A, 3 * 3600e3], [A1, 3600e3], [B, 5 * 86400e3]]) {
  const p = path.join(ROOM_DIR, `${name}.spz`)
  fs.copyFileSync(SPZ, p)
  fs.utimesSync(p, new Date(now - age), new Date(now - age))
}
const tf = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }
const cfgA = { version: 1, splat: `room/${A}.spz`, saved: new Date(now - 3 * 3600e3).toISOString(), transform: tf }
fs.writeFileSync(path.join(ROOM_DIR, `${A}.room.json`), JSON.stringify(cfgA))
fs.writeFileSync(path.join(ROOM_DIR, `${A1}.room.json`), JSON.stringify({ ...cfgA, splat: `room/${A1}.spz`, parent: A }))
fs.writeFileSync(path.join(ROOM_DIR, 'room.json'), JSON.stringify(cfgA))
// The shell: the hand-made fixture is in capture world (floor at y = -1.32); room A's transform lifts the floor to 0.
fs.copyFileSync(path.join(REPO, 'fixtures/roomplan/roomplan.json'), path.join(ROOM_DIR, `${A}.roomplan.json`))
cfgA.transform = { ...tf, position: [0, 1.32, 0] }
fs.writeFileSync(path.join(ROOM_DIR, `${A}.room.json`), JSON.stringify(cfgA))
// A layout that places an item the library doesn't have (deleted): it must load with a placeholder.
fs.writeFileSync(path.join(DATA, 'layouts', A, 'with-missing.json'), JSON.stringify({ version: 1, name: 'with-missing', room_name: A,
  room: { splat: `room/${A}.spz` }, items: [{ uid: 'm1', id: 'gone-armchair', render: 'glb', position: [0.5, 0, 0.5], rotation_y_deg: 0 }] }))
const ZIP = path.join(DATA, 'capture.zip')
execFileSync('python3', ['-c', `import zipfile,sys,json
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('${A}/transforms.json', json.dumps({'frames': [{}] * 1210}))
    z.writestr('${A}/meta.json', json.dumps({'format': 'nook-scan'}))`, ZIP])

// --- servers ---------------------------------------------------------------------------------------------------------
const procs = {}, logs = {}
const run = (key, args) => {
  const env = { ...process.env, NOOK_NO_DOTENV: '1', NOOK_FAL_MOCK: 'fixtures/fal' }
  delete env.FAL_KEY
  const p = spawn('python3', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env })
  logs[key] = ''
  p.stdout.on('data', (d) => { logs[key] += d })
  p.stderr.on('data', (d) => { logs[key] += d })
  procs[key] = p
}
const rel = (p) => path.relative(REPO, p)
run('scan', ['evals/mock_scan_server.py', '--port', String(SCAN_PORT), '--seconds', '1', '--room-dir', rel(ROOM_DIR)])
run('planner', ['planner/serve.py', '--port', String(UP), '--room-dir', rel(ROOM_DIR), '--room-file', rel(path.join(ROOM_DIR, 'room.json')),
  '--layouts-dir', rel(path.join(DATA, 'layouts')), '--renders-dir', rel(path.join(DATA, 'renders')), '--costs-file', rel(path.join(DATA, 'costs.csv')),
  '--scan-api', SCAN])
run('library', ['evals/mock_library_server.py', '--upstream', `http://127.0.0.1:${UP}`, '--port', String(PORT), '--seconds', '0.5',
  '--room-dir', rel(ROOM_DIR), '--scan', SCAN, '--library', rel(path.join(DATA, 'library'))])
fs.cpSync(path.join(REPO, 'fixtures/library'), path.join(DATA, 'library'), { recursive: true })
const killAll = () => { for (const p of Object.values(procs)) p.kill() }
process.on('exit', killAll)
let browser
const finish = async () => {
  for (const [k, v] of Object.entries(logs)) fs.writeFileSync(path.join(DATA, `${k}.log`), v)
  await browser?.close().catch(() => {})
  killAll()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed in ${secs()} s`)
  process.exit(failed ? 1 : 0)
}
process.on('unhandledRejection', async (e) => { check('no harness exception', false, e?.stack || String(e)); await finish() })
const waitUp = async (url) => {
  for (let i = 0; i < 75; i++) { try { if ((await fetch(url)).ok) return true } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 200)) }
  return false
}
check('mock jobs, planner and mock library servers start', await waitUp(`${SCAN}/api/scan/health`) && await waitUp(`http://127.0.0.1:${UP}/api/rooms`) && await waitUp(`${BASE}/api/library`),
  fmt(logs))
const up = await fetch(`${SCAN}/api/scan/captures`, { method: 'POST', headers: { 'X-Nook': '1', 'Content-Type': 'application/zip' }, body: fs.readFileSync(ZIP) })
const upJob = await up.json()
for (let i = 0; i < 50 && (await (await fetch(`${SCAN}/api/scan/jobs/${upJob.id}`)).json()).status !== 'done'; i++) await new Promise((r) => setTimeout(r, 200))
const rooms = (await (await fetch(`${BASE}/api/rooms`)).json()).rooms || []
const byName = Object.fromEntries(rooms.map((r) => [r.name, r]))
check('§2.7 v4 fields through the mock: A has its shell and capture, A-r1 its parent, B no capture',
  byName[A]?.roomplan_url === `/room/${A}.roomplan.json` && byName[A]?.capture === A && byName[A1]?.parent === A && byName[B]?.capture === null, fmt(rooms))

// --- browser ---------------------------------------------------------------------------------------------------------
browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP = { viewport: { width: 1280, height: 800 } }
const pageErrors = [], consoleErrors = [], refused = []
async function open(device, room) {
  const context = await browser.newContext(device === 'phone' ? PHONE : DESKTOP)
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${device}: ${m.text()} ${m.location()?.url || ''}`) })
  page.on('pageerror', (e) => pageErrors.push(`${device}: ${e.stack || e}`))
  page.on('response', (r) => { if (r.status() === 403) refused.push(`${device}: ${r.request().method()} ${r.url()}`) })
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(s)
  }))
  await page.goto(`${BASE}/planner/?room=${room}`)
  await page.waitForFunction(() => window.nook && window.nook.ready)
  await page.evaluate(() => window.nook.ready)
  return page
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const ev = async (page, fn, arg) => { try { return await page.evaluate(fn, arg) } catch (e) { return { __error: String(e).slice(0, 300) } } }

// --- desktop: library manager (§2.8) -----------------------------------------------------------------------------------
const d = await open('desktop', A)
await d.evaluate((name) => window.nook.openRoom(name), A)
const job = await ev(d, async () => {
  const blob = await (await fetch('/fixtures/models/arrow.glb')).blob()
  const file = new File([blob], 'arrow.glb', { type: 'model/gltf-binary' })
  return window.nook.addItemFromFile(file, { name: 'Arrow print', dims_cm: { w: 60, d: 3, h: 40 }, mount: 'wall' })
})
check('addItemFromFile() returns a library job', job && job.id && job.kind === 'add', fmt(job))
let jobs = []
for (let i = 0; i < 40; i++) {
  jobs = await ev(d, () => window.nook.libraryJobs())
  if (Array.isArray(jobs) && jobs.find((j) => j.id === job?.id)?.status === 'done') break
  await new Promise((r) => setTimeout(r, 250))
}
check('libraryJobs() shows the job done', Array.isArray(jobs) && jobs.find((j) => j.id === job?.id)?.status === 'done', fmt(jobs))
const urlJob = await ev(d, () => window.nook.addItemFromUrl('https://example.com/chair.jpg', { name: 'Url chair', dims_cm: { w: 70, d: 70, h: 90 }, engine: 'sam3d' }))
check('addItemFromUrl() returns a job with the $0.02 estimate', urlJob?.cost_usd_estimate === 0.02 || urlJob?.job?.cost_usd_estimate === 0.02, fmt(urlJob))
const edited = await ev(d, () => window.nook.editLibraryItem('arrow-print', { name: 'Arrow print (framed)' }))
check('editLibraryItem() renames in place', edited?.name === 'Arrow print (framed)', fmt(edited))
await ev(d, () => window.nook.removeLibraryItem('arrow-print'))
const lib1 = await (await fetch(`${BASE}/api/library`)).json()
check('removeLibraryItem() moves it to the trash', !lib1.items.some((i) => i.id === 'arrow-print') && lib1.trash.some((t) => t.id === 'arrow-print'), fmt(lib1.trash))
const restored = await ev(d, () => window.nook.restoreLibraryItem('arrow-print'))
check('restoreLibraryItem() brings it back', restored?.id === 'arrow-print', fmt(restored))
await shot(d, 'desktop-library')

// --- desktop: missing item (§2.8) ------------------------------------------------------------------------------------------
const lm = await ev(d, () => window.nook.loadLayout('with-missing'))
const st1 = await ev(d, () => window.nook.getState())
check('a layout placing a deleted item loads, keeping it as a placeholder', !lm?.__error && st1?.items?.some((i) => i.id === 'gone-armchair'), fmt(lm) + fmt(st1?.items))
await shot(d, 'desktop-missing-item')

// --- desktop: elevation and hanging (§2.10) -----------------------------------------------------------------------------------
const uid = await ev(d, () => window.nook.addItem('sheen-chair', { position: [0, 0, 0] }))
await ev(d, (u) => window.nook.moveItem(u, { position: [0.2, 1.2, -0.4] }), uid)
const it = (await ev(d, () => window.nook.getState()))?.items?.find((i) => i.uid === uid)
check('P23 moveItem() honors y (elevation), worldBounds follow', it && Math.abs(it.position[1] - 1.2) < 0.001 && Math.abs(it.worldBounds?.min?.[1] - 1.2) < 0.01, fmt(it))
await ev(d, () => window.nook.saveLayout('raised'))
await ev(d, () => window.nook.loadLayout('raised'))
const it2 = (await ev(d, () => window.nook.getState()))?.items?.find((i) => Math.abs((i.position?.[0] ?? 9) - 0.2) < 0.001)
check('P23 the elevation round-trips through Save and load', it2 && Math.abs(it2.position[1] - 1.2) < 0.001, fmt(it2))
await ev(d, (u) => window.nook.moveItem(u, { position: [0, 9, 0] }), it2?.uid)
const it3 = (await ev(d, () => window.nook.getState()))?.items?.find((i) => i.uid === it2?.uid)
check('elevation is clamped to 4 m', it3 && Math.abs(it3.position[1] - 4) < 0.001, fmt(it3?.position))
const pid = await ev(d, () => window.nook.addItem('test-cube', { position: [0, 0, 0] }))
await ev(d, (u) => window.nook.hangItem(u, { point: [0.5, 1.5, -2.0], normal: [0, 0, 1] }), pid)
const h1 = (await ev(d, () => window.nook.getState()))?.items?.find((i) => i.uid === pid)
check('P24 hangItem() on a wall facing +Z: yaw 0, back against the wall, mounted wall',
  h1 && Math.abs(((h1.rotation_y_deg % 360) + 360) % 360) < 0.1 && Math.abs(h1.worldBounds?.min?.[2] - -2.0) < 0.01 && h1.mounted === 'wall', fmt(h1))
await ev(d, (u) => window.nook.hangItem(u, { point: [1.75, 1.5, 0], normal: [-1, 0, 0] }), pid)
const h2 = (await ev(d, () => window.nook.getState()))?.items?.find((i) => i.uid === pid)
const yaw2 = h2 ? ((h2.rotation_y_deg % 360) + 360) % 360 : NaN
check('P24 hangItem() on a wall facing -X: yaw -90 / 270, back at x = 1.75', h2 && Math.abs(yaw2 - 270) < 0.1 && Math.abs(h2.worldBounds?.max?.[0] - 1.75) < 0.01, fmt(h2))
await shot(d, 'desktop-hung')

// --- desktop: measured shell (§2.7 v4) -----------------------------------------------------------------------------------
const s0 = await ev(d, () => window.nook.getState())
check('getState().room.roomplan is true for a room with a shell', s0?.room?.roomplan === true, fmt(s0?.room))
await ev(d, () => window.nook.setShell(true))
check('setShell(true) shows the shell', (await ev(d, () => window.nook.getState()))?.shell === true)
check('a shell toggle is on the page', await d.locator('[data-nook="shell"]').count() > 0)
await shot(d, 'desktop-shell')

// --- desktop: retrain (§5.1 planner) -----------------------------------------------------------------------------------
const defs = await ev(d, (n) => window.nook.retrainDefaults(n), A)
check('retrainDefaults() returns the scaled settings and an estimate', defs?.settings?.steps === 72600 && defs?.eta_s > 0, fmt(defs))
const rj = await ev(d, (n) => window.nook.retrainRoom(n, { steps: 40000 }, 'Sharper'), A)
check('P26 retrainRoom() queues <base>-r2', rj?.name === `${A}-r2` && rj?.kind === 'retrain', fmt(rj))
const rb = await ev(d, (n) => window.nook.retrainRoom(n), B)
check('P26 retrainRoom() on a room without a kept capture rejects with "upload again"', /upload/i.test(rb?.__error || ''), fmt(rb))
await d.locator('[data-nook="retrain"]').first().click({ timeout: 20000 }).catch(() => {})
await d.locator('[data-nook="retrain-advanced"]').first().waitFor({ timeout: 20000 }).catch(() => {})   // the sheet loads /defaults first
await shot(d, 'desktop-retrain-sheet')
check('the retrain sheet has Advanced settings', await d.locator('[data-nook="retrain-advanced"]').count() > 0)

// --- phone: elevation control (P25), touch targets ------------------------------------------------------------------------
const p = await open('phone', A)
const pu = await ev(p, () => window.nook.addItem('sheen-chair', { position: [0, 0, 0] }))
await ev(p, (u) => window.nook.selectItem(u), pu)
const upBtn = p.locator('[data-nook="elev-up"]').first()
let tapped = 0
if (await upBtn.count()) for (; tapped < 10; tapped++) await upBtn.tap()
const pe = (await ev(p, () => window.nook.getState()))?.items?.find((i) => i.uid === pu)
check('P25 ten taps on Up raise the item by 10 cm at 390 × 844', tapped === 10 && pe && Math.abs(pe.position[1] - 0.10) < 0.001, `taps ${tapped} ${fmt(pe?.position)}`)
const small = await p.evaluate(() => [...document.querySelectorAll('[data-nook]')].filter((e) => e.offsetParent).map((e) => [e.dataset.nook, e.getBoundingClientRect()])
  .filter(([, r]) => r.width < 44 || r.height < 44).map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`))
check('every visible v4 control is at least 44 × 44 px on the phone', small.length === 0, small.join(', '))
await shot(p, 'phone-elevation')

// --- every mutation carried X-Nook; no errors ------------------------------------------------------------------------------
check('no request was refused as cross-site (every mutation sends X-Nook)', refused.length === 0, refused.join(' | '))
check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 800))
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 800))
await finish()
