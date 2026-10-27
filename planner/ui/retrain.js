// Retrain (§5.1 planner): a room whose capture kakapo kept can be trained again with settings scaled to it. The sheet
// shows the defaults (GET …/defaults: frames, steps, splats) and the time estimate, with one button; Advanced shows
// every §4.9.1 setting with a plain hint. The new room is <base>-rN; it shows with the scans while it trains.
// Entry points: Retrain in the desktop top bar (the open room), the Room panel and the Rooms list menus.
// ctx.retrain = { open(name), canRetrain(name) → 'kept'|'not-kept'|null }. Styles: styles/manage.css.
import { h, toggle } from './kit.js'
import { icon } from './icons.js'
import { openSheet, textInput } from './sheet.js'
import { NOT_KEPT, baseName, fmtSplats } from '../data.js'

const n0 = (v) => Math.round(v).toLocaleString('en-US').replace(/,/g, ' ')
export const SETTINGS = [
  { key: 'steps', label: 'Training steps', min: 1000, max: 200000, hint: 'More steps: sharper detail, a longer run.', fmt: n0 },
  { key: 'train_max_splats', label: 'Training splats', min: 100000, max: 4000000, hint: 'More detail, more GPU memory and time.', fmt: (v) => fmtSplats(v) },
  { key: 'deliver_max_splats', label: 'Splats delivered', min: 100000, max: 4000000, hint: 'What the planner and the phone load: fewer opens faster. At most the training splats.', fmt: (v) => fmtSplats(v) },
  { key: 'max_image_size', label: 'Video frame size', min: 640, max: 3840, unit: 'px', hint: 'Long side of each video frame it learns from. Bigger: finer texture, more memory.' },
  { key: 'stills_max_size', label: 'Still photo size', min: 640, max: 4032, unit: 'px', hint: 'Long side of the high-resolution stills, when the scan has them.' },
  { key: 'sh_degree', label: 'Colour detail', min: 0, max: 3, hint: 'How colour shifts with the angle you look from: 3 is the most lifelike, 0 the lightest file.' },
  { key: 'pose_opt', label: 'Refine camera poses', bool: true, hint: 'Lets training nudge where the phone was. Can rescue a wobbly scan; slower.' },
  { key: 'holdout_every', label: 'Hold out every Nth frame', min: 0, max: 50, hint: 'Keeps some frames out of training to score the result. 0 trains on every frame.' },
]
const minutes = (s) => (!(s > 0) ? '' : s < 90 ? `about ${Math.max(1, Math.round(s / 60))} min` : s < 5400 ? `about ${Math.round(s / 60)} min` : `about ${(s / 3600).toFixed(1)} h`)

