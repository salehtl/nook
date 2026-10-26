// Workspace (area B): the chrome around the 3D view. Frames "00 · Nav", "00 · Selection", "00 · Walk" and B1–B8 on the
// Paper page "v2 · Design". Styles: styles/workspace.css.
//   top bar      phone: room switcher pill + scan/render chips under it; desktop: switcher + chips left, views, Measure,
//                Frame, Render right. The switcher opens Rooms (shell page 'rooms').
//   rail         phone only: view picker, Measure, Frame, Render (pinned)
//   bars         selection bar (−15°, +15°, More, Remove, Done), mode bars for measure / pick floor / check size,
//                walk bar (Seated/Standing: viewpoint stepper, WASD keycaps on desktop, Back to orbit). On the phone the
//                selection and mode bars take the dock's place; the walk bar sits above it.
//   overlay      selection footprint, label and rotate grip; measure and check-size points (drag them; on touch the
//                point floats 40 px above the finger inside a loupe); the pick-floor marker
//   cards        loading a room (B7: progress, Cancel → Rooms), can't load (Try again, Back to rooms), the one-time
//                gesture hint (phone, D5.2)
// ctx.workspace (for the other areas): { requestRender(), openScan(scan), startPickFloor(), startCheckSize(), startMeasure() }
// Events it sends on shell.events (cancelable; call preventDefault() to take over, else the fallback runs):
//   'render-request' {}          Render pressed      → fallback: a confirm dialog, then engine.renderViewInternal()
//   'open-render'    { meta }    "Render ready · View" → fallback: open the Renders panel
//   'open-scan'      { scan }    a scan chip tapped  → fallback: open Rooms
import { ring, unsavedGlyph, icon } from './icons.js'
import { dimsText, quiet, fmtUsd, renderPrice, RENDER_MODELS } from '../engine.js'
import { roomTitle, friendlyDate, scanDate, fmtBytes, fmtEta } from '../data.js'

