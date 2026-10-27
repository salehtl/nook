// Planner v2 rooms UI smoke eval: seeds three rooms, runs the mock jobs server (evals/mock_scan_server.py) behind
// planner/serve.py --scan-api, uploads one tiny capture so a scan trains while the UI is open, and walks the key
// states at phone (390 × 844, touch) and desktop (1280 × 800) size in headless Helium. It checks the §2.7 hook
// (listRooms / openRoom / getState().room.name), page and console errors, phone touch targets (≥ 44 × 44 px) and
// that the dock, rail, sheet and bars don't overlap. Screenshots: evals/out/rooms-ui/shots/.
// Usage: node evals/planner_rooms_smoke.mjs   (or npm run eval:rooms-ui)
//
// Harness nudges (documented, not product behaviour):
//   - after the upload it calls nookCtx.data.refresh() so the UI sees the scan now instead of on the next 60 s poll;
//   - when the mock job turns done it copies fixtures/room/test.spz into the room dir under the job's name (the real
//     trainer writes the room before it marks the job done);
//   - CSS animations and transitions are turned off so screenshots don't catch a sheet mid-slide.
// Expected console errors (filtered, listed at the end): failed /api/scan/* requests after the mock is stopped
// (502 from the proxy) and every request after the planner server is stopped (the offline state).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const OUT = path.join(REPO, 'evals/out/rooms-ui')
const DATA = path.join(OUT, 'data')
const ROOM_DIR = path.join(DATA, 'room')
const SHOTS = path.join(OUT, 'shots')
const PORT = Number(process.env.NOOK_EVAL_PORT || 8833)
const SCAN_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const SCAN = `http://127.0.0.1:${SCAN_PORT}`
const BROWSER = process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium'
const TRAIN_SECONDS = Number(process.env.NOOK_EVAL_TRAIN_SECONDS || 60)
const LIB = '/fixtures/library/library.json'
const T0 = Date.now()
const secs = () => ((Date.now() - T0) / 1000).toFixed(0)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? "ok  " : "FAIL"} [${secs()}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const note = (s) => console.log(`     ${s}`)
const fmt = (v) => JSON.stringify(v)

// --- seed --------------------------------------------------------------------------------------------------
const ROOMS = {
  a: 'scan-20261026-093654', // title + alignment (room.json points here)
  b: 'scan-20261025-180212', // never opened: no config, no thumbnail
  c: 'scan-20261023-214700', // aligned, no title
}
const JOB_NAME = 'scan-20261027-101500'
fs.rmSync(DATA, { recursive: true, force: true })
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(ROOM_DIR, { recursive: true })
fs.mkdirSync(path.join(DATA, 'layouts', ROOMS.a), { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
const SPZ = path.join(REPO, 'fixtures/room/test.spz')
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const now = Date.now()
const ages = { a: 2 * 3600e3, b: 86400e3, c: 3 * 86400e3 }
for (const [k, name] of Object.entries(ROOMS)) {
  const p = path.join(ROOM_DIR, `${name}.spz`)
  fs.copyFileSync(SPZ, p)
  const t = new Date(now - ages[k])
  fs.utimesSync(p, t, t)
}
const cfgA = { version: 1, splat: `room/${ROOMS.a}.spz`, title: 'Reading room, morning', saved: iso(now - 3600e3),
  transform: { position: [0, 0.05, 0], quaternion: [0, 0.0436, 0, 0.999], scale: 1.0 } }
fs.writeFileSync(path.join(ROOM_DIR, `${ROOMS.a}.room.json`), JSON.stringify(cfgA, null, 1))
fs.writeFileSync(path.join(ROOM_DIR, 'room.json'), JSON.stringify(cfgA, null, 1))
fs.writeFileSync(path.join(ROOM_DIR, `${ROOMS.c}.room.json`), JSON.stringify({ version: 1, splat: `room/${ROOMS.c}.spz`, saved: iso(now - 2 * 86400e3) }))
fs.writeFileSync(path.join(DATA, 'layouts', ROOMS.a, 'evening.json'), JSON.stringify({ version: 1, name: 'evening', room_name: ROOMS.a,
  room: { splat: `room/${ROOMS.a}.spz` }, items: [{ id: 'sheen-chair', position: [0.4, 0, -0.3], rotation_y_deg: 20, render: 'glb' }] }))
// One tiny capture zip: one top folder with transforms.json (all the mock checks).
const ZIP = path.join(DATA, 'capture.zip')
execFileSync('python3', ['-c', `import zipfile,sys,json
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('${JOB_NAME}/transforms.json', json.dumps({'frames': []}))
    z.writestr('${JOB_NAME}/meta.json', json.dumps({'format': 'nook-scan'}))`, ZIP])

// --- servers -----------------------------------------------------------------------------------------------
const procs = {}
const logs = {}
const run = (key, args) => {
  const env = { ...process.env, NOOK_NO_DOTENV: '1', NOOK_FAL_MOCK: 'fixtures/fal' }
  delete env.FAL_KEY
  const p = spawn('python3', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env })
  logs[key] = ''
  p.stdout.on('data', (d) => { logs[key] += d })
  p.stderr.on('data', (d) => { logs[key] += d })
  procs[key] = p
  return p
}
run('scan', ['evals/mock_scan_server.py', '--port', String(SCAN_PORT), '--seconds', String(TRAIN_SECONDS)])
const rel = (p) => path.relative(REPO, p)
run('planner', ['planner/serve.py', '--port', String(PORT), '--room-dir', rel(ROOM_DIR), '--room-file', rel(path.join(ROOM_DIR, 'room.json')),
  '--layouts-dir', rel(path.join(DATA, 'layouts')), '--renders-dir', rel(path.join(DATA, 'renders')), '--costs-file', rel(path.join(DATA, 'costs.csv')),
  '--scan-api', SCAN])
const killAll = () => { for (const p of Object.values(procs)) p.kill() }
process.on('exit', killAll)

let browser, browsers
const finish = async (code) => {
  for (const [k, v] of Object.entries(logs)) fs.writeFileSync(path.join(DATA, `${k}.log`), v)
  for (const b of browsers || []) await b.close().catch(() => {})
  killAll()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed in ${secs()} s`)
  process.exit(code ?? (failed ? 1 : 0))
}
process.on('unhandledRejection', async (e) => { check('no harness exception', false, e?.stack || String(e)); await finish(1) })

const waitUp = async (url) => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return true } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 200)) }
  return false
}
check('mock jobs server starts', await waitUp(`${SCAN}/api/scan/health`), logs.scan)
check('planner server starts with --scan-api', await waitUp(`${BASE}/api/rooms`), logs.planner)
const apiRooms = await (await fetch(`${BASE}/api/rooms`)).json()
check('GET /api/rooms lists the three seeded rooms newest first', apiRooms.rooms?.map((r) => r.name).join() === [ROOMS.a, ROOMS.b, ROOMS.c].join(), fmt(apiRooms.rooms?.map((r) => r.name)))

// --- browser -----------------------------------------------------------------------------------------------
// One browser per device so the phone and desktop walks run side by side, each with its own (CPU) GPU process.
const launch = () => chromium.launch({ executablePath: BROWSER, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
browsers = await Promise.all([launch(), launch()])
browser = browsers[0]
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP = { viewport: { width: 1280, height: 800 } }
const pageErrors = []
const consoleErrors = []
const expectedErrors = []
let scanApiDown = false, serverDown = false
const isExpected = (text, url) => (scanApiDown && /\/api\/scan\//.test(url)) || (serverDown && (url.startsWith(BASE) || /ERR_CONNECTION_REFUSED|Failed to fetch/.test(text)))

async function open(device, label, query = '') {
  const context = await browsers[device === 'phone' ? 0 : 1].newContext(device === 'phone' ? PHONE : DESKTOP)
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const url = m.location()?.url || ''
    const line = `${label}: ${m.text()} ${url}`
    if (isExpected(m.text(), url)) expectedErrors.push(line); else consoleErrors.push(line)
  })
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.stack || e}`))
  if (process.env.NOOK_EVAL_DEBUG) {
    page.on('request', (r) => console.log(`  ${label} req ${secs()} ${r.url().slice(0, 110)}`))
    page.on('requestfinished', (r) => console.log(`  ${label} fin ${secs()} ${r.url().slice(0, 110)}`))
    page.on('requestfailed', (r) => console.log(`  ${label} FAILED ${secs()} ${r.url().slice(0, 110)} ${r.failure()?.errorText}`))
  }
  await page.addInitScript(() => {
    // Frame pacing for SwiftShader: three.js asks for a frame on every requestAnimationFrame, far faster than the CPU
    // can draw one, and the queued GPU work makes every screenshot wait for seconds. Frames are spaced out (at most
    // one per FRAME_MS) and the harness can hold them altogether (__frames.hold) while it reads the DOM or takes a shot.
    const FRAME_MS = 1200
    const w = window, raf0 = w.requestAnimationFrame.bind(w), px = new Uint8Array(4)
    const gl = () => w.nookCtx?.engine?.three?.renderer?.getContext?.()
    let last = 0, queue = [], timer = 0
    const flush = () => { timer = 0; raf0((t) => { last = performance.now(); const q = queue; queue = []; for (const cb of q) cb(t) }) }
    const ctl = w.__frames = { hold: false,
      drain() { const g = gl(); if (g) g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px) },
      set(hold) { ctl.hold = hold; if (!hold && queue.length && !timer) timer = setTimeout(flush, 0) } }
    w.requestAnimationFrame = (cb) => {
      queue.push(cb)
      if (!ctl.hold && !timer) timer = setTimeout(flush, Math.max(0, FRAME_MS - (performance.now() - last)))
      return 0
    }
    const css = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}'
    addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s) })
  })
  await use(null, context.browser()) // hold the other pages' frames while this one loads
  await page.goto(`${BASE}/planner/?library=${encodeURIComponent(LIB)}${query}`)
  await page.waitForFunction(() => window.nook && window.nook.ready && window.nookCtx)
  pages.add(page)
  await page.evaluate(() => window.nook.ready)
  return page
}
// SwiftShader renders every frame on the CPU, so only the page being driven draws: the others have their
// requestAnimationFrame held (three.js asks for each frame again, so holding it pauses the render loop; timers and
// polling keep running). Freezing pages over CDP deadlocks the shared GPU process, so it isn't used.
const pages = new Set()
const setFrames = (page, on) => page.evaluate((run) => window.__frames?.set(!run), on).catch(() => {})
async function use(page, browserOf = page?.context().browser()) {
  for (const pg of pages) {
    if (pg.isClosed()) pages.delete(pg)
    else if (pg.context().browser() === browserOf) await setFrames(pg, pg === page)
  }
  return page
}
// DOM checks run between frames: hold the active page's frames too while they run, then let it draw again.
async function still(page, fn) {
  // let pending requestAnimationFrame work (class flips, overlay positions) run once before holding
  await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 3000) })).catch(() => {})
  await setFrames(page, false)
  try { return await fn() } finally { await setFrames(page, true) }
}
const text = (page, sel) => still(page, () => page.locator(sel).first().innerText())
const idle = (page) => page.evaluate(() => window.nookCtx.engine.idle?.()).catch(() => {})
// Hold frames, let the GPU finish the last one, then take the screenshot (the canvas keeps its last frame).
const shot = async (page, name) => {
  const t = Date.now()
  await page.waitForTimeout(150)
  await still(page, async () => {
    await page.evaluate(() => window.__frames?.drain())
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  })
  if (process.env.NOOK_EVAL_DEBUG) note(`shot ${name} ${Date.now() - t} ms`)
}
const roomState = (page) => page.evaluate(() => { const r = window.nook.getState().room; return { name: r.name ?? null, kind: r.kind, loaded: r.loaded } })
const waitRoom = (page, name, timeout = 90000) => page.waitForFunction((n) => { const r = window.nook.getState().room; return r.name === n && r.loaded }, name, { timeout })
const phase = (page) => page.evaluate(() => ({ sheet: document.documentElement.dataset.sheet || '', page: window.nookCtx.shell.getOpenPage() }))

