// nook planner icons: the Paper kit "00 · Kit / 01 · Icons" set (20 px grid, 1.5 px stroke, round caps and joins).
// Everything draws in currentColor, so recolour with CSS `color`.
//   icon(name, { size = 20, stroke, title }) → <svg>      iconHtml(name, opts) → markup string
//   unsavedGlyph(size = 14) → <svg>   the brass disc with a pencil (unsaved; never a ring)
//   ring(progress 0–1 | null, { size = 14, tone: 'accent'|'text' }) → <svg>   progress only (null: a short arc)
//   names: string[]
const S = (d) => `<path d="${d}"/>`
const DOT = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`
const C = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`
const R = (x, y, w, h, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`

export const paths = {
  orbit: S('M2.75 13.38A8 3.5 -25 1 1 17.25 6.62A8 3.5 -25 1 1 2.75 13.38') + C(10, 10, 3) + DOT(14.9, 11.06, 1.25),
  seated: S('M6.5 3.5v13M6.5 11.5h7a1 1 0 0 1 1 1v4'),
  standing: C(10, 4, 1.75) + S('M10 7v5.5M10 12.5l-2.5 4.5M10 12.5l2.5 4.5M6.5 9.5h7'),
  measure: S('M4.5 15.5l11-11M2.75 13.75l3.5 3.5M13.75 2.75l3.5 3.5M8.5 11.5l1 1M11.5 8.5l1 1'),
  frame: S('M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5') + DOT(10, 10, 1),
  render: S('M9 3l1.5 4.5L15 9l-4.5 1.5L9 15l-1.5-4.5L3 9l4.5-1.5z') + S('M15.5 13v4M13.5 15h4'),
  library: S('M3 11.5a1.5 1.5 0 0 1 3 0V13h8v-1.5a1.5 1.5 0 0 1 3 0V16H3zM5 16v1.5M15 16v1.5M4.5 10.2V9A1.5 1.5 0 0 1 6 7.5h4.5M15 2.5v6M12 5.5h6'),
  'in-room': S('M10 3l7 3.5-7 3.5-7-3.5zM3 10l7 3.5 7-3.5M3 13.5l7 3.5 7-3.5'),
  layouts: S('M5.5 3.5h9v13l-4.5-3-4.5 3z'),
  room: R(2.5, 7, 15, 6, 1.5) + R(7, 8.75, 6, 2.5, 1.25) + DOT(10, 10, 0.75),
  renders: R(3, 4, 14, 12, 1.5) + S('M3 13.5l4-4 3.5 3.5 2-2 4.5 4.5') + C(13, 7.5, 1.25),
  rooms: R(3, 3, 6, 6, 1.25) + R(11, 3, 6, 6, 1.25) + R(3, 11, 6, 6, 1.25) + R(11, 11, 6, 6, 1.25),
  'chevron-down': S('M6 8l4 4 4-4'),
  'chevron-right': S('M8 6l4 4-4 4'),
  close: S('M5.5 5.5l9 9M14.5 5.5l-9 9'),
  more: DOT(4.5, 10, 1.25) + DOT(10, 10, 1.25) + DOT(15.5, 10, 1.25),
  trash: S('M3.5 5.5h13M8 5.5v-2h4v2M5 5.5l.8 10.6a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L15 5.5M8.5 8.5V14M11.5 8.5V14'),
  pencil: S('M12.5 3.5l4 4-9 9h-4v-4zM10.5 5.5l4 4'),
  play: S('M7 4.5v11l8.5-5.5z'),
  warning: S('M10 3l7.5 13.5h-15zM10 8.5V12') + DOT(10, 14.25, 0.85),
  check: S('M4 10.5l3.75 3.75L16 6'),
  'cloud-off': S('M7.5 15.5H6a3.5 3.5 0 0 1-.6-6.95A4.75 4.75 0 0 1 13.6 7.2M16.2 9.6A3 3 0 0 1 14 15.5h-3M3 3l14 14'),
  info: C(10, 10, 7.5) + S('M10 9v5') + DOT(10, 6.5, 0.85),
  clock: C(10, 10, 7.5) + S('M10 6v4l2.5 2'),
  cancelled: C(10, 10, 7.5) + S('M4.75 4.75l10.5 10.5'),
  panel: R(3, 4, 14, 12, 1.5) + S('M8 4v12'),
  search: C(9, 9, 5) + S('M13 13l4 4'),
  plus: S('M10 4v12M4 10h12'),
  flip: S('M10 3v14M6.5 6.5L10 3l3.5 3.5M6.5 13.5L10 17l3.5-3.5'),
  revert: S('M5 8.5h7.5a4 4 0 0 1 0 8H8') + S('M8 5.5l-3 3 3 3'),
}
paths.inroom = paths['in-room']
export const names = Object.keys(paths)

export function iconHtml(name, { size = 20, stroke = 1.5, title = '' } = {}) {
  const body = paths[name] || paths.info
  // Small icons are drawn heavier so they keep the 1.5 px look (the kit uses 1.875 at 16 px, 2 at 14 px).
  const sw = size >= 20 ? stroke : Math.min(2.2, stroke * 20 / size)
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${round(sw)}" stroke-linecap="round" stroke-linejoin="round" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'}>${title ? `<title>${title}</title>` : ''}${body}</svg>`
}
const round = (v) => Math.round(v * 1000) / 1000
const fromHtml = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild }
export const icon = (name, opts) => fromHtml(iconHtml(name, opts))

export const unsavedGlyph = (size = 14) => fromHtml(`<svg class="glyph-unsaved" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="var(--color-accent)"/><path d="M3.9 10.1l.55-2.1 4.4-4.4 1.55 1.55-4.4 4.4z" fill="var(--color-accent-ink)"/></svg>`)

// Progress ring (16 px grid, drawn at `size`): a faint full circle and an arc from 12 o'clock. Use rgba, not color-mix,
// inside SVG (color-mix renders black there).
export function ring(progress, { size = 14, tone = 'accent' } = {}) {
  const faint = tone === 'accent' ? 'rgba(217,164,65,0.3)' : 'rgba(236,232,224,0.25)'
  const color = tone === 'accent' ? 'var(--color-accent)' : 'var(--color-text)'
  const p = progress == null || !Number.isFinite(progress) ? 0.25 : Math.max(0.02, Math.min(0.999, progress))
  const a = p * 2 * Math.PI
  const x = 8 + 6 * Math.sin(a), y = 8 - 6 * Math.cos(a)
  return fromHtml(`<svg class="ring${progress == null ? ' spin' : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="${faint}"/><path d="M8 2A6 6 0 ${p > 0.5 ? 1 : 0} 1 ${round(x)} ${round(y)}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`)
}
