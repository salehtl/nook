// nook planner shell: phone vs desktop chrome, panels (desktop side panel / phone bottom sheets), pages (Rooms),
// toasts, confirm dialogs, "…" menus and tooltips. Area modules (workspace, panels, rooms) build on it; see main.js.
//
// createShell({ engine }) → shell
//   mode, isPhone()                 'phone' (≤ 760 px wide or a coarse pointer) | 'desktop'; switches live on resize
//   mounts                          { view, overlays, topbar, rail, modebar, dock, panel, sheet, pages, toasts, layer }
//   events                          'mode' { mode }, 'panel' { id, open, detent }, 'page' { id, open }, 'layout' metrics
//   metrics()                       { mode, width, height, usable, safe: {top,bottom,left,right}, sheetH, chromeBottom, chromeLeft }
// Panels (desktop: rail of section icons + 264 px body; phone: dock → bottom sheet)
//   registerPanel({ id, label, short?, icon, phoneDetent = 'half', order?, mount(body, api), onOpen(info), onClose() }) → api
//     api = { id, body, head, actions, setTitle(text), setCount(text), setStatus(node|text|null), open(opts), close(), isOpen(), detent() }
//     `short` is the dock/rail label ("In room"); `label` is the panel title ("In the room").
//   openPanel(id, { detent }), closePanel(), togglePanel(id), getOpenPanel() → { id, detent } | null
//   setDetent('peek'|'half'|'full')  phone only
// Pages (phone: full-height sheet; desktop: overlay under the bar, `width` px wide)
//   registerPage({ id, label, width = 880, mount(body, api), onOpen(info), onClose() }) → api (same shape as a panel's)
//   openPage(id), closePage(), getOpenPage() → id | null
// Feedback
//   toast(text, { kind: 'info'|'ok'|'error', icon, action: { label, onClick }, ms, id }) → { el, close(), update(text) }
//     info/ok leave after 4 s (8 s with an action); errors stay until closed. Same id or text replaces the old one.
//   confirm({ title, body, icon, danger, confirm: 'OK', cancel: 'Cancel' }) → Promise<boolean>
//   confirm({ title, body, icon, actions: [{ label, value, kind: 'primary'|'secondary'|'danger'|'quiet', default, cancel }] }) → Promise<value>
//     desktop: dialog (Enter = default action, Esc = cancel); phone: action sheet (cancel is the separate bottom button)
//   menu(anchorEl, [{ label, icon, kbd, danger, disabled, onSelect } | '-'], { align: 'end'|'start' }) → { close() }
//   Tooltips: any element with data-tip="Measure" (and data-kbd="M") shows the kit tooltip on desktop hover.
// Keys: shell.addKeyFilter(fn) — fn(keydown) → true swallows it before engine input sees it. While a dialog, menu or
// page is open, every key is swallowed (they handle their own).
import { icon, ring, unsavedGlyph } from './icons.js'
import { h, kbd } from './kit.js'

const DETENTS = ['peek', 'half', 'full']
const PEEK = 176, HALF = 422, FULL = 696 // the Paper detents at 390 × 844 (usable height 696)