const NS = 'http://www.w3.org/2000/svg'
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false))
const fromHtml = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild }
const glyph = (body, size = 20, vb = 20, sw = 1.5) => fromHtml(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`)
const G = {
  rotL: '<path d="M5 8.2A6 6 0 1 1 4.5 12"/><path d="M4.2 4.5v4h4"/>',
  rotR: '<path d="M15 8.2A6 6 0 1 0 15.5 12"/><path d="M15.8 4.5v4h-4"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5"/>',
  back: '<path d="M12.5 4.5L7 10l5.5 5.5"/>',
  prev: '<path d="M12 5l-5 5 5 5"/>',
  next: '<path d="M8 5l5 5-5 5"/>',
  floor: '<path d="M2.5 14.5l4-3h11l-4 3z"/><path d="M10 3v8.5M7.75 5.25L10 3l2.25 2.25"/>',
  size: '<circle cx="4" cy="10" r="2"/><circle cx="16" cy="10" r="2"/><path d="M6 10h8"/>',
  grip: '<path d="M12.6 6.2A5 5 0 1 0 13 9.5"/><path d="M13.2 3v3.4H9.8"/>',
}
const HINT_KEY = 'nook.hint.gestures'
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const VIEW_LABEL = { orbit: 'Orbit', seated: 'Seated', standing: 'Standing' }
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const nbsp = (n) => Math.round(n).toLocaleString('en-US').replace(/,/g, '\u202F')
const cm = (m) => Math.round(m * 100)

export function mount(ctx) {
  const { engine, data, shell, kit } = ctx
  const { h, kbd } = kit
  const root = document.documentElement
  const phone = () => shell.isPhone()
  const on = (t, type, fn) => t.addEventListener(type, fn)
  const ask = (name, detail) => !shell.events.dispatchEvent(new CustomEvent(name, { detail, cancelable: true })) // true: someone took it

  // --- state that isn't the engine's -------------------------------------------------------------------------
  let rendering = null      // { t0 } while a render runs
  let lastRemoved = null    // { snap, toast } for Undo / ⌘Z
  let returnPanel = null    // the phone sheet a mode closed, reopened when the mode ends
  let handleDrag = null     // { kind: 'measure'|'two', i, touch, x, y }
  let loadStat = { t0: 0, b0: 0, loaded: 0, total: 0, rate: 0 }
  let lookHintUntil = 0

  // --- top bar: switcher + chips (both modes), tools (desktop) ------------------------------------------------
  const switcher = h('button.ws-switcher', { type: 'button', 'aria-label': 'Rooms', dataset: { tip: 'All rooms' }, onclick: () => shell.openPage('rooms') })
  const chips = h('div.ws-chips')
  const banner = h('div.ws-banner', { hidden: true })
  const left = h('div.ws-top-left', switcher, chips)
  const views = kit.segmented(['orbit', 'seated', 'standing'].map((v, i) => ({ value: v, label: VIEW_LABEL[v], icon: v, kbd: String(i + 1), tip: VIEW_LABEL[v] })),
    engine.getView(), (v) => engine.setViewInternal(v), { label: 'View' })
  views.classList.add('ws-views')
  const toolBtn = (ic, label, key, onclick, cls = '') => h(`button.ws-tool${cls}`, { type: 'button', onclick, dataset: { tip: label, kbd: key } }, icon(ic, { size: 16, stroke: 1.875 }), h('span', label))
  const measureBtn = toolBtn('measure', 'Measure', 'M', () => toggleMeasure())
  const frameBtn = toolBtn('frame', 'Frame', 'F', () => frame())
  const renderBtn = toolBtn('render', 'Render', null, () => requestRender(), '.is-strong')
  renderBtn.dataset.tip = 'Render this view (paid)'
  const right = h('div.ws-top-right', views, h('span.ws-divider'), measureBtn, frameBtn, renderBtn)
  shell.mounts.topbar.append(left, right, banner)

  // --- phone rail ------------------------------------------------------------------------------------------------
  const railView = h('button.ws-rail-btn.is-view', { type: 'button', 'aria-label': 'View', onclick: (e) => viewMenu(e.currentTarget) })
  const railMeasure = h('button.ws-rail-btn', { type: 'button', 'aria-label': 'Measure', onclick: () => toggleMeasure() }, icon('measure'))
  const railFrame = h('button.ws-rail-btn', { type: 'button', 'aria-label': 'Frame the room', onclick: () => frame() }, icon('frame'))
  const railRender = h('button.ws-rail-btn', { type: 'button', 'aria-label': 'Render this view', onclick: () => requestRender() }, icon('render'))
  const rail = h('div.ws-rail', railView, h('span.ws-rail-div'), railMeasure, railFrame, railRender)
  shell.mounts.rail.append(rail)

  function viewMenu(anchor) {
    const cur = engine.getView()
    shell.menu(anchor, ['orbit', 'seated', 'standing'].map((v, i) => ({
      label: v === 'orbit' ? 'Orbit' : `${VIEW_LABEL[v]} · ${v === 'seated' ? 115 : 160} cm`, icon: v === cur ? 'check' : v, kbd: String(i + 1),
      onSelect: () => engine.setViewInternal(v),
    })), { align: 'end', above: true })
  }
  function frame() {
    if (engine.getView() !== 'orbit') engine.setViewInternal('orbit')
    engine.frameRoom()
  }
  function toggleMeasure() {
    const active = !engine.getMeasureState().active
    if (!active) engine.clearMeasure()
    engine.setMeasureActive(active)
  }

  // --- bottom: bars (in #modebar) and cards ------------------------------------------------------------------
  const selBar = h('div.ws-selbar', { hidden: true })
  const modeBar = h('div.ws-modebar', { hidden: true })
  const sizeCard = h('div.ws-sizecard', { hidden: true })
  const walkBar = h('div.ws-walkbar', { hidden: true })
  const loadCard = h('div.ws-loadcard', { hidden: true, role: 'status' })
  const hint = h('div.ws-hint', { hidden: true })
  shell.mounts.modebar.append(selBar, walkBar, modeBar, sizeCard, loadCard, hint)

  // --- overlay: footprint, label, grip, points, loupe ---------------------------------------------------------
  const svg = document.createElementNS(NS, 'svg')
  svg.classList.add('ws-svg')
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e }
  const fpPoly = mk('polygon', { class: 'ws-fp' })
  const fpStem = mk('line', { class: 'ws-fp-stem' })
  const mLineShadow = mk('line', { class: 'ws-mline-shadow' })
  const mLine = mk('line', { class: 'ws-mline' })
  const floorMark = mk('g', { class: 'ws-floormark' })
  floorMark.innerHTML = '<ellipse rx="96" ry="24" class="a"/><ellipse rx="48" ry="12" class="b"/><path d="M-26 0h52M0 -7v14" class="c"/><circle r="22" class="d"/><circle r="8" class="e"/>'
  // Check room (B4): chalk dimension lines on the room's box, width along the far floor edge, height up its corner
  const dimLines = [0, 1].map(() => { const g = mk('g', { class: 'ws-dim' }); g.append(mk('line', { class: 'l' }), mk('line', { class: 't' }), mk('line', { class: 't' })); return g })
  svg.append(fpPoly, fpStem, mLineShadow, mLine, floorMark, ...dimLines)
  const label = h('div.ws-label', { 'aria-hidden': 'true' })
  const grip = h('button.ws-grip', { type: 'button', 'aria-label': 'Rotate (drag)', dataset: { tip: 'Drag to rotate', kbd: 'R' } }, h('span', glyph(G.grip, 16, 16, 1.7)))
  const pill = h('div.ws-dist')
  const floorTag = h('div.ws-floortag', 'Floor here')
  const handles = [0, 1].map((i) => h('div.ws-handle', { dataset: { i } }, h('span')))
  const handleTags = ['A', 'B'].map((t) => h('div.ws-handle-tag', t))
  const loupeCanvas = h('canvas')
  const loupe = h('div.ws-loupe', loupeCanvas, glyph('<path d="M32 18v10M32 36v10M18 32h10M36 32h10" stroke="#ECE8E0"/><circle cx="32" cy="32" r="3.5" fill="#D9A441" stroke="none"/>', 64, 64))
  const lookHint = h('div.ws-lookhint', 'Drag to look · click the floor to walk there')
  const dimTags = [0, 1].map(() => h('div.ws-dimtag', { hidden: true }))
  shell.mounts.overlays.append(svg, label, grip, pill, floorTag, ...handles, ...handleTags, loupe, lookHint, ...dimTags)

  // --- helpers ---------------------------------------------------------------------------------------------------
  const set = (el, show) => { el.hidden = !show; return show }
  const roomName = () => engine.getRoomName()
  const titleOf = (name) => (name ? data.getRoom(name)?.title || roomTitle({ name }) : null)
  const busy = () => engine.getRoomLoad().loading || engine.getRoom().failed

  function switcherInfo() {
    const r = engine.getRoom(), load = engine.getRoomLoad(), name = roomName()
    const title = titleOf(name) || r.dropped || (r.kind === 'placeholder' ? 'Placeholder room' : 'Scan')
    if (load.loading) {
      const p = load.progress
      return { state: 'loading', title: name ? title : (load.label || '').split('/').pop() || title, glyph: ring(p == null || p >= 1 ? null : p, { size: 14, tone: 'text' }), word: p != null && p < 1 ? `Loading ${Math.round(p * 100)} %` : 'Loading' }
    }
    if (r.failed) return { state: 'failed', title, glyph: icon('warning', { size: 16, stroke: 1.75 }), word: "Can't load" }
    if (engine.isRoomDirty() || engine.isLayoutDirty()) return { state: 'unsaved', title, glyph: unsavedGlyph(14), word: 'Unsaved' }
    const link = linkScan()
    if (link && !name && !r.dropped) { // ?room=<a scan still on its way> (A6): the scan, with its progress
      const p = link.word === 'Training' && typeof link.progress === 'number' ? link.progress : null
      return { state: 'training', title: link.title, glyph: ring(p, { size: 14 }), word: p != null ? `Training ${Math.round(p * 100)} %` : link.word }
    }
    if (r.kind === 'placeholder' && !name && !r.dropped) {
      const none = data.getState().loaded && !data.getRooms().length
      return { state: 'placeholder', title: 'Placeholder room', glyph: fromHtml('<svg class="glyph-dashed" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.2"/></svg>'), word: none ? 'No rooms yet' : '' }
    }
    return { state: 'ready', title, glyph: h('span.dot'), word: '' }
  }
  function renderSwitcher() {
    const s = switcherInfo()
    switcher.dataset.state = s.state
    const chevron = icon('chevron-down', { size: 16, stroke: 1.9 })
    chevron.classList.add('ws-chevron')
    fill(switcher, h('span.ws-sw-glyph', s.glyph), h('span.ws-sw-title', s.title), s.word ? h('span.ws-sw-word', s.word) : null, phone() && s.word ? null : chevron)
    switcher.setAttribute('aria-label', `${s.title}${s.word ? `, ${s.word}` : ''}. Open rooms`)
  }

  // Chips: rendering, then one per scan on kakapo that isn't a room yet (failed ones until dismissed).
  function chip(kind, g, text, onclick) {
    const c = h(`span.ws-chip.is-${kind}`, h('span.ws-chip-glyph', g), h('span.ws-chip-text', text))
    return h('button.ws-chip-hit', { type: 'button', onclick, 'aria-label': text }, c)
  }
  // The scan a ?room= link names while it's still queued or training (the room-link card shows its progress).
  function linkScan() {
    const want = engine.getMissingRoom()
    const sc = want ? data.getScan(want) : null
    return sc && (sc.status === 'queued' || sc.status === 'training') ? sc : null
  }
  function renderChips() {
    const list = []
    const sz = phone() ? 16 : 14
    if (rendering) {
      const el = (performance.now() - rendering.t0) / 1000
      const left = Math.max(0, 20 - el)
      list.push(chip('rendering', ring(Math.min(0.95, el / 20), { size: sz }), left > 3 ? `Rendering… · about ${Math.ceil(left / 5) * 5} s` : 'Rendering…', () => shell.openPanel('renders')))
    }
    const link = linkScan()
    for (const s of data.getScans()) {
      if (s.status === 'cancelled' || s === link || s.id === link?.id) continue
      if (s.status === 'failed') { list.push(chip('failed', icon('warning', { size: 16, stroke: 1.75 }), 'Scan failed · Details', () => openScan(s))); continue }
      if (s.status === 'queued') { list.push(chip('queued', icon('clock', { size: sz }), 'Scan queued', () => openScan(s))); continue }
      if (s.word === 'Preparing') { list.push(chip('preparing', ring(null, { size: sz }), 'Preparing scan', () => openScan(s))); continue }
      const p = typeof s.progress === 'number' ? s.progress : null
      const eta = fmtEta(s.eta_s)
      list.push(chip('training', ring(p, { size: sz }), ['Training', p != null ? `${Math.round(p * 100)} %` : null, eta || null].filter(Boolean).join(' · '), () => openScan(s)))
    }
    fill(chips, ...list)
  }
  function openScan(scan) { if (!ask('open-scan', { scan })) shell.openPage('rooms') }

  // --- render: request, chip, ready toast -----------------------------------------------------------------------
  async function requestRender() {
    if (busy()) return
    if (ask('render-request', {})) return
    let shot = null
    try { shot = engine.captureView({ maxPx: 1536 }) } catch { /* price for 1 MP */ }
    const model = 'nano-banana'
    const ok = await shell.confirm({ title: 'Render this view?', icon: 'render', confirm: 'Render',
      body: `${RENDER_MODELS[model].label} · ${engine.isRenderMock() ? 'mock, $0' : fmtUsd(renderPrice(model, shot))}. A photoreal pass of what you see, in about 20 s.` })
    if (ok) quiet(engine.renderViewInternal({ model }))
  }
  let renderTimer = null
  on(engine.events, 'render', (e) => {
    const { phase, meta } = e.detail
    if (phase === 'start') {
      rendering = { t0: performance.now() }
      clearInterval(renderTimer)
      renderTimer = setInterval(renderChips, 1000)
    } else {
      rendering = null
      clearInterval(renderTimer)
      if (phase === 'done' && meta) {
        shell.toast('Render ready', { kind: 'ok', id: 'render-ready', ms: 10000, action: { label: 'View', onClick: () => { if (!ask('open-render', { meta })) shell.openPanel('renders') } } })
      }
    }
    renderChips()
  })

  // --- selection bar -----------------------------------------------------------------------------------------------
  function removeSelected() {
    const uid = engine.getSelected()
    if (!uid) return
    const snap = engine.removeItemWithUndo(uid)
    if (!snap) return
    const undo = () => { if (lastRemoved?.snap === snap) lastRemoved = null; quiet(engine.restoreItem(snap)) }
    const t = shell.toast(`${snap.name} removed`, { id: `removed:${uid}`, icon: 'trash', ms: 6000, action: { label: 'Undo', onClick: undo } })
    if (!phone()) t.el.querySelector('.toast-action')?.append(kbd(isMac ? '⌘Z' : 'Ctrl Z'))
    lastRemoved = { snap, toast: t, undo }
  }
  function itemMenu(anchor) {
    const it = engine.getItem(engine.getSelected())
    if (!it) return
    const splatRoom = engine.getRoom().kind === 'splat'
    const items = []
    if (it.hasGlb && it.hasSplat) items.push({ label: it.render === 'splat' ? 'Show as GLB' : 'Show as splat', icon: 'flip', onSelect: () => quiet(engine.toggleRender(it.uid, it.render === 'splat' ? 'glb' : 'splat')) })
    items.push({ label: 'Relight here', icon: 'render', disabled: !splatRoom, onSelect: () => quiet(engine.relightInternal([it.position[0], 1.0, it.position[2]])) })
    items.push({ label: 'Sit here', icon: 'seated', kbd: '2', onSelect: () => engine.setViewInternal('seated') })
    shell.menu(anchor, items, { align: phone() ? 'start' : 'end', above: true })
  }
  function buildSelBar() {
    if (phone()) {
      const it = (g, text, onclick, cls = '') => h(`button.ws-sb-item${cls}`, { type: 'button', onclick }, g, h('span', text))
      fill(selBar,
        it(glyph(G.rotL), '−15°', () => engine.rotateSelected(-15)),
        it(glyph(G.rotR), '+15°', () => engine.rotateSelected(15)),
        it(icon('more'), 'More', (e) => itemMenu(e.currentTarget), '.is-narrow'),
        it(glyph(G.trash), 'Remove', removeSelected, '.is-narrow.is-danger'),
        h('span.ws-spacer'),
        h('button.ws-done', { type: 'button', onclick: () => engine.select(null) }, 'Done'))
    } else {
      const it = (g, text, key, tip, onclick, cls = '') => h(`button.ws-sb-item${cls}`, { type: 'button', onclick, dataset: { tip, kbd: key } }, g, text ? h('span', text) : null, key ? kbd(key) : null)
      fill(selBar,
        it(glyph(G.rotL, 16, 20, 1.6), '−15°', '⇧R', 'Rotate back 15°', () => engine.rotateSelected(-15)),
        it(glyph(G.rotR, 16, 20, 1.6), '+15°', 'R', 'Rotate 15°', () => engine.rotateSelected(15)),
        h('span.ws-divider'),
        h('button.ws-sb-item.is-icon', { type: 'button', 'aria-label': 'More', dataset: { tip: 'More' }, onclick: (e) => itemMenu(e.currentTarget) }, icon('more', { size: 16 })),
        it(glyph(G.trash, 16, 20, 1.6), 'Remove', 'Del', 'Remove from the room', removeSelected, '.is-danger'),
        h('button.ws-done', { type: 'button', onclick: () => engine.select(null), dataset: { tip: 'Deselect' } }, h('span', 'Done'), h('kbd.kbd.is-ink', 'Esc')))
    }
  }

  // --- walk bar -------------------------------------------------------------------------------------------------
  const keyEls = {}
  function buildWalkBar() {
    const view = engine.getView()
    const eye = Math.round((engine.getEyeHeight() || (view === 'seated' ? 1.15 : 1.6)) * 100)
    const vp = engine.getViewpoints()
    const step = (d) => engine.stepViewpoint(d, { glide: true })
    const count = vp.count ? h('div.ws-vp-count', h('b', vp.index >= 0 ? `${vp.index + 1} of ${vp.count}` : `${vp.count}`), h('span', vp.index >= 0 ? 'viewpoints' : 'viewpoints · › to start')) : h('div.ws-vp-count.is-none', h('span', 'No scan viewpoints'))
    if (phone()) {
      fill(walkBar,
        h('div.ws-wb-line', h('b', VIEW_LABEL[view]), h('span', `Eye height ${eye} cm`)),
        h('div.ws-wb-controls',
          vp.count ? h('button.ws-wb-step', { type: 'button', 'aria-label': 'Previous viewpoint', onclick: () => step(-1) }, glyph(G.prev, 20, 20, 1.8)) : null,
          count,
          vp.count ? h('button.ws-wb-step', { type: 'button', 'aria-label': 'Next viewpoint', onclick: () => step(1) }, glyph(G.next, 20, 20, 1.8)) : null,
          h('span.ws-spacer'),
          h('button.ws-wb-orbit', { type: 'button', onclick: () => engine.setViewInternal('orbit') }, icon('orbit', { size: 18 }), h('span', 'Orbit'))))
      return
    }
    const key = (k) => {
      const el = h('button.ws-key', { type: 'button', 'aria-label': `Walk ${{ w: 'forward', a: 'left', s: 'back', d: 'right' }[k]}` }, k.toUpperCase())
      const up = () => engine.input?.hold(k, false)
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); engine.input?.hold(k, true) })
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
      el.addEventListener('lostpointercapture', up)
      keyEls[k] = el
      return el
    }
    fill(walkBar,
      h('div.ws-wb-mode', h('b', VIEW_LABEL[view]), h('span', `Eye height ${eye} cm`)),
      h('span.ws-divider.is-tall'),
      h('div.ws-wb-stepper',
        h('button.ws-wb-step', { type: 'button', disabled: !vp.count, 'aria-label': 'Previous viewpoint', dataset: { tip: 'Previous viewpoint', kbd: '[' }, onclick: () => step(-1) }, glyph(G.prev, 16, 20, 1.9), kbd('[')),
        count,
        h('button.ws-wb-step', { type: 'button', disabled: !vp.count, 'aria-label': 'Next viewpoint', dataset: { tip: 'Next viewpoint', kbd: ']' }, onclick: () => step(1) }, kbd(']'), glyph(G.next, 16, 20, 1.9))),
      h('span.ws-divider.is-tall'),
      h('div.ws-wb-walk', h('div.ws-keys', key('w'), h('div', key('a'), key('s'), key('d'))), h('div.ws-wb-walktext', h('span', 'Walk'), h('small', 'or click a key'))),
      h('span.ws-divider.is-tall'),
      h('button.ws-wb-orbit', { type: 'button', onclick: () => engine.setViewInternal('orbit'), dataset: { tip: 'Back to orbit', kbd: '1' } }, icon('orbit', { size: 16, stroke: 1.75 }), h('span', 'Back to orbit'), kbd('1')))
    syncKeys(engine.input?.held() || new Set())
  }
  function syncKeys(held) { for (const [k, el] of Object.entries(keyEls)) el.classList.toggle('is-down', held.has(k)) }
  engine.input?.onKeys?.(syncKeys)

  // --- modes: measure, pick floor, check size --------------------------------------------------------------------
  function bannerContent(kind) {
    const pick = engine.getPick(), m = engine.getMeasureState()
    const desk = !phone()
    if (kind === 'measure') {
      const text = m.points === 0 ? (desk ? 'Click a point to start' : 'Tap a point to start') : m.points === 1 ? (desk ? 'Click where it ends' : 'Tap where it ends') : desk ? 'Drag a point to adjust, click to start again' : 'Drag a point; it floats above your finger'
      return { ic: icon('measure', { size: desk ? 16 : 20, stroke: desk ? 1.6 : 1.5 }), cap: 'Measure', text }
    }
    if (kind === 'floor') return { ic: glyph(G.floor, desk ? 16 : 20), cap: 'Pick floor', text: pick.floor ? (desk ? 'Click again to move the point' : 'Tap again to move the point') : desk ? 'Click open floor, away from furniture' : 'Tap open floor, away from furniture' }
    const text = pick.points === 0 ? `${desk ? 'Click' : 'Tap'} one end of something you know` : pick.points === 1 ? `Now the other end` : 'Type the real distance from A to B'
    return { ic: glyph(G.size, desk ? 16 : 20), cap: 'Check size', text }
  }
  function modeKind() {
    const pick = engine.getPick()
    if (pick.mode === 'floor') return 'floor'
    if (pick.mode === 'two') return 'two'
    if (engine.getMeasureState().active) return 'measure'
    return null
  }
  function endMode() {
    engine.cancelPickMode()
    engine.clearMeasure()
    engine.setMeasureActive(false)
  }
  function renderBanner(kind) {
    if (!set(banner, !!kind && !busy())) return
    const b = bannerContent(kind)
    const kids = [h('span.ws-bn-icon', b.ic), h('span.ws-bn-text', h('span.ws-bn-cap', b.cap), h('span.ws-bn-line', b.text))]
    if (!phone()) {
      const pick = engine.getPick()
      if (kind === 'measure') kids.push(h('button.ws-bn-btn', { type: 'button', onclick: () => engine.clearMeasure() }, 'Clear'), h('button.ws-bn-btn.is-primary', { type: 'button', onclick: endMode }, h('span', 'Done'), h('kbd.kbd.is-ink', 'Esc')))
      else if (kind === 'floor') {
        kids.push(h('span.ws-bn-meta', pick.floor ? floorText(pick.floor).join(' · ') : ''),
          h('button.ws-bn-btn', { type: 'button', onclick: endMode }, 'Cancel'),
          h('button.ws-bn-btn.is-primary', { type: 'button', disabled: !pick.floor, onclick: () => engine.applyPickFloor() }, h('span', 'Apply'), h('kbd.kbd.is-ink', '↵')))
      } else kids.push(h('button.ws-bn-btn', { type: 'button', disabled: !pick.points, onclick: () => engine.resetTwoPoints() }, 'Pick again'), h('button.ws-bn-btn', { type: 'button', onclick: endMode }, h('span', 'Cancel'), kbd('Esc')))
    }
    fill(banner, ...kids)
  }
  function floorText(f) {
    const move = Math.abs(f.moveCm)
    return [move < 0.5 ? 'The floor is already here' : `Room moves ${move < 10 ? move.toFixed(1) : Math.round(move)} cm`, f.level ? `Tilt ${f.tiltDeg.toFixed(1)}° → level` : 'Already level here']
  }
  function renderModeBar(kind) {
    // phone: the bar in the dock's place. Desktop uses the banner (and the size card).
    if (!set(modeBar, phone() && !!kind && !busy() && !(kind === 'two' && engine.getPick().points === 2))) return
    const pick = engine.getPick()
    const txt = (a, b) => h('div.ws-mb-text', h('b', a), h('span', b))
    const btn = (t, onclick, primary, disabled) => h(`button.ws-mb-btn${primary ? '.is-primary' : ''}`, { type: 'button', onclick, disabled }, t)
    if (kind === 'measure') {
      const m = engine.getMeasure()
      fill(modeBar, m ? txt(`${m.meters.toFixed(2)} m · ${cm(m.meters)} cm`, 'Tap the floor to start again') : txt('No measurement yet', engine.getMeasureState().points ? 'Tap the second point' : 'Tap two points'),
        btn('Clear', () => engine.clearMeasure(), false, !engine.getMeasureState().points), btn('Done', endMode, true))
    } else if (kind === 'floor') {
      const [a, b] = pick.floor ? floorText(pick.floor) : ['No point yet', 'Tap open floor']
      fill(modeBar, txt(a, b), btn('Cancel', endMode), btn('Apply', () => engine.applyPickFloor(), true, !pick.floor))
    } else {
      fill(modeBar, txt(pick.points ? 'Point A set' : 'No points yet', pick.points ? 'Tap point B' : 'Tap point A'), btn('Cancel', endMode), btn('Pick again', () => engine.resetTwoPoints(), false, !pick.points))
    }
  }

  // Check size card: the real distance between A and B (cm), lifted above the phone keyboard.
  const sizeInput = h('input.ws-size-input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off', 'aria-label': 'Real distance from A to B in centimeters', placeholder: '' })
  const sizeSub = h('span.ws-size-sub')
  const sizeApply = h('button.ws-size-btn.is-primary', { type: 'button', onclick: () => applySize() }, 'Apply scale')
  sizeCard.append(
    h('div.ws-size-row', h('div.ws-size-text', h('b', 'Real distance A to B'), sizeSub), h('label.ws-size-field', sizeInput, h('span', 'cm'))),
    h('div.ws-size-row',
      h('button.ws-size-btn', { type: 'button', onclick: () => engine.resetTwoPoints() }, 'Pick again'),
      h('span.ws-spacer'),
      h('button.ws-size-btn', { type: 'button', onclick: endMode }, 'Cancel'),
      sizeApply))
  const sizeValue = () => { const v = parseFloat(String(sizeInput.value).replace(',', '.')); return v > 0 ? v : null }
  function syncSizeSub() {
    const pick = engine.getPick(), v = sizeValue()
    sizeSub.textContent = v && pick.measured ? `Scales the room by ×${(v / 100 / pick.measured).toFixed(2)}` : `${cm(pick.measured || 0)} cm in the scan`
    sizeApply.disabled = !v
  }
  sizeInput.addEventListener('input', syncSizeSub)
  sizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applySize() }
    if (e.key === 'Escape') { e.preventDefault(); endMode() }
  })
  function applySize() {
    const v = sizeValue()
    if (!v) { sizeInput.focus(); return }
    sizeInput.blur()
    engine.applyTwoPointScale(v / 100)
  }
  function renderSizeCard() {
    const pick = engine.getPick()
    const show = pick.mode === 'two' && pick.points === 2 && !busy()
    const was = !sizeCard.hidden
    if (!set(sizeCard, show)) { if (was) sizeInput.blur(); return }
    if (!was) { sizeInput.value = ''; sizeInput.placeholder = String(cm(pick.measured || 0)); requestAnimationFrame(() => sizeInput.focus({ preventScroll: true })) }
    syncSizeSub()
  }

  // --- loading and can't-load cards (B7) ---------------------------------------------------------------------------
  function renderLoadCard() {
    const load = engine.getRoomLoad(), r = engine.getRoom()
    const name = roomName()
    const dr = name ? data.getRoom(name) : null
    const title = titleOf(name) || (load.label || '').split('/').pop() || 'Room'
    let state = load.loading ? 'loading' : r.failed ? 'failed' : ''
    root.dataset.ws = state
    if (!set(loadCard, !!state)) { loadCard.style.removeProperty('--thumb'); return }
    loadCard.dataset.state = state
    const thumb = dr?.thumb_url
    root.style.setProperty('--ws-thumb', thumb && state === 'loading' ? `url("${thumb}")` : 'none')
    if (state === 'loading') {
      const total = loadStat.total || dr?.size_bytes || 0
      const p = load.progress
      const metaBits = [thumb ? friendlyDate(scanDate(name) || dr?.created) : dr ? 'New room' : null, dr?.splats ? `${nbsp(dr.splats)} splats` : null, total ? fmtBytes(total) : null].filter(Boolean)
      const left = loadStat.rate > 0 && total && p != null && p < 1 ? (total - loadStat.loaded) / loadStat.rate : null
      const pct = p != null ? Math.round(p * 100) : null
      const progressLine = p == null ? 'Loading…' : p >= 1 ? 'Opening the scan…' : `${total ? `${Math.round(loadStat.loaded / 1e6)} of ${fmtBytes(total)} · ` : ''}${pct} %`
      const canCancel = !r.dropped && !!name
      fill(loadCard,
        h('div.ws-lc-head', h('span.ws-lc-cap', 'Loading room'), h('h2.ws-lc-title', title), metaBits.length ? h('span.ws-lc-meta', metaBits.join(' · ')) : null),
        h('div.ws-lc-progress', h('div.ws-lc-bar', { style: { '--p': `${p == null ? 8 : Math.max(2, pct)}%` }, class: p == null ? 'is-indeterminate' : '' }, h('span')),
          h('div.ws-lc-nums', h('span', progressLine), left != null ? h('span.muted', left < 2 ? 'Almost there' : `About ${left < 60 ? `${Math.ceil(left)} s` : `${Math.round(left / 60)} min`} left`) : null)),
        canCancel || phone() ? h('div.ws-lc-actions', h('button.ws-lc-btn', { type: 'button', onclick: cancelLoad }, glyph(G.back, 20, 20, 1.75), h('span', 'Cancel, back to rooms'), !phone() ? kbd('Esc') : null)) : null)
    } else {
      const err = r.error || {}
      const body = err.kind === 'offline' ? `kakapo isn't answering. Check you're on home Wi-Fi or Tailscale, then try again.${loadStat.total ? ` Stopped at ${Math.round(loadStat.loaded / 1e6)} of ${fmtBytes(loadStat.total)}.` : ''}`
        : err.kind === 'missing' ? `kakapo is answering, but this room's splat file (${err.file}) is missing. Open it from the Mac to fix, then try again.`
          : `The splat file${err.file ? ` (${err.file})` : ''} couldn't be read. Open it from the Mac to fix, then try again.`
      fill(loadCard,
        h('div.ws-lc-head', h('span.ws-lc-cap.is-danger', icon(err.kind === 'offline' ? 'cloud-off' : 'warning', { size: 16, stroke: 2 }), "Can't load this room"), h('h2.ws-lc-title', title), h('p.ws-lc-body', body)),
        h('div.ws-lc-actions.is-two',
          h('button.ws-lc-btn', { type: 'button', onclick: () => shell.openPage('rooms') }, phone() ? glyph(G.back, 20, 20, 1.75) : null, h('span', 'Back to rooms')),
          h('button.ws-lc-btn.is-primary', { type: 'button', onclick: () => quiet(engine.retryRoom()) }, h('span', 'Try again'), !phone() ? h('kbd.kbd.is-ink', '↵') : null)))
    }
  }
  function cancelLoad() {
    engine.cancelRoomLoad()
    shell.openPage('rooms')
  }
  on(engine.events, 'room-progress', (e) => {
    const { loaded, total } = e.detail
    const now = performance.now()
    if (!loadStat.t0 || loaded < loadStat.loaded) loadStat = { t0: now, b0: loaded, loaded, total, rate: 0 }
    else {
      loadStat.loaded = loaded
      loadStat.total = total
      const dt = (now - loadStat.t0) / 1000
      if (dt > 0.4) loadStat.rate = (loaded - loadStat.b0) / dt
    }
    throttle(renderLoadCard)
    throttle(renderSwitcher)
  })
  const pending = new Set()
  function throttle(fn) {
    if (pending.has(fn)) return
    pending.add(fn)
    setTimeout(() => { pending.delete(fn); fn() }, 120)
  }

  // --- gesture hint (phone, once per device) -----------------------------------------------------------------------
  function renderHint() {
    const want = phone() && store.get(HINT_KEY) !== '1' && engine.getRoom().loaded && !busy() && !modeKind() && !engine.getSelected() && engine.getView() === 'orbit'
    if (!set(hint, want) || hint.childElementCount) return
    const row = (ic, a, b) => h('div.ws-hint-row', h('span.ws-hint-ic', fromHtml(`<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic}</svg>`)), h('div', h('b', a), h('span', b)))
    hint.append(
      h('div.ws-hint-head', h('b', 'Getting around the room'), h('button.ws-hint-ok', { type: 'button', onclick: () => { store.set(HINT_KEY, '1'); hint.hidden = true } }, 'Got it')),
      row('<path d="M5 17a10 5 0 0 0 18 0" stroke="#D9A441" stroke-width="1.5"/><path d="M20.5 14.8l2.6 2.3-3.1 1.4" stroke="#D9A441" stroke-width="1.5"/><circle cx="14" cy="10" r="4" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/>', 'One finger', 'Orbit the room'),
      row('<circle cx="10" cy="15" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><circle cx="18" cy="11" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><path d="M6 19l-2.5 2.5M3.5 18.5v3h3M22 7l2.5-2.5M24.5 7.5v-3h-3" stroke="#D9A441" stroke-width="1.5"/>', 'Two fingers', 'Pan, and pinch to zoom'),
      row('<circle cx="14" cy="14" r="9" stroke="#D9A441" stroke-width="1.5" stroke-dasharray="2.5 3"/><circle cx="14" cy="14" r="4" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/>', 'Tap an item', 'Then drag it to move it'))
  }

  // --- the whole chrome from the current state ---------------------------------------------------------------------
  function sync() {
    const view = engine.getView()
    const sel = engine.getSelected()
    const kind = modeKind()
    const loadingOrFailed = busy()
    renderSwitcher()
    renderChips()
    renderLoadCard()
    views.set(view)
    measureBtn.setAttribute('aria-pressed', String(kind === 'measure'))
    railMeasure.setAttribute('aria-pressed', String(kind === 'measure'))
    fill(railView, icon(view))
    railView.setAttribute('aria-label', `View: ${VIEW_LABEL[view]}`)
    for (const b of [...views.querySelectorAll('button'), measureBtn, frameBtn, renderBtn, railView, railMeasure, railFrame, railRender]) b.disabled = loadingOrFailed
    renderBanner(kind)
    chips.hidden = phone() && !!kind
    renderModeBar(kind)
    renderSizeCard()
    const showSel = !!sel && !kind && !loadingOrFailed
    if (set(selBar, showSel) && !selBar.childElementCount) buildSelBar()
    const walking = view !== 'orbit' && !loadingOrFailed && !(phone() && kind)
    const vp = engine.getViewpoints()
    const sig = `${view}|${vp.index}|${vp.count}|${shell.mode}`
    if (set(walkBar, walking) && walkBar.dataset.sig !== sig) { walkBar.dataset.sig = sig; buildWalkBar() }
    root.dataset.wsBar = phone() ? (!sizeCard.hidden ? 'size' : !modeBar.hidden ? 'mode' : showSel ? 'select' : '') : ''
    root.dataset.wsWalk = walking ? '1' : ''
    renderHint()
  }
  const rebuild = () => { selBar.replaceChildren(); hint.replaceChildren(); walkBar.dataset.sig = ''; sync() }

  // Phone: a mode (measure, pick) closes the sheet so the bars and the room are visible; it comes back after.
  function modeStarted() {
    if (!phone()) return
    const open = shell.getOpenPanel()
    if (open) { returnPanel = open; shell.closePanel() }
  }
  function modeEnded() {
    if (returnPanel && phone() && !modeKind()) { const p = returnPanel; returnPanel = null; shell.openPanel(p.id, { detent: p.detent || 'peek' }) }
  }

  for (const ev of ['room', 'dirty', 'view', 'viewpoint', 'selection', 'grid', 'look']) on(engine.events, ev, sync)
  on(engine.events, 'items', (e) => { if (e.detail.change !== 'move') sync() })
  on(engine.events, 'measure', (e) => { if (e.detail.active && !banner.dataset.on) modeStarted(); banner.dataset.on = e.detail.active ? '1' : ''; sync(); if (!e.detail.active) modeEnded() })
  on(engine.events, 'pick', (e) => {
    const ph = e.detail.phase
    if (ph === 'start' && e.detail.points === 0) modeStarted()
    sync()
    if (ph === 'cancel' || ph === 'applied') modeEnded()
  })
  on(engine.events, 'room', (e) => {
    if (e.detail.phase === 'loading') { loadStat = { t0: 0, b0: 0, loaded: 0, total: 0, rate: 0 }; endMode() }
    // The can't-load card says it all: drop the engine's matching error toast (it's reported right after this event).
    if (e.detail.phase === 'failed' && engine.getRoom().failed) {
      setTimeout(() => { for (const t of shell.mounts.toasts.querySelectorAll('.toast-error')) if (/Could not load room scan/.test(t.textContent)) t.querySelector('.toast-close')?.click() }, 0)
    }
  })
  on(engine.events, 'view', () => { if (engine.getView() !== 'orbit' && !phone()) lookHintUntil = performance.now() + 8000 })
  on(engine.events, 'walk', () => { lookHintUntil = 0 })
  for (const ev of ['rooms', 'scans', 'offline']) on(data.events, ev, () => { renderSwitcher(); renderChips(); if (!loadCard.hidden) renderLoadCard() })
  on(shell.events, 'mode', rebuild)
  on(shell.events, 'page', sync)

  // --- keys: Del with Undo, ⌘Z, Esc while loading, Enter on the failed card ---------------------------------------
  shell.addKeyFilter((e) => {
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false
    if (engine.getRoomLoad().loading && e.key === 'Escape') { e.preventDefault(); cancelLoad(); return true }
    if (engine.getRoom().failed && e.key === 'Enter' && !t?.closest?.('button')) { e.preventDefault(); quiet(engine.retryRoom()); return true }
    if ((e.key === 'Delete' || e.key === 'Backspace') && engine.getSelected() && !e.metaKey && !e.ctrlKey) { e.preventDefault(); removeSelected(); return true }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && lastRemoved) { e.preventDefault(); const l = lastRemoved; lastRemoved = null; l.toast?.close(); l.undo(); return true }
    if (e.key === 'Enter' && engine.getPick().floor && engine.getPick().mode === 'floor') { e.preventDefault(); engine.applyPickFloor(); return true }
    return false
  })

  // --- the grip: drag around the item's center to rotate it (15° steps on touch, Shift on desktop) ----------------
  grip.addEventListener('pointerdown', (e) => {
    const uid = engine.getSelected()
    if (!uid || !engine.beginRotateDrag(uid, e.clientX, e.clientY)) return
    e.preventDefault()
    grip.setPointerCapture?.(e.pointerId)
    grip.dataset.touch = e.pointerType !== 'mouse' ? '1' : ''
  })
  grip.addEventListener('pointermove', (e) => { if (engine.getDrag()?.mode === 'rotate') engine.dragTo(e.clientX, e.clientY, { snapTo: grip.dataset.touch === '1' }) })
  const gripUp = () => { if (engine.getDrag()?.mode === 'rotate') engine.endItemDrag() }
  grip.addEventListener('pointerup', gripUp)
  grip.addEventListener('pointercancel', gripUp)
  grip.addEventListener('click', (e) => { if (e.detail === 0) engine.rotateSelected(15) }) // keyboard activation

  // --- point handles: drag a measure / check-size point; on touch it floats 40 px above the finger -----------------
  handles.forEach((el, i) => {
    el.addEventListener('pointerdown', (e) => {
      const kind = engine.getPick().mode === 'two' ? 'two' : engine.getMeasureState().active ? 'measure' : null
      if (!kind) return
      e.preventDefault()
      el.setPointerCapture?.(e.pointerId)
      handleDrag = { kind, i, touch: e.pointerType !== 'mouse', x: e.clientX, y: e.clientY }
      moveHandle(e)
    })
    el.addEventListener('pointermove', (e) => { if (handleDrag?.i === i) moveHandle(e) })
    const up = () => { if (handleDrag?.i === i) { handleDrag = null; loupe.hidden = true } }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
  function moveHandle(e) {
    const d = handleDrag
    d.x = e.clientX
    d.y = e.clientY - (d.touch ? 40 : 0)
    if (d.kind === 'measure') engine.setMeasurePointAt(d.i, d.x, d.y)
    else engine.setPickPointAt(d.i, d.x, d.y)
  }

  // --- per frame: place the overlay ----------------------------------------------------------------------------------
  const px = (el, x, y) => { el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)` }
  const hide = (...els) => { for (const el of els) if (!el.hidden) el.hidden = true }
  const vw = () => window.innerWidth, vh = () => window.innerHeight
  engine.onFrame(() => {
    const sel = engine.getSelected()
    const kind = modeKind()
    const showSel = sel && !busy() && !kind
    // selection footprint, label, grip
    const f = showSel ? engine.getFootprint(sel) : null
    const s = f ? f.corners.map((c) => engine.worldToScreen(c)) : null
    if (s && s.every((p) => p.visible)) {
      fpPoly.setAttribute('points', s.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
      const c = s.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 })
      const fr = s[1]
      let dx = fr.x - c.x, dy = fr.y - c.y
      const len = Math.hypot(dx, dy) || 1
      dx /= len; dy /= len
      fpStem.setAttribute('x1', fr.x); fpStem.setAttribute('y1', fr.y)
      fpStem.setAttribute('x2', fr.x + dx * 11); fpStem.setAttribute('y2', fr.y + dy * 11)
      const gx = fr.x + dx * 24 - 22, gy = fr.y + dy * 24 - 22
      px(grip, gx, gy)
      const it = engine.getItem(sel)
      const text = `${it.name}|${dimsText(it.lib?.dims_cm)}`
      if (label.dataset.text !== text) {
        label.dataset.text = text
        fill(label, h('b', it.name), it.lib?.dims_cm ? h('span', dimsText(it.lib.dims_cm)) : null)
      }
      const front = [s[0], s[1]]
      const lx = Math.min(...front.map((p) => p.x)), lw = label.offsetWidth || 140, lh = label.offsetHeight || 40
      let ly = Math.max(...s.map((p) => p.y)) + 10
      if (lx < gx + 40 && lx + lw > gx + 4 && ly < gy + 38) ly = gy + 38 // keep the grip clear
      px(label, Math.max(8, Math.min(vw() - lw - 8, lx)), Math.max(8, Math.min(vh() - lh - 8, ly)))
      fpPoly.style.display = fpStem.style.display = ''
      label.hidden = grip.hidden = false
    } else {
      fpPoly.style.display = fpStem.style.display = 'none'
      hide(label, grip)
    }
    // measure / check-size points
    const pts = kind === 'measure' ? engine.getMeasurePoints() : kind === 'two' ? engine.getPick().pointList : []
    const sp = pts.map((p) => engine.worldToScreen(p))
    handles.forEach((el, i) => {
      const p = sp[i]
      if (p && p.visible) { px(el, p.x - 22, p.y - 22); el.hidden = false; el.classList.toggle('is-active', handleDrag?.i === i) } else el.hidden = true
    })
    handleTags.forEach((el, i) => { const p = sp[i]; if (kind === 'two' && p && p.visible) { px(el, p.x - 5, p.y + 23); el.hidden = false } else el.hidden = true })
    if (sp.length === 2 && sp.every((p) => p.visible)) {
      for (const l of [mLine, mLineShadow]) { l.setAttribute('x1', sp[0].x); l.setAttribute('y1', sp[0].y); l.setAttribute('x2', sp[1].x); l.setAttribute('y2', sp[1].y); l.style.display = '' }
      mLineShadow.style.display = kind === 'measure' && !phone() ? '' : 'none'
      const meters = kind === 'measure' ? engine.getMeasure()?.meters : engine.getPick().measured
      const mx = (sp[0].x + sp[1].x) / 2, my = (sp[0].y + sp[1].y) / 2
      pill.dataset.kind = kind
      const txt = kind === 'two' ? `${meters.toFixed(2)} m|in the scan` : phone() ? `${meters.toFixed(2)} m|` : `${meters.toFixed(2)} m|/ ${cm(meters)} cm`
      if (pill.dataset.text !== txt) { pill.dataset.text = txt; const [a, b] = txt.split('|'); fill(pill, h('b', a), b ? h('span', b) : null) }
      const pw = pill.offsetWidth || 80
      px(pill, mx - pw / 2, my - (kind === 'two' ? 70 : 38))
      pill.hidden = false
    } else {
      mLine.style.display = mLineShadow.style.display = 'none'
      pill.hidden = true
    }
    // pick-floor marker
    const fl = kind === 'floor' ? engine.getPick().floor : null
    const fs = fl ? engine.worldToScreen(fl.point) : null
    if (fs && fs.visible) {
      floorMark.setAttribute('transform', `translate(${fs.x.toFixed(1)} ${fs.y.toFixed(1)})`)
      floorMark.style.display = ''
      px(floorTag, fs.x - (floorTag.offsetWidth || 90) / 2, fs.y - 58)
      floorTag.hidden = false
    } else { floorMark.style.display = 'none'; floorTag.hidden = true }
    drawDims(kind)
    // loupe while a point is dragged by touch
    if (handleDrag?.touch) drawLoupe(handleDrag.x, handleDrag.y)
    else if (!loupe.hidden) loupe.hidden = true
    // desktop first-person hint
    lookHint.hidden = !(engine.getView() !== 'orbit' && !phone() && performance.now() < lookHintUntil && !busy())
  })
  // Dimension lines while the Room panel (Check room) is open in orbit: the floor edge farthest from the camera, and
  // the vertical edge at its right-hand end on screen.
  function drawDims(kind) {
    const open = shell.getOpenPanel()?.id === 'room' && !kind && !busy() && engine.getView() === 'orbit' && engine.getRoom().loaded
    const lines = []
    if (open) {
      const { min, max } = engine.getRoomBox()
      const y0 = min[1]
      const cam = engine.three.camera.position
      const edges = [[[min[0], y0, min[2]], [max[0], y0, min[2]]], [[min[0], y0, max[2]], [max[0], y0, max[2]]],
        [[min[0], y0, min[2]], [min[0], y0, max[2]]], [[max[0], y0, min[2]], [max[0], y0, max[2]]]]
      // the pair of floor edges that runs most across the screen, then the farther one of the two (the back wall)
      const across = (e) => { const a = engine.worldToScreen(e[0]), b = engine.worldToScreen(e[1]); return Math.abs(b.x - a.x) }
      const pair = across(edges[0]) + across(edges[1]) >= across(edges[2]) + across(edges[3]) ? edges.slice(0, 2) : edges.slice(2)
      const dist = (e) => Math.hypot((e[0][0] + e[1][0]) / 2 - cam.x, (e[0][2] + e[1][2]) / 2 - cam.z)
      const far = dist(pair[0]) >= dist(pair[1]) ? pair[0] : pair[1]
      const s = far.map((p) => engine.worldToScreen(p))
      const right = s[0].x > s[1].x ? 0 : 1
      const top = [far[right][0], max[1], far[right][2]]
      lines.push({ a: far[0], b: far[1], m: Math.hypot(far[1][0] - far[0][0], far[1][2] - far[0][2]) })
      lines.push({ a: far[right], b: top, m: max[1] - y0 })
    }
    dimLines.forEach((g, i) => {
      const L = lines[i]
      const a = L && engine.worldToScreen(L.a), b = L && engine.worldToScreen(L.b)
      if (!L || !a.visible || !b.visible || Math.hypot(b.x - a.x, b.y - a.y) < 40) { g.style.display = 'none'; dimTags[i].hidden = true; return }
      const [l, t1, t2] = g.children
      const set = (el, x1, y1, x2, y2) => { el.setAttribute('x1', x1.toFixed(1)); el.setAttribute('y1', y1.toFixed(1)); el.setAttribute('x2', x2.toFixed(1)); el.setAttribute('y2', y2.toFixed(1)) }
      set(l, a.x, a.y, b.x, b.y)
      const len = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / len * 6, ny = (b.x - a.x) / len * 6
      set(t1, a.x - nx, a.y - ny, a.x + nx, a.y + ny)
      set(t2, b.x - nx, b.y - ny, b.x + nx, b.y + ny)
      g.style.display = ''
      const tag = dimTags[i], txt = `${L.m.toFixed(2)} m`
      if (tag.textContent !== txt) tag.textContent = txt
      px(tag, (a.x + b.x) / 2 - (tag.offsetWidth || 56) / 2, (a.y + b.y) / 2 - (tag.offsetHeight || 24) / 2)
      tag.hidden = false
    })
  }
  const ZOOM = 2
  function drawLoupe(x, y) {
    const src = engine.canvas
    const r = src.getBoundingClientRect()
    const k = src.width / r.width
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (loupeCanvas.width !== 64 * dpr) { loupeCanvas.width = loupeCanvas.height = 64 * dpr }
    const ctx2 = loupeCanvas.getContext('2d')
    const size = (64 / ZOOM) * k
    ctx2.fillStyle = '#6A5644'
    ctx2.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height)
    try { ctx2.drawImage(src, (x - r.left) * k - size / 2, (y - r.top) * k - size / 2, size, size, 0, 0, loupeCanvas.width, loupeCanvas.height) } catch { /* not ready */ }
    px(loupe, x - 32, y - 32)
    loupe.hidden = false
  }

  // --- keyboard inset (phone): the check-size card rides above the keyboard ------------------------------------------
  const vv = window.visualViewport
  function syncKb() {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    root.style.setProperty('--kb', `${Math.round(kb)}px`)
    root.dataset.kb = kb > 80 ? 'up' : ''
  }
  vv?.addEventListener('resize', syncKb)
  vv?.addEventListener('scroll', syncKb)
  syncKb()

  ctx.workspace = {
    requestRender,
    openScan,
    startPickFloor: () => engine.startPickMode('floor'),
    startCheckSize: () => engine.startPickMode('two'),
    startMeasure: () => { if (!engine.getMeasureState().active) toggleMeasure() },
  }
  sync()
}
