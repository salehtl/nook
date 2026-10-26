// nook planner input: mouse/pen pointer and keyboard handling on top of the engine API (engine.js).
// installInput(engine) → { enabled: { pointer, keyboard }, setKeyFilter(fn), dispose() }
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off (e.g. a touch UI driving engine.tap,
//                                        engine.lookBy and engine.setMove itself). OrbitControls and the gizmo stay on.
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open).
// Keys: R / Shift+R rotate 15°, G gizmo mode, Delete/Backspace remove, Esc clear, M measure, F frame, 1 2 3 views,
// [ ] scan viewpoints, WASD/arrows walk (Shift faster), hold Shift to snap the gizmo.
import { VIEWS } from './engine.js'

export function installInput(engine) {
  const canvas = engine.canvas
  const enabled = { pointer: true, keyboard: true }
  let keyFilter = null
  const keys = new Set()
  const off = []
  const on = (target, type, fn) => { target.addEventListener(type, fn); off.push(() => target.removeEventListener(type, fn)) }

  // Walking: recomputed from the held keys whenever they change; the engine applies it every frame.
  const syncMove = () => {
    const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0)
    const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0)
    engine.setMove({ forward, side, fast: keys.has('shift') })
  }

  // --- pointer: drag to look in first person, click to pick / measure / select
  let down = null
  on(canvas, 'pointerdown', (e) => {
    if (!enabled.pointer || e.button !== 0) return
    down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, gizmo: engine.isGizmoActive(), moved: false }
    if (engine.getView() !== 'orbit' && !down.gizmo) canvas.setPointerCapture?.(e.pointerId)
  })
  on(canvas, 'pointermove', (e) => {
    if (!down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true
    if (engine.getView() !== 'orbit' && !down.gizmo && !engine.isGizmoDragging()) {
      engine.lookBy(e.clientX - down.lx, e.clientY - down.ly)
    }
    down.lx = e.clientX; down.ly = e.clientY
  })
  on(window, 'pointerup', (e) => {
    const d = down
    down = null
    if (!d || e.button !== 0 || d.moved || d.gizmo || e.target !== canvas) return
    try {
      engine.tap(e.clientX, e.clientY)
    } catch (err) {
      engine.reportError('Click failed', err)
    }
  })

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
    keys.add(k)
    syncMove()
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const selected = engine.getSelected()
    if (k === 'escape') {
      engine.cancelPickMode()
      engine.clearMeasure()
      engine.setMeasureActive(false)
      engine.select(null)
    } else if (k === 'delete' || k === 'backspace') {
      if (selected) { e.preventDefault(); engine.removeItemInternal(selected) }
    } else if (k === 'r') {
      engine.rotateSelected(e.shiftKey ? -15 : 15)
    } else if (k === 'g') {
      if (selected) engine.setGizmoMode(engine.getGizmoMode() === 'translate' ? 'rotate' : 'translate')
    } else if (k === 'm') {
      engine.setMeasureActive(!engine.getMeasureState().active)
    } else if (k === 'f') {
      if (engine.getView() === 'orbit') engine.frameRoom()
    } else if (k === '1' || k === '2' || k === '3') {
      engine.setViewInternal(VIEWS[Number(k) - 1])
    } else if (k === '[' || k === ']') {
      engine.stepViewpoint(k === ']' ? 1 : -1)
    }
    if (engine.getView() !== 'orbit' && k.startsWith('arrow')) e.preventDefault()
  })
  on(window, 'keyup', (e) => {
    const k = e.key.toLowerCase()
    keys.delete(k)
    syncMove()
    if (k === 'shift') engine.setSnap(false)
  })
  on(window, 'blur', () => { keys.clear(); syncMove() })

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    dispose: () => { for (const f of off.splice(0)) f(); keys.clear(); syncMove() },
  }
}
