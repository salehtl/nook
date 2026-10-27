// Rooms overlays of our own (the shell's confirm and menu cover the rest): the phone action sheet with a header
// (Paper A2), the rename sheet that rides above the keyboard (A2 Rename), and the failed-scan half sheet (D3.2).
// One overlay at a time; it blocks the engine's keys and closes with Esc, the scrim or the page closing.
import { icon } from '../icons.js'
import { h } from '../kit.js'

export function createOverlays(shell) {
  let current = null
  shell.addKeyFilter(() => !!current)
  window.addEventListener('keydown', (e) => {
    if (!current) return
    if (e.key === 'Escape') { e.preventDefault(); close() }
  })
  function open(els, { onClose } = {}) {
    close()
    const entry = { els, onClose }
    current = entry
    shell.mounts.layer.append(...els)
    return () => { if (current === entry) close() }
  }
  function close() {
    const c = current
    if (!c) return
    current = null
    for (const el of c.els) el.remove()
    c.onClose?.()
  }
  return { open, close, isOpen: () => !!current }
}

// Phone action sheet: { head: { thumb, title, sub }, items: [{ label, sub, icon, tone: 'accent'|'danger', disabled, onSelect }], cancel }
export function actionSheet(ov, { head, items, cancel = 'Cancel' }) {
  let done = null
  const pick = (it) => { done(); it.onSelect?.() }
  const card = h('div.rm-as-card',
    head ? h('div.rm-as-head', h('div.rm-as-thumb', head.thumb), h('div.rm-as-head-text', h('div.rm-as-title', head.title), head.sub ? h('div.rm-as-sub', head.sub) : null)) : null,
    items.map((it) => h(`button.rm-as-item${it.tone ? `.is-${it.tone}` : ''}`, { type: 'button', disabled: !!it.disabled, onclick: () => pick(it) },
      it.icon ? icon(it.icon, { size: 20 }) : null,
      h('span.rm-as-label', h('span', it.label), it.sub ? h('span.rm-as-item-sub', it.sub) : null))))
  const sheet = h('div.rm-as', { role: 'dialog', 'aria-modal': 'true', 'aria-label': head?.title || 'Actions' }, card,
    h('button.rm-as-cancel', { type: 'button', onclick: () => done() }, cancel))
  const scrim = h('div.scrim.rm-scrim', { onclick: () => done() })
  done = ov.open([scrim, sheet])
  return done
}

// Rename: phone sheet above the keyboard. onSave(title) → Promise; resolves the sheet.
export function renameSheet(ov, { value, was, onSave }) {
  let done = null, busy = false
  const input = h('input.rm-rn-input', { type: 'text', value, placeholder: was, maxLength: 120, enterKeyHint: 'done', autocomplete: 'off', spellcheck: false, 'aria-label': 'Room title' })
  const clear = h('button.rm-rn-clear', { type: 'button', 'aria-label': 'Clear', onclick: () => { input.value = ''; input.focus() } }, h('span', icon('close', { size: 10, stroke: 3 })))
  const save = async () => {
    if (busy) return
    busy = true
    try { await onSave(input.value); done() } catch { busy = false }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save() } })
  const sheet = h('div.rm-rn', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rename room' },
    h('div.rm-rn-bar',
      h('button.rm-rn-btn', { type: 'button', onclick: () => done() }, 'Cancel'),
      h('div.rm-rn-title', 'Rename room'),
      h('button.rm-rn-btn.is-save', { type: 'button', onclick: save }, 'Save')),
    h('div.rm-rn-body', h('div.rm-rn-field', input, clear),
      h('p.rm-rn-hint', `Was “${was}”. Only the title changes, not the file on kakapo.`)))
  const scrim = h('div.scrim.rm-scrim', { onclick: () => done() })
  // Ride the keyboard: the visual viewport shrinks when it's up (the layout viewport doesn't on iOS).
  const vv = window.visualViewport
  const place = () => {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    sheet.style.bottom = `${kb}px`
    sheet.classList.toggle('has-keyboard', kb > 40)
  }
  vv?.addEventListener('resize', place)
  vv?.addEventListener('scroll', place)
  done = ov.open([scrim, sheet], { onClose: () => { vv?.removeEventListener('resize', place); vv?.removeEventListener('scroll', place) } })
  place()
  input.focus() // inside the tap that opened it, so iOS shows the keyboard
  input.select()
  return done
}

// Failed scan, phone half sheet (D3.2): pill + stage, the error sentence, what to do, Copy error / Dismiss.
export function failedSheet(ov, { date, stage, message, advice, onCopy, onDismiss }) {
  let done = null
  const sheet = h('div.rm-fs', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan failed' },
    h('div.sheet-grab', { 'aria-hidden': 'true' }),
    h('header.rm-fs-head',
      h('div.rm-fs-titles', h('h2.rm-fs-title', 'Scan failed'), h('span.rm-fs-date', date)),
      h('button.sheet-close', { type: 'button', 'aria-label': 'Close', onclick: () => done() }, h('span', icon('close', { size: 16, stroke: 2 })))),
    failedBody({ stage, message, advice }),
    h('div.rm-fs-actions',
      h('button.btn.btn-secondary', { type: 'button', onclick: () => onCopy?.() }, 'Copy error'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => { done(); onDismiss?.() } }, 'Dismiss')))
  const scrim = h('div.scrim.rm-scrim.is-light', { onclick: () => done() })
  done = ov.open([scrim, sheet])
  return done
}

export function failedBody({ stage, message, advice }) {
  return h('div.rm-fs-body',
    h('div.rm-fs-status', h('span.pill.pill-failed', icon('warning', { size: 14 }), h('span', 'Failed')), h('span.rm-fs-stage', `Stopped while ${stage}`)),
    h('p.rm-fs-msg', message || 'The scan stopped on kakapo.'),
    h('div.rm-fs-try', h('div.caps', 'To try again'), h('p', advice)))
}