// Every visible control on the phone is at least 44 × 44 px (contract P20).
const targetViolations = []
async function checkTargets(page, state) {
  const bad = await page.evaluate(() => {
    const out = []
    const vw = innerWidth, vh = innerHeight
    for (const el of document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [role="menuitem"], [role="option"], [role="tab"]')) {
      if (el.disabled || el.closest('[hidden], [aria-hidden="true"], [inert]')) continue
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      if (getComputedStyle(el).pointerEvents === 'none' || el.closest('[style*="pointer-events: none"]')) continue
      let p = el, hidden = false
      while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.pointerEvents === 'none' || +cs.opacity === 0) { hidden = true; break } p = p.parentElement }
      if (hidden) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
      // clipped by a scrolling ancestor (e.g. a list row scrolled out of the sheet)
      let a = el.parentElement, clipped = false
      while (a && a !== document.body) {
        const cs = getComputedStyle(a)
        if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) { const ar = a.getBoundingClientRect(); if (r.bottom <= ar.top || r.top >= ar.bottom) { clipped = true; break } }
        a = a.parentElement
      }
      if (clipped) continue
      // the hit area: the element, grown by an absolutely placed ::before/::after (the kit's 44 pt hit wrappers),
      // or the <label> around a field
      let hw = r.width, hh = r.height
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo)
        if (ps.content === 'none' || ps.position !== 'absolute') continue
        const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0)
        hw = Math.max(hw, r.width - px(ps.left) - px(ps.right))
        hh = Math.max(hh, r.height - px(ps.top) - px(ps.bottom))
      }
      const lab = el.matches('input, select, textarea') ? el.closest('label') : null
      if (lab) { const lr = lab.getBoundingClientRect(); hw = Math.max(hw, lr.width); hh = Math.max(hh, lr.height) }
      if (hw >= 43.5 && hh >= 43.5) continue
      const name = (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${name}" ${Math.round(hw)}×${Math.round(hh)}`)
    }
    return out
  })
  for (const b of bad) targetViolations.push(`${state}: ${b}`)
  check(`phone ${state}: visible controls ≥ 44 × 44 px`, bad.length === 0, bad.join('; '))
}
// The dock, rail, sheet and the bars that take the dock's place don't overlap each other.
async function checkOverlap(page, state) {
  const hits = await page.evaluate(() => {
    const sel = { dock: '#dock', rail: '#rail', sheet: '#sheet', selbar: '.ws-selbar', modebar: '.ws-modebar', walkbar: '.ws-walkbar', sizecard: '.ws-sizecard', toasts: '#toasts > .toast' }
    const boxes = []
    for (const [k, s] of Object.entries(sel)) {
      for (const el of document.querySelectorAll(s)) {
        if (el.closest('[hidden]') || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
        let p = el, gone = false
        while (p && p !== document.body) { const cs = getComputedStyle(p); if (+cs.opacity === 0 || cs.display === 'none') { gone = true; break } p = p.parentElement }
        if (gone) continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight) continue
        boxes.push({ k, r: { l: r.left, t: r.top, rr: r.right, b: r.bottom } })
      }
    }
    const out = []
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r
      const w = Math.min(a.rr, b.rr) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (w > 1 && h > 1) out.push(`${boxes[i].k}×${boxes[j].k} (${Math.round(w)}×${Math.round(h)})`)
    }
    return out
  })
  check(`${state}: dock, rail, sheet, bars and toasts don't overlap`, hits.length === 0, hits.join(', '))
}
async function phoneState(page, state, file) {
  await still(page, async () => {
    await page.evaluate(() => window.__frames?.drain())
    await page.screenshot({ path: path.join(SHOTS, `${file}.png`) })
    await checkTargets(page, state)
    await checkOverlap(page, `phone ${state}`)
  })
}
const dock = (page, label) => page.locator('.dock-item').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click()

