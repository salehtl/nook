// Panel (area C): Room. On top the Check room card: measured W × D × H, floor tilt ("Level 0.2°" with a check, or
// "Tilted 1.8°"), Pick floor, Check size and Save room (with the "Not saved · kakapo isn't answering" + Retry state).
// Below: the 50 cm grid, Fine-tune (yaw/pitch/roll/x/y/z/scale: steppers on the phone, number fields on the desktop,
// plus Flip upside down) and Look (exposure, warmth, contact shadows, Relight; a sub-view on the phone). The "…" menu
// holds Flip and Revert… (confirmed). The phone sheet opens at peek with just the Check room card.
// Frames C4 (phone), C6 Room (desktop), B4 (the peek card). Pick modes: engine.startPickMode; the workspace draws them.
import * as THREE from 'three'
import { quiet, round, wrapDeg } from '../../engine.js'
import { pic, withIcon, numberControl, isOffline, OFFLINE_BODY } from './common.js'
import { friendlyDate } from '../../data.js'

const DEG = Math.PI / 180
const LEVEL_DEG = 0.5 // at or under this floor tilt reads "Level"

// The yaw/pitch/roll the engine shows for a quaternion (same decomposition as engine.getRoomEuler).
function eulerOf(q) {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(q || [0, 0, 0, 1]).normalize(), 'YXZ')
  let yaw = e.y / DEG, pitch = e.x / DEG, roll = e.z / DEG
  if (Math.abs(roll) > 90) { yaw = wrapDeg(yaw + 180); pitch = wrapDeg(180 - pitch); roll = wrapDeg(roll + 180) }
  return { yaw, pitch, roll }
}
const fmtM = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–')
const warmthWord = (w) => (Math.abs(w) < 0.005 ? 'Neutral' : `${w > 0 ? 'Warm' : 'Cool'} ${Math.abs(w).toFixed(2)}`)

