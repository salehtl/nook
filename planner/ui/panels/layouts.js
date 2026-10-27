// Panel (area C): Layouts, the saved arrangements of furniture for the open room. A "Now in the room" card (Save
// layout, Save as new… with a name check, the save-failed state with Retry), then the room's layouts: item count, saved
// date, the current one marked, Load (asks first when the furniture has unsaved changes), and a "…" menu with Save
// current over it and Delete…. Older (v1) layouts are marked and can't be deleted. Frames C3 (phone) and C6 sections.
import { SLUG, quiet } from '../../engine.js'
import { pic, withIcon, shortDate, isOffline, OFFLINE_BODY } from './common.js'

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
// "evening-two-chairs" → "Evening two chairs"
export const pretty = (name) => { const s = String(name || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }

export function mount({ engine, data, shell, kit, icons }) {
  const { h, button } = kit
  const panel = shell.registerPanel({ id: 'layouts', label: 'Layouts', icon: 'layouts', phoneDetent: 'half', mount: () => {} })
  let asking = false   // the Save as new form is open
  let draft = ''
  let failure = null   // { message, offline, retry }
  let busy = false
  const card = h('section.p-card.ly-card')
  const note = h('p.p-note.ly-note')
  const list = h('div.ly-list', { role: 'list' })
  const none = h('p.p-note.ly-none')
  panel.body.classList.add('ly')
  panel.body.append(card, note, list, none)

  const current = () => engine.getLayoutName().trim()
  const names = () => engine.getLayoutDetails().map((d) => d.name)

  async function save(name, { quietly = false } = {}) {
    if (busy) return false
    busy = true
    failure = null
    render()
    try {
      await engine.saveLayoutInternal(name)
      asking = false
      draft = ''
      if (!quietly) shell.toast(`Layout saved as ${pretty(name)}`, { kind: 'ok', id: 'layout-saved' })
      return true
    } catch (e) {
      failure = { message: e.message, offline: isOffline(e), retry: () => quiet(save(name)) }
      return false
    } finally {
      busy = false
      render()
    }
  }

  async function load(name) {
    const cur = current()
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const acts = [
        { label: cur ? 'Save, then load' : 'Save as new first', value: 'save', kind: 'primary', default: true },
        { label: "Load, don't save", value: 'discard', kind: 'secondary' },
        { label: 'Cancel', value: null, kind: 'secondary', cancel: true },
      ]
      const v = await shell.confirm({
        title: `Load ${pretty(name)}?`, icon: 'warning',
        body: cur ? `The furniture has changes that aren't saved to ${pretty(cur)}. Loading replaces it.` : "The furniture in the room isn't saved as a layout. Loading replaces it.",
        actions: shell.isPhone() ? acts : [acts[2], acts[1], acts[0]],
      })
      if (v == null) return
      if (v === 'save') {
        if (!cur) { openForm(); return }
        if (!(await save(cur, { quietly: true }))) return
      }
    }
    try { await engine.loadLayoutInternal(name) } catch { return } // reported
    shell.toast(`Loaded ${pretty(name)}`, { kind: 'ok', id: 'layout-loaded' })
  }

  async function del(name) {
    const ok = await shell.confirm({ title: `Delete ${pretty(name)}?`, icon: 'trash', danger: true, confirm: 'Delete',
      body: "It's removed from kakapo. The furniture in the room stays as it is." })
    if (!ok) return
    try { await engine.deleteLayoutInternal(name) } catch { return }
    shell.toast(`${pretty(name)} deleted`, { id: 'layout-deleted' })
  }

  function openForm() {
    asking = true
    draft = ''
    failure = null
    if (shell.isPhone() && shell.getOpenPanel()?.detent === 'peek') shell.setDetent('half')
    if (!panel.isOpen()) shell.openPanel('layouts')
    render()
    requestAnimationFrame(() => card.querySelector('input')?.focus())
  }

  function formCheck(text) {
    const slug = slugify(text)
    if (!text.trim()) return { slug, error: null, hint: 'Letters, numbers and spaces.' }
    if (!slug || !SLUG.test(slug)) return { slug, error: 'Use letters or numbers in the name.' }
    if (names().includes(slug)) return { slug, error: `${pretty(slug)} already exists. Pick another name, or use its … menu to save over it.` }
    return { slug, error: null, hint: slug !== text.trim() ? `Saved as ${slug}` : '' }
  }

  function cardView() {
    const n = engine.getItems().length
    const cur = current()
    const dirty = engine.isLayoutDirty()
    const title = cur ? pretty(cur) : n ? 'Not saved as a layout' : 'Empty room'
    const metaText = `${n} ${n === 1 ? 'item' : 'items'} · ${cur ? (dirty ? 'changed since saved' : 'saved') : n ? 'not saved yet' : 'add furniture first'}`
    const head = [
      h('span.caps', 'Now in the room'),
      h('h3.ly-card-title', { title: cur || null }, title),
      h('span.ly-card-meta.tnum', dirty && n ? icons.unsavedGlyph(14) : null, h('span', metaText)),
    ]
    if (failure) {
      return [head,
        h('div.p-fail', { role: 'alert' }, h('span.p-fail-title', pic('warning', { size: 16 }), h('span', failure.offline ? "Not saved · kakapo isn't answering" : 'Not saved')),
          h('span.p-fail-body', failure.offline ? OFFLINE_BODY : failure.message)),
        h('div.ly-actions', withIcon(button({ label: 'Retry', kind: 'primary', block: true, disabled: busy, onClick: () => failure?.retry() }), 'retry'),
          shell.isPhone() ? null : button({ label: 'Cancel', kind: 'quiet', onClick: () => { failure = null; render() } }))]
    }
    if (asking) {
      const check = formCheck(draft)
      const msg = h(`span.ly-form-msg${check.error ? '.is-error' : ''}`, check.error || check.hint || '')
      const go = button({ label: 'Save as new', kind: 'primary', disabled: busy || !!check.error || !draft.trim() })
      const submit = (e) => {
        e?.preventDefault()
        const c = formCheck(draft)
        if (c.error || !draft.trim()) return
        quiet(save(c.slug))
      }
      go.type = 'submit'
      const input = h('input.input', { type: 'text', value: draft, placeholder: 'Evening, lamp by the window', spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New layout name',
        oninput: () => {
          draft = input.value
          const c = formCheck(draft)
          msg.textContent = c.error || c.hint || ''
          msg.classList.toggle('is-error', !!c.error)
          go.disabled = busy || !!c.error || !draft.trim()
        },
        onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); asking = false; render() } } })
      return [head, h('form.ly-form', { onsubmit: submit },
        h('label.field', h('span.field-label', 'New layout name'), input), msg,
        h('div.ly-form-actions', button({ label: 'Cancel', kind: 'quiet', onClick: () => { asking = false; render() } }), go))]
    }
    const btns = cur
      ? [button({ label: busy ? 'Saving…' : 'Save layout', kind: 'primary', disabled: busy || !n && !dirty, onClick: () => quiet(save(cur)) }),
        button({ label: 'Save as new…', kind: 'secondary', disabled: busy, onClick: openForm })]
      : [button({ label: 'Save layout…', kind: 'primary', disabled: busy || !n, onClick: openForm })]
    return [head, h('div.ly-actions', btns)]
  }

  function rowView(d, cur) {
    const isCur = d.name === cur
    const count = Number.isFinite(d.items) ? `${d.items} ${d.items === 1 ? 'item' : 'items'}` : null
    const meta = [isCur && !shell.isPhone() ? h('span.ly-cur-word', 'Current') : null, [count, d.updated ? shortDate(d.updated) : null].filter(Boolean).join(' · ') || null]
      .filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))
    const more = h('button.ly-more', { type: 'button', 'aria-label': `More for ${pretty(d.name)}`, 'aria-haspopup': 'menu', dataset: { nodrag: '' },
      onclick: (e) => {
        e.stopPropagation()
        shell.menu(e.currentTarget, [
          ...(isCur ? [] : [{ label: 'Load', icon: 'layouts', onSelect: () => quiet(load(d.name)) }]),
          { label: 'Save current over it', icon: 'bookmark', onSelect: async () => {
            if (!isCur && !(await shell.confirm({ title: `Save over ${pretty(d.name)}?`, body: `It becomes the furniture in the room now (${engine.getItems().length} items).`, confirm: 'Save over it' }))) return
            quiet(save(d.name))
          } },
          ...(d.legacy || !engine.getRoomName() ? [] : ['-', { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => quiet(del(d.name)) }]),
        ], { align: 'end' })
      } }, pic('more', { size: 18 }))
    const trail = isCur
      ? (shell.isPhone() ? h('span.ly-current.caps', 'Current') : null)
      : h('button.btn.btn-secondary.ly-load', { type: 'button', onclick: (e) => { e.stopPropagation(); quiet(load(d.name)) } }, 'Load')
    return h(`div.ly-row${isCur ? '.is-current' : ''}`, { role: 'listitem', title: d.name },
      h('span.ly-mark', pic(isCur ? 'bookmark-fill' : 'bookmark', { size: 18 })),
      h('span.ly-text', h('span.ly-name', pretty(d.name), d.legacy ? h('span.p-tag', { dataset: { tip: 'Saved before rooms had their own layouts' } }, 'Older') : null),
        h('span.ly-meta.tnum', meta)),
      trail, more)
  }

  function render() {
    const cur = current()
    const details = engine.getLayoutDetails().slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.name.localeCompare(b.name))
    panel.setCount(String(details.length))
    card.classList.toggle('is-failed', !!failure)
    const typing = asking && card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
    if (!typing) card.replaceChildren(...cardView().flat())
    const room = engine.getRoomName()
    const roomTitle = room ? data.getRoom(room)?.title || room : null
    note.replaceChildren(h('span.dot'), h('span', roomTitle ? `Saved with ${roomTitle}. Other rooms keep their own.` : 'Layouts for the placeholder room and dropped scans are shared.'))
    list.replaceChildren(...details.map((d) => rowView(d, cur)))
    none.hidden = details.length > 0
    none.textContent = 'No layouts for this room yet. Arrange some furniture, then Save layout.'
  }

  engine.events.addEventListener('layouts', render)
  engine.events.addEventListener('dirty', render)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('room', (e) => { if (['loaded', 'title', 'missing'].includes(e.detail.phase)) { failure = null; render() } })
  data.events.addEventListener('rooms', render)
  shell.events.addEventListener('mode', render)
  render()
}
