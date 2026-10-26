// Panel (area C): In the room, the furniture placed in the open room. Rows: thumbnail, name, W × D × H cm, the render
// mode (a GLB / Splat switch when the piece has both, else "GLB only"), and Remove (with an Undo toast). Tapping a
// row selects the piece (the phone sheet drops to peek so you can see it). Frames C2 (phone) and C6 sections.
import { dimsText, quiet } from '../../engine.js'
import { pic, itemThumb, emptyState } from './common.js'

export function mount({ engine, shell, kit }) {
  const { h, segmented, button } = kit
  const panel = shell.registerPanel({ id: 'inroom', label: 'In the room', short: 'In room', icon: 'in-room', phoneDetent: 'half', mount: () => {} })
  const list = h('div.ir-list', { role: 'list' })
  const empty = emptyState({
    icon: 'sofa', title: 'Nothing in the room yet',
    body: 'Add a piece from the Library. It lands in the middle of the view; drag it on the floor to place it.',
    action: button({ label: 'Open Library', kind: 'primary', onClick: () => shell.openPanel('library') }),
  })
  const hint = h('p.p-hint.ir-hint', pic('info', { size: 16 }), h('span', 'Tap a row to select it; the sheet drops to peek so you can see it. Splat looks closer to the scan, GLB is lighter.'))
  const keys = h('div.ir-keys',
    h('span.caps', 'Selected item'),
    h('div.ir-keys-grid', [['R', 'Rotate 15°'], ['⇧R', 'Back 15°'], ['Del', 'Remove'], ['Esc', 'Deselect']].map(([k, t]) => h('span.ir-key', kit.kbd(k), h('span', t)))))
  panel.body.classList.add('ir')
  panel.body.append(list, empty, hint, keys)

  function remove(uid) {
    const snap = engine.removeItemWithUndo(uid)
    if (!snap) return
    shell.toast(`${snap.name} removed`, { id: `removed:${uid}`, icon: 'trash', ms: 6000, action: { label: 'Undo', onClick: () => quiet(engine.restoreItem(snap)) } })
  }

  function select(uid) {
    engine.select(uid)
    if (shell.isPhone()) shell.setDetent('peek')
  }

  function row(it, selected) {
    const both = it.hasGlb && it.hasSplat
    const mode = both
      ? segmented([{ value: 'glb', label: 'GLB' }, { value: 'splat', label: 'Splat' }], it.render, (v) => quiet(engine.toggleRender(it.uid, v)), { small: true, label: `${it.name}: render as` })
      : h('span.ir-mode', it.render === 'splat' ? 'Splat only' : 'GLB only')
    mode.dataset.nodrag = ''
    mode.addEventListener('click', (e) => e.stopPropagation())
    const del = h('button.ir-del', { type: 'button', 'aria-label': `Remove ${it.name}`, dataset: { tip: 'Remove', kbd: 'Del' }, onclick: (e) => { e.stopPropagation(); remove(it.uid) } }, pic('trash', { size: 18 }))
    const r = h(`div.ir-row${selected ? '.is-selected' : ''}`, {
      role: 'listitem', tabindex: 0, dataset: { uid: it.uid }, 'aria-current': selected ? 'true' : null,
      onclick: () => select(it.uid),
      onkeydown: (e) => {
        if (e.target !== r) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it.uid) }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(it.uid) }
      },
    },
    itemThumb(engine, it.lib, 'ir-thumb'),
    h('span.ir-text', h('span.ir-name', it.name), h('span.ir-meta.tnum', dimsText(it.lib?.dims_cm))),
    h('span.ir-modeslot', mode), del)
    return r
  }

  function render() {
    const items = engine.getItems()
    const sel = engine.getSelected()
    panel.setCount(String(items.length))
    list.replaceChildren(...items.map((it) => row(it, it.uid === sel)))
    empty.hidden = items.length > 0
    hint.hidden = !items.length
    keys.hidden = !items.length
    if (sel) requestAnimationFrame(() => list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' }))
  }

  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('selection', render)
  engine.events.addEventListener('library', render)
  render()
}
