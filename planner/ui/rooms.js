// Rooms (areas A and D): every room and scan on kakapo. Phone: a full-height page; desktop: an 880 px table overlay
// under the bar. Open, rename, move to trash, cancel or dismiss a scan; empty, loading and offline states; the
// room-link cards for ?room=<name>, the "ready · Open" toast and the failed-scan sheet.
// Parts: rooms/list.js (the list), rooms/sheets.js (phone sheets), rooms/flows.js (switching, links, toasts).
// Exposes ctx.rooms = { open(), close(), openScan(jobId), openRoom(name) → Promise<bool>, isArmed(name), arm(name, on) }.
import { h } from './kit.js'
import { renderList, focusRow } from './rooms/list.js'
import { createOverlays, actionSheet, renameSheet, failedSheet, failedBody } from './rooms/sheets.js'
import { createFlows } from './rooms/flows.js'
import { cube, bigRing, scanKind, isBusy, pillText, minsLeft, adviceFor, stageWord, friendlyDate, scanDate, plural, thumbSrc, countText } from './rooms/common.js'

export function mount(ctx) {
  const { engine, data, shell } = ctx
  const root = h('div.rm-root')
  const ov = createOverlays(shell)
  const R = { ctx, render, retry, tickAgain: null }
  let page = null
  let editing = null // desktop inline rename: { name }
  let pending = false

  // --- render ------------------------------------------------------------------------------------------------
  function render() {
    if (!page?.isOpen()) return
    if (editing) { pending = true; return }
    const active = document.activeElement
    const key = root.contains(active) ? active.closest('.rm-row')?.dataset.key : null
    const scroll = root.closest('.page-body')?.scrollTop
    page.setCount(countText(data))
    renderList(R, root)
    const body = root.closest('.page-body')
    if (body && scroll != null) body.scrollTop = scroll
    if (key) focusRow(root, key)
  }
  async function retry() {
    const b = root.querySelectorAll('.rm-retry .btn, .rm-offline .btn')
    for (const x of b) { x.disabled = true; x.textContent = 'Trying…' }
    try { await data.retry() } finally { render() }
  }

  // --- actions -------------------------------------------------------------------------------------------------
  const offline = () => data.getState().offline
  const roomThumb = (r) => {
    const src = thumbSrc(r)
    return src ? h('img.rm-thumb', { src, alt: '' }) : h('div.rm-thumb.is-none', cube(20))
  }

  function roomActions(r, anchor) {
    const isOpen = r.name === engine.getRoomName()
    const off = offline()
    if (shell.isPhone()) {
      actionSheet(ov, {
        head: { thumb: roomThumb(r), title: r.title, sub: r.titleSet ? r.name : `${r.name} · no title yet` },
        items: [
          { label: isOpen ? 'Open now' : 'Open room', icon: 'play', tone: 'accent', disabled: isOpen || off, onSelect: () => R.switchTo(r.name) },
          { label: 'Rename', icon: 'pencil', disabled: off, onSelect: () => rename(r) },
          { label: 'Move to trash…', icon: 'trash', tone: 'danger', disabled: off, onSelect: () => trash(r) },
        ],
      })
      return
    }
    shell.menu(anchor, [
      { label: isOpen ? 'Open now' : 'Open room', icon: 'play', kbd: 'Enter', disabled: isOpen || off, onSelect: () => R.switchTo(r.name) },
      { label: 'Rename', icon: 'pencil', kbd: 'F2', disabled: off, onSelect: () => rename(r) },
      '-',
      { label: 'Move to trash…', icon: 'trash', kbd: 'Del', danger: true, disabled: off, onSelect: () => trash(r) },
    ])
  }

  function scanActions(s, anchor) {
    const k = scanKind(s)
    const off = offline()
    if (k === 'failed') return openScan(s.id)
    const armed = flows.isArmed(s.name)
    const stay = engine.getRoomName() ? flows.titleOf(engine.getRoomName()) : 'this room'
    const items = isBusy(s) ? [
      armed ? { label: 'Don\'t wait', sub: 'It won\'t open by itself', icon: 'close', onSelect: () => flows.arm(s.name, false) }
        : { label: 'Open when ready', sub: `Stays in ${stay} until then`, icon: 'play', tone: 'accent', disabled: off, onSelect: () => armAndToast(s) },
      { label: 'Cancel scan…', icon: 'trash', tone: 'danger', disabled: off, onSelect: () => cancelScan(s) },
    ] : [{ label: 'Dismiss', icon: 'close', onSelect: () => dismiss(s) }]
    if (shell.isPhone()) {
      const sub = k === 'training' ? [pillText(s), minsLeft(s.eta_s)].filter(Boolean).join(' · ') : s.word
      const thumb = h(`div.rm-thumb.is-scan.is-${k}`, k === 'training' || k === 'preparing' ? bigRing(k === 'training' ? s.progress : null, 28) : null)
      actionSheet(ov, { head: { thumb, title: s.title, sub }, items })
      return
    }
    shell.menu(anchor, items.map((it) => ({ label: it.label, icon: it.icon, danger: it.tone === 'danger', disabled: it.disabled, onSelect: it.onSelect })))
  }
  function armAndToast(s) {
    flows.arm(s.name)
    shell.toast(`${s.title} opens when it's ready. Keep this page open.`, { kind: 'info', id: `armed-${s.name}` })
  }

  function rename(r) {
    const save = async (title) => {
      const t = (title || '').trim()
      if (t === (r.titleSet ? r.title : '')) return
      await data.rename(r.name, t)
    }
    if (shell.isPhone()) {
      renameSheet(ov, { value: r.titleSet ? r.title : '', was: r.title, onSave: save })
      return
    }
    // desktop: inline, in the row
    const row = root.querySelector(`.rm-row[data-key="room:${CSS.escape(r.name)}"]`)
    const titleEl = row?.querySelector('.rm-title')
    if (!titleEl) return
    editing = { name: r.name }
    const input = h('input.input.rm-inline-input', { type: 'text', value: r.titleSet ? r.title : '', placeholder: r.title, maxLength: 120, 'aria-label': 'Room title', spellcheck: false, autocomplete: 'off' })
    const hint = h('div.rm-line.rm-inline-hint', 'Enter to save · Esc to cancel · only the title changes, not the file on kakapo')
    const line = titleEl.nextElementSibling
    titleEl.replaceWith(input)
    line?.replaceWith(hint)
    let done = false
    const finish = async (keep) => {
      if (done) return
      done = true
      if (keep) { try { await save(input.value) } catch { /* reported */ } }
      editing = null
      pending = false
      render()
      focusRow(root, `room:${r.name}`)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    input.focus()
    input.select()
  }

  async function trash(r) {
    const n = r.layouts || 0
    const ok = await shell.confirm({
      title: `Move ${r.title} to the trash?`, icon: 'trash', danger: true,
      body: n ? `The room and its ${plural(n, 'layout')} move to the trash folder on kakapo. You can restore them from there.`
        : 'The room moves to the trash folder on kakapo. You can restore it from there.',
      confirm: 'Move to trash', cancel: 'Keep room',
    })
    if (!ok) return
    try {
      await data.trash(r.name)
      shell.toast(`${r.title} moved to the trash on kakapo.`, { kind: 'ok' })
    } catch { /* reported */ }
  }

  async function cancelScan(s) {
    const ok = await shell.confirm({
      title: `Cancel ${s.title}?`, icon: 'trash', danger: true,
      body: s.status === 'queued' ? 'It won\'t train. To try again, tap “Send to kakapo” in Nook Scan.' : 'Training stops on kakapo. To try again, tap “Send to kakapo” in Nook Scan.',
      confirm: 'Cancel scan', cancel: 'Keep training',
    })
    if (!ok) return
    flows.arm(s.name, false)
    try { await data.cancelScan(s.id) } catch { /* reported */ }
  }

  function dismiss(s) {
    data.dismissScan(s.id)
    shell.toast('Scan dismissed. Send it again from Nook Scan.', { kind: 'info', id: `dismiss-${s.id}` })
  }

  // The failed-scan sheet (D3), or a scan's actions; the workspace's failed chip calls this.
  function openScan(jobId) {
    const s = data.getJob(jobId)
    if (!s) { open(); return }
    if (s.status === 'done') { R.switchTo(s.name); return }
    if (s.status !== 'failed') {
      if (shell.isPhone()) scanActions(s)
      else open()
      return
    }
    const info = { date: friendlyDate(scanDate(s.name) || s.created), stage: stageWord(s), message: s.message, advice: adviceFor(s) }
    const copy = async () => {
      const text = `${s.title} (${s.name}): ${s.message || 'failed'}`
      try { await navigator.clipboard.writeText(text); shell.toast('Error copied.', { kind: 'ok', ms: 2000 }) } catch { shell.toast('Couldn\'t copy. Select the text instead.', { kind: 'info' }) }
    }
    if (shell.isPhone()) {
      failedSheet(ov, { ...info, onCopy: copy, onDismiss: () => dismiss(s) })
      return
    }
    shell.confirm({
      title: `Scan failed · ${info.date}`, icon: 'warning', danger: true, body: failedBody(info),
      actions: [{ label: 'Copy error', value: 'copy', kind: 'quiet' }, { label: 'Close', value: null, kind: 'secondary', cancel: true },
        { label: 'Dismiss', value: 'dismiss', kind: 'primary', default: true }],
    }).then((v) => { if (v === 'copy') copy(); if (v === 'dismiss') dismiss(s) })
  }

  // --- the page --------------------------------------------------------------------------------------------
  let againTimer = null
  page = shell.registerPage({
    id: 'rooms', label: 'Rooms', width: 880,
    mount: (body) => body.append(root),
    onOpen: () => {
      render()
      data.refresh().catch(() => {})
      if (!shell.isPhone()) requestAnimationFrame(() => focusRow(root))
      clearInterval(againTimer)
      againTimer = setInterval(() => R.tickAgain?.(), 1000)
    },
    onClose: () => { ov.close(); clearInterval(againTimer); editing = null },
  })

  // Desktop keys inside the list: ↑ ↓ move, Enter opens, F2 renames, Del moves to trash.
  root.addEventListener('keydown', (e) => {
    if (shell.isPhone() || e.target.closest('input')) return
    const row = e.target.closest('.rm-row')
    const rows = [...root.querySelectorAll('.rm-row[tabindex="0"]')]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = rows.indexOf(row)
      const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      next?.focus()
      next?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (!row || e.target !== row) return
    const key = row.dataset.key || ''
    const room = key.startsWith('room:') ? data.getRoom(key.slice(5)) : null
    const scan = key.startsWith('scan:') ? data.getJob(key.slice(5)) : null
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row._open?.() }
    else if (e.key === 'F2' && room && !offline()) { e.preventDefault(); rename(room) }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !offline()) {
      e.preventDefault()
      if (room) trash(room)
      else if (scan && isBusy(scan)) cancelScan(scan)
      else if (scan) dismiss(scan)
    }
  })

  const flows = createFlows(R)
  Object.assign(R, { switchTo: flows.switchTo, roomActions, scanActions, openScan, open })
  function open() { shell.openPage('rooms') }

  for (const ev of ['rooms', 'scans', 'offline']) data.events.addEventListener(ev, render)
  engine.events.addEventListener('room', (e) => { if (['loaded', 'saved', 'title', 'missing', 'failed'].includes(e.detail?.phase)) render() })
  engine.events.addEventListener('dirty', render)
  shell.events.addEventListener('mode', () => { ov.close(); render() })

  ctx.rooms = {
    open,
    close: () => shell.closePage(),
    openScan,
    openRoom: (name) => flows.switchTo(name),
    isArmed: flows.isArmed,
    arm: flows.arm,
  }
}
