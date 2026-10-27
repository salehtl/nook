// nook planner entry: the engine (engine.js) and its input (input.js), the rooms/scans store (data.js), the shell
// (ui/shell.js) and the area modules that fill it, plus the window.nook test hook. Spec: contract/CONTRACT.md §2.
// Every UI module exports mount(ctx), ctx = { engine, data, shell, icons, kit }.
import { engine } from './engine.js'
import { installInput } from './input.js'
import { createData } from './data.js'
import { createShell } from './ui/shell.js'
import * as icons from './ui/icons.js'
import * as kit from './ui/kit.js'
import * as workspace from './ui/workspace.js'
import * as library from './ui/panels/library.js'
import * as inroom from './ui/panels/inroom.js'
import * as layouts from './ui/panels/layouts.js'
import * as roomPanel from './ui/panels/room.js'
import * as renders from './ui/panels/renders.js'
import * as rooms from './ui/rooms.js'

engine.input = installInput(engine)
const shell = createShell({ engine })
engine.mount(shell.mounts.view)
const data = createData({ engine })
const ctx = { engine, data, shell, icons, kit }
window.nookCtx = ctx // for manual checks from the console; evals use window.nook only

// Panels register in rail/dock order: Library, In room, Layouts, Room, Renders.
for (const [name, mod] of Object.entries({ workspace, library, inroom, layouts, room: roomPanel, renders, rooms })) {
  try { mod.mount(ctx) } catch (e) { engine.reportError(`Could not set up the ${name} UI`, e) }
}

// Engine messages become toasts (errors stay until closed).
engine.events.addEventListener('toast', (e) => shell.toast(e.detail.text, { kind: e.detail.kind, ms: e.detail.kind === 'error' ? 0 : e.detail.ms }))
engine.events.addEventListener('error', (e) => shell.toast(e.detail.text, { kind: 'error' }))

// Unsaved alignment, look or layout: ask before leaving the page.
window.addEventListener('beforeunload', (e) => {
  if (!engine.isRoomDirty() && !engine.isLayoutDirty()) return
  e.preventDefault()
  e.returnValue = ''
})

// Drop a scan file anywhere to use it for this session.
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() })
window.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  e.preventDefault()
  engine.dropScanFile(file).catch(() => {})
})

let readyResolve
const ready = new Promise((r) => { readyResolve = r })

// --- window.nook test hook (contract §2.4, §2.6, §2.7) -----------------------------------------
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
  // §2.7. loadRoom() with the open room's scan keeps the room's name, so saveRoom() writes that room's config.
  listRooms: () => engine.listRoomsInternal(),
  openRoom: (name) => engine.openRoom(name),
  saveRoom: () => engine.saveRoom(),
  // Extras beyond the contract, for manual checks (P5, P9): current measurement and world -> screen pixels.
  getMeasure: () => engine.getMeasure(),
  worldToScreen: (p) => { const s = engine.worldToScreen(p); return [s.x, s.y] },
}

engine.init().catch((e) => engine.reportError('Startup failed', e)).finally(() => readyResolve())
data.start().catch(() => {})
