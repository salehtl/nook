// Rooms (area A) shared bits: thumbnails, scan glyphs, status text, month groups, the room/scan wording.
import { friendlyDate, relDate, clock, scanDate, fmtBytes, fmtSplats, fmtMinutes } from '../../data.js'

const svg = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// The "no preview yet" cube (Paper A1), and the empty-state mark with its brass dot.
export const cube = (size = 22) => svg(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.8l6.2 3.6v7.2L10 17.2l-6.2-3.6V6.4L10 2.8Z"/><path d="M3.8 6.4L10 10l6.2-3.6M10 10v7.2"/></svg>`)
export const emptyMark = () => svg(`<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4l14 8v16l-14 8-14-8V12l14-8Z" fill="none" stroke="#A39E94" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 12l14 8 14-8M20 20v16" fill="none" stroke="#A39E94" stroke-width="1.5" stroke-linejoin="round"/><circle cx="20" cy="20" r="2.5" fill="#D9A441"/></svg>`)

// A big progress ring for a scan's thumbnail slot (36 px phone, 28 px desktop). null: a spinning arc.
export function bigRing(progress, size = 36) {
  const p = progress == null || !Number.isFinite(progress) ? 0.25 : Math.max(0.02, Math.min(0.999, progress))
  const a = p * 2 * Math.PI, r = 14
  const x = 18 + r * Math.sin(a), y = 18 - r * Math.cos(a)
  return svg(`<svg class="ring${progress == null ? ' spin' : ''}" width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(236,232,224,0.15)" stroke-width="3"/><path d="M18 4A14 14 0 ${p > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" stroke="#D9A441" stroke-width="3" stroke-linecap="round"/></svg>`)
}

// Status of a scan: kit pill key, its pill text, and whether it's still on its way.
export function scanKind(s) {
  if (s.status === 'queued') return 'queued'
  if (s.status === 'training') return s.word === 'Preparing' ? 'preparing' : 'training'
  return s.status // failed | cancelled | done
}
export const isBusy = (s) => s && (s.status === 'queued' || s.status === 'training')
export const pct = (s) => Math.round(Math.max(0, Math.min(1, s.progress || 0)) * 100)
export const pillText = (s) => (scanKind(s) === 'training' ? `Training ${pct(s)} %` : s.word)
export const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US').replace(/,/g, '\u202F') : '')
export const steps = (s) => (s.total_steps ? `Step ${num(s.step || 0)} / ${num(s.total_steps)}` : '')
export const minsLeft = (eta) => (!(eta > 0) ? '' : eta < 60 ? 'less than a minute left' : `${Math.round(eta / 60)} min left`)
export const aboutLeft = (eta) => (!(eta > 0) ? '' : eta < 60 ? 'less than a minute left' : `about ${Math.round(eta / 60)} min left`)
export const sent = (s) => (s.created ? `Sent ${clock(s.created)}` : '')
export const stageWord = (s) => (s.stage && s.stage !== 'done' ? s.stage.replace('building trainer', 'preparing').replace('waiting', 'queued') : 'training')

// The usual training time (median of the rooms' training seconds), for "about 16 min to go" before a scan starts.
export function typicalSeconds(rooms) {
  const t = rooms.map((r) => r.train_seconds).filter((v) => v > 0).sort((a, b) => a - b)
  return t.length ? t[Math.floor(t.length / 2)] : null
}

// The job ahead of a queued scan (the one training, else the next older queued one).
export function aheadOf(s, scans) {
  return scans.find((x) => x.status === 'training') || scans.filter((x) => x.status === 'queued' && x.created < s.created).pop() || null
}

// A failed scan: what to do next, from its error sentence.
export function adviceFor(s) {
  const m = (s.message || '').toLowerCase()
  if (/upload|reached kakapo|cut off|restart|again later|disk|server/.test(m)) {
    return 'In Nook Scan, open this scan under Recent and tap Send to kakapo. Stay on home Wi-Fi until it says Sent. It shows up here by itself.'
  }
  return 'Scan the room again in Nook Scan, slowly and with the lights on, then tap “Send to kakapo”. It shows up here by itself.'
}

// Rooms grouped by month, newest first: [{ key, label, rooms }]
export function byMonth(rooms) {
  const groups = []
  const year = new Date().getFullYear()
  for (const r of rooms) {
    const d = scanDate(r.name) || new Date(r.created)
    const ok = !Number.isNaN(d.getTime())
    const key = ok ? `${d.getFullYear()}-${d.getMonth()}` : 'unknown'
    let g = groups.find((x) => x.key === key)
    if (!g) groups.push(g = { key, label: ok ? `${MONTHS[d.getMonth()]}${d.getFullYear() !== year ? ` ${d.getFullYear()}` : ''}` : 'Undated', rooms: [] })
    g.rooms.push(r)
  }
  return groups
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export function countText(data) {
  const rooms = data.getRooms().length, scans = data.getScans().length
  const st = data.getState()
  if (st.offline && st.asOf) return `As of ${clock(st.asOf)}`
  if (!st.loaded && !rooms && !scans) return 'Checking kakapo…'
  if (!rooms) return scans ? `No rooms yet · ${plural(scans, 'scan')} on kakapo` : 'None yet'
  return scans ? `${plural(rooms, 'room')} · ${plural(scans, 'scan')} on kakapo` : plural(rooms, 'room')
}

// A room's numbers; the open room's splat count comes from the engine when the jobs API doesn't know it.
export function roomNumbers(r, engine) {
  const splats = r.splats ?? (engine.getRoomName() === r.name && engine.getRoom().splatCount ? engine.getRoom().splatCount : null)
  return { splats: fmtSplats(splats), size: fmtBytes(r.size_bytes), train: fmtMinutes(r.train_seconds), quality: r.quality ? r.quality[0].toUpperCase() + r.quality.slice(1) : '' }
}
export const neverOpened = (r) => !r.thumb_url
export const thumbSrc = (r) => (r.thumb_url ? `${r.thumb_url}${r.thumb_v ? `${r.thumb_url.includes('?') ? '&' : '?'}v=${r.thumb_v}` : ''}` : null)
export const dateLine = (r) => relDate(scanDate(r.name) || r.created)
export { friendlyDate, relDate, clock, scanDate }
