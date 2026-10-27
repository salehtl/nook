// The Rooms list (Paper A1 phone / A4 desktop table): "Scans on kakapo", then rooms by month, newest first; the
// open room marked "Open now"; one "…" slot per row. Empty (A3/A5), loading skeleton (A3), offline (A3/A5).
// v4 (§2.7): retrained <base>-rN rooms are listed under their <base>, newest first, the base room among them. (Retrain on
// a room whose capture isn't kept says "upload again" in the retrain sheet, ui/retrain.js.)
import { icon } from '../icons.js'
import { h, pill } from '../kit.js'
import {
  cube, emptyMark, bigRing, scanKind, isBusy, pillText, steps, minsLeft, aboutLeft, sent, stageWord, typicalSeconds,
  aheadOf, byMonth, plural, roomNumbers, neverOpened, thumbSrc, dateLine, clock,
} from './common.js'
import { groupRooms, version } from '../../data.js'

export function renderList(R, root) {
  const { engine, data, shell } = R.ctx
  const phone = shell.isPhone()
  const st = data.getState()
  const rooms = data.getRooms(), scans = data.getScans()
  const openName = engine.getRoomName()
  const offline = st.offline
  const dirty = engine.getDirty()
  root.className = `rm-root ${phone ? 'is-phone' : 'is-desktop'}${offline ? ' is-offline' : ''}`

  // loading skeleton: only with nothing cached on this device
  if (!st.loaded && !rooms.length && !scans.length) {
    root.replaceChildren(h('div.rm-skel', { 'aria-busy': 'true', 'aria-label': 'Loading rooms' }, h('div.rm-skel-sec'),
      Array.from({ length: 5 }, () => h('div.rm-skel-row', h('div.rm-skel-thumb'), h('div.rm-skel-lines', h('i', { style: { width: '72%' } }), h('i', { style: { width: '48%' } }), h('i', { style: { width: '64%' } }))))))
    return
  }

  const out = []
  if (offline) out.push(offlineBanner(R, st, phone))
  if (!phone && rooms.length) out.push(colHeads())

  // Scans on kakapo
  if (scans.length) {
    out.push(secHead('Scans on kakapo', scans.filter(isBusy).length > 1 || scans.some((s) => s.status === 'queued') ? 'One trains at a time' : ''))
    const typical = typicalSeconds(rooms) || 960 // the usual run on kakapo
    for (const s of scans) out.push(scanRow(R, s, { phone, offline, scans, typical }))
  }

  if (!rooms.length) {
    root.classList.add(scans.length ? 'is-first' : 'is-empty')
    if (scans.length) out.push(firstOnItsWay(scans[0], phone))
    else if (st.roomsApi === false) out.push(noRoomsApi())
    else out.push(emptyState(phone))
  } else {
    const groups = groupRooms(rooms)
    const byNewest = new Map(groups.map((g) => [g.newest, g]))
    for (const m of byMonth(groups.map((g) => g.newest))) {
      const n = m.rooms.reduce((a, r) => a + byNewest.get(r).rooms.length, 0)
      out.push(secHead(m.label, plural(n, 'room'), true))
      for (const newest of m.rooms) {
        const g = byNewest.get(newest)
        const many = g.rooms.length > 1
        g.rooms.forEach((r, i) => out.push(roomRow(R, r, { phone, offline, open: r.name === openName, dirty: r.name === openName && (dirty.room || dirty.layout), version: many ? version(r.name) : null, nested: many && i > 0 })))
      }
    }
  }
  if (!phone && rooms.length) out.push(keyLegend())
  if (phone && offline) out.push(h('div.rm-retry', h('button.btn.btn-secondary.btn-block', { type: 'button', onclick: () => R.retry() }, 'Try again'), h('p', 'Trying again by itself every 30 s')))
  root.replaceChildren(...out)
}

