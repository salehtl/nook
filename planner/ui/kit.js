// nook planner UI kit: tiny DOM builders for the kit.css elements, shared by every UI module. No state lives here.
//   h('div.row.is-selected', { onclick, title, dataset: {…}, style: {…}, …attrs }, ...children)   (children: nodes, strings, arrays, null)
//   button({ label, icon, kind: 'primary'|'secondary'|'quiet'|'danger', onClick, title, kbd, disabled, block })
//   iconButton(icon, { label (aria + tooltip), kind: 'quiet'|'secondary', onClick, kbd, size })
//   pill(status, text?)            status: queued|preparing|training|ready|failed|cancelled (icon + word; text overrides)
//   kbd(text)                      a keycap
//   toggle({ label, hint, checked, onChange })   → row with .switch; row.input is the checkbox
//   segmented(options [{ value, label, icon }], value, onChange, { small })   → .seg; seg.set(value)
//   slider({ label, min, max, step, value, format(v), onInput })   → .slider-row; row.set(value)
//   chip({ label, pressed, onClick })   → .chip; chip.set(pressed)
//   field({ label, value, placeholder, onInput, type })   → .field; field.input
import { icon, ring } from './icons.js'

export function h(sel, attrs, ...children) {
  const [tag, ...classes] = sel.split('.')
  const el = document.createElement(tag || 'div')
  if (classes.length) el.className = classes.join(' ')
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'class') el.className += ` ${v}`
    else if (k in el && typeof v !== 'string') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  append(el, children)
  return el
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
}

export function button({ label, icon: ic, kind = 'secondary', onClick, title, kbd: key, disabled, block, type = 'button' } = {}) {
  const b = h(`button.btn.btn-${kind}${block ? '.btn-block' : ''}`, { type, onclick: onClick, disabled, title: title || null, dataset: key ? { tip: title || label, kbd: key } : null },
    ic ? icon(ic, { size: 20 }) : null, label ? h('span', label) : null)
  return b
}

export function iconButton(name, { label, kind = 'quiet', onClick, kbd: key, size = 20 } = {}) {
  return h(`button.btn.btn-icon.btn-${kind}`, { type: 'button', onclick: onClick, 'aria-label': label, dataset: label ? { tip: label, ...(key ? { kbd: key } : {}) } : null }, icon(name, { size }))
}

const PILL = { queued: ['clock', 'Queued'], preparing: [null, 'Preparing'], training: [null, 'Training'], ready: ['check', 'Ready'], failed: ['warning', 'Failed'], cancelled: ['cancelled', 'Cancelled'] }
export function pill(status, text, progress = null) {
  const [ic, word] = PILL[status] || ['info', status]
  const glyph = ic ? icon(ic, { size: 14 }) : ring(status === 'training' ? progress : null, { size: 14 })
  return h(`span.pill.pill-${status}`, glyph, h('span', text || word))
}

export const kbd = (text) => h('kbd.kbd', text)

export function toggle({ label, hint, checked = false, onChange } = {}) {
  const input = h('input.switch', { type: 'checkbox', checked, onchange: (e) => onChange?.(e.target.checked) })
  const row = h('label.toggle-row', h('span.toggle-text', h('span.toggle-label', label), hint ? h('span.toggle-hint', hint) : null), input)
  row.input = input
  return row
}

export function segmented(options, value, onChange, { small = false, label } = {}) {
  const seg = h(`div.seg${small ? '.seg-sm' : ''}`, { role: 'group', 'aria-label': label || null })
  const set = (v) => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(v))) }
  for (const o of options) {
    seg.append(h('button', { type: 'button', dataset: { value: String(o.value), ...(o.kbd ? { tip: o.tip || o.label, kbd: o.kbd } : {}) }, onclick: () => { set(o.value); onChange?.(o.value) } },
      o.icon ? icon(o.icon, { size: 20 }) : null, o.label ? h('span', o.label) : null))
  }
  set(value)
  seg.set = set
  return seg
}

export function slider({ label, min = 0, max = 1, step = 0.01, value = 0, format = (v) => String(v), onInput } = {}) {
  const out = h('span.slider-value')
  const input = h('input.slider', { type: 'range', min, max, step, 'aria-label': label })
  const set = (v) => {
    input.value = v
    out.textContent = format(Number(v))
    input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`)
  }
  input.addEventListener('input', () => { set(input.value); onInput?.(Number(input.value)) })
  set(value)
  const row = h('div.slider-row', h('div.slider-head', h('span.slider-label', label), out), input)
  row.set = set
  row.input = input
  return row
}

export function chip({ label, pressed = false, onClick } = {}) {
  const c = h('button.chip', { type: 'button', onclick: onClick })
  const set = (on) => {
    c.setAttribute('aria-pressed', String(!!on))
    c.replaceChildren(...(on ? [icon('check', { size: 16 })] : []), h('span', label))
  }
  set(pressed)
  c.set = set
  return c
}

export function field({ label, value = '', placeholder = '', onInput, type = 'text' } = {}) {
  const input = h('input.input', { type, value, placeholder, spellcheck: false, autocomplete: 'off', oninput: (e) => onInput?.(e.target.value) })
  const f = h('label.field', label ? h('span.field-label', label) : null, input)
  f.input = input
  return f
}
