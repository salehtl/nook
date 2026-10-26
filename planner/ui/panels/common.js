// Shared bits for the area C panels (Library, In the room, Layouts, Room, Renders): thumbnails, empty states,
// dates, money, steppers, and the "kakapo isn't answering" check. Styles: styles/panels.css.
import { h } from '../kit.js'
import { icon } from '../icons.js'
import { RENDER_MODELS } from '../../engine.js'

// Extra icons the panels need (same 20 px grid and stroke as ui/icons.js).
const EXTRA = {
  sofa: '<path d="M4 9V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M3 15V11a1.5 1.5 0 0 1 3 0v1.5h8V11a1.5 1.5 0 0 1 3 0v4zM5 15v1.5M15 15v1.5"/>',
  'pick-floor': '<path d="M2.5 15.5h15M5 15.5l3-6h4l3 6M10 3v6.5"/><circle cx="10" cy="3" r="1.3" fill="currentColor" stroke="none"/>',
  'check-size': '<circle cx="4.5" cy="15.5" r="2"/><circle cx="15.5" cy="4.5" r="2"/><path d="M6 14l8-8" stroke-dasharray="2 2"/>',
  'check-circle': '<circle cx="10" cy="10" r="8"/><path d="M6.5 10.3l2.4 2.4 4.6-5"/>',
  tilt: '<path d="M2.5 14.5l15-4M4 17.5h12"/><circle cx="11" cy="10.4" r="1.2" fill="currentColor" stroke="none"/>',
  retry: '<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2"/>',
  bookmark: '<path d="M5.5 3.5h9v13l-4.5-3-4.5 3z"/>',
  'bookmark-fill': '<path d="M5.5 3.5h9v13l-4.5-3-4.5 3z" fill="currentColor"/>',
  minus: '<path d="M4 10h12"/>',
  'chevron-left': '<path d="M12 6l-4 4 4 4"/>',
  sliders: '<path d="M3 6h8M15 6h2M3 14h2M9 14h8"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/>',
  external: '<path d="M11 3.5h5.5V9M16.5 3.5L9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8"/>',
  sun: '<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/>',
}
export function pic(name, { size = 20, stroke = 1.5 } = {}) {
  if (!EXTRA[name]) return icon(name, { size, stroke })
  const sw = size >= 20 ? stroke : Math.min(2.2, stroke * 20 / size)
  const t = document.createElement('template')
  t.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${Math.round(sw * 1000) / 1000}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA[name]}</svg>`
  return t.content.firstChild
}

// A kit button with one of the icons above in front of its label.
export const withIcon = (btn, name, size = 18) => { btn.prepend(pic(name, { size })); return btn }

// "Bookcase 80" → "B8", "Oak reading lamp" → "OR"
export function monogram(name) {
  const words = String(name || '?').trim().split(/[\s_-]+/).filter(Boolean)
  const a = words[0]?.[0] || '?'
  const b = words.length > 1 ? words[1][0] : words[0]?.[1] || ''
  return (a + b).toUpperCase()
}

// A library item's thumbnail, or its monogram when there's none (or it fails to load).
export function itemThumb(engine, lib, cls = 'p-thumb') {
  const mono = () => h(`span.${cls}.is-mono`, { 'aria-hidden': 'true' }, monogram(lib?.name || lib?.id))
  const rel = lib?.assets?.thumb
  if (!rel) return mono()
  const img = h(`img.${cls}`, { alt: '', loading: 'lazy', draggable: false, src: engine.assetUrl(rel) })
  img.addEventListener('error', () => img.replaceWith(mono()), { once: true })
  return img
}

export function emptyState({ icon: ic, title, body, action }) {
  return h('div.p-empty', h('span.p-empty-icon', pic(ic, { size: 20 })), h('h3.p-empty-title', title), body ? h('p.p-empty-body', body) : null, action || null)
}

// Errors from fetch() failing (no HTTP status): the engine words them "kakapo isn't answering".
export const isOffline = (err) => /isn't answering|could not reach|Failed to fetch|NetworkError/i.test(err?.message || String(err || ''))
export const OFFLINE_BODY = "Your changes stay in this tab. Check you're on home Wi-Fi or Tailscale, then retry."

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n) => String(n).padStart(2, '0')
const toDate = (v) => { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d }
export const clock = (v) => { const d = toDate(v); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '' }
// "26 Oct, 10:12"
export const shortDate = (v) => { const d = toDate(v); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(d)}` : '' }
// "Today, 09:52" · "Yesterday, 18:31" · "Sat 25 Oct, 18:31"
export function dayDate(v) {
  const d = toDate(v)
  if (!d) return ''
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  if (diff === 0) return `Today, ${clock(d)}`
  if (diff === 1) return `Yesterday, ${clock(d)}`
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(d)}`
}

export const money = (v) => `$${(Number(v) || 0).toFixed(2)}`
const SHORT_MODEL = { 'nano-banana': 'Nano Banana', kontext: 'FLUX Kontext', qwen: 'Qwen' }
export const modelShort = (m) => SHORT_MODEL[m] || RENDER_MODELS[m]?.label || m || ''
export const VIEW_WORD = { orbit: 'Orbit', seated: 'Seated', standing: 'Standing' }

// A number stepper (phone: − value +, 44 pt targets) or a number field (desktop). Values in display units.
//   numberControl({ label, unit, step, digits, get, set, min, max, mode }) → el with el.sync(changed)
export function numberControl({ label, unit = '', step = 1, digits = 1, get, set, min = -Infinity, max = Infinity, mode, fmtUnit }) {
  const clampV = (v) => Math.min(max, Math.max(min, v))
  const fmt = (v) => `${Number(v).toFixed(digits).replace('-', '−')}${fmtUnit ?? unit}`
  if (mode === 'phone') {
    const out = h('span.st-value.tnum')
    const nudge = (k) => { set(clampV(Math.round((get() + k * step) / step) * step)); el.sync() }
    // hold to repeat
    const holdBtn = (k, ic, aria) => {
      let t = null, n = 0
      const stop = () => { clearTimeout(t); t = null }
      const b = h('button.st-btn', { type: 'button', 'aria-label': aria,
        onpointerdown: (e) => { if (e.button) return; n = 0; nudge(k); const go = () => { n++; nudge(k); t = setTimeout(go, n > 8 ? 40 : 90) }; t = setTimeout(go, 420) },
        onpointerup: stop, onpointerleave: stop, onpointercancel: stop,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nudge(k) } } }, pic(ic, { size: 16, stroke: 1.9 }))
      return b
    }
    const el = h('div.st', holdBtn(-1, 'minus', `Less ${label}`), h('span.st-text', h('span.st-label', label), out), holdBtn(1, 'plus', `More ${label}`))
    el.sync = (changed = el.classList.contains('is-changed')) => { out.textContent = fmt(get()); el.classList.toggle('is-changed', !!changed) }
    el.sync(false)
    return el
  }
  const input = h('input.nf-input.tnum', { type: 'text', inputmode: 'decimal', spellcheck: false, autocomplete: 'off', 'aria-label': label })
  const commit = () => {
    const v = Number(String(input.value).replace('−', '-').replace(',', '.'))
    if (Number.isFinite(v)) set(clampV(v))
    el.sync()
  }
  input.addEventListener('change', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); input.select() }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
      set(clampV(Math.round((get() + k * step) / step) * step))
      el.sync()
      input.select()
    }
  })
  const el = h('label.nf', h('span.nf-label', label), h('span.nf-box', input, unit ? h('span.nf-unit', unit.trim()) : null))
  el.sync = (changed = el.classList.contains('is-changed')) => {
    if (document.activeElement !== input) input.value = Number(get()).toFixed(digits).replace('-', '−')
    el.classList.toggle('is-changed', !!changed)
  }
  el.sync(false)
  return el
}

// Fetch an image URL as a JPEG data URL plus its size (Render again from a past render's input).
export async function imageShot(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  const blob = await res.blob()
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  return { dataUrl, width: img.naturalWidth, height: img.naturalHeight }
}
