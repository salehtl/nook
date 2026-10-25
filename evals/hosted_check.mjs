// Smoke-test the hosted planner (Cloudflare Pages + Functions + KV + R2). Usage: node evals/hosted_check.mjs [base-url]
// Before Access is on, it runs anonymously. After that, pass a CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET service token.
import { chromium } from 'playwright-core'

const BASE = (process.argv[2] || 'https://nook-3mk.pages.dev').replace(/\/$/, '')
const hdr = process.env.CF_ACCESS_CLIENT_ID ? { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET } : {}
let fails = 0
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
const get = (p, o = {}) => fetch(BASE + p, { ...o, headers: { ...hdr, ...(o.headers || {}) } })

const root = await get('/', { redirect: 'manual' })
check('/ redirects to /planner/', [301, 302, 307, 308].includes(root.status) && /\/planner\/?$/.test(root.headers.get('location') || ''), `${root.status} ${root.headers.get('location')}`)
check('GET /api/room', (await get('/api/room')).ok)
check('PUT /api/layouts/<non-slug> is 400', (await get('/api/layouts/Bad%20Name', { method: 'PUT', body: '{}' })).status === 400)
check('GET /api/layouts/<missing> is 404', (await get('/api/layouts/nope-nope')).status === 404)
const lib = await get('/library/library.json')
check('library.json served from R2', lib.ok, String(lib.status))
const items = lib.ok ? (await lib.json()).items : []
for (const it of items) {
  for (const key of ['glb', 'splat']) {
    if (!it.assets[key]) continue
    const r = await get(`/library/${it.assets[key]}`, { method: 'HEAD' })
    check(`${it.id} ${key} served (${r.headers.get('content-type')}, ${(Number(r.headers.get('content-length')) / 1e6).toFixed(1)} MB)`, r.ok, String(r.status))
  }
}
check('dotfiles and traversal are 404', (await get('/library/.env')).status === 404)

const browser = await chromium.launch({ executablePath: '/Applications/Helium.app/Contents/MacOS/Helium', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: hdr })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`${BASE}/planner/`)
await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 60000 })
await page.evaluate(() => window.nook.ready)
check('planner loads the hosted library', (await page.evaluate(() => window.nook.getLibrary().length)) === items.length)
if (items.length) {
  const id = items[0].id
  for (const render of ['glb', 'splat']) {
    const ok = await page.evaluate(([id, render]) => window.nook.addItem(id, { render, position: [render === 'glb' ? -0.5 : 0.5, 0, 0] }).then(() => true, (e) => String(e)), [id, render])
    check(`addItem ${id} (${render}) from R2`, ok === true, ok)
  }
  await page.evaluate(() => window.nook.saveLayout('cf-smoke'))
  await page.goto('about:blank'); await page.goto(`${BASE}/planner/`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 60000 })
  await page.evaluate(() => window.nook.ready)
  await page.evaluate(() => window.nook.loadLayout('cf-smoke'))
  check('layout round-trips through KV', (await page.evaluate(() => window.nook.getState().items.length)) === 2)
  check('listLayouts sees it', (await page.evaluate(() => window.nook.listLayouts())).includes('cf-smoke'))
}
check('no page or console errors', errors.length === 0, errors.join(' | '))
await page.screenshot({ path: 'evals/out/hosted.png', timeout: 240000 })
await browser.close()
console.log(fails ? `\n${fails} failing` : '\nall passed')
process.exit(fails ? 1 : 0)