export function mount({ engine, data, shell, kit, icons }) {
  const { h, button, toggle, slider } = kit
  let view = 'main'          // phone: 'main' | 'look' (the Look sub-view)
  let fineOpen = false
  let lookOpen = false       // desktop disclosure
  let failure = null         // { offline, message }
  let saving = false
  let relighting = false
  let pickFromPanel = false  // the phone sheet closed for a pick; reopen it after

  const panel = shell.registerPanel({
    id: 'room', label: 'Room', icon: 'room', phoneDetent: 'peek', mount: () => {},
    onClose: () => { if (view === 'look') { view = 'main'; render() } },
  })
  panel.body.classList.add('rp')

  // --- head: back (Look sub-view), unsaved status, Fine-tune (phone peek), "…" -----------------------------------
  const back = h('button.rp-back', { type: 'button', hidden: true, onclick: () => { view = 'main'; render() } }, pic('chevron-left', { size: 18 }), h('span', 'Room'))
  panel.head.querySelector('.panel-title-wrap')?.prepend(back)
  const fineBtn = withIcon(button({ label: 'Fine-tune', kind: 'quiet', onClick: () => { fineOpen = true; view = 'main'; shell.setDetent('full'); render() } }), 'sliders')
  fineBtn.classList.add('rp-fine-btn')
  const moreBtn = h('button.btn.btn-icon.btn-quiet.rp-more', { type: 'button', 'aria-label': 'More room actions', 'aria-haspopup': 'menu', dataset: { tip: 'More' },
    onclick: (e) => shell.menu(e.currentTarget, [
      { label: 'Flip upside down', icon: 'flip', disabled: !isSplat(), onSelect: flip },
      '-',
      { label: 'Revert…', icon: 'revert', danger: true, disabled: !engine.isRoomDirty(), onSelect: () => quiet(revert()) },
    ], { align: 'end' }) }, pic('more', { size: 18 }))
  panel.actions.append(fineBtn, moreBtn)

  const isSplat = () => engine.getRoom().kind === 'splat'
  const roomTitle = () => { const n = engine.getRoomName(); return (n && data.getRoom(n)?.title) || (isSplat() ? 'this room' : 'the placeholder room') }

  // --- actions ---------------------------------------------------------------------------------------------------
  async function saveRoom() {
    if (saving) return
    saving = true
    failure = null
    sync()
    try {
      await engine.saveRoom()
    } catch (e) {
      failure = { offline: isOffline(e), message: e.message }
    } finally {
      saving = false
      render()
    }
  }

  async function revert() {
    const saved = engine.getSavedRoomConfig()?.saved
    const n = fineChanges().length
    const body = `Goes back to the alignment and look ${saved ? `saved ${friendlyDate(saved)}` : 'last saved'}.${n ? ` ${n} fine-tune change${n === 1 ? ' is' : 's are'} lost.` : ''} Furniture stays put.`
    const ok = await shell.confirm(shell.isPhone()
      ? { title: `Revert ${roomTitle()}?`, body, actions: [{ label: 'Revert', value: true, kind: 'danger', default: true }, { label: 'Keep changes', value: false, cancel: true }] }
      : { title: `Revert ${roomTitle()}?`, body, icon: 'revert', danger: true, confirm: 'Revert', cancel: 'Keep changes' })
    if (!ok) return
    failure = null
    try { await engine.revertRoom() } catch { /* reported */ }
    shell.toast('Room reverted to the last save', { id: 'room-reverted' })
  }

  function flip() {
    const e = engine.getRoomEuler()
    engine.setRoomEuler({ yaw: e.yaw, pitch: wrapDeg(e.pitch + 180), roll: e.roll })
    sync()
  }

  function pick(mode) {
    if (!isSplat()) { shell.toast('Open a room scan first; the placeholder room is already level.', { id: 'pick-placeholder' }); return }
    engine.startPickMode(mode)
    if (engine.getPick().mode !== mode) return
    if (shell.isPhone()) { pickFromPanel = true; shell.closePanel() }
  }

  // --- Check room card -----------------------------------------------------------------------------------------
  const sizeValue = h('span.rp-size.tnum')
  const tiltGlyph = h('span.rp-tilt-glyph')
  const tiltWord = h('span.rp-tilt-word')
  const tiltDeg = h('span.rp-tilt-deg.tnum')
  const tilt = h('span.rp-tilt', tiltGlyph, tiltWord, h('span.rp-tilt-desk', 'floor tilt'), tiltDeg)
  const readouts = h('div.rp-read',
    h('div.rp-read-size', h('span.caps', 'Measured · W × D × H'), sizeValue),
    h('div.rp-read-tilt', h('span.caps', 'Floor tilt'), tilt))
  const pickFloor = withIcon(button({ label: 'Pick floor', kind: 'secondary', onClick: () => pick('floor') }), 'pick-floor')
  const checkSize = withIcon(button({ label: 'Check size', kind: 'secondary', onClick: () => pick('two') }), 'check-size')
  pickFloor.dataset.tip = 'Tap open floor to set the floor height'
  checkSize.dataset.tip = 'Two points and their real distance set the scale'
  const failBox = h('div.p-fail', { role: 'alert' })
  const saveBtn = button({ label: 'Save room', kind: 'primary', block: true, onClick: () => quiet(saveRoom()) })
  const card = h('section.p-card.rp-card', { 'aria-label': 'Check room' }, readouts, h('div.rp-tools', pickFloor, checkSize), failBox, saveBtn)

  // --- rows: grid, Fine-tune, Look ------------------------------------------------------------------------------
  const grid = toggle({ label: '50 cm grid', hint: 'Floor lines, to see it\'s level', checked: engine.getGridVisible(), onChange: (on) => engine.setGridVisible(on) })
  grid.classList.add('rp-row')
  const fineCount = h('span.rp-changed.tnum')
  const fineHint = h('span.toggle-hint.rp-fine-hint', 'Turn, tilt, shift, scale by numbers')
  const fineChevron = h('span.rp-chev')
  const fineRow = h('button.rp-row.rp-disclose', { type: 'button', 'aria-expanded': 'false', onclick: () => {
    fineOpen = !fineOpen
    if (fineOpen && shell.isPhone() && shell.getOpenPanel()?.detent !== 'full') shell.setDetent('full')
    render()
  } }, h('span.toggle-text', h('span.toggle-label', 'Fine-tune'), fineHint), fineCount, fineChevron)
  const fineBody = h('div.rp-fine')
  const lookSummary = h('span.toggle-hint.rp-look-sum.tnum')
  const lookChevron = h('span.rp-chev')
  const lookRow = h('button.rp-row.rp-disclose', { type: 'button', onclick: () => {
    if (shell.isPhone()) { view = 'look'; if (shell.getOpenPanel()?.detent === 'peek') shell.setDetent('half') } else lookOpen = !lookOpen
    render()
  } }, h('span.toggle-text', h('span.toggle-label', 'Look'), lookSummary), lookChevron)
  const lookBody = h('div.rp-look')
  const lookSave = button({ label: 'Save room', kind: 'primary', block: true, onClick: () => quiet(saveRoom()) })

  // --- Fine-tune controls -----------------------------------------------------------------------------------------
  let controls = []
  const saved = () => engine.getSavedRoomConfig() || {}
  const savedT = () => saved().transform || { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }
  function fineSpecs() {
    const e = () => engine.getRoomEuler()
    const setE = (k) => (v) => engine.setRoomEuler({ ...e(), [k]: v })
    if (!isSplat()) {
      const ph = () => engine.getRoomConfig().placeholder
      const sp = saved().placeholder || {}
      return ['w', 'd', 'h'].map((k) => ({ key: k, label: { w: 'Width', d: 'Depth', h: 'Height' }[k], unit: ' m', step: 0.05, digits: 2, min: 0.5, max: 50,
        get: () => ph()[k], set: (v) => engine.setPlaceholderSize(k, round(v, 3)), changed: () => sp[k] != null && Math.abs(ph()[k] - sp[k]) > 1e-4 }))
    }
    const se = () => eulerOf(savedT().quaternion)
    const ang = (k, label) => ({ key: k, label, unit: '°', step: 0.5, digits: 1, get: () => e()[k], set: setE(k), changed: () => Math.abs(wrapDeg(e()[k] - se()[k])) > 0.05 })
    const pos = (i, label) => ({ key: 'xyz'[i], label, unit: ' m', step: 0.01, digits: 2, get: () => engine.getRoomConfig().transform.position[i],
      set: (v) => engine.setRoomPosition(i, round(v, 5)), changed: () => Math.abs(engine.getRoomConfig().transform.position[i] - (savedT().position?.[i] ?? 0)) > 5e-4 })
    const phone = shell.isPhone()
    const order = phone
      ? [ang('yaw', 'Yaw'), pos(0, 'X'), ang('pitch', 'Pitch'), pos(1, 'Y · floor'), ang('roll', 'Roll'), pos(2, 'Z')]
      : [ang('yaw', 'Yaw'), ang('pitch', 'Pitch'), ang('roll', 'Roll'), pos(0, 'X'), pos(1, 'Y (floor)'), pos(2, 'Z')]
    order.push({ key: 'scale', label: 'Scale', unit: '×', step: 0.001, digits: 3, min: 0.01, max: 100, get: () => engine.getRoomConfig().transform.scale,
      set: (v) => engine.setRoomScale(round(v, 6)), changed: () => Math.abs(engine.getRoomConfig().transform.scale - (savedT().scale ?? 1)) > 5e-4 })
    return order
  }
  const fineChanges = () => controls.filter((c) => c.spec.changed())
  function buildFine() {
    const mode = shell.isPhone() ? 'phone' : 'desktop'
    controls = fineSpecs().map((spec) => ({ spec, el: numberControl({ ...spec, mode }) }))
    const flipBtn = withIcon(button({ label: 'Flip upside down', kind: 'secondary', block: true, onClick: flip }), 'flip')
    fineBody.replaceChildren(h(`div.rp-grid.is-${mode}`, controls.map((c) => c.el)), isSplat() ? flipBtn : h('p.p-note', 'The placeholder room: set its size here. Open a room scan to align it.'))
  }

  // --- Look controls ------------------------------------------------------------------------------------------------
  const exposure = slider({ label: 'Exposure', min: -2, max: 2, step: 0.01, value: 0, format: (v) => `${(2 ** v).toFixed(2)}×`,
    onInput: (v) => engine.setLook({ exposure: round(2 ** (Math.abs(v) < 0.03 ? 0 : v), 3) }) })
  exposure.append(h('div.rp-ticks', h('span', '0.25×'), h('span', '1×'), h('span', '4×')))
  const warmth = slider({ label: 'Warmth', min: -1, max: 1, step: 0.01, value: 0, format: warmthWord,
    onInput: (v) => engine.setLook({ warmth: round(Math.abs(v) < 0.03 ? 0 : v, 2) }) })
  warmth.classList.add('is-warmth')
  warmth.append(h('div.rp-ticks', h('span', 'Cool'), h('span', 'Warm')))
  for (const s of [exposure, warmth]) s.input.addEventListener('dblclick', () => engine.setLook(s === exposure ? { exposure: 1 } : { warmth: 0 }))
  const shadows = toggle({ label: 'Contact shadows', checked: true, onChange: (on) => engine.setContactShadows(on) })
  const relightBtn = button({ label: 'Relight', kind: 'secondary', onClick: async () => {
    relighting = true; syncLook()
    try { await engine.relightInternal(null) } catch { /* reported */ }
    relighting = false; syncLook()
    shell.toast('Furniture relit from the room centre', { kind: 'ok', id: 'relit' })
  } })
  const relight = h('div.rp-relight', h('span.toggle-text', h('span.toggle-label', 'Relight furniture'), h('span.toggle-hint', 'Bakes the scan\'s light onto items again, from the room centre.')), relightBtn)
  lookBody.append(exposure, warmth, shadows, relight)

  // --- layout ---------------------------------------------------------------------------------------------------
  function render() {
    const phone = shell.isPhone()
    if (!phone) view = 'main'
    buildFine()
    if (view === 'look') {
      panel.body.replaceChildren(lookBody, lookSave)
    } else {
      const parts = [card, grid, fineRow]
      if (fineOpen) parts.push(fineBody)
      parts.push(lookRow)
      if (!phone && lookOpen) parts.push(lookBody)
      panel.body.replaceChildren(...parts)
    }
    sync()
  }

  function syncHead() {
    const phone = shell.isPhone()
    const det = phone ? shell.getOpenPanel()?.id === 'room' && shell.getOpenPanel().detent : null
    panel.setTitle(view === 'look' ? 'Look' : det === 'peek' ? 'Check room' : 'Room')
    back.hidden = view !== 'look'
    panel.body.dataset.view = view
    const dirty = engine.isRoomDirty()
    panel.setStatus(failure ? h('span.rp-status.is-failed', pic('warning', { size: 14 }), 'Not saved')
      : dirty && det !== 'peek' ? h('span.rp-status', icons.unsavedGlyph(14), 'Unsaved') : null)
  }

  function syncLook() {
    const l = engine.getLook()
    if (document.activeElement !== exposure.input) exposure.set(Math.log2(l.exposure))
    if (document.activeElement !== warmth.input) warmth.set(l.warmth)
    exposure.classList.toggle('is-changed', Math.abs(l.exposure - 1) > 1e-3)
    warmth.classList.toggle('is-changed', Math.abs(l.warmth) > 1e-3)
    shadows.input.checked = !!l.contactShadows
    relightBtn.disabled = relighting || l.roomKind !== 'splat'
    relightBtn.lastChild.textContent = relighting ? 'Relighting…' : 'Relight'
    lookSummary.textContent = `${shell.isPhone() ? 'Exposure ' : ''}${l.exposure.toFixed(2)}× · ${warmthWord(l.warmth).toLowerCase()} · shadows ${l.contactShadows ? 'on' : 'off'}`
  }

  function sync() {
    syncHead()
    const splat = isSplat()
    const s = engine.getRoomSize()
    sizeValue.textContent = `${fmtM(s.w)} × ${fmtM(s.d)} × ${fmtM(s.h)} m`
    const t = engine.getFloorTilt()
    const level = !splat || t <= LEVEL_DEG
    tilt.classList.toggle('is-level', level)
    tilt.classList.toggle('is-tilted', !level)
    tiltGlyph.replaceChildren(pic(level ? 'check-circle' : 'tilt', { size: 18 }))
    tiltWord.textContent = level ? 'Level' : 'Tilted'
    tiltDeg.textContent = `${(splat ? t : 0).toFixed(1)}°`
    pickFloor.disabled = checkSize.disabled = !splat
    const pickMode = engine.getPick().mode
    pickFloor.setAttribute('aria-pressed', String(pickMode === 'floor'))
    checkSize.setAttribute('aria-pressed', String(pickMode === 'two'))
    card.classList.toggle('is-failed', !!failure)
    failBox.hidden = !failure
    if (failure) {
      failBox.replaceChildren(h('span.p-fail-title', pic('warning', { size: 16 }), h('span', failure.offline ? "Not saved · kakapo isn't answering" : 'Not saved')),
        h('span.p-fail-body', failure.offline ? OFFLINE_BODY : failure.message))
    }
    for (const b of [saveBtn, lookSave]) {
      b.replaceChildren(...(failure && !saving ? [pic('retry', { size: 18 }), h('span', 'Retry')] : [h('span', saving ? 'Saving…' : 'Save room')]))
      b.disabled = saving
      b.classList.toggle('is-quiet-save', !engine.isRoomDirty() && !failure)
    }
    for (const c of controls) c.el.sync(c.spec.changed())
    const n = fineChanges().length
    fineCount.textContent = n ? `${n} changed` : ''
    fineHint.hidden = fineOpen || (n > 0 && shell.isPhone())
    fineRow.setAttribute('aria-expanded', String(fineOpen))
    fineChevron.replaceChildren(pic(fineOpen ? 'chevron-down' : shell.isPhone() ? 'chevron-right' : 'chevron-right', { size: 18 }))
    lookRow.setAttribute('aria-expanded', String(!shell.isPhone() && lookOpen))
    lookChevron.replaceChildren(pic(!shell.isPhone() && lookOpen ? 'chevron-down' : 'chevron-right', { size: 18 }))
    grid.input.checked = engine.getGridVisible()
    syncLook()
  }

  engine.events.addEventListener('room', (e) => {
    const p = e.detail.phase
    if (p === 'edit') return sync()
    if (p === 'loaded' || p === 'failed' || p === 'missing') { failure = null; fineOpen = fineOpen && isSplat() }
    if (p === 'saved') failure = null
    if (p !== 'loading') render()
  })
  engine.events.addEventListener('dirty', sync)
  engine.events.addEventListener('look', syncLook)
  engine.events.addEventListener('grid', () => { grid.input.checked = engine.getGridVisible() })
  engine.events.addEventListener('pick', (e) => {
    sync()
    if (e.detail.phase === 'cancel' && pickFromPanel) { pickFromPanel = false; if (shell.isPhone() && !shell.getOpenPanel()) shell.openPanel('room', { detent: 'peek' }) }
  })
  data.events.addEventListener('rooms', syncHead)
  shell.events.addEventListener('mode', render)
  shell.events.addEventListener('panel', (e) => { if (e.detail.id === 'room') syncHead() })
  render()
}