const secHead = (label, note, line) => h(`div.rm-sec${line ? '.has-line' : ''}`, h('span.caps', label), note ? h('span.rm-sec-note', note) : null)

function colHeads() {
  return h('div.rm-cols', { 'aria-hidden': 'true' }, h('span.rm-c-thumb'), h('span.rm-c-main', 'Room'), h('span.rm-c-num.c-splats', 'Splats'),
    h('span.rm-c-num.c-size', 'Size'), h('span.rm-c-num.c-train', 'Training'), h('span.c-q', 'Quality'), h('span.rm-c-num.c-lay', 'Layouts'),
    h('span.c-al', 'Aligned'), h('span.rm-c-more'))
}

function keyLegend() {
  const k = (keys, label) => h('span.rm-key', h('span.rm-keycap', keys), h('span', label))
  return h('div.rm-keys', { 'aria-hidden': 'true' }, k('↑ ↓', 'Move'), k('Enter', 'Open'), k('F2', 'Rename'), k('Del', 'Move to trash'), k('Esc', 'Close'))
}

function offlineBanner(R, st, phone) {
  const when = st.asOf ? clock(st.asOf) : null
  const open = R.ctx.engine.getRoomName()
  const openTitle = open ? R.ctx.data.getRoom(open)?.title : null
  if (phone) {
    return h('div.rm-offline', { role: 'status' }, icon('cloud-off', { size: 20 }),
      h('div.rm-offline-text', h('strong', 'kakapo isn\'t answering'),
        h('span', `Check you're on home Wi-Fi or Tailscale.${when ? ` This is the list from ${when}` : ''}${openTitle ? `; ${openTitle} stays open.` : '.'}`)))
  }
  const again = h('span.rm-offline-again')
  R.tickAgain = () => {
    const s = R.ctx.data.getState()
    const sec = s.retryAt ? Math.max(0, Math.round((s.retryAt - Date.now()) / 1000)) : null
    again.textContent = sec == null ? '' : sec > 0 ? `Again in ${sec} s` : 'Trying…'
  }
  R.tickAgain()
  return h('div.rm-offline', { role: 'status' }, icon('cloud-off', { size: 18 }),
    h('div.rm-offline-text', h('strong', 'kakapo isn\'t answering.'), h('span', ` Check you're on home Wi-Fi or Tailscale.${when ? ` This is the list from ${when}.` : ''}`)),
    again, h('button.btn.btn-secondary', { type: 'button', onclick: () => R.retry() }, 'Try again'))
}

function thumbEl(r, phone) {
  const src = thumbSrc(r)
  if (src) return h('img.rm-thumb', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: false, onerror: (e) => e.target.replaceWith(h('div.rm-thumb.is-none', cube(phone ? 22 : 20))) })
  return h('div.rm-thumb.is-none', cube(phone ? 22 : 20))
}

function scanThumb(s, phone) {
  const k = scanKind(s)
  const glyph = k === 'training' ? bigRing(s.progress, phone ? 36 : 28) : k === 'preparing' ? bigRing(null, phone ? 36 : 28)
    : icon(k === 'queued' ? 'clock' : k === 'failed' ? 'warning' : 'cancelled', { size: 22 })
  return h(`div.rm-thumb.is-scan.is-${k}`, glyph)
}

const moreBtn = (label, onClick) => h('button.rm-more', { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); onClick(e.currentTarget) } }, icon('more', { size: 20 }))

function rowEl(cls, { key, label, onOpen, disabled }, ...kids) {
  const el = h(`div.rm-row${cls}`, { role: 'button', tabindex: disabled ? '-1' : '0', 'aria-label': label, 'aria-disabled': disabled ? 'true' : null, dataset: { key } }, ...kids)
  el.addEventListener('click', (e) => { if (!disabled && !e.target.closest('button, input')) onOpen() })
  el._open = disabled ? null : onOpen
  return el
}