let P, D, L, watcher, job, doneAt = null
const training = () => !doneAt
async function guard(label, pagesFor, fn) {
  try { await fn() } catch (e) {
    check(`${label} walk-through finished`, false, e?.stack || String(e))
    for (const [pg, n] of pagesFor()) if (pg && !pg.isClosed()) await pg.screenshot({ path: path.join(SHOTS, `FAILED-${n}.png`) }).catch(() => {})
  }
}

// --- phase 1: open both, then upload a capture so a scan trains while the UI is open ------------------------------
async function setup() {
  console.log(`[${secs()} s] opening phone and desktop`)
  ;[P, D] = await Promise.all([open('phone', 'phone'), open('desktop', 'desktop')])
  let s = await roomState(P)
  check('phone opens the current room (room.json) by name', s.name === ROOMS.a && s.loaded, fmt(s))
  s = await roomState(D)
  check('desktop opens the current room by name', s.name === ROOMS.a && s.loaded, fmt(s))
  const listed = await P.evaluate(() => window.nook.listRooms())
  check('listRooms() returns the three rooms newest first', listed.map((r) => r.name).join() === [ROOMS.a, ROOMS.b, ROOMS.c].join(), fmt(listed.map((r) => r.name)))
  check('listRooms() marks the titled room aligned and the never-opened one not', listed[0]?.title === 'Reading room, morning' && listed[0]?.aligned === true && listed[1]?.aligned === false && listed[1]?.thumb_url == null, fmt(listed.slice(0, 2)))
  check('switcher shows the room title', (await text(P, '.ws-sw-title'))?.trim() === 'Reading room, morning')
  // dismiss the one-time gesture hint, as a person would
  if (await P.locator('.ws-hint:not([hidden])').count()) await P.locator('.ws-hint-ok').click()

  console.log(`[${secs()} s] uploading the capture`)
  const up = await fetch(`${BASE}/api/scan/captures`, { method: 'POST', headers: { 'content-type': 'application/zip', 'X-Nook': '1' }, body: fs.readFileSync(ZIP) })
  job = await up.json()
  check('upload through the planner proxy starts a job (202)', up.status === 202 && job.name === JOB_NAME, `${up.status} ${fmt(job)}`)
  watcher = setInterval(async () => {
    if (doneAt) return
    try {
      const j = await (await fetch(`${SCAN}/api/scan/jobs/${job.id}`)).json()
      if (j.status === 'done' && !doneAt) {
        doneAt = Date.now()
        fs.copyFileSync(SPZ, path.join(ROOM_DIR, `${JOB_NAME}.spz`))
        note(`[${secs()} s] job done; ${JOB_NAME}.spz copied into the room dir`)
      }
    } catch { /* mock gone */ }
  }, 150)
  await Promise.all([P, D].map((pg) => pg.evaluate(() => window.nookCtx.data.refresh())))
}

