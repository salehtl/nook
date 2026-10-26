// Publish nook to Cloudflare: upload new or changed library/ and room/ files to R2, then deploy the planner to Pages.
// Usage: npm run cf:publish [-- --push-room] [-- --no-assets]
//   --push-room  also overwrite the hosted room config (KV "room") with local room/room.json
//   --no-assets  skip the R2 upload, deploy code only
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const DEPLOY = path.join(REPO, 'deploy')
const DIST = path.join(DEPLOY, 'dist')
const MANIFEST = path.join(DEPLOY, '.published.json')
const BUCKET = 'nook-assets'
const KV_ID = 'a3d603dc459040148c1cb3540f9f0264'
const args = new Set(process.argv.slice(2))
const TYPES = { glb: 'model/gltf-binary', json: 'application/json', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', csv: 'text/csv' }

const wrangler = (argv, opts = {}) => execFileSync('npx', ['-y', 'wrangler@4', ...argv], { cwd: DEPLOY, stdio: 'inherit', ...opts })

// Files the planner needs. Skipped: raw engine outputs, failed runs, the inbox, and room.json (the hosted room lives in KV).
function assetFiles() {
  const out = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const rel = path.relative(REPO, p).split(path.sep).join('/')
      if (e.name.startsWith('.') || /^library\/(_inbox|_failed)(\/|$)|\/raw(\/|$)|^room\/room\.json$/.test(rel)) continue
      if (e.isDirectory()) walk(p)
      else out.push({ p, rel, stamp: `${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}` })
    }
  }
  walk(path.join(REPO, 'library'))
  walk(path.join(REPO, 'room'))
  return out
}

// 1. Static site
fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(path.join(DIST, 'planner'), { recursive: true })
for (const f of ['index.html', 'main.js', 'engine.js', 'input.js', 'ui-v1.js', 'style.css']) fs.copyFileSync(path.join(REPO, 'planner', f), path.join(DIST, 'planner', f))
fs.writeFileSync(path.join(DIST, '_redirects'), '/ /planner/ 302\n')
fs.writeFileSync(path.join(DIST, '_headers'), '/planner/*\n  Cache-Control: no-cache\n')

// 2. Assets to R2 (only what changed since the last publish)
if (!args.has('--no-assets')) {
  const seen = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {}
  const todo = assetFiles().filter((f) => seen[f.rel] !== f.stamp)
  console.log(`R2: ${todo.length} file(s) to upload`)
  for (const f of todo) {
    const type = TYPES[f.rel.split('.').pop().toLowerCase()] || 'application/octet-stream'
    wrangler(['r2', 'object', 'put', `${BUCKET}/${f.rel}`, '--file', f.p, '--content-type', type, '--remote'], { stdio: ['ignore', 'ignore', 'inherit'] })
    seen[f.rel] = f.stamp
    fs.writeFileSync(MANIFEST, JSON.stringify(seen, null, 2))
    console.log(`  ↑ ${f.rel}`)
  }
}

// 3. Room config
if (args.has('--push-room')) {
  const room = path.join(REPO, 'room/room.json')
  if (!fs.existsSync(room)) { console.error('no room/room.json to push'); process.exit(1) }
  wrangler(['kv', 'key', 'put', 'room', '--path', room, '--namespace-id', KV_ID, '--remote'])
}

// 4. Pages deploy (picks up deploy/functions and deploy/wrangler.toml)
wrangler(['pages', 'deploy', 'dist', '--project-name', 'nook', '--branch', 'main', '--commit-dirty=true'])