function scanRow(R, s, { phone, offline, scans, typical }) {
  const k = scanKind(s)
  const ahead = k === 'queued' ? aheadOf(s, scans) : null
  const p = pill(k, pillText(s), s.progress)
  const atAsOf = offline && R.ctx.data.getState().asOf ? `at ${clock(R.ctx.data.getState().asOf)}` : ''
  const open = () => (k === 'failed' ? R.openScan(s.id) : R.scanActions(s, el.querySelector('.rm-more')))
  let el
  if (phone) {
    const second = k === 'training' ? (atAsOf || minsLeft(s.eta_s)) : k === 'preparing' ? (typical ? `about ${Math.round(typical / 60)} min to go` : '')
      : k === 'queued' ? sent(s) : k === 'failed' ? `while ${stageWord(s)}` : k === 'cancelled' ? sent(s) : ''
    const third = k === 'training' ? steps(s) : k === 'preparing' ? (s.created ? `${sent(s)} from Nook Scan` : '')
      : k === 'queued' ? (ahead ? `Starts after ${ahead.title}` : 'Waiting for kakapo') : k === 'failed' ? s.message : k === 'cancelled' ? 'Dismiss it to hide it' : ''
    el = rowEl(`.is-scan.is-${k}`, { key: `scan:${s.id}`, label: `${s.title}, ${pillText(s)}`, onOpen: open, disabled: offline },
      scanThumb(s, phone),
      h('div.rm-main', h('div.rm-title', s.title),
        h('div.rm-line.rm-status', p, second ? h(`span${k === 'training' && !offline ? '.is-strong' : ''}`, second) : null),
        third ? h(`div.rm-line${k === 'failed' ? '.is-text' : ''}`, third) : null),
      moreBtn(`Actions for ${s.title}`, (b) => R.scanActions(s, b)))
  } else {
    const sub = k === 'failed' ? `Failed while ${stageWord(s)}` : k === 'cancelled' ? (s.finished ? `Cancelled ${clock(s.finished)}` : 'Cancelled') : sent(s)
    const text = k === 'training' ? [steps(s), atAsOf || aboutLeft(s.eta_s)].filter(Boolean).join(atAsOf ? ' ' : ' · ')
      : k === 'preparing' ? ['Preparing images', typical ? `about ${Math.round(typical / 60)} min to go` : ''].filter(Boolean).join(' · ')
        : k === 'queued' ? (ahead ? `Starts after ${ahead.title}` : 'Waiting for kakapo')
          : k === 'failed' ? (s.message || 'The scan stopped on kakapo.') : 'Dismiss it to hide it from this list.'
    el = rowEl(`.is-scan.is-${k}`, { key: `scan:${s.id}`, label: `${s.title}, ${pillText(s)}`, onOpen: open, disabled: offline },
      scanThumb(s, phone), h('span.rm-gap'),
      h('div.rm-main', h('div.rm-title', s.title), h('div.rm-line', sub)),
      h('div.rm-span', p, h('span.rm-span-text', text)),
      moreBtn(`Actions for ${s.title}`, (b) => R.scanActions(s, b)))
  }
  return el
}

