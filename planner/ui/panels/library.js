// Panel (area C): Library, the furniture you can add. One list at every detent (bigger thumbnails at full height):
// thumbnail or monogram, name, W × D × H cm, a Splat tag and an "In room" check. Search plus filter chips
// All / In the room · n / Has splat · n. Tapping a row adds the piece near the centre on the floor, selects it,
// drops the phone sheet to peek and toasts "<name> added · Undo". Frames C1 (phone) and C6 (desktop).
import { dimsText, quiet } from '../../engine.js'
import { pic, itemThumb } from './common.js'

export function mount({ engine, shell, kit }) {
  const { h, chip } = kit
  let query = ''
  let filter = 'all'
  let lastAdded = null // library id of the piece just added (marked; the peek sheet shows it)

  const panel = shell.registerPanel({ id: 'library', label: 'Library', icon: 'library', phoneDetent: 'half', mount: () => {} })

  const input = h('input.p-search-input', { type: 'search', placeholder: 'Search furniture', spellcheck: false, autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search furniture',
    oninput: () => { query = input.value.trim().toLowerCase(); render() } })
  const clear = h('button.p-search-clear', { type: 'button', 'aria-label': 'Clear the search', hidden: true, onclick: () => { input.value = ''; query = ''; render(); input.focus() } }, pic('close', { size: 16 }))
  const search = h('label.p-search', pic('search', { size: 16, stroke: 1.6 }), input, clear)
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); clear.click() } })
  const chips = {
    all: chip({ label: 'All', onClick: () => setFilter('all') }),
    inroom: chip({ label: 'In the room', onClick: () => setFilter('inroom') }),
    splat: chip({ label: 'Has splat', onClick: () => setFilter('splat') }),
  }
  const tools = h('div.p-tools.lib-tools', search, h('div.p-chips', { role: 'group', 'aria-label': 'Filter' }, Object.values(chips)))
  const list = h('div.lib-list', { role: 'list' })
  const none = h('p.p-note.lib-none')
  panel.body.classList.add('lib')
  panel.body.append(tools, list, none)

  function setFilter(f) { filter = filter === f && f !== 'all' ? 'all' : f; render() }

  function counts() {
    const n = new Map()
    for (const it of engine.getItems()) n.set(it.id, (n.get(it.id) || 0) + 1)
    return n
  }

  async function add(lib) {
    let uid
    try { uid = await engine.addItemInternal(lib.id) } catch { return } // reported (toast)
    engine.select(uid)
    lastAdded = lib.id
    const name = lib.name || lib.id
    shell.toast(`${name} added`, { kind: 'ok', id: `added:${uid}`, action: { label: 'Undo', onClick: () => engine.removeItemInternal(uid) } })
    if (shell.isPhone()) shell.setDetent('peek')
    render()
    showAdded()
  }
  function showAdded() {
    const row = lastAdded && list.querySelector(`[data-id="${CSS.escape(lastAdded)}"]`)
    if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }))
  }

  function row(lib, n, selectedId) {
    const name = lib.name || lib.id
    const hasSplat = !!lib.assets?.splat
    const inRoom = n > 0
    const meta = [h('span.lib-dims.tnum', dimsText(lib.dims_cm))]
    if (hasSplat) meta.push(h('span.p-tag', 'Splat'))
    const roomMark = inRoom ? h('span.lib-inroom', { dataset: { tip: n > 1 ? `In the room · ${n}` : 'In the room' } }, pic('check', { size: 14, stroke: 2.2 }), h('span.lib-inroom-word', n > 1 ? `In room · ${n}` : 'In room')) : null
    return h(`button.lib-row${lastAdded === lib.id || selectedId === lib.id ? '.is-marked' : ''}`, {
      type: 'button', role: 'listitem', dataset: { id: lib.id }, 'aria-label': `Add ${name}${inRoom ? ' (in the room)' : ''}`,
      onclick: () => quiet(add(lib)),
    },
    itemThumb(engine, lib, 'lib-thumb'),
    h('span.lib-text', h('span.lib-title', h('span.lib-name', name), roomMark), h('span.lib-meta', meta)),
    h('span.lib-add', { 'aria-hidden': 'true' }, h('span', pic('plus', { size: 16, stroke: 1.9 }))))
  }

  function render() {
    const all = engine.getLibrary()
    const n = counts()
    const sel = engine.getItem(engine.getSelected())
    const inRoomCount = all.filter((l) => n.get(l.id)).length
    const splatCount = all.filter((l) => l.assets?.splat).length
    panel.setCount(all.length ? String(all.length) : '')
    input.placeholder = all.length ? (shell.isPhone() ? `Search ${all.length} items` : 'Search furniture') : 'Search furniture'
    clear.hidden = !input.value
    chips.all.set(filter === 'all')
    chips.inroom.set(filter === 'inroom')
    chips.splat.set(filter === 'splat')
    chips.inroom.lastChild.textContent = `${shell.isPhone() ? 'In the room' : 'In room'} · ${inRoomCount}`
    chips.splat.lastChild.textContent = `Has splat · ${splatCount}`
    const shown = all.filter((l) => {
      if (filter === 'inroom' && !n.get(l.id)) return false
      if (filter === 'splat' && !l.assets?.splat) return false
      if (!query) return true
      return [l.name, l.id, l.category].some((s) => String(s || '').toLowerCase().includes(query))
    })
    list.replaceChildren(...shown.map((l) => row(l, n.get(l.id) || 0, sel?.id)))
    tools.hidden = !all.length
    none.hidden = shown.length > 0
    if (!all.length) {
      none.replaceChildren(h('strong', 'The library is empty.'), ' Add furniture with nook-add (a photo, a product link or a 3D file), then reload.')
    } else if (!shown.length) {
      none.replaceChildren(query ? `Nothing matches "${input.value.trim()}".` : filter === 'inroom' ? 'Nothing from the library is in the room yet.' : 'No piece has a splat yet.')
    }
  }

  engine.events.addEventListener('library', render)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('selection', (e) => { if (!e.detail.uid) lastAdded = null; render() })
  shell.events.addEventListener('mode', render)
  shell.events.addEventListener('panel', (e) => {
    if (e.detail.id !== 'library' || !e.detail.open) return
    if (e.detail.detent === 'peek') showAdded()
    else if (e.detail.detent !== 'peek' && !engine.getSelected()) lastAdded = null
  })
  // "/" focuses the search on desktop while the Library is open
  shell.addKeyFilter((e) => {
    if (e.key !== '/' || shell.isPhone() || !panel.isOpen() || e.target.closest?.('input, textarea')) return false
    e.preventDefault()
    input.focus()
    return true
  })
  render()
}
