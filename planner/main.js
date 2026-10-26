// nook planner entry: the engine (engine.js), its pointer/keyboard input (input.js) and the v1 DOM UI (ui-v1.js),
// plus the window.nook test hook. Spec: contract/CONTRACT.md §2.
import { engine } from './engine.js'
import { installInput } from './input.js'
import { installUiV1 } from './ui-v1.js'

engine.mount(document.getElementById('viewport'))
engine.input = installInput(engine)
installUiV1(engine, engine.input)

let readyResolve
const ready = new Promise((r) => { readyResolve = r })

// --- window.nook test hook (contract §2.4, §2.6) -------------------------------------------
window.nook = {
  ready,
  errors: engine.errors,
  getLibrary: () => engine.getLibrary(),
  loadRoom: (cfg) => engine.loadRoomInternal(cfg),
  addItem: (id, opts) => {
    const o = opts || {}
    return engine.addItemInternal(id, { position: o.position, rotation_y_deg: o.rotation_y_deg, render: o.render })
  },
  moveItem: (uid, opts) => engine.moveItemInternal(uid, opts),
  removeItem: (uid) => engine.removeItemInternal(uid),
  clearItems: () => engine.clearItemsInternal(),
  saveLayout: (name) => engine.saveLayoutInternal(name),
  loadLayout: (name) => engine.loadLayoutInternal(name),
  listLayouts: () => engine.listLayoutsInternal().catch((e) => { throw engine.reportError('Could not list layouts', e) }),
  setView: (v) => engine.setViewInternal(v),
  gotoViewpoint: (i) => engine.gotoViewpoint(i),
  getState: () => engine.getState(),
  // §2.6
  getRenderSettings: () => engine.getRenderSettings(),
  setRenderSettings: (s) => {
    if (!s || typeof s !== 'object') { engine.reportError('setRenderSettings needs an object'); return }
    if (s.exposure !== undefined || s.warmth !== undefined) engine.setLook(s)
    if (typeof s.contactShadows === 'boolean') engine.setContactShadows(s.contactShadows)
  },
  relight: (position) => engine.relightInternal(position),
  renderView: (opts) => engine.renderViewInternal(opts),
  listRenders: () => engine.listRendersInternal(),
  // Extras beyond the contract, for manual checks (P5, P9): current measurement and world -> screen pixels.
  getMeasure: () => engine.getMeasure(),
  worldToScreen: (p) => { const s = engine.worldToScreen(p); return [s.x, s.y] },
}

engine.init().catch((e) => engine.reportError('Startup failed', e)).finally(() => readyResolve())
