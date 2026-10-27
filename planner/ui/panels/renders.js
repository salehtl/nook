// Panel (area C): Renders, the paid photoreal passes of a view (contract §2.6). The list (newest first, with cost;
// a "Rendering…" row while one runs, a failed row "Not charged · Retry…"), the empty state, the Render confirm
// (preview of what gets sent, model and price, optional prompt, "Render · $0.04") and the Render viewer (desktop:
// planner view and render side by side; phone: full screen with a Planner / Render toggle; "Render again…" reopens
// the confirm prefilled with that render's view, model and prompt). Frames C5 (phone) and C6/C7 (desktop).
//
// The workspace's Render button sends shell event 'render-request' and its "Render ready · View" toast 'open-render'
// { meta }; this panel takes both (preventDefault). Also on ctx.renders:
//   openConfirm({ from?: RenderMeta, retry?: failedEntry }) → Promise   the confirm for the current view (or prefilled)
//   openViewer(name | RenderMeta)                                     show a finished render
//   getPending() → [{ id, model, started, state: 'rendering'|'failed', error? }]
//   events: 'state' { pending }   'done' { meta }   'failed' { error }
import { RENDER_MODELS, DEFAULT_RENDER_PROMPT, renderPrice, quiet } from '../../engine.js'
import { pic, withIcon, emptyState, dayDate, clock, money, modelShort, VIEW_WORD, imageShot } from './common.js'

const ABOUT = 30 // seconds a render usually takes
const MODEL_NOTE = { 'nano-banana': 'Keeps camera and layout', kontext: 'Freer light, may move things', qwen: 'Restyles more, slower' }

