// shot.mjs URL OUT.png: open the planner at URL in software GL, wait for the room, save a screenshot and print its state.
import { chromium } from 'playwright-core'
const [url, out] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: process.env.NOOK_BROWSER, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []; p.on('pageerror', (e) => errs.push(String(e)))
await p.goto(url)
await p.waitForFunction(() => window.nook?.getState?.()?.room?.loaded, null, { timeout: 200000 })
await new Promise((r) => setTimeout(r, 45000))
console.log(JSON.stringify({ room: await p.evaluate(() => { const r = window.nook.getState().room; return { kind: r.kind, loaded: r.loaded, splatCount: r.splatCount, lod: r.lod } }), errs }))
await p.screenshot({ path: out }); await b.close()
