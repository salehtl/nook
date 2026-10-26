// nook planner UI v1: the sidebar, toolbar, selection bar, tags, toasts, render dialogs and drag-and-drop of
// planner/index.html, driven only through the engine API and its events (engine.js). Temporary: planner v2 replaces it.
import {
  DEFAULT_RENDER_PROMPT, LOOK_DEFAULT, RENDER_MODELS, dimsText, fmtUsd, quiet, renderPrice, round, wrapDeg,
} from './engine.js'

const $ = (id) => document.getElementById(id)

export function installUiV1(engine, input) {
  const on = (name, fn) => engine.events.addEventListener(name, (e) => fn(e.detail || {}))

  // --- toasts ----------------------------------------------------------------------------
  function toast(text, kind = 'info', ms = 6000) {
    if ([...$('toasts').children].some((t) => t.textContent === text)) return
    const el = document.createElement('div')
    el.className = `toast ${kind}`
    el.textContent = text
    el.onclick = () => el.remove()
    $('toasts').prepend(el)
    while ($('toasts').children.length > 6) $('toasts').lastChild.remove()
    setTimeout(() => el.remove(), ms)
  }
  on('toast', (d) => toast(d.text, d.kind, d.ms))
  on('error', (d) => toast(d.text, 'error', 9000))
  on('status', (d) => { $('room-status').textContent = d.text })

  // --- view inset: keep the projection center in the part of the view the sidebar doesn't cover
  function updateInset() {
    const side = $('sidebar').classList.contains('collapsed') ? 0 : $('sidebar').getBoundingClientRect().right
    engine.setViewInset(side)
  }
  window.addEventListener('resize', updateInset)
  updateInset()

  // --- library -----------------------------------------------------------------------------
  const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  function renderLibraryUI(library) {
    const ul = $('library-list')
    $('lib-count').textContent = library.length ? `(${library.length})` : ''
    $('library-empty').hidden = library.length > 0
    ul.replaceChildren(...library.map((it) => {
      const li = document.createElement('li')
      li.title = `Add ${it.name} to the room`
      let thumb
      if (it.assets?.thumb) {
        thumb = document.createElement('img')
        thumb.className = 'thumb'
        thumb.alt = ''
        thumb.src = engine.assetUrl(it.assets.thumb)
        thumb.onerror = () => {
          const ph = document.createElement('div'); ph.className = 'thumb'; ph.textContent = initials(it.name)
          thumb.replaceWith(ph)
          engine.reportError(`Missing thumbnail for "${it.name}" (${it.assets.thumb})`)
        }
      } else {
        thumb = document.createElement('div'); thumb.className = 'thumb'; thumb.textContent = initials(it.name)
      }
      const meta = document.createElement('div'); meta.className = 'meta'
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = it.name || it.id
      const dm = document.createElement('span'); dm.className = 'dims'; dm.textContent = dimsText(it.dims_cm)
      meta.append(nm, dm)
      const badge = document.createElement('span'); badge.className = 'badge'
      badge.textContent = it.assets?.splat ? 'glb · splat' : 'glb'
      li.append(thumb, meta, badge)
      li.onclick = () => quiet(engine.addItemInternal(it.id).then((uid) => engine.select(uid)))
      return li
    }))
  }
  on('library', (d) => renderLibraryUI(d.items || engine.getLibrary()))

  // --- placed items + selection ---------------------------------------------------------------
  function renderPlacedUI() {
    const items = engine.getItems()
    const selected = engine.getSelected()
    const ul = $('placed-list')
    $('placed-count').textContent = items.length ? `(${items.length})` : ''
    ul.replaceChildren(...items.map((r) => {
      const li = document.createElement('li')
      if (r.uid === selected) li.className = 'sel'
      const nm = document.createElement('span'); nm.textContent = r.name
      const rd = document.createElement('span'); rd.className = 'badge'; rd.textContent = r.render
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove'
      x.onclick = (e) => { e.stopPropagation(); engine.removeItemInternal(r.uid) }
      li.append(nm, rd, x)
      li.onclick = () => engine.select(r.uid)
      return li
    }))
  }

  function renderSelectionUI() {
    const mode = engine.getGizmoMode()
    $('sel-move').classList.toggle('on', mode === 'translate')
    $('sel-rotate').classList.toggle('on', mode === 'rotate')
    const uid = engine.getSelected()
    const rec = uid && engine.getItem(uid)
    $('selbar').hidden = !rec
    $('item-label').hidden = !rec
    $('sel-relight').hidden = engine.getRoom().kind !== 'splat'
    if (!rec) return
    $('sel-name').textContent = rec.name
    $('sel-render-seg').hidden = !(rec.hasGlb && rec.hasSplat)
    $('sel-glb').classList.toggle('on', rec.render === 'glb')
    $('sel-splat').classList.toggle('on', rec.render === 'splat')
    const lab = $('item-label')
    lab.replaceChildren(document.createTextNode(rec.name))
    const dm = document.createElement('span'); dm.className = 'dims'; dm.textContent = dimsText(rec.lib.dims_cm)
    lab.append(dm)
  }
  on('items', (d) => { if (d.change !== 'move') { renderPlacedUI(); renderSelectionUI() } })
  on('selection', () => { renderSelectionUI(); renderPlacedUI() })

  // --- views + tools ------------------------------------------------------------------------
  on('view', (d) => {
    for (const b of document.querySelectorAll('#toolbar [data-view]')) b.classList.toggle('on', b.dataset.view === d.view)
  })

  function updateModeHint() {
    const el = $('mode-hint')
    const pick = engine.getPick()
    const ms = engine.getMeasureState()
    let text = ''
    if (pick.mode === 'floor') text = 'Click a point on the floor of the scan · Esc cancels'
    else if (pick.mode === 'two') text = `Click point ${pick.points + 1} of 2 on the scan · Esc cancels`
    else if (ms.active) text = ms.points === 1 ? 'Click the second point · Esc clears' : 'Measure: click two points · Esc clears'
    el.textContent = text
    el.hidden = !text
  }
  on('measure', (d) => {
    $('tool-measure').classList.toggle('on', d.active)
    const el = $('measure-label')
    if (d.meters != null) {
      el.textContent = `${d.meters.toFixed(3)} m · ${(d.meters * 100).toFixed(1)} cm`
      el.dataset.meters = String(d.meters)
      el.hidden = false
    } else {
      el.hidden = true
    }
    updateModeHint()
  })
  on('pick', (d) => {
    // The two-point row shows once both points are picked, until it's applied or cancelled.
    $('al-two-row').hidden = !(d.points === 2 && d.measured != null)
    if (d.phase === 'ready') {
      $('al-two-measured').textContent = `${d.measured.toFixed(3)} m in scan →`
      $('al-two-dist').focus()
    }
    updateModeHint()
  })

  // --- room + alignment panel -----------------------------------------------------------------
  let align = { yaw: 0, pitch: 0, roll: 0 }
  function syncRoomUI() {
    const cfg = engine.getRoomConfig()
    const t = cfg.transform
    align = engine.getRoomEuler()
    $('al-yaw').value = align.yaw; $('al-pitch').value = align.pitch; $('al-roll').value = align.roll
    $('al-x').value = round(t.position[0], 4); $('al-y').value = round(t.position[1], 4); $('al-z').value = round(t.position[2], 4)
    $('al-scale').value = round(t.scale, 5)
    const p = cfg.placeholder
    $('ph-w').value = p.w; $('ph-d').value = p.d; $('ph-h').value = p.h
    if (document.activeElement !== $('scan-url')) $('scan-url').value = cfg.splat || ''
    const isSplat = engine.getRoom().kind === 'splat'
    for (const id of ['al-floor', 'al-two', 'al-flip']) $(id).disabled = !isSplat
    $('ph-row').hidden = isSplat
    syncLookUI(engine.getLook())
    renderSelectionUI()
  }
  // 'loading' keeps the old values until the room is in; 'edit' is a field being typed in.
  on('room', (d) => { if (d.phase !== 'loading' && d.phase !== 'edit') syncRoomUI() })

  function syncLookUI(l) {
    const ev = Math.log2(l.exposure)
    if (document.activeElement !== $('look-exposure')) $('look-exposure').value = String(round(ev, 3))
    if (document.activeElement !== $('look-warmth')) $('look-warmth').value = String(l.warmth)
    $('look-exposure-val').textContent = `${l.exposure.toFixed(2)}×`
    $('look-warmth-val').textContent = l.warmth === 0 ? 'neutral' : `${l.warmth > 0 ? 'warm' : 'cool'} ${Math.abs(l.warmth).toFixed(2)}`
    $('look-shadows').checked = l.contactShadows
    $('look-relight').disabled = l.roomKind !== 'splat'
    $('look-env').textContent = l.envSource === 'splat'
      ? `lit by the scan from ${l.envProbe.map((v) => v.toFixed(1)).join(', ')}`
      : l.roomKind === 'splat' ? 'baking light from the scan…' : 'neutral studio light'
    $('look-env').title = l.envSource === 'splat' ? 'Furniture is lit by a cube map of the scan taken from this point (m). Relight here moves it.' : ''
  }
  on('look', (l) => syncLookUI(l))

  function bindNumber(id, apply) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value)
      if (Number.isFinite(v)) apply(v)
    })
  }
  bindNumber('al-yaw', (v) => { align.yaw = v; engine.setRoomEuler(align) })
  bindNumber('al-pitch', (v) => { align.pitch = v; engine.setRoomEuler(align) })
  bindNumber('al-roll', (v) => { align.roll = v; engine.setRoomEuler(align) })
  bindNumber('al-x', (v) => engine.setRoomPosition(0, v))
  bindNumber('al-y', (v) => engine.setRoomPosition(1, v))
  bindNumber('al-z', (v) => engine.setRoomPosition(2, v))
  bindNumber('al-scale', (v) => engine.setRoomScale(v))
  for (const k of ['w', 'd', 'h']) bindNumber(`ph-${k}`, (v) => engine.setPlaceholderSize(k, v))
  $('al-flip').onclick = () => {
    align.pitch = wrapDeg(align.pitch + 180)
    engine.setRoomEuler(align)
    syncRoomUI()
  }
  $('al-floor').onclick = () => engine.startPickMode('floor')
  $('al-two').onclick = () => engine.startPickMode('two')
  const applyTwo = () => engine.applyTwoPointScale(parseFloat($('al-two-dist').value))
  $('al-two-apply').onclick = applyTwo
  $('al-two-dist').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyTwo() })
  $('room-save').onclick = () => quiet(engine.saveRoom())
  $('room-revert').onclick = () => quiet(engine.revertRoom())
  const loadScanFromField = () => quiet(engine.loadScanPath($('scan-url').value.trim()))
  $('scan-load').onclick = loadScanFromField
  $('scan-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadScanFromField() })
  $('look-exposure').addEventListener('input', () => { const v = parseFloat($('look-exposure').value); if (Number.isFinite(v)) engine.setLook({ exposure: round(2 ** v, 4) }) })
  $('look-warmth').addEventListener('input', () => { const v = parseFloat($('look-warmth').value); if (Number.isFinite(v)) engine.setLook({ warmth: round(v, 3) }) })
  $('look-shadows').addEventListener('change', () => engine.setContactShadows($('look-shadows').checked))
  $('look-reset').onclick = () => engine.setLook({ ...LOOK_DEFAULT })
  $('look-relight').onclick = () => quiet(engine.relightInternal(null).then(() => toast('Lit the furniture from the room center.', 'ok', 2500)))

  // --- layouts ------------------------------------------------------------------------------------
  on('layouts', (d) => {
    if (d.name != null) $('layout-name').value = d.name
    if (!d.names) return
    $('layout-list').replaceChildren(...d.names.map((n) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.textContent = n
      b.title = `Load layout ${n}`
      b.onclick = () => quiet(engine.loadLayoutInternal(n).then(() => toast(`Loaded layout "${n}"`, 'ok', 2500)))
      li.append(b)
      return li
    }))
  })
  engine.setLayoutName($('layout-name').value)
  $('layout-name').addEventListener('input', () => engine.setLayoutName($('layout-name').value))
  $('layout-save').onclick = () => {
    const name = $('layout-name').value.trim()
    quiet(engine.saveLayoutInternal(name).then(() => toast(`Saved layout "${name}"`, 'ok', 2500)))
  }
  $('layout-load').onclick = () => {
    const name = $('layout-name').value.trim()
    quiet(engine.loadLayoutInternal(name).then(() => toast(`Loaded layout "${name}"`, 'ok', 2500)))
  }
  $('layout-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('layout-save').click() })

  // --- toolbar + selection bar ----------------------------------------------------------------------
  for (const b of document.querySelectorAll('#toolbar [data-view]')) b.onclick = () => engine.setViewInternal(b.dataset.view)
  $('tool-measure').onclick = () => engine.setMeasureActive(!engine.getMeasureState().active)
  $('tool-frame').onclick = () => { engine.setViewInternal('orbit'); engine.frameRoom() }
  $('sel-move').onclick = () => engine.setGizmoMode('translate')
  $('sel-rotate').onclick = () => engine.setGizmoMode('rotate')
  $('sel-ccw').onclick = () => engine.rotateSelected(15)
  $('sel-cw').onclick = () => engine.rotateSelected(-15)
  $('sel-glb').onclick = () => quiet(engine.toggleRender(engine.getSelected(), 'glb'))
  $('sel-splat').onclick = () => quiet(engine.toggleRender(engine.getSelected(), 'splat'))
  $('sel-remove').onclick = () => { const uid = engine.getSelected(); if (uid) engine.removeItemInternal(uid) }
  $('sel-relight').onclick = () => {
    const uid = engine.getSelected()
    const rec = uid && engine.getItem(uid)
    if (!rec) return
    const p = [round(rec.position[0], 4), 1.0, round(rec.position[2], 4)]
    quiet(engine.relightInternal(p).then(() => toast(`Lit the furniture from ${rec.name}'s spot.`, 'ok', 2500)))
  }
  $('collapse').onclick = () => { $('sidebar').classList.add('collapsed'); $('expand').hidden = false; updateInset() }
  $('expand').onclick = () => { $('sidebar').classList.remove('collapsed'); $('expand').hidden = true; updateInset() }

  // --- render this view (contract §2.6.5) ----------------------------------------------------------
  function openRenderViewer(meta) {
    $('rv-title').textContent = meta.name
    const bits = [RENDER_MODELS[meta.model]?.label || meta.model, meta.mock ? 'mock, $0' : fmtUsd(meta.cost_usd || 0)]
    if (meta.view) bits.push(meta.view)
    if (meta.layout) bits.push(`layout ${meta.layout}`)
    $('rv-meta').textContent = bits.join(' · ')
    $('rv-input').src = meta.input_url
    $('rv-result').src = meta.url
    $('rv-open').href = meta.url
    $('render-view').hidden = false
  }
  function closeRenderViewer() { $('render-view').hidden = true }

  function renderRendersUI(renders) {
    $('render-count').textContent = renders.length ? `(${renders.length})` : ''
    $('render-empty').hidden = renders.length > 0
    $('render-list').replaceChildren(...renders.map((m) => {
      const li = document.createElement('li')
      li.title = `Open ${m.name}`
      const img = document.createElement('img')
      img.className = 'thumb'
      img.alt = ''
      img.loading = 'lazy'
      img.src = m.url
      const meta = document.createElement('div'); meta.className = 'meta'
      const nm = document.createElement('span'); nm.className = 'name'
      nm.textContent = (m.created || m.name).replace('T', ' ').replace(/(\d\d:\d\d):\d\d.*$/, '$1')
      const dm = document.createElement('span'); dm.className = 'dims'
      dm.textContent = `${m.model}${m.view ? ` · ${m.view}` : ''} · ${m.mock ? 'mock' : fmtUsd(m.cost_usd || 0)}`
      meta.append(nm, dm)
      li.append(img, meta)
      li.onclick = () => openRenderViewer(m)
      return li
    }))
  }
  on('renders', (d) => renderRendersUI(d.renders || engine.getRenders()))

  // Confirm dialog: capture first, so the preview is exactly what gets sent.
  let pendingShot = null
  function openRenderConfirm() {
    try { pendingShot = engine.captureView() } catch (e) { engine.reportError('Could not capture the view', e); return }
    $('rc-preview').src = pendingShot.dataUrl
    if (!$('rc-prompt').value.trim()) $('rc-prompt').value = DEFAULT_RENDER_PROMPT
    $('rc-go').disabled = false
    updateRenderPrice()
    $('render-confirm').hidden = false
  }
  function closeRenderConfirm() {
    $('render-confirm').hidden = true
    pendingShot = null
  }
  function updateRenderPrice() {
    const model = $('rc-model').value
    const price = renderPrice(model, pendingShot)
    const mock = engine.isRenderMock()
    const size = pendingShot ? `${pendingShot.width} × ${pendingShot.height} px` : ''
    $('rc-price').textContent = mock ? 'mock mode: $0' : `about ${fmtUsd(price)}`
    $('rc-note').textContent = `${size} JPEG to fal (${RENDER_MODELS[model].label}). ${mock ? 'NOOK_FAL_MOCK is set: the result is a copy of the input.' : 'The FAL key stays on the server.'}`
    $('rc-go').textContent = mock ? 'Render (mock, $0)' : `Render · ${fmtUsd(price)}`
  }
  function confirmRender() {
    if (!pendingShot) return
    const shot = pendingShot
    const model = $('rc-model').value
    const prompt = $('rc-prompt').value.trim()
    $('rc-go').disabled = true
    $('rc-go').textContent = 'Rendering…'
    $('tool-render').disabled = true
    $('tool-render').textContent = 'Rendering…'
    quiet(engine.postRender(shot, model, prompt && prompt !== DEFAULT_RENDER_PROMPT ? prompt : undefined)
      .then((meta) => {
        closeRenderConfirm()
        openRenderViewer(meta)
        $('sec-renders').open = true
      })
      .finally(() => {
        $('rc-go').disabled = false
        updateRenderPrice()
        $('tool-render').disabled = false
        $('tool-render').textContent = 'Render'
      }))
  }
  $('tool-render').onclick = () => quiet(engine.idle().then(openRenderConfirm))
  $('rc-model').replaceChildren(...Object.entries(RENDER_MODELS).map(([k, m]) => {
    const o = document.createElement('option')
    o.value = k
    o.textContent = `${m.label} (${k === 'qwen' ? '$0.03/MP' : fmtUsd(m.price(1))})`
    return o
  }))
  $('rc-model').onchange = updateRenderPrice
  $('rc-cancel').onclick = closeRenderConfirm
  $('rc-go').onclick = confirmRender
  $('rv-close').onclick = closeRenderViewer
  for (const id of ['render-confirm', 'render-view']) {
    $(id).addEventListener('pointerdown', (e) => { if (e.target === $(id)) (id === 'render-view' ? closeRenderViewer : closeRenderConfirm)() })
  }
  // While a dialog is open, the only key is Esc, to close it.
  input?.setKeyFilter((e) => {
    if ($('render-confirm').hidden && $('render-view').hidden) return false
    if (e.key === 'Escape') { closeRenderConfirm(); closeRenderViewer() }
    return true
  })

  // --- drag-and-drop a scan to use it as the room for this session ----------------------------------
  let dragDepth = 0
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false })
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    $('drop').hidden = true
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    quiet(engine.dropScanFile(file))
  })

  // --- floating tags: the selected item's label and the measurement ---------------------------------
  function placeTag(el, world, lift = 0) {
    const s = engine.worldToScreen(world)
    el.style.visibility = s.visible ? 'visible' : 'hidden'
    if (!s.visible) return
    el.style.left = `${s.x}px`
    el.style.top = `${s.y - lift}px`
  }
  engine.onFrame(() => {
    const uid = engine.getSelected()
    if (uid && !$('item-label').hidden) {
      const b = engine.getItemBounds(uid)
      if (b) placeTag($('item-label'), [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2], 10)
    }
    const m = engine.getMeasure()
    if (m) placeTag($('measure-label'), [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2])
  })

  syncRoomUI()
}