export function createShell({ engine }) {
  const root = document.documentElement
  const $ = (id) => document.getElementById(id)
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  const mounts = {
    view: $('view'), overlays: $('overlays'), topbar: $('topbar'), rail: $('rail'), modebar: $('modebar'), dock: $('dock'),
    panel: $('panel'), sheet: $('sheet'), pages: $('pages'), toasts: $('toasts'), layer: $('layer'),
  }
  const store = {
    get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  }

  // --- mode + metrics -------------------------------------------------------------------------------------
  const coarse = matchMedia('(pointer: coarse)')
  let mode = null
  const probe = h('div', { style: { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', top: '0', left: '0',
    paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' } })
  document.body.append(probe)
  function safe() {
    const s = getComputedStyle(probe)
    return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0, right: parseFloat(s.paddingRight) || 0 }
  }
  const m = { width: 0, height: 0, usable: 0, safe: { top: 0, bottom: 0, left: 0, right: 0 }, sheetH: 0, chromeBottom: 0, chromeLeft: 0 }
  function measure() {
    m.width = window.innerWidth
    m.height = window.innerHeight // the layout viewport: the page's own bottom is above Safari's bar
    m.safe = safe()
    m.usable = Math.max(240, m.height - m.safe.top - m.safe.bottom)
    root.style.setProperty('--vh', `${m.height}px`)
  }
  const detentPx = (d) => {
    const half = Math.round(m.usable * HALF / FULL)
    if (d === 'full') return m.usable
    if (d === 'half') return Math.min(half, m.usable)
    return Math.min(PEEK, half)
  }

  function computeMode() { return window.innerWidth <= 760 || coarse.matches ? 'phone' : 'desktop' }
  function applyMode() {
    const next = computeMode()
    if (next === mode) return false
    const prev = mode
    mode = next
    root.dataset.mode = mode
    if (prev) rehost(prev)
    emit('mode', { mode })
    return true
  }

  // --- panels -------------------------------------------------------------------------------------------------
  const panels = new Map()
  let openId = null          // phone: the sheet's panel; desktop: the side panel's section (shown unless collapsed)
  let detent = null          // phone sheet detent while open
  let collapsed = store.get('nook.panel.collapsed') === '1'
  const sorted = () => [...panels.values()].sort((a, b) => a.order - b.order)

  function makeHead(spec) {
    const title = h('h2.panel-title', spec.label)
    const count = h('span.panel-count')
    const status = h('span.panel-status')
    const actions = h('div.panel-actions')
    const head = h('div.panel-head', h('div.panel-title-wrap', title, count, status), actions)
    const body = h('div.panel-body', { dataset: { panel: spec.id } })
    const api = {
      id: spec.id, body, head, actions,
      setTitle: (t) => { title.textContent = t ?? '' },
      setCount: (t) => { count.textContent = t == null ? '' : String(t) },
      setStatus: (n) => { status.replaceChildren(...(n == null || n === '' ? [] : [n instanceof Node ? n : String(n)])) },
    }
    return api
  }

  function registerPanel(spec) {
    if (!spec?.id || panels.has(spec.id)) throw new Error(`registerPanel: missing or duplicate id "${spec?.id}"`)
    const api = makeHead(spec)
    const p = { ...spec, order: spec.order ?? panels.size * 10, phoneDetent: spec.phoneDetent || 'half', api }
    Object.assign(api, {
      open: (o) => openPanel(spec.id, o), close: () => { if (openId === spec.id) closePanel() },
      isOpen: () => isPanelOpen(spec.id), detent: () => (isPanelOpen(spec.id) && mode === 'phone' ? detent : null),
    })
    panels.set(spec.id, p)
    try { spec.mount?.(api.body, api) } catch (e) { engine?.reportError(`Could not set up the ${spec.label || spec.id} panel`, e) }
    buildDock()
    buildRail()
    if (mode === 'desktop' && !openId && !collapsed) openPanel(sorted()[0].id)
    return api
  }

  const isPanelOpen = (id) => openId === id && (mode === 'phone' ? !!detent : !collapsed)
  function getOpenPanel() { return openId && isPanelOpen(openId) ? { id: openId, detent: mode === 'phone' ? detent : null } : null }

  function openPanel(id, { detent: d } = {}) {
    const p = panels.get(id)
    if (!p) return
    const was = getOpenPanel()
    if (was && was.id !== id) panels.get(was.id)?.onClose?.()
    openId = id
    if (mode === 'phone') {
      showInSheet(p)
      setDetent(DETENTS.includes(d) ? d : was?.id === id && detent ? detent : p.phoneDetent, { silent: true })
    } else {
      collapsed = false
      store.set('nook.panel.collapsed', '0')
      showInSide(p)
    }
    if (!was || was.id !== id) p.onOpen?.({ mode, detent: mode === 'phone' ? detent : null })
    syncChrome()
    emit('panel', { id, open: true, detent: mode === 'phone' ? detent : null })
  }

  function closePanel() {
    const was = getOpenPanel()
    if (!was) return
    const p = panels.get(was.id)
    if (mode === 'phone') { detent = null; sheet.classList.remove('is-open'); sheet.style.height = '0px' } else { collapsed = true; store.set('nook.panel.collapsed', '1') }
    p?.onClose?.()
    syncChrome()
    emit('panel', { id: was.id, open: false, detent: null })
  }
  const togglePanel = (id) => (isPanelOpen(id) ? closePanel() : openPanel(id))

  // Desktop side panel: rail + body
  const sideRail = h('nav.side-rail', { 'aria-label': 'Panels' })
  const sideHead = h('header.side-head')
  const sideContent = h('div.side-content.scroll')
  mounts.panel.classList.add('side')
  mounts.panel.append(sideRail, h('div.side-body', sideHead, sideContent))
  function buildRail() {
    const tabs = sorted().map((p) => h('button.side-tab', {
      type: 'button', dataset: { id: p.id, tip: p.label }, 'aria-current': String(openId === p.id && !collapsed),
      onclick: () => (openId === p.id && !collapsed ? closePanel() : openPanel(p.id)),
    }, icon(p.icon, { size: 20 }), h('span', p.short || p.label)))
    const collapse = h('button.side-collapse', { type: 'button', 'aria-label': collapsed ? 'Show panel' : 'Collapse panel', dataset: { tip: collapsed ? 'Show panel' : 'Collapse panel' },
      onclick: () => (collapsed ? openPanel(openId || sorted()[0]?.id) : closePanel()) }, icon('panel', { size: 20 }))
    sideRail.replaceChildren(...tabs, h('div.side-spacer'), collapse)
  }
  function showInSide(p) {
    sideHead.replaceChildren(p.api.head)
    sideContent.replaceChildren(p.api.body)
  }

  // Phone dock: the first four panels, the rest under More
  function buildDock() {
    const list = sorted()
    const main = list.length <= 4 ? list : list.slice(0, 4)
    const rest = list.slice(main.length)
    const item = (label, ic, current, onclick) => h('button.dock-item', { type: 'button', 'aria-current': String(current), onclick }, icon(ic, { size: 20 }), h('span', label))
    const items = main.map((p) => item(p.short || p.label, p.icon, openId === p.id && !!detent, () => togglePanel(p.id)))
    if (rest.length) {
      const more = item('More', 'more', rest.some((p) => openId === p.id && !!detent), (e) => {
        if (rest.length === 1) return togglePanel(rest[0].id)
        menu(e.currentTarget, rest.map((p) => ({ label: p.label, icon: p.icon, onSelect: () => openPanel(p.id) })), { align: 'end', above: true })
      })
      items.push(more)
    }
    mounts.dock.replaceChildren(...items)
  }

  // Phone bottom sheet
  const sheet = mounts.sheet
  sheet.classList.add('sheet')
  sheet.setAttribute('role', 'dialog')
  const grab = h('div.sheet-grab', { 'aria-hidden': 'true' })
  const sheetHead = h('header.sheet-head')
  const sheetClose = h('button.sheet-close', { type: 'button', 'aria-label': 'Close', onclick: () => closePanel() }, h('span', icon('close', { size: 16, stroke: 2 })))
  const sheetBody = h('div.sheet-body')
  sheet.append(grab, sheetHead, sheetBody)
  const scrim = h('div', { id: 'sheet-scrim', onclick: () => setDetent('half') })
  sheet.before(scrim)
  function showInSheet(p) {
    sheetHead.replaceChildren(p.api.head, sheetClose)
    sheetBody.replaceChildren(p.api.body)
    sheet.setAttribute('aria-label', p.label)
    sheet.classList.add('is-open')
  }
  function setDetent(d, { silent = false } = {}) {
    if (mode !== 'phone' || !openId || !DETENTS.includes(d)) return
    detent = d
    sheet.style.height = `${detentPx(d) + m.safe.bottom}px`
    syncChrome()
    if (!silent) emit('panel', { id: openId, open: true, detent })
  }
  // Drag the grabber or the header: follow the finger, then settle on the nearest detent (a fling counts), or close.
  let drag = null
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea, a, [data-nodrag]')) return
    drag = { id: e.pointerId, y0: e.clientY, h0: sheet.getBoundingClientRect().height - m.safe.bottom, t: performance.now(), y: e.clientY, v: 0, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const now = performance.now()
    drag.v = (e.clientY - drag.y) / Math.max(1, now - drag.t)
    drag.t = now
    drag.y = e.clientY
    if (!drag.moved && Math.abs(e.clientY - drag.y0) < 6) return
    drag.moved = true
    sheet.classList.add('is-dragging')
    const hgt = Math.max(0, Math.min(m.usable, drag.h0 - (e.clientY - drag.y0)))
    sheet.style.height = `${hgt + m.safe.bottom}px`
    root.style.setProperty('--sheet-h', `${hgt + m.safe.bottom}px`)
  }
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const d = drag
    drag = null
    sheet.classList.remove('is-dragging')
    if (!d.moved) { setDetent(detent === 'peek' ? 'half' : detent === 'half' ? 'full' : 'half'); return } // tap: grow
    const hgt = d.h0 - (d.y - d.y0)
    const projected = hgt - Math.max(-2, Math.min(2, d.v)) * 180 // a fling carries up to about 360 px
    if (projected < detentPx('peek') * 0.55) { closePanel(); return }
    const best = DETENTS.reduce((a, b) => (Math.abs(detentPx(b) - projected) < Math.abs(detentPx(a) - projected) ? b : a))
    setDetent(best)
  }
  for (const el of [grab, sheetHead]) {
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  function rehost(prev) {
    const p = openId && panels.get(openId)
    if (prev === 'phone' && mode === 'desktop') {
      const wasOpen = !!detent
      detent = null
      sheet.classList.remove('is-open')
      sheet.style.height = '0px'
      if (p && (wasOpen || !collapsed)) { collapsed = false; showInSide(p) } else if (!p && !collapsed && panels.size) { openId = sorted()[0].id; showInSide(panels.get(openId)) }
    } else if (prev === 'desktop' && mode === 'phone') {
      detent = null // the sheet starts closed on the phone; the dock opens it
      sheet.classList.remove('is-open')
    }
    buildDock()
    buildRail()
    if (pageOpen) mountPage(pages.get(pageOpen))
  }

  // Chrome sizes → CSS vars, the engine's view inset, and the attributes the CSS keys off.
  function syncChrome() {
    root.dataset.sheet = mode === 'phone' && detent ? detent : ''
    root.dataset.panel = mode === 'desktop' ? (collapsed ? 'collapsed' : 'open') : ''
    if (mode === 'phone') {
      m.sheetH = detent ? detentPx(detent) + m.safe.bottom : 0
      m.chromeBottom = detent ? m.sheetH : m.safe.bottom + 8 + 64
      m.chromeLeft = 0
      engine?.setViewInset(0, detent && detent !== 'full' ? m.sheetH : 0, 0)
    } else {
      m.sheetH = 0
      m.chromeBottom = 0
      m.chromeLeft = panels.size ? (collapsed ? 56 : 320) : 0
      engine?.setViewInset(m.chromeLeft, 0, 52)
    }
    root.style.setProperty('--sheet-h', `${m.sheetH}px`)
    root.style.setProperty('--chrome-bottom', `${m.chromeBottom}px`)
    root.style.setProperty('--chrome-left', `${m.chromeLeft}px`)
    root.style.setProperty('--chrome-top', mode === 'desktop' ? '52px' : `${m.safe.top}px`)
    buildDock()
    buildRail()
    emit('layout', metrics())
  }
  const metrics = () => ({ mode, ...m, safe: { ...m.safe } })

  // --- pages (Rooms) -------------------------------------------------------------------------------------
  const pages = new Map()
  let pageOpen = null
  let pageEls = []
  function registerPage(spec) {
    if (!spec?.id || pages.has(spec.id)) throw new Error(`registerPage: missing or duplicate id "${spec?.id}"`)
    const api = makeHead(spec)
    api.open = () => openPage(spec.id)
    api.close = () => { if (pageOpen === spec.id) closePage() }
    api.isOpen = () => pageOpen === spec.id
    const p = { ...spec, width: spec.width || 880, api }
    pages.set(spec.id, p)
    try { spec.mount?.(api.body, api) } catch (e) { engine?.reportError(`Could not set up ${spec.label || spec.id}`, e) }
    return api
  }
  function mountPage(p) {
    for (const el of pageEls) el.remove()
    const close = h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Close', onclick: () => closePage() }, icon('close', { size: mode === 'phone' ? 18 : 16 }))
    const head = h('header.page-head', p.api.head, mode === 'desktop' ? kbd('Esc') : null, close)
    const body = h('div.page-body')
    body.append(p.api.body)
    const el = h('section.page', { role: 'dialog', 'aria-label': p.label || p.id, style: { '--page-w': `${p.width}px` } },
      mode === 'phone' ? h('div.sheet-grab', { 'aria-hidden': 'true' }) : null, head, body)
    pageEls = mode === 'phone' ? [h('div.page-scrim', { onclick: () => closePage() }), el] : [el]
    mounts.pages.append(...pageEls)
    if (mode === 'phone') {
      el.classList.add('is-entering')
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')))
      // swipe the grabber or header down to close
      let y0 = null
      const grabEl = el.querySelector('.sheet-grab')
      for (const t of [grabEl, head]) {
        t.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, input, a')) { y0 = e.clientY; t.setPointerCapture(e.pointerId) } })
        t.addEventListener('pointermove', (e) => { if (y0 != null) el.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)` })
        t.addEventListener('pointerup', (e) => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; el.style.transform = ''; if (dy > 120) closePage() })
        t.addEventListener('pointercancel', () => { y0 = null; el.style.transform = '' })
      }
    }
  }
  function openPage(id) {
    const p = pages.get(id)
    if (!p) return
    if (pageOpen && pageOpen !== id) closePage()
    if (pageOpen === id) return
    pageOpen = id
    mountPage(p)
    p.onOpen?.({ mode })
    emit('page', { id, open: true })
  }
  function closePage() {
    if (!pageOpen) return
    const p = pages.get(pageOpen)
    pageOpen = null
    for (const el of pageEls) el.remove()
    pageEls = []
    p?.onClose?.()
    emit('page', { id: p?.id, open: false })
  }
  // Desktop: a click into the room closes the overlay.
  mounts.view.addEventListener('pointerdown', () => { if (pageOpen && mode === 'desktop') closePage() })

  // --- toasts --------------------------------------------------------------------------------------------
  const toasts = []
  function toast(text, { kind = 'info', icon: ic, action, ms, id } = {}) {
    const key = id || `${kind}:${text}`
    const old = toasts.find((t) => t.key === key)
    if (old) old.close(true)
    const textEl = h('span.toast-text', text)
    const el = h(`div.toast.toast-${kind}`, { role: kind === 'error' ? 'alert' : 'status' },
      icon(ic || (kind === 'ok' ? 'check' : kind === 'error' ? 'warning' : 'info'), { size: 20 }), textEl)
    const t = { key, el, timer: null }
    t.close = (instant) => {
      clearTimeout(t.timer)
      const i = toasts.indexOf(t)
      if (i >= 0) toasts.splice(i, 1)
      if (instant) { el.remove(); return }
      el.classList.add('is-leaving')
      setTimeout(() => el.remove(), 200)
    }
    t.update = (next) => { textEl.textContent = next }
    if (action) el.append(h('button.toast-action', { type: 'button', onclick: () => { t.close(); action.onClick?.() } }, action.label))
    el.append(h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => t.close() }, icon('close', { size: 16 })))
    const life = ms ?? (kind === 'error' ? 0 : action ? 8000 : 4000)
    if (life > 0) t.timer = setTimeout(() => t.close(), life)
    toasts.push(t)
    mounts.toasts.append(el)
    while (toasts.length > 3) toasts[0].close(true)
    return { el, close: () => t.close(), update: t.update }
  }

  // --- layer: dialogs, action sheets, menus, tooltips ------------------------------------------------------
  const modals = [] // { el, cancel() } innermost last
  function pushModal(els, cancel) {
    const entry = { els, cancel }
    modals.push(entry)
    mounts.layer.append(...els)
    return () => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); for (const e of els) e.remove() }
  }

  function confirm(opts = {}) {
    const { title = '', body = '', icon: ic, danger = false } = opts
    const actions = opts.actions || [
      { label: opts.cancel || 'Cancel', value: false, kind: 'secondary', cancel: true },
      { label: opts.confirm || 'OK', value: true, kind: danger ? 'danger' : 'primary', default: true },
    ]
    const cancelAction = actions.find((a) => a.cancel) || null
    const cancelValue = cancelAction ? cancelAction.value : null
    return new Promise((resolve) => {
      let done = null
      const finish = (v) => { done?.(); resolve(v) }
      const mkBtn = (a) => h(`button.btn.btn-${a.kind || 'secondary'}`, { type: 'button', onclick: () => finish(a.value) }, a.label)
      if (mode === 'desktop') {
        const btns = actions.map(mkBtn)
        const dlg = h('div.dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div.dialog-main',
            ic ? h(`div.dialog-icon${danger ? '.is-danger' : ''}`, icon(ic, { size: 20 })) : null,
            h('div.dialog-text', h('h2.dialog-title', title), body ? h('p.dialog-body', body) : null)),
          h('div.dialog-actions', btns))
        const sc = h('div.scrim', { onclick: () => finish(cancelValue) })
        done = pushModal([sc, dlg], () => finish(cancelValue))
        const def = actions.findIndex((a) => a.default)
        ;(btns[def] || btns.at(-1)).focus()
        modals.at(-1).enter = def >= 0 ? () => finish(actions[def].value) : null
      } else {
        const main = actions.filter((a) => a !== cancelAction).map((a) => { const b = mkBtn(a); b.classList.add('btn-block'); return b })
        const sheetEl = h('div.actionsheet', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div.actionsheet-card',
            h('div.actionsheet-text', h('h2.actionsheet-title', title), body ? h('p.actionsheet-body', body) : null),
            main.length ? h('div.actionsheet-buttons', main) : null),
          cancelAction ? h('button.actionsheet-cancel', { type: 'button', onclick: () => finish(cancelValue) }, cancelAction.label) : null)
        const sc = h('div.scrim', { onclick: () => finish(cancelValue) })
        done = pushModal([sc, sheetEl], () => finish(cancelValue))
      }
    })
  }

  function menu(anchor, items, { align = 'end', above = false } = {}) {
    const close = () => { done?.(); anchor?.setAttribute?.('aria-expanded', 'false') }
    const buttons = []
    const el = h('div.menu', { role: 'menu' }, items.map((it) => {
      if (it === '-' || it?.separator) return h('div.menu-sep', { role: 'separator' })
      const b = h(`button.menu-item${it.danger ? '.is-danger' : ''}`, { type: 'button', role: 'menuitem', disabled: !!it.disabled,
        onclick: () => { close(); it.onSelect?.() } }, it.icon ? icon(it.icon, { size: mode === 'phone' ? 20 : 15 }) : null, h('span.label', it.label), it.kbd ? kbd(it.kbd) : null)
      buttons.push(b)
      return b
    }))
    const catcher = h('div', { style: { position: 'fixed', inset: '0' }, onpointerdown: (e) => { e.preventDefault(); close() } })
    let done = pushModal([catcher, el], close)
    anchor?.setAttribute?.('aria-expanded', 'true')
    // place it under (or above) the anchor, inside the window
    const r = anchor?.getBoundingClientRect?.() || { left: m.width / 2, right: m.width / 2, top: m.height / 2, bottom: m.height / 2 }
    const mr = el.getBoundingClientRect()
    let x = align === 'end' ? r.right - mr.width : r.left
    x = Math.max(8, Math.min(m.width - mr.width - 8, x))
    let y = above || r.bottom + 4 + mr.height > m.height - 8 ? r.top - 4 - mr.height : r.bottom + 4
    y = Math.max(8, y)
    Object.assign(el.style, { left: `${x}px`, top: `${y}px` })
    el.addEventListener('keydown', (e) => {
      const live = buttons.filter((b) => !b.disabled)
      const i = live.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); live[(i + 1) % live.length]?.focus() }
      if (e.key === 'ArrowUp') { e.preventDefault(); live[(i - 1 + live.length) % live.length]?.focus() }
    })
    if (mode === 'desktop') buttons.find((b) => !b.disabled)?.focus()
    return { close }
  }

  // Tooltips (desktop hover): data-tip + optional data-kbd
  let tipEl = null, tipTimer = null
  const hideTip = () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null }
  document.addEventListener('pointerover', (e) => {
    if (mode !== 'desktop' || e.pointerType !== 'mouse') return
    const t = e.target.closest?.('[data-tip]')
    hideTip()
    if (!t) return
    tipTimer = setTimeout(() => {
      if (!t.isConnected) return
      tipEl = h('div.tooltip', { role: 'tooltip' }, h('span', t.dataset.tip), t.dataset.kbd ? kbd(t.dataset.kbd) : null)
      mounts.layer.append(tipEl)
      const r = t.getBoundingClientRect(), tr = tipEl.getBoundingClientRect()
      const below = r.bottom + 6 + tr.height < m.height
      Object.assign(tipEl.style, {
        left: `${Math.max(6, Math.min(m.width - tr.width - 6, r.left + r.width / 2 - tr.width / 2))}px`,
        top: `${below ? r.bottom + 6 : r.top - 6 - tr.height}px`,
      })
      // side rail tabs: to the right instead
      if (t.closest('.side-rail')) Object.assign(tipEl.style, { left: `${r.right + 6}px`, top: `${r.top + r.height / 2 - tr.height / 2}px` })
    }, 450)
  })
  document.addEventListener('pointerdown', hideTip, true)

  // --- keys: Esc closes the innermost layer; modals swallow keys before the engine's input sees them -------------
  const keyFilters = []
  const addKeyFilter = (fn) => { keyFilters.push(fn); return () => keyFilters.splice(keyFilters.indexOf(fn), 1) }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (modals.length) { e.preventDefault(); modals.at(-1).cancel(); return }
    if (pageOpen && !e.target.closest?.('input, textarea')) { e.preventDefault(); closePage() }
  }, true)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && modals.at(-1)?.enter && !e.target.closest?.('button, input, textarea')) { e.preventDefault(); modals.at(-1).enter() }
  }, true)
  engine?.input?.setKeyFilter((e) => modals.length > 0 || pageOpen != null || keyFilters.some((f) => f(e)))

  // --- touch: no page zoom (iOS ignores user-scalable=no) ----------------------------------------------
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
  document.addEventListener('dblclick', (e) => { if (mode === 'phone') e.preventDefault() }, { passive: false })

  // --- live resize --------------------------------------------------------------------------------------
  const onResize = () => {
    measure()
    applyMode()
    if (mode === 'phone' && detent && !drag) sheet.style.height = `${detentPx(detent) + m.safe.bottom}px`
    syncChrome()
  }
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
  coarse.addEventListener?.('change', onResize)
  measure()
  applyMode()
  syncChrome()

  return {
    get mode() { return mode },
    isPhone: () => mode === 'phone',
    mounts,
    events,
    metrics,
    registerPanel,
    openPanel,
    closePanel,
    togglePanel,
    getOpenPanel,
    setDetent,
    registerPage,
    openPage,
    closePage,
    getOpenPage: () => pageOpen,
    toast,
    confirm,
    menu,
    addKeyFilter,
    glyphs: { ring, unsavedGlyph },
  }
}