export function mount(ctx) {
  const { engine, data, shell } = ctx

  // --- desktop top bar: Retrain the open room --------------------------------------------------------------------
  const top = h('button.ws-tool.rt-top', { type: 'button', hidden: true, dataset: { nook: 'retrain', tip: 'Train this scan again, with settings scaled to it' }, onclick: () => open(engine.getRoomName()) },
    icon('retrain', { size: 16, stroke: 1.875 }), h('span', 'Retrain'))
  const left = shell.mounts.topbar.querySelector('.ws-top-left')
  if (left) left.insertBefore(top, left.querySelector('.ws-chips')); else shell.mounts.topbar.append(top)
  function syncTop() { top.hidden = shell.isPhone() || canRetrain(engine.getRoomName()) !== 'kept' }
  for (const ev of ['rooms', 'scans']) data.events.addEventListener(ev, syncTop)
  engine.events.addEventListener('room', syncTop)
  engine.events.addEventListener('rooms', syncTop)
  shell.events.addEventListener('mode', syncTop)

  // 'kept' (its capture is on kakapo), 'not-kept', or null (not a room / no v4 info)
  function canRetrain(name) {
    if (!name) return null
    const r = data.getRoom(name) || engine.getRoomsList().find((x) => x.name === name)
    if (!r || !('capture' in r)) return null
    return r.capture ? 'kept' : 'not-kept'
  }

  // --- the sheet ----------------------------------------------------------------------------------------------------
  function open(name) {
    if (!name) return
    const r = data.getRoom(name)
    const title = r?.title || name
    if (canRetrain(name) !== 'kept') {
      const sheet = openSheet(shell, { title: `Retrain ${title}`, cls: 'rt',
        body: h('div.rt-notkept', icon('cloud-off', { size: 20 }), h('div', h('b', `${NOT_KEPT}.`),
          h('p', 'kakapo keeps the upload of each scan it trains from now on, but not this one. In Nook Scan, open the scan under Recent and tap Send to kakapo: it trains again as a new room.'))),
        actions: [h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => sheet.close() }, 'Close')] })
      return sheet
    }
    const st = { defs: null, values: {}, advanced: false, busy: false, error: '' }
    const summary = h('div.rt-summary', h('div.rt-loading', 'Getting the settings for this capture…'))
    const nameInput = textInput({ placeholder: 'Sharper', maxLength: 120, label: 'Title of the new room' })
    const advBtn = h('button.rt-adv', { type: 'button', 'aria-expanded': 'false', dataset: { nook: 'retrain-advanced' }, onclick: () => { st.advanced = !st.advanced; sync() } },
      icon('chevron-right', { size: 16 }), h('span', 'Advanced'), h('span.rt-adv-note'))
    const adv = h('div.rt-settings', { hidden: true })
    const errEl = h('p.ms-error', { role: 'alert', hidden: true })
    const next = `${baseName(name)}-r…`
    const body = h('div.ms-form.rt-form', summary,
      h('label.ms-row', h('span.ms-label', 'Title of the new room'), nameInput, h('span.ms-hint', `Optional. It's saved as ${next}; this room stays as it is.`)),
      advBtn, adv, errEl)
    const cancel = h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => sheet.close() }, 'Cancel')
    const go = h('button.btn.btn-primary.ms-btn.ms-primary', { type: 'button', dataset: { nook: 'retrain-go' }, onclick: () => submit() }, 'Retrain')
    const sheet = openSheet(shell, { title: `Retrain ${title}`, sub: 'The same capture, trained again with settings scaled to it. The new version shows with the scans while it trains.', body, actions: [cancel, go], cls: 'rt' })

    const fields = {}
    for (const s of SETTINGS) {
      let control
      if (s.bool) {
        control = toggle({ label: s.label, hint: s.hint, checked: false, onChange: (on) => { st.values[s.key] = on; sync() } })
        control.classList.add('rt-toggle')
        fields[s.key] = { el: control, set: (v) => { control.input.checked = !!v } }
        adv.append(control)
        continue
      }
      const input = textInput({ inputmode: 'numeric', label: s.label, onInput: (v) => { st.values[s.key] = v.trim() === '' ? undefined : Number(String(v).replace(/[\s ,]/g, '')); sync() } })
      const range = h('span.rt-range', `${s.fmt ? s.fmt(s.min) : n0(s.min)}–${s.fmt ? s.fmt(s.max) : n0(s.max)}${s.unit ? ` ${s.unit}` : ''}`)
      const err = h('span.rt-err', { hidden: true })
      const el = h('label.rt-set', h('span.rt-set-head', h('span.rt-set-label', s.label), range), h('span.rt-set-hint', s.hint), input, err)
      fields[s.key] = { el, input, err, set: (v) => { input.value = v == null ? '' : String(v) } }
      adv.append(el)
    }
    const reset = h('button.btn.btn-quiet.rt-reset', { type: 'button', onclick: () => { st.values = {}; fill(); sync() } }, icon('revert', { size: 16 }), h('span', 'Back to the defaults'))
    adv.append(reset)

    function fill() { for (const s of SETTINGS) fields[s.key].set(st.values[s.key] ?? st.defs?.settings?.[s.key]) }
    const value = (k) => (st.values[k] !== undefined ? st.values[k] : st.defs?.settings?.[k])
    function problems() {
      const out = {}
      for (const s of SETTINGS) {
        const v = st.values[s.key]
        if (v === undefined || s.bool) continue
        if (!Number.isInteger(v) || v < s.min || v > s.max || (s.key === 'holdout_every' && v === 1)) {
          out[s.key] = s.key === 'holdout_every' ? '0, or a whole number from 2 to 50' : `A whole number from ${n0(s.min)} to ${n0(s.max)}`
        }
      }
      if (!out.deliver_max_splats && Number(value('deliver_max_splats')) > Number(value('train_max_splats'))) out.deliver_max_splats = 'At most the training splats'
      return out
    }
    const changed = () => Object.fromEntries(Object.entries(st.values).filter(([k, v]) => v !== undefined && v !== st.defs?.settings?.[k]))
    // The time scales with steps × training splats (the trainer's measured speed, gpu.py).
    function eta() {
      const d = st.defs
      if (!d?.eta_s) return null
      const k = (value('steps') / d.settings.steps) * (value('train_max_splats') / d.settings.train_max_splats)
      return Number.isFinite(k) && k > 0 ? d.eta_s * k : d.eta_s
    }
    function sync() {
      const d = st.defs
      const bad = problems()
      const nChanged = Object.keys(changed()).length
      advBtn.setAttribute('aria-expanded', String(st.advanced))
      advBtn.querySelector('.icon')?.replaceWith(icon(st.advanced ? 'chevron-down' : 'chevron-right', { size: 16 }))
      advBtn.querySelector('.rt-adv-note').textContent = nChanged ? `${nChanged} changed` : 'Every setting, with what it does'
      adv.hidden = !st.advanced
      for (const s of SETTINGS) {
        const f = fields[s.key]
        f.el.classList.toggle('is-changed', st.values[s.key] !== undefined && st.values[s.key] !== d?.settings?.[s.key])
        if (f.err) { f.err.hidden = !bad[s.key]; f.err.textContent = bad[s.key] || '' }
      }
      if (d) {
        const t = eta()
        const tile = (k, v, sub) => h('div.rt-tile', h('span.caps', k), h('b.tnum', v), sub ? h('span', sub) : null)
        summary.replaceChildren(
          tile('Frames', n0(d.n_train), 'to learn from'),
          tile('Steps', n0(value('steps')), nChanged ? 'your settings' : 'scaled to it'),
          tile('Time', minutes(t) || '—', 'on kakapo'),
          h('p.rt-splats', `${fmtSplats(value('train_max_splats'))} splats while training, ${fmtSplats(value('deliver_max_splats'))} delivered · colour detail ${value('sh_degree')}`))
      }
      go.disabled = !d || st.busy || Object.keys(bad).length > 0
      const t = eta()
      go.textContent = st.busy ? 'Starting…' : !d ? 'Retrain' : `Retrain${t ? ` · ${minutes(t)}` : ''}`
      errEl.hidden = !st.error
      errEl.textContent = st.error
    }
    async function submit() {
      if (st.busy || !st.defs) return
      st.busy = true
      st.error = ''
      sync()
      try {
        const job = await data.retrainRoom(name, changed(), nameInput.value)
        sheet.close()
        shell.toast(`Retraining as ${job?.name || 'a new version'}: ${job?.status === 'queued' ? 'queued on kakapo' : 'started'}. It shows with the scans.`, {
          kind: 'ok', id: `retrain-${job?.id}`, ms: 8000, action: { label: 'Rooms', onClick: () => shell.openPage('rooms') },
        })
      } catch (e) {
        st.busy = false
        st.error = e.message
        sync()
      }
    }
    data.retrainDefaults(name).then((d) => {
      if (!sheet.isOpen()) return
      st.defs = d && d.settings ? d : null
      if (!st.defs) st.error = "kakapo didn't send the settings for this capture"
      fill()
      sync()
    }).catch((e) => { st.error = e.message; summary.replaceChildren(); sync() })
    sync()
    return sheet
  }

  ctx.retrain = { open, canRetrain }
  syncTop()
}
