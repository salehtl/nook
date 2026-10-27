// Rooms flows (area D): switching rooms through the unsaved-changes confirm (D4), "Open when ready" and the
// "<title> is ready · Open" toast (D2), the room-link cards for ?room=<name> (A6 still training, D5.5 can't find).
import { icon } from '../icons.js'
import { h, pill, kbd } from '../kit.js'
import { isBusy, scanKind, pillText, steps, aboutLeft, aheadOf, plural } from './common.js'

export function createFlows(R) {
  const { engine, data, shell } = R.ctx
  const armed = new Set() // room names that open by themselves when their scan is ready
  let switching = null      // the room last asked for (no "ready · Open" toast for it)

  const titleOf = (name) => data.getRoom(name)?.title || data.getScan(name)?.title || name
  function openTitle() {
    const name = engine.getRoomName()
    if (name) return titleOf(name)
    return engine.getRoom().kind === 'placeholder' ? 'the placeholder room' : 'this room'
  }

  // What's unsaved, for the confirm: [{ icon, title, meta }]
  function unsavedRows() {
    const d = engine.getDirty(), rows = []
    if (d.layout) {
      const name = engine.getLayoutName(), n = engine.getItems().length
      rows.push(name ? { icon: 'layouts', title: `Layout · ${name}`, meta: `${plural(n, 'item')} changed` }
        : { icon: 'in-room', title: 'Furniture in the room', meta: `${plural(n, 'item')}, not in a layout` })
    }
    if (d.room) {
      const a = engine.getRoomConfig(), b = engine.getSavedRoomConfig() || {}
      const bits = []
      const ta = a.transform || {}, tb = b.transform || {}
      if (JSON.stringify(ta.quaternion) !== JSON.stringify(tb.quaternion ?? [0, 0, 0, 1])) bits.push('turned or levelled')
      if (JSON.stringify(ta.position) !== JSON.stringify(tb.position ?? [0, 0, 0])) bits.push('moved')
      if ((ta.scale ?? 1) !== (tb.scale ?? 1)) bits.push(`scale ${(ta.scale ?? 1).toFixed(2)}×`)
      if (JSON.stringify(a.look) !== JSON.stringify(b.look ?? a.look)) bits.push('look changed')
      if (JSON.stringify(a.placeholder) !== JSON.stringify(b.placeholder ?? a.placeholder)) bits.push('size changed')
      rows.push({ icon: 'room', title: 'Room alignment', meta: bits.join(' · ') || 'changed' })
    }
    return rows
  }

  async function confirmUnsaved(target) {
    const phone = shell.isPhone()
    const list = h('div.rm-unsaved', unsavedRows().map((r) => h('div.rm-unsaved-row', icon(r.icon, { size: 16 }),
      h('span.rm-unsaved-text', h('span.rm-unsaved-title', r.title), h('span.rm-unsaved-meta', r.meta)))))
    const cur = openTitle(), next = titleOf(target)
    const body = document.createDocumentFragment()
    body.append(h('span.rm-unsaved-lead', phone ? `It has changes that aren't saved yet. ${next} opens after.` : `${next} opens after. Unsaved here:`), list)
    const save = { label: 'Save room and switch', value: 'save', kind: 'primary', default: true }
    const discard = { label: 'Discard changes', value: 'discard', kind: 'discard' }
    const cancel = { label: 'Cancel', value: 'cancel', kind: 'secondary', cancel: true }
    return shell.confirm({ title: phone ? `Save ${cur} first?` : `Save ${cur} before switching?`, body, icon: 'pencil',
      actions: phone ? [save, discard, cancel] : [discard, cancel, save] })
  }

  async function saveAll() {
    const d = engine.getDirty()
    if (d.room) await engine.saveRoom()
    if (d.layout && engine.getLayoutName()) await engine.saveLayoutInternal(engine.getLayoutName())
  }

  function setUrlRoom(name) {
    try {
      const u = new URL(location.href)
      u.searchParams.set('room', name)
      history.replaceState(history.state, '', u)
    } catch { /* ignore */ }
  }

  // Open a room: through the unsaved confirm, then the workspace's loading card takes over. → true when it switched
  async function switchTo(name) {
    if (!name) return false
    if (name === engine.getRoomName() && !engine.getRoom().dropped) { shell.closePage(); hideCard(); return true }
    const d = engine.getDirty()
    if (d.room || d.layout) {
      const choice = await confirmUnsaved(name)
      if (choice !== 'save' && choice !== 'discard') return false
      if (choice === 'save') { try { await saveAll() } catch { return false } }
    }
    shell.closePage()
    hideCard()
    switching = name
    setUrlRoom(name)
    engine.openRoom(name).catch(() => {})
    return true
  }

  // --- Open when ready, and the ready toast ----------------------------------------------------------------------
  function arm(name, on = true) {
    if (on) armed.add(name); else armed.delete(name)
    if (card?.name === name) drawCard()
    R.render()
  }
  data.events.addEventListener('scan-ready', (e) => {
    const { job, room } = e.detail || {}
    if (!job?.name) return
    if (armed.has(job.name)) { armed.delete(job.name); if (room) { switchTo(job.name); return } }
    if (card?.name === job.name) drawCard()
    if (!room || switching === job.name || engine.getRoomName() === job.name) return
    shell.toast(`${room.title} is ready.`, { kind: 'ok', ms: 10000, id: `ready-${job.name}`, action: { label: 'Open', onClick: () => switchTo(job.name) } })
  })
  // A watched scan that fails or is cancelled stops waiting.
  data.events.addEventListener('scans', () => {
    for (const name of [...armed]) {
      const s = data.getScan(name)
      if (s && (s.status === 'failed' || s.status === 'cancelled')) {
        armed.delete(name)
        if (s.status === 'failed') shell.toast(`${s.title} failed. It won't open.`, { kind: 'error', action: { label: 'Details', onClick: () => R.openScan(s.id) } })
      }
    }
    if (card) drawCard()
  })

  // --- room-link cards: ?room=<name> that isn't a room yet (A6) or at all (D5.5) -----------------------------------
  let card = null // { name, el }
  const host = h('div.rm-cardhost')
  document.body.append(host)
  function hideCard() { card = null; host.replaceChildren() }
  function showCard(name) { card = { name }; drawCard() }
  function drawCard() {
    if (!card) return
    const phone = shell.isPhone()
    const { name } = card
    const room = data.getRoom(name)
    const s = data.getScan(name)
    if (room && (!s || !isBusy(s))) {
      if (armed.has(name)) { armed.delete(name); switchTo(name); return }
      host.replaceChildren(readyCard(room))
      return
    }
    if (s && s.status === 'failed') { hideCard(); R.openScan(s.id); return }
    if (!s || !isBusy(s)) { host.replaceChildren(missingCard(name, s)); return }
    const on = armed.has(name)
    const k = scanKind(s)
    const queued = k === 'queued'
    const ahead = queued ? aheadOf(s, data.getScans()) : null
    const lead = on ? 'Keep this page open. The room loads by itself when training ends.'
      : queued ? 'This scan is waiting its turn on kakapo. It can open as soon as it\'s ready.'
        : 'This room is still training on kakapo. It can open as soon as it\'s ready.'
    const left = queued ? (ahead ? `Starts after ${ahead.title}` : 'Waiting for kakapo') : k === 'preparing' ? 'Preparing images' : steps(s)
    const right = queued ? '' : aboutLeft(s.eta_s)
    const main = on
      ? h('button.btn.rm-card-armed', { type: 'button', 'aria-disabled': 'true' }, icon('check', { size: 20 }), h('span', 'Opens when ready'))
      : h('button.btn.btn-primary.rm-card-main', { type: 'button', onclick: () => arm(name) }, h('span', 'Open when ready'), phone ? null : kbd('Enter'))
    const alt = h('button.btn.btn-quiet.rm-card-alt', { type: 'button', onclick: () => (on ? (arm(name, false), hideCard()) : (hideCard(), R.open())) }, on ? 'Don\'t wait' : 'See all rooms')
    host.replaceChildren(h('div.rm-card', { role: 'region', 'aria-label': 'Room link' },
      h('div.rm-card-head', pill(k, pillText(s), s.progress), h('h2.rm-card-title', s.title), h('p.rm-card-text', lead)),
      h('div.rm-card-progress', h('div.rm-card-progress-row', h('span', left), h('strong', right)),
        h('div.rm-card-bar', h('span', { style: { width: `${Math.round((s.progress || 0) * 100)}%` } }))),
      h('div.rm-card-actions', phone ? [main, alt] : [alt, main])))
  }
  function readyCard(room) {
    return h('div.rm-card', { role: 'region', 'aria-label': 'Room link' },
      h('div.rm-card-head', pill('ready'), h('h2.rm-card-title', room.title), h('p.rm-card-text', 'Training finished. The room is ready to open.')),
      h('div.rm-card-actions', h('button.btn.btn-quiet.rm-card-alt', { type: 'button', onclick: () => { hideCard(); R.open() } }, 'See all rooms'),
        h('button.btn.btn-primary.rm-card-main', { type: 'button', onclick: () => switchTo(room.name) }, 'Open room')))
  }
  function missingCard(name, s) {
    const body = s?.status === 'cancelled'
      ? `The scan ${name} was cancelled on kakapo. Send it again from Nook Scan.`
      : `kakapo has no room or scan called ${name}. It may be in the trash on kakapo, or the link has a typo.`
    return h('div.rm-card.is-missing', { role: 'region', 'aria-label': 'Room link' },
      h('div.rm-card-head', h('div.caps', 'Room link'), h('h2.rm-card-title', 'Can\'t find this room'), h('p.rm-card-text', body)),
      h('div.rm-card-actions', h('button.btn.btn-primary.rm-card-main', { type: 'button', onclick: () => { hideCard(); R.open() } }, 'Open Rooms')))
  }
  // Enter arms the desktop card (when nothing else has the keys).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !card || shell.isPhone() || shell.getOpenPage() || e.target.closest?.('input, textarea, button, [role="button"]')) return
    const s = data.getScan(card.name)
    if (isBusy(s) && !armed.has(card.name)) { e.preventDefault(); arm(card.name) }
  })
  function checkLink() {
    const want = engine.getMissingRoom()
    if (!want) return
    if (!data.getState().loaded) return // waits for the first list
    if (data.getRoom(want) && !data.getScan(want)) { if (card?.name !== want) engine.openRoom(want).catch(() => {}); return }
    if (card?.name !== want) showCard(want)
  }
  engine.events.addEventListener('room', (e) => {
    const p = e.detail?.phase
    if (p === 'missing') checkLink()
    if (p === 'loading' && e.detail?.name && card && card.name !== e.detail.name) hideCard()
    if (p === 'loading' && e.detail?.name && card?.name === e.detail.name) hideCard()
  })
  data.events.addEventListener('rooms', () => (card ? drawCard() : checkLink()))

  // D5.3: the first time a room that was never aligned opens on this device, offer Check room.
  const alignAsked = (name) => { try { return localStorage.getItem(`nook.align-asked.${name}`) === '1' } catch { return true } }
  engine.events.addEventListener('room', (e) => {
    const name = e.detail?.name
    if (e.detail?.phase !== 'loaded' || !name || alignAsked(name) || data.getRoom(name)?.aligned !== false) return
    try { localStorage.setItem(`nook.align-asked.${name}`, '1') } catch { /* private mode: ask again next time */ }
    setTimeout(() => {
      if (engine.getRoomName() !== name) return
      shell.toast('Not aligned yet. Check it\'s level and the right size.', { ms: 10000, action: { label: 'Check room', onClick: () => shell.openPanel('room', { detent: 'peek' }) } })
    }, 1500)
  })
  shell.events.addEventListener('mode', () => drawCard())
  checkLink()

  return { switchTo, arm, isArmed: (name) => armed.has(name), hideCard, titleOf, openTitle }
}