// --- phone: training chip, Rooms, room link, ready toast, then the workspace states ------------------------------
async function phoneFlow() {
  await P.waitForFunction(() => /Training|Preparing/.test(document.querySelector('.ws-chips')?.textContent || ''), null, { timeout: 20000 })
  check('phone: the training chip shows in the workspace', training(), 'the job finished before the shot')
  await phoneState(P, 'workspace default', '01-phone-workspace')

  await P.locator('.ws-switcher').click()
  await P.waitForSelector('.page .rm-row')
  let txt = await text(P, '.page')
  check('phone Rooms lists the training scan and the three rooms', txt.includes('Reading room, morning') && /Training|Preparing/i.test(txt) && (await P.locator('.page .rm-row').count()) >= 4, txt.slice(0, 300))
  check('phone Rooms counts read "3 rooms · 1 scan on kakapo"', /3 rooms · 1 scan on kakapo/.test(txt), txt.slice(0, 200))
  check('phone Rooms shot is taken while the scan trains', training())
  await phoneState(P, 'Rooms', '02-phone-rooms')
  await P.locator('.page-head button[aria-label="Close"]').click()

  console.log(`[${secs()} s] room link to the training scan`)
  L = await open('phone', 'link', `&room=${JOB_NAME}`)
  await L.waitForSelector('.rm-card', { timeout: 20000 })
  txt = await text(L, '.rm-card')
  check('?room=<training scan> shows the progress card with Open when ready', /Open when ready/.test(txt) && /Training|Preparing/i.test(txt), txt)
  const sw = await text(L, '.ws-switcher')
  check('the link\'s switcher names the scan with its progress, not the placeholder', /Training|Preparing|Queued/.test(sw) && !/Placeholder/.test(sw), sw)
  check('the link card shot is taken while the scan trains', training())
  await shot(L, '03-phone-link-training')
  await still(L, () => checkTargets(L, 'link card'))
  await L.locator('.rm-card-main').click()
  check('Open when ready arms the card', /Opens when ready/.test(await text(L, '.rm-card')))

  console.log(`[${secs()} s] waiting for the scan to finish`)
  await use(P)
  const toast = P.locator('#toasts .toast', { hasText: 'is ready' })
  await setFrames(P, false) // nothing to draw while waiting; the shot then needn't wait for queued frames
  await toast.waitFor({ timeout: (TRAIN_SECONDS + 60) * 1000 })
  const toastText = await toast.innerText()
  check('phone: "<title> is ready" toast with Open appears', /Open/.test(toastText) && /Tue 27 Oct, 10:15/.test(toastText), toastText)
  await phoneState(P, 'ready toast', '04-phone-ready-toast')
  await toast.locator('.toast-action').click()
  const notAligned = P.locator('#toasts .toast', { hasText: 'Not aligned yet' }).waitFor({ timeout: 90000 }).then(() => true, () => false)
  await waitRoom(P, JOB_NAME)
  check('Open from the toast opens the new room; getState().room.name follows', (await roomState(P)).name === JOB_NAME)
  check('the URL names the open room', (await P.evaluate(() => new URL(location.href).searchParams.get('room'))) === JOB_NAME)
  check('a never-aligned room offers "Not aligned yet · Check room"', await notAligned)
  await phoneState(P, 'new room opened', '05-phone-new-room')
  await use(L)
  const armedOpened = await waitRoom(L, JOB_NAME, 30000).then(() => true, () => false)
  check('the armed room link opens the room by itself when ready', armedOpened, fmt(await roomState(L)))
  await L.context().close()
  await use(P)
  const listed2 = await P.evaluate(() => window.nook.listRooms())
  check('listRooms() now has the new room first', listed2.length === 4 && listed2[0].name === JOB_NAME, fmt(listed2.map((r) => r.name)))

  console.log(`[${secs()} s] phone states`)
  await P.evaluate((n) => window.nook.openRoom(n), ROOMS.b)
  check('openRoom(never-opened room) loads it; name follows', (await roomState(P)).name === ROOMS.b)
  await P.evaluate((n) => window.nook.openRoom(n), ROOMS.a)
  await idle(P)
  check('openRoom(titled room) loads it; name follows', (await roomState(P)).name === ROOMS.a)
  await P.evaluate(() => document.querySelectorAll('#toasts .toast-close').forEach((b) => b.click()))

  await dock(P, 'Library')
  await P.waitForFunction(() => document.documentElement.dataset.sheet === 'half')
  await P.waitForSelector('.lib-row')
  await phoneState(P, 'Library half', '06-phone-library-half')
  await P.locator('.lib-row').first().click()
  await P.waitForFunction(() => window.nook.getState().items.length === 1 && document.documentElement.dataset.sheet === 'peek')
  check('tapping a Library row adds the item, selects it and drops to peek', (await P.evaluate(() => window.nookCtx.engine.getSelected())) != null)
  check('"… added" toast offers Undo', /added/.test(await text(P, '#toasts')) && /Undo/.test(await text(P, '#toasts')))
  await phoneState(P, 'Library added (peek)', '07-phone-library-added')
  await P.locator('.sheet-close').click()
  await P.waitForFunction(() => !document.documentElement.dataset.sheet)
  await P.waitForSelector('.ws-selbar:not([hidden])')
  await P.evaluate(() => document.querySelectorAll('#toasts .toast-close').forEach((b) => b.click()))
  await phoneState(P, 'item selected', '08-phone-item-selected')
  check('selection label shows the name and size', /cm/.test(await text(P, '.ws-label')))
  await P.locator('.ws-selbar .ws-done').click()

  await dock(P, 'Room')
  await P.waitForFunction(() => document.documentElement.dataset.sheet === 'peek')
  txt = await text(P, '#sheet')
  check('Room opens at peek with the Check room card (Pick floor, Check size, Save room)', /Pick floor/.test(txt) && /Check size/.test(txt) && /Save room/.test(txt), txt.slice(0, 200))
  await P.waitForFunction(() => [...document.querySelectorAll('.ws-dimtag')].filter((t) => !t.hidden).length === 2, null, { timeout: 15000 }).catch(() => {})
  check('Check room draws the width and height dimension lines', await P.evaluate(() => [...document.querySelectorAll('.ws-dimtag')].filter((t) => !t.hidden).every((t) => / m$/.test(t.textContent)) && [...document.querySelectorAll('.ws-dimtag')].filter((t) => !t.hidden).length === 2))
  await phoneState(P, 'Room peek (Check room)', '09-phone-check-room')
  await P.locator('.sheet-close').click()
  await P.waitForFunction(() => !document.documentElement.dataset.sheet)

  await dock(P, 'Layouts')
  await P.waitForFunction(() => document.documentElement.dataset.sheet === 'half')
  await P.waitForTimeout(500)
  txt = await text(P, '#sheet')
  check('Layouts lists the room\'s layout', /evening/i.test(txt), txt.slice(0, 200))
  await phoneState(P, 'Layouts', '10-phone-layouts')
  await P.locator('.sheet-close').click()
  await P.waitForFunction(() => !document.documentElement.dataset.sheet)

  await P.locator('.ws-rail-btn[aria-label="Measure"]').click()
  await P.waitForSelector('.ws-modebar:not([hidden])')
  for (const [x, y] of [[120, 520], [270, 600]]) { await P.touchscreen.tap(x, y); await P.waitForTimeout(600) }
  const meas = await P.evaluate(() => window.nook.getMeasure())
  check('measure: two taps make a distance', meas?.meters > 0, fmt(meas))
  await phoneState(P, 'measure', '11-phone-measure')
  await P.locator('.ws-modebar button', { hasText: 'Done' }).click()

  await P.locator('.ws-rail-btn.is-view').click()
  await P.locator('[role="menuitem"]', { hasText: 'Seated' }).click()
  await P.waitForSelector('.ws-walkbar:not([hidden])')
  const cam = await P.evaluate(() => window.nook.getState().camera)
  check('seated: walk bar shows; eye at 1.15 m', cam.view === 'seated' && Math.abs(cam.position[1] - 1.15) < 0.01, fmt(cam))
  await phoneState(P, 'seated walk bar', '12-phone-seated')
  await P.locator('.ws-wb-orbit').click()
  check('Orbit returns to the orbit view', (await P.evaluate(() => window.nook.getState().camera.view)) === 'orbit')
}

