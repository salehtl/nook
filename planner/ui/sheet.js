// A form sheet for the v4 flows (library add / edit, retrain): a centred dialog on the desktop, a bottom sheet on the
// phone (scrolling body, actions pinned at the bottom, lifted above the keyboard). One at a time; Esc, the scrim or
// Cancel close it, and the engine's keys are swallowed while it's open. Styles: styles/manage.css.
//   openSheet(shell, { title, sub, body: Node, actions: [Node], cls, onClose, label }) →
//     { el, body, close(), setActions(nodes), setTitle(text, sub), isOpen() }
import { h } from './kit.js'
import { icon } from './icons.js'

let current = null
let filterAdded = false

export function openSheet(shell, { title = '', sub = '', body = null, actions = [], cls = '', onClose, label } = {}) {
  current?.close()
  if (!filterAdded) {
    filterAdded = true
    shell.addKeyFilter((e) => {
      if (!current) return false
      if (e.key === 'Escape') { e.preventDefault(); current.close() }
      return true
    })
  }
  const phone = shell.isPhone()
  const titleEl = h('h2.ms-title', title)
  const subEl = h('p.ms-sub', { hidden: !sub }, sub)
  const close = h('button.ms-close', { type: 'button', 'aria-label': 'Close', onclick: () => api.close() }, h('span', icon('close', { size: 16, stroke: 2 })))
  const bodyEl = h('div.ms-body', body)
  const foot = h('div.ms-foot', actions)
  const el = h(`div.ms${phone ? '.is-phone' : '.is-desktop'}${cls ? `.${cls}` : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title },
    phone ? h('div.sheet-grab', { 'aria-hidden': 'true' }) : null,
    h('header.ms-head', h('div.ms-titles', titleEl, subEl), close),
    bodyEl, foot)
  const scrim = h('div.scrim.ms-scrim', { onclick: () => api.close() })
  // ride the phone keyboard
  const vv = window.visualViewport
  const place = () => {
    if (!phone) return
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    el.style.bottom = `${kb}px`
    el.style.maxHeight = `${Math.max(240, (vv ? vv.height : window.innerHeight) - 24)}px`
  }
  vv?.addEventListener('resize', place)
  shell.mounts.layer.append(scrim, el)
  place()
  const onMode = () => api.close()
  shell.events.addEventListener('mode', onMode)
  const api = {
    el,
    body: bodyEl,
    isOpen: () => current === api,
    close() {
      if (current !== api) return
      current = null
      vv?.removeEventListener('resize', place)
      shell.events.removeEventListener('mode', onMode)
      scrim.remove()
      el.remove()
      onClose?.()
    },
    setActions(nodes) { foot.replaceChildren(...[nodes].flat().filter(Boolean)) },
    setTitle(t, s) { titleEl.textContent = t; if (s !== undefined) { subEl.textContent = s || ''; subEl.hidden = !s } },
  }
  current = api
  if (!phone) requestAnimationFrame(() => el.querySelector('input:not([type="file"]), button.ms-primary')?.focus({ preventScroll: true }))
  return api
}

export const isSheetOpen = () => !!current
export const closeSheet = () => current?.close()

// Small form helpers shared by the sheets.
export function formRow(label, control, hint) {
  return h('label.ms-row', h('span.ms-label', label), control, hint ? h('span.ms-hint', hint) : null)
}
export function textInput({ value = '', placeholder = '', type = 'text', inputmode, maxLength, onInput, label } = {}) {
  return h('input.ms-input', { type, value, placeholder, inputmode: inputmode || null, maxLength: maxLength || null, spellcheck: false, autocomplete: 'off', 'aria-label': label || null, oninput: (e) => onInput?.(e.target.value) })
}