function roomRow(R, r, { phone, offline, open, dirty, version: ver = null, nested = false }) {
  const n = roomNumbers(r, R.ctx.engine)
  const disabled = offline && !open
  const openBits = open ? h('span.rm-open', dirty ? R.ctx.shell.glyphs.unsavedGlyph(14) : null, h('span', dirty ? 'Open now · Unsaved' : 'Open now')) : null
  const date = dateLine(r)
  const second = neverOpened(r) && !open ? 'Never opened · no preview yet' : r.titleSet ? date : (/^(Today|Yesterday)/.test(date) ? date : 'No title yet')
  const line2 = h('div.rm-line', openBits, openBits ? h('span', ` ·\u00A0${second}`) : second)
  const aligned = r.aligned ? h('span.rm-aligned', icon('check', { size: phone ? 16 : 14 }), h('span', 'Aligned')) : h('span', 'Not aligned')
  const onOpen = () => R.switchTo(r.name)
  const cls = `${open ? '.is-open' : ''}${disabled ? '.is-disabled' : ''}${nested ? '.is-version' : ''}`
  const tag = ver == null ? null : h('span.rm-ver', ver ? `Retrain ${ver}` : 'Original')
  if (phone) {
    const nums = [n.splats && `${n.splats} splats`, n.size, n.train].filter(Boolean).join(' · ')
    const layouts = r.layouts ? plural(r.layouts, 'layout') : 'No layouts'
    return rowEl(cls, { key: `room:${r.name}`, label: `${r.title}${open ? ', open now' : ''}`, onOpen, disabled },
      thumbEl(r, phone),
      h('div.rm-main', h('div.rm-title', tag, r.title), line2, nums ? h('div.rm-line', nums) : null,
        h('div.rm-line.rm-flags', h('span', `${layouts} ·`), aligned, r.quality === 'draft' ? h('span', '· Draft') : null)),
      moreBtn(`Actions for ${r.title}`, (b) => R.roomActions(r, b)))
  }
  const cell = (c, v) => h(`span.${c}${v ? '' : '.is-empty'}`, v || '—')
  return rowEl(cls, { key: `room:${r.name}`, label: `${r.title}${open ? ', open now' : ''}`, onOpen, disabled },
    thumbEl(r, phone), h('span.rm-gap'),
    h('div.rm-main', h('div.rm-title', tag, r.title), line2),
    cell('rm-c-num.c-splats', n.splats), cell('rm-c-num.c-size', n.size), cell('rm-c-num.c-train', n.train),
    h(`span.c-q${r.quality === 'draft' ? '.is-muted' : ''}`, n.quality || '—'), h('span.rm-c-num.c-lay', String(r.layouts ?? 0)),
    h(`span.c-al${r.aligned ? '' : '.is-muted'}`, aligned),
    moreBtn(`Actions for ${r.title}`, (b) => R.roomActions(r, b)))
}

function emptyState(phone) {
  const where = phone ? 'this iPhone' : 'the iPhone'
  return h('div.rm-empty',
    h('div.rm-empty-mark', emptyMark()),
    h('h2.rm-empty-title', 'No rooms yet'),
    h('p.rm-empty-lead', phone ? 'A room is a scan that kakapo has trained. Scan with Nook Scan on this iPhone; training takes about 16 minutes.'
      : 'A room is a scan that kakapo has trained. Scans come from Nook Scan on the iPhone; training takes about 16 minutes.'),
    h('ol.rm-steps', [`Open Nook Scan on ${where}`, 'Walk the room slowly, lights on', 'Tap “Send to kakapo” in Nook Scan']
      .map((t, i) => h('li', h('span.rm-step-n', String(i + 1)), h('span', t)))),
    h('p.rm-empty-foot', 'The scan shows up here while it trains. No need to refresh.'))
}

function firstOnItsWay(s, phone) {
  return h('div.rm-first', h('h2.rm-empty-title', 'Your first room is on its way'),
    h('p.rm-empty-lead', `When training ends, ${s.title} moves down here as a room and a toast offers Open. You can close Rooms and look around meanwhile.`))
}

function noRoomsApi() {
  return h('div.rm-empty', h('h2.rm-empty-title', 'One room only'),
    h('p.rm-empty-lead', 'This server doesn\'t list rooms, so the planner shows the current room. Run planner/serve.py on kakapo to see every scan.'))
}

export function focusRow(root, key) {
  const rows = [...root.querySelectorAll('.rm-row[tabindex="0"]')]
  const el = (key && rows.find((r) => r.dataset.key === key)) || root.querySelector('.rm-row.is-open[tabindex="0"]') || rows[0]
  el?.focus({ preventScroll: false })
  return el
}