// --- desktop: Rooms table while training, panel open / collapsed, measure, seated -------------------------------
async function desktopFlow() {
  await D.locator('.ws-switcher').click()
  await D.locator('.page .pill', { hasText: /Training|Preparing/i }).first().waitFor({ timeout: 30000 })
  await D.mouse.move(800, 790) // no tooltip left over from the click
  const txt = await text(D, '.page')
  check('desktop Rooms table lists the training scan', /Training|Preparing/i.test(txt) && txt.includes('Reading room, morning'), txt.slice(0, 300))
  check('desktop Rooms shot is taken while the scan trains', training())
  await shot(D, '02-desktop-rooms')
  await D.keyboard.press('Escape')
  check('desktop Rooms closes with Esc', await D.evaluate(() => !window.nookCtx.shell.getOpenPage()))

  if (!(await D.evaluate(() => window.nookCtx.shell.getOpenPanel()))) await D.locator('.side-tab').first().click()
  await D.evaluate(() => window.nook.addItem('sheen-chair', { position: [0.3, 0, 0.2], rotation_y_deg: 30 }))
  await idle(D)
  await shot(D, '06-desktop-panel-open')
  await still(D, () => checkOverlap(D, 'desktop panel open'))
  const panelW = await D.evaluate(() => document.querySelector('#panel').getBoundingClientRect().width)
  check('desktop panel covers at most a third of 1280', panelW <= 1280 / 3 + 1, `${panelW}px`)
  await D.locator('.side-collapse').click()
  await D.waitForFunction(() => document.documentElement.dataset.panel === 'collapsed')
  await shot(D, '07-desktop-panel-collapsed')
  await D.locator('.side-collapse').click()
  await D.waitForFunction(() => document.documentElement.dataset.panel === 'open')
  await D.keyboard.press('m')
  await D.waitForTimeout(300)
  for (const [x, y] of [[620, 520], [900, 600]]) { await D.mouse.click(x, y); await D.waitForTimeout(600) }
  check('desktop measure: two clicks make a distance', (await D.evaluate(() => window.nook.getMeasure()))?.meters > 0)
  await shot(D, '08-desktop-measure')
  await D.keyboard.press('Escape'); await D.keyboard.press('Escape')
  await D.keyboard.press('2')
  await D.waitForSelector('.ws-walkbar:not([hidden])')
  check('desktop seated: walk bar with WASD keycaps', (await D.locator('.ws-walkbar .ws-key').count()) === 4)
  await shot(D, '09-desktop-seated')
  await D.locator('.ws-wb-orbit').click()
  // the ready toast reaches the desktop too
  await setFrames(D, false)
  const ready = await D.locator('#toasts .toast', { hasText: 'is ready' }).waitFor({ timeout: (TRAIN_SECONDS + 60) * 1000 }).then(() => true, () => false)
  check('desktop: "<title> is ready" toast appears', ready)
  if (ready) await shot(D, '04-desktop-ready-toast')
}