export function mount(ctx) {
  const { engine, shell, kit } = ctx
  const { h, button, segmented } = kit
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  let pending = [] // { id, model, prompt, shot, started, state, error, at }
  let seq = 0
  let tick = null
  let modal = null // { kind: 'confirm'|'viewer', close(), rerender() }

  const panel = shell.registerPanel({ id: 'renders', label: 'Renders', icon: 'renders', phoneDetent: 'half', mount: () => {} })
  panel.body.classList.add('rn')
  const summary = h('div.rn-summary')
  const list = h('div.rn-list', { role: 'list' })
  const empty = emptyState({
    icon: 'render', title: 'No renders yet',
    body: 'A render is a photoreal pass of the current view, about $0.04 each. You see the price before anything is sent.',
    action: button({ label: 'Render this view…', kind: 'primary', onClick: () => quiet(openConfirm()) }),
  })
  panel.body.append(summary, list, empty)

  const real = (p) => (p && p !== DEFAULT_RENDER_PROMPT ? p : '')
  const metaLine = (m) => [modelShort(m.model), VIEW_WORD[m.view] || null].filter(Boolean).join(' · ')
  const cost = (m) => (m.mock ? '$0' : money(m.cost_usd))

  // --- list ------------------------------------------------------------------------------------------------------
  function render() {
    const renders = engine.getRenders()
    const phone = shell.isPhone()
    panel.setCount(String(renders.length + pending.filter((p) => p.state === 'rendering').length))
    const spent = renders.reduce((s, m) => s + (m.mock ? 0 : Number(m.cost_usd) || 0), 0)
    summary.hidden = !renders.length && !pending.length
    summary.replaceChildren(h('span', 'Newest first'), h('span.rn-spent.tnum', `${money(spent)} spent`))
    const rows = []
    for (const p of pending) {
      const going = p.state === 'rendering'
      const left = Math.max(0, ABOUT - (Date.now() - p.started) / 1000)
      rows.push(h(`div.rn-row.is-${p.state}`, { role: 'listitem' },
        h(`span.rn-thumb.is-${p.state}`, going ? kit.h('span', ctx.icons.ring(null, { size: 18 })) : pic('warning', { size: 18 })),
        h('span.rn-text',
          h('span.rn-title', going ? 'Rendering…' : `Failed${p.reason ? ` · ${p.reason}` : ''}`),
          h('span.rn-meta.tnum', going ? `${modelShort(p.model)} · ${left > 2 ? `about ${Math.ceil(left / 5) * 5} s` : 'any moment'}` : `Not charged · ${clock(p.at)}`)),
        going
          ? h('span.rn-cost.is-pending.tnum', money(renderPrice(p.model, p.shot)))
          : h('button.rn-retry', { type: 'button', onclick: () => quiet(openConfirm({ retry: p })) }, 'Retry…'),
        going ? null : h('button.rn-dismiss', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { pending = pending.filter((x) => x !== p); changed() } }, pic('close', { size: 16 }))))
    }
    renders.forEach((m) => {
      rows.push(h('button.rn-row', { type: 'button', role: 'listitem', onclick: () => openViewer(m) },
        h('img.rn-thumb', { src: m.url, alt: '', loading: 'lazy', draggable: false }),
        h('span.rn-text', h('span.rn-title.tnum', dayDate(m.created)), h('span.rn-meta', metaLine(m))),
        h('span.rn-cost.tnum', cost(m)),
        phone ? h('span.rn-chev', pic('chevron-right', { size: 18 })) : null))
    })
    list.replaceChildren(...rows)
    empty.hidden = rows.length > 0
  }
  function changed() {
    render()
    const going = pending.some((p) => p.state === 'rendering')
    if (going && !tick) tick = setInterval(render, 5000)
    if (!going && tick) { clearInterval(tick); tick = null }
    emit('state', { pending: getPending() })
  }
  const getPending = () => pending.map(({ id, model, started, state, error }) => ({ id, model, started, state, error }))

  // --- modal plumbing (dialog on desktop, full-height sheet on the phone) -------------------------------------------
  function openModal(kind, build) {
    modal?.close()
    const els = []
    const close = () => {
      if (modal?.els !== els) return
      for (const e of els) e.remove()
      modal = null
    }
    const rerender = () => {
      for (const e of els.splice(0)) e.remove()
      const phone = shell.isPhone()
      const content = build({ phone, close })
      const scrim = h('div.scrim', { onclick: close })
      const box = h(`div.rn-modal.is-${kind}.is-${phone ? 'phone' : 'desktop'}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': content.label }, content.el)
      els.push(scrim, box)
      shell.mounts.layer.append(scrim, box)
      if (!phone) requestAnimationFrame(() => (box.querySelector('[data-autofocus]') || box.querySelector('button'))?.focus())
    }
    modal = { kind, els, close, rerender }
    rerender()
    return modal
  }
  // While a modal is open: keys go to it (Esc closes, ←/→ step the viewer), not to the 3D view.
  shell.addKeyFilter((e) => {
    if (!modal) return false
    if (e.key === 'Escape') { e.preventDefault(); modal.close() } else if (modal.kind === 'viewer' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('input, textarea')) {
      e.preventDefault(); modal.step?.(e.key === 'ArrowRight' ? 1 : -1)
    }
    return true
  })
  shell.events.addEventListener('mode', () => { render(); modal?.rerender() })

  // --- confirm ---------------------------------------------------------------------------------------------------
  async function openConfirm({ from = null, retry = null } = {}) {
    let shot = retry?.shot || null
    let model = retry?.model || (from && RENDER_MODELS[from.model] ? from.model : Object.keys(RENDER_MODELS)[0])
    let prompt = retry ? retry.prompt || '' : real(from?.prompt)
    const items = engine.getItems().length
    const view = from?.view || retry?.view || engine.getView()
    let loadError = null
    if (!shot && !from) {
      try { await engine.idle(); shot = engine.captureView() } catch (e) { engine.reportError('Could not capture the view', e); return }
    }
    const m = openModal('confirm', ({ phone, close }) => {
      const title = from ? 'Render again' : retry ? 'Try the render again' : 'Render this view'
      const sub = from ? `From ${dayDate(from.created)} · prefilled, change anything` : retry ? 'Same view; nothing was charged' : 'Photoreal, paid'
      const price = () => (engine.isRenderMock() ? 0 : renderPrice(model, shot))
      const goLabel = () => (engine.isRenderMock() ? 'Render · $0 (mock)' : `Render · ${money(price())}`)
      const go = withIcon(button({ label: goLabel(), kind: 'primary', block: phone, disabled: !shot, onClick: () => submit() }), 'render')
      go.dataset.autofocus = ''
      const setGo = () => { go.lastChild.textContent = goLabel(); go.disabled = !shot }
      const models = h('div.rc-models', { role: 'radiogroup', 'aria-label': 'Model' }, Object.entries(RENDER_MODELS).map(([key, def]) => {
        const b = h('button.rc-model', { type: 'button', role: 'radio', 'aria-checked': String(key === model),
          onclick: () => { model = key; for (const x of models.children) x.setAttribute('aria-checked', String(x === b)); for (const p of models.querySelectorAll('.rc-price')) p.textContent = money(renderPrice(p.dataset.model, shot)); setGo() } },
        h('span.rc-radio'), h('span.rc-model-text', h('span.rc-model-name', def.label), h('span.rc-model-note', MODEL_NOTE[key] || '')),
        h('span.rc-price.tnum', { dataset: { model: key } }, money(renderPrice(key, shot))))
        return b
      }))
      const promptEl = h(phone ? 'input.input.rc-prompt' : 'textarea.input.rc-prompt', { placeholder: phone ? 'Add a prompt (optional)' : 'Say what to change, if anything: "evening light, warm oak floor"', rows: 3, spellcheck: true, 'aria-label': 'Prompt (optional)',
        oninput: (e) => { prompt = e.target.value } })
      promptEl.value = prompt
      const preview = h('div.rc-preview', shot ? h('img', { src: shot.dataUrl, alt: 'The view that gets sent' }) : h('span.rc-preview-wait', loadError ? `Could not load that view: ${loadError}` : 'Loading that view…'))
      const sizeText = shot ? `${shot.width} × ${shot.height} JPEG` : '…'
      const orient = shot ? (shot.width < shot.height ? 'Portrait, like the screen' : 'Landscape, like the screen') : ''
      const viewText = `${VIEW_WORD[view] || 'Orbit'}${from ? '' : ` · ${items} ${items === 1 ? 'item' : 'items'}`}`
      if (!phone) preview.append(h('span.rc-caption.tnum', `${from ? "That render's view" : 'This view'} · ${sizeText} · ${viewText}`))
      const facts = h('div.rc-facts',
        h('span.caps', 'What gets sent'),
        h('p', h('strong', from ? "That render's view" : 'This view, as framed'), h('span', viewText)),
        h('p.tnum', h('strong', sizeText), h('span', from ? 'The same picture as before' : orient)),
        h('p', h('strong', 'To fal, via kakapo'), h('span', `Key stays on the server. About ${ABOUT} s.`)))
      const mockNote = engine.isRenderMock() ? h('p.rc-mock', 'Mock mode: nothing goes to fal and nothing is charged.') : null
      const closeBtn = h('button.btn.btn-icon.btn-quiet.rc-close', { type: 'button', 'aria-label': 'Close', onclick: close }, pic('close', { size: 16 }))
      const head = h('header.rc-head', h('h2.rc-title', title), h('span.rc-sub', sub), closeBtn)
      function submit() {
        if (!shot) return
        close()
        quiet(run({ shot, model, prompt: prompt.trim(), view }))
      }
      if (phone) {
        return { label: title, el: h('div.rc-sheet', h('div.sheet-grab', { 'aria-hidden': 'true' }), head,
          h('div.rc-body', h('div.rc-top', preview, facts), h('span.caps.rc-label', 'Model'), models, h('label.rc-prompt-wrap', pic('pencil', { size: 16 }), promptEl), mockNote),
          h('div.rc-foot', go, h('button.rc-cancel', { type: 'button', onclick: close }, 'Cancel'))) }
      }
      return { label: title, el: h('div.rc-dialog', head,
        h('div.rc-body', preview, h('span.caps.rc-label', 'Model'), models, h('span.caps.rc-label', 'Prompt · optional'), promptEl, mockNote),
        h('footer.rc-foot', h('p.rc-note', `Goes to fal via kakapo; the key stays on the server. About ${ABOUT} s.`), button({ label: 'Cancel', kind: 'secondary', onClick: close }), go)) }
    })
    if (from && !shot) {
      try { shot = await imageShot(from.input_url) } catch (e) { loadError = e.message }
      if (modal === m) m.rerender()
    }
  }

  async function run({ shot, model, prompt, view }) {
    const p = { id: `r${++seq}`, model, prompt, shot, view, started: Date.now(), state: 'rendering' }
    pending.unshift(p)
    changed()
    try {
      const meta = await engine.postRender(shot, model, prompt || undefined)
      pending = pending.filter((x) => x !== p)
      changed()
      emit('done', { meta }) // the workspace shows the "Rendering…" chip and the "Render ready · View" toast
    } catch (e) {
      const msg = e.message || ''
      Object.assign(p, { state: 'failed', at: Date.now(), error: msg, reason: /timed? ?out/i.test(msg) ? 'timed out' : /FAL_KEY/.test(msg) ? 'no fal key' : /isn't answering|could not reach/i.test(msg) ? "kakapo isn't answering" : '' })
      changed()
      emit('failed', { error: msg })
    }
  }

  // --- viewer ----------------------------------------------------------------------------------------------------
  function openViewer(which) {
    const all = () => engine.getRenders()
    let idx = Math.max(0, all().findIndex((r) => r.name === (typeof which === 'string' ? which : which?.name)))
    let side = 'render'
    const m = openModal('viewer', ({ phone, close }) => {
      const list = all()
      const r = list[idx] || (typeof which === 'object' ? which : null)
      if (!r) return { label: 'Render', el: h('p.p-note', 'That render is gone.') }
      const step = (k) => { if (list.length < 2) return; idx = (idx + k + list.length) % list.length; m.rerender() }
      const of = list.length > 1 ? `${idx + 1} of ${list.length}` : ''
      const again = withIcon(button({ label: 'Render again…', kind: 'secondary', onClick: () => quiet(openConfirm({ from: r })) }), 'render')
      const p = real(r.prompt)
      const promptEl = p ? h('p.rv-prompt', pic('pencil', { size: 14 }), h('span', p)) : null
      const closeBtn = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'Close', onclick: close }, pic('close', { size: 16 }))
      if (phone) {
        const img = h('img.rv-img', { src: side === 'render' ? r.url : r.input_url, alt: side === 'render' ? 'The render' : 'The planner view that was sent' })
        const seg = segmented([{ value: 'planner', label: 'Planner' }, { value: 'render', label: 'Render' }], side, (v) => { side = v; img.src = v === 'render' ? r.url : r.input_url }, { small: true, label: 'Show' })
        const more = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'More', onclick: (e) => shell.menu(e.currentTarget, [
          { label: 'Open image', icon: 'renders', onSelect: () => window.open(r.url, '_blank', 'noopener') },
          ...(list.length > 1 ? [{ label: 'Newer', icon: 'chevron-down', disabled: idx === 0, onSelect: () => step(-1) }, { label: 'Older', icon: 'chevron-down', disabled: idx === list.length - 1, onSelect: () => step(1) }] : []),
        ], { align: 'end' }) }, pic('more', { size: 18 }))
        let x0 = null
        const stage = h('div.rv-stage', { onpointerdown: (e) => { x0 = e.clientX }, onpointerup: (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 60) step(e.clientX < x0 ? 1 : -1); x0 = null } }, img)
        return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-phone',
          h('header.rv-head', closeBtn, h('div.rv-titles', h('h2.rv-title.tnum', dayDate(r.created)), h('span.rv-sub.tnum', [of, modelShort(r.model), VIEW_WORD[r.view]].filter(Boolean).join(' · '))), more),
          h('div.rv-seg', seg), stage,
          h('footer.rv-foot', promptEl, h('div.rv-actions', again))) }
      }
      const size = h('span.tnum', '')
      const resImg = h('img', { src: r.url, alt: 'The render', onload: (e) => { size.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight}` } })
      const nav = list.length > 1 ? h('div.rv-nav',
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Newer', dataset: { tip: 'Newer', kbd: '←' }, onclick: () => step(-1) }, pic('chevron-left', { size: 16 })),
        h('span.tnum', of),
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Older', dataset: { tip: 'Older', kbd: '→' }, onclick: () => step(1) }, pic('chevron-right', { size: 16 }))) : null
      return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-desk',
        h('header.rv-head', h('h2.rv-title.tnum', `Render · ${dayDate(r.created)}`),
          h('span.rv-sub.tnum', [RENDER_MODELS[r.model]?.label || r.model, cost(r), r.view ? `${VIEW_WORD[r.view] || r.view} view` : null].filter(Boolean).join(' · ')),
          h('span.rv-spacer'),
          h('a.btn.btn-quiet', { href: r.url, target: '_blank', rel: 'noopener' }, 'Open image'), nav, h('span.rv-sep'), closeBtn),
        h('div.rv-pair',
          h('figure', h('div.rv-frame', h('img', { src: r.input_url, alt: 'The planner view that was sent' })), h('figcaption', h('span.caps', 'Planner view'), h('span', 'What was sent'))),
          h('figure', h('div.rv-frame', resImg), h('figcaption', h('span.caps', 'Render'), size))),
        h('footer.rv-foot', p ? h('div.rv-prompt-block', h('span.caps', 'Prompt'), h('p', p)) : h('div.rv-prompt-block', h('span.caps', 'Prompt'), h('p.muted', 'The default: keep everything, make it a photograph.')),
          h('div.rv-actions', again))) }
    })
    m.step = (k) => { const n = all().length; if (n < 2) return; idx = (idx + k + n) % n; m.rerender() }
  }

  engine.events.addEventListener('renders', () => { render(); if (modal?.kind === 'viewer') modal.rerender() })
  // The workspace's Render button and its "Render ready · View" toast hand over to the confirm and the viewer.
  shell.events.addEventListener('render-request', (e) => { e.preventDefault(); quiet(openConfirm()) })
  shell.events.addEventListener('open-render', (e) => { e.preventDefault(); openViewer(e.detail?.meta) })
  render()
  ctx.renders = { openConfirm, openViewer, getPending, events }
}
