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
if (process.argv.includes('--room')) {
  const room = kv('key', 'get', 'room').trim()
  if (room && room !== 'Value not found') {
    fs.mkdirSync(path.join(REPO, 'room'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'room/room.json'), JSON.stringify(JSON.parse(room), null, 2) + '\n')
    console.log('↓ room/room.json')
  }
}
console.log(`${keys.length} layout(s) pulled`)