// --- offline: kakapo's jobs server gone, then kakapo gone ----------------------------------------------------
async function offlineFlow() {
  console.log(`[${secs()} s] offline states`)
  scanApiDown = true
  procs.scan.kill()
  await new Promise((r) => setTimeout(r, 500))
  await P.evaluate(() => window.nookCtx.data.refresh().catch(() => {}))
  await P.locator('.ws-switcher').click()
  await P.waitForSelector('.page .rm-row')
  await P.waitForTimeout(500)
  const txt = await text(P, '.page')
  check('jobs server down: Rooms still lists the four rooms, not offline', (await P.locator('.page .rm-row').count()) >= 4 && !/isn't answering/.test(txt), txt.slice(0, 200))
  await shot(P, '13-phone-rooms-no-jobs')
  await P.locator('.page-head button[aria-label="Close"]').click()

  serverDown = true
  procs.planner.kill()
  await new Promise((r) => setTimeout(r, 500))
  await Promise.all([[P, 'phone'], [D, 'desktop']].map(async ([pg, dev]) => {
    await pg.evaluate(() => window.nookCtx.data.refresh().catch(() => {}))
    if (!(await pg.evaluate(() => window.nookCtx.shell.getOpenPage()))) await pg.locator('.ws-switcher').click()
    if (dev === 'desktop') await pg.mouse.move(800, 790)
    await pg.waitForFunction(() => window.nookCtx.data.getState().offline)
    await pg.waitForTimeout(600)
    const t = await text(pg, '.page')
    check(`${dev} offline: Rooms shows the last-known list with "As of"`, /As of \d\d:\d\d/.test(t) && t.includes('Reading room, morning'), t.slice(0, 300))
    await shot(pg, `14-${dev}-rooms-offline`)
    if (dev === 'phone') await still(pg, () => checkTargets(pg, 'Rooms offline'))
  }))
}

await guard('setup', () => [[P, 'phone'], [D, 'desktop']], setup)
if (P && D && job) {
  await Promise.all([
    guard('phone', () => [[P, 'phone'], [L, 'link']], phoneFlow),
    guard('desktop', () => [[D, 'desktop']], desktopFlow),
  ])
  await guard('offline', () => [[P, 'phone'], [D, 'desktop']], offlineFlow)
}
// --- summary -----------------------------------------------------------------------------------------------
clearInterval(watcher)
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n'))
check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.join('\n'))
if (expectedErrors.length) note(`${expectedErrors.length} expected console errors filtered (jobs server or planner server stopped on purpose)`)
if (targetViolations.length) note(`touch targets under 44 px:\n       ${targetViolations.join('\n       ')}`)
await finish()
