// End-to-end: load any library.json into the planner, place every item in a row, and check its size and floor contact.
// Usage: node evals/library_in_planner.mjs [library.json]   (default: library/library.json)
// Screenshot: evals/out/e2e/<library dir name>.png
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const libFile = path.resolve(process.argv[2] || path.join(REPO, 'library/library.json'))
const libUrl = '/' + path.relative(REPO, libFile).split(path.sep).join('/')
const OUT = path.join(REPO, 'evals/out/e2e')
const PORT = 8798
fs.mkdirSync(path.join(OUT, 'layouts'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'fixtures/room/placeholder.json'), path.join(OUT, 'room.json'))

const server = spawn('python3', ['planner/serve.py', '--port', String(PORT), '--room-file', 'evals/out/e2e/room.json', '--layouts-dir', 'evals/out/e2e/layouts'], { cwd: REPO, stdio: 'ignore' })
process.on('exit', () => server.kill())
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/room`)).ok) break } catch { await new Promise((r) => setTimeout(r, 200)) } }

const browser = await chromium.launch({ executablePath: process.env.NOOK_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${PORT}/planner/?library=${encodeURIComponent(libUrl)}`)
await page.waitForFunction(() => window.nook && window.nook.ready, null, { timeout: 30000 })
await page.evaluate(() => window.nook.ready)

const items = await page.evaluate(() => window.nook.getLibrary())
let failed = 0
let x = -((items.length - 1) * 0.6) / 2
for (const item of items) {
  const renders = item.assets.splat ? ['glb', 'splat'] : ['glb']
  for (const render of renders) {
    const res = await page.evaluate(async ([id, render, pos]) => {
      try {
        const uid = await window.nook.addItem(id, { render, position: pos })
        return window.nook.getState().items.find((i) => i.uid === uid)
      } catch (e) { return { error: String(e) } }
    }, [item.id, render, [x, 0, render === 'glb' ? -0.6 : 0.6]])
    if (res.error) { failed++; console.log(`FAIL ${item.id} (${render}): ${res.error}`); continue }
    const size = res.worldBounds.max.map((v, i) => v - res.worldBounds.min[i])
    const want = [item.dims_cm.w, item.dims_cm.h, item.dims_cm.d].map((v) => v / 100)
    const tol = render === 'glb' ? 0.02 : 0.05
    const okH = Math.abs(size[1] - want[1]) / want[1] <= tol
    const okFloor = Math.abs(res.worldBounds.min[1]) <= 0.03
    const okWD = render === 'splat' || [0, 2].every((i) => Math.abs(size[i] - want[i]) / want[i] <= tol)
    const ok = okH && okFloor && okWD
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${item.id} (${render}) size ${size.map((v) => (v * 100).toFixed(1)).join('×')} cm vs ${item.dims_cm.w}×${item.dims_cm.h}×${item.dims_cm.d} (w×h×d)`)
  }
  x += 0.9
}
await page.waitForTimeout(2500)
const shot = path.join(OUT, `${path.basename(path.dirname(libFile))}.png`)
await page.screenshot({ path: shot })
if (errors.length) { failed++; console.log(`FAIL errors: ${errors.join(' | ')}`) }
console.log(`\n${items.length} items, ${failed} failing · screenshot ${path.relative(REPO, shot)}`)
await browser.close()
process.exit(failed ? 1 : 0)
