// nook planner input: pointer (mouse, pen, touch) and keyboard handling on top of the engine API (engine.js).
// installInput(engine) → { enabled: { pointer, keyboard }, setKeyFilter(fn), hold(key, on), held(), onKeys(fn), dispose() }
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off. OrbitControls stays on.
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open).
//   hold('w'|'a'|'s'|'d', on)            press or release a walk key from the UI (the clickable WASD keycaps)
//   held() → Set of walk keys down;      onKeys(fn) → unsubscribe; fn(held) whenever it changes
// Pointer, one gesture at a time: a drag that starts on the selected item (its box on screen, plus 16 px on touch)
// moves it on the floor; anything else orbits (OrbitControls: one finger turns, two pan and pinch) or, in first person,
// looks. A tap (no drag, one finger) picks, measures, selects, or in first person walks there.
// Keys: R / Shift+R rotate 15°, Delete/Backspace remove, Esc leaves a mode or deselects, M measure, F frame, 1 2 3 views,
// [ ] scan viewpoints, WASD/arrows walk (Shift faster), hold Shift to snap moves (5 cm) and the rotate grip (15°).
import { VIEWS } from './engine.js'

const TAP_PX = { mouse: 4, pen: 6, touch: 10 }
const WALK = ['w', 'a', 's', 'd']

export function installInput(engine) {
  const canvas = engine.canvas
  const enabled = { pointer: true, keyboard: true }
  let keyFilter = null
  const keys = new Set()
  const ui = new Set() // walk keys held from the UI
  const keyFns = new Set()
  const off = []
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); off.push(() => target.removeEventListener(type, fn, opts)) }

  // Walking: recomputed from the held keys whenever they change; the engine applies it every frame.
  const has = (k) => keys.has(k) || ui.has(k)
  const held = () => new Set(WALK.filter((k) => has(k) || has({ w: 'arrowup', a: 'arrowleft', s: 'arrowdown', d: 'arrowright' }[k])))
  const syncMove = () => {
    const forward = (has('w') || has('arrowup') ? 1 : 0) - (has('s') || has('arrowdown') ? 1 : 0)
    const side = (has('d') || has('arrowright') ? 1 : 0) - (has('a') || has('arrowleft') ? 1 : 0)
    engine.setMove({ forward, side, fast: keys.has('shift') })
    const h = held()
    for (const fn of keyFns) fn(h)
  }

  // --- pointer (capture phase on window, so it runs before OrbitControls sees the event on the canvas)
  const ptrs = new Set()
  let g = null // the gesture: { id, kind: 'item'|'look'|'other', x0, y0, lx, ly, t0, type, moved, multi }
  const busy = () => engine.getPick().mode || engine.getMeasureState().active
  on(window, 'pointerdown', (e) => {
    if (!enabled.pointer || e.target !== canvas) return
    if (e.pointerType === 'mouse' && e.button !== 0) return // right button: OrbitControls pans
    ptrs.add(e.pointerId)
    if (ptrs.size > 1) { if (g) g.multi = true; return }
    g = { id: e.pointerId, kind: 'other', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), type: e.pointerType, moved: false, multi: false }
    const sel = engine.getSelected()
    const pad = e.pointerType === 'mouse' ? 6 : 16
    if (sel && !busy() && engine.hitItemAt(sel, e.clientX, e.clientY, pad) && engine.beginItemDrag(sel, e.clientX, e.clientY)) g.kind = 'item'
    else if (engine.getView() !== 'orbit') g.kind = 'look'
    if (g.kind !== 'other') canvas.setPointerCapture?.(e.pointerId)
  }, true)
  on(window, 'pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > (TAP_PX[g.type] ?? 6)) g.moved = true
    if (g.kind === 'item') engine.dragTo(e.clientX, e.clientY)
    else if (g.kind === 'look' && !g.multi && g.moved) engine.lookBy(e.clientX - g.lx, e.clientY - g.ly)
    g.lx = e.clientX
    g.ly = e.clientY
  }, true)
  const up = (e) => {
    if (!ptrs.delete(e.pointerId) || !g || ptrs.size) return
    const d = g
    g = null
    if (d.kind === 'item') engine.endItemDrag()
    const quick = d.type === 'mouse' || performance.now() - d.t0 < 700
    if (e.type !== 'pointerup' || d.moved || d.multi || !quick) return
    try { engine.tap(e.clientX, e.clientY) } catch (err) { engine.reportError('Tap failed', err) }
  }
  on(window, 'pointerup', up, true)
  on(window, 'pointercancel', up, true)

  // --- keyboard
  const typing = (e) => {
    const t = e.target
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  }
  on(window, 'keydown', (e) => {
    if (!enabled.keyboard) return
    const k = e.key.toLowerCase()
    if (k === 'shift') engine.setSnap(true)
    if (keyFilter && keyFilter(e)) return
    if (typing(e)) {
      if (e.key === 'Escape') e.target.blur()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    keys.add(k)
    syncMove()
    const selected = engine.getSelected()
    if (k === 'escape') {
      if (engine.getPick().mode || engine.getPick().points) engine.cancelPickMode()
      else if (engine.getMeasureState().active) { engine.clearMeasure(); engine.setMeasureActive(false) }
      else engine.select(null)
    } else if (k === 'delete' || k === 'backspace') {
      if (selected) { e.preventDefault(); engine.removeItemInternal(selected) }
    } else if (k === 'r') {
      engine.rotateSelected(e.shiftKey ? -15 : 15)
    } else if (k === 'm') {
      const active = !engine.getMeasureState().active
      if (!active) engine.clearMeasure()
      engine.setMeasureActive(active)
    } else if (k === 'f') {
      if (engine.getView() !== 'orbit') engine.setViewInternal('orbit')
      engine.frameRoom()
    } else if (k === '1' || k === '2' || k === '3') {
      engine.setViewInternal(VIEWS[Number(k) - 1])
    } else if (k === '[' || k === ']') {
      engine.stepViewpoint(k === ']' ? 1 : -1, { glide: engine.getView() !== 'orbit' })
    }
    if (engine.getView() !== 'orbit' && k.startsWith('arrow')) e.preventDefault()
  })
  on(window, 'keyup', (e) => {
    const k = e.key.toLowerCase()
    keys.delete(k)
    syncMove()
    if (k === 'shift') engine.setSnap(false)
  })
  on(window, 'blur', () => { keys.clear(); ui.clear(); syncMove(); engine.setSnap(false) })

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    hold: (k, down) => { if (!WALK.includes(k)) return; if (down) ui.add(k); else ui.delete(k); syncMove() },
    held,
    onKeys: (fn) => { keyFns.add(fn); return () => keyFns.delete(fn) },
    dispose: () => { for (const f of off.splice(0)) f(); keys.clear(); ui.clear(); syncMove() },
  }
}
