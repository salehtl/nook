// Pull state saved on the hosted planner back to disk: layouts (KV "layout:*") to layouts/, and with --room the
// room config (KV "room") to room/room.json. Lets a local session see what was arranged on the hosted site.
// Usage: npm run cf:pull [-- --room]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const KV_ID = 'a3d603dc459040148c1cb3540f9f0264'
const kv = (...argv) => execFileSync('npx', ['-y', 'wrangler@4', 'kv', ...argv, '--namespace-id', KV_ID, '--remote'],
  { cwd: path.join(REPO, 'deploy'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

const keys = JSON.parse(kv('key', 'list', '--prefix', 'layout:')).map((k) => k.name)
fs.mkdirSync(path.join(REPO, 'layouts'), { recursive: true })
for (const key of keys) {
  const name = key.slice('layout:'.length)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue
  const data = JSON.parse(kv('key', 'get', key))
  fs.writeFileSync(path.join(REPO, 'layouts', `${name}.json`), JSON.stringify(data, null, 2) + '\n')
  console.log(`↓ layouts/${name}.json`)
}
// Renders made on the hosted copy: image + metadata to renders/, and their cost into library/costs.csv (once).
const r2get = (key, file) => execFileSync('npx', ['-y', 'wrangler@4', 'r2', 'object', 'get', `nook-assets/${key}`, '--file', file, '--remote'],
  { cwd: path.join(REPO, 'deploy'), stdio: ['ignore', 'ignore', 'inherit'] })
const costs = path.join(REPO, 'library/costs.csv')
for (const key of JSON.parse(kv('key', 'list', '--prefix', 'render:')).map((k) => k.name)) {
  const meta = JSON.parse(kv('key', 'get', key))
  const dir = path.join(REPO, 'renders')
  fs.mkdirSync(dir, { recursive: true })
  for (const url of [meta.url, meta.input_url]) {
    const file = path.join(dir, path.basename(url))
    if (!fs.existsSync(file)) r2get(url.replace(/^\//, ''), file)
  }
  fs.writeFileSync(path.join(dir, `${meta.name}.json`), JSON.stringify(meta, null, 2) + '\n')
  const text = fs.existsSync(costs) ? fs.readFileSync(costs, 'utf8') : 'date,id,engine,cost_usd,mock,input\n'
  if (!text.includes(`,${meta.name},`)) {
    fs.mkdirSync(path.dirname(costs), { recursive: true })
    fs.writeFileSync(costs, (text.endsWith('\n') ? text : text + '\n') + `${meta.created},${meta.name},render:${meta.model},${meta.cost_usd},false,${meta.view || 'hosted'}\n`)
  }
  console.log(`↓ renders/${meta.name}.jpg`)
}
if (process.argv.includes('--room')) {
  const room = kv('key', 'get', 'room').trim()
  if (room && room !== 'Value not found') {
    fs.mkdirSync(path.join(REPO, 'room'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'room/room.json'), JSON.stringify(JSON.parse(room), null, 2) + '\n')
    console.log('↓ room/room.json')
  }
}
console.log(`${keys.length} layout(s) pulled`)
