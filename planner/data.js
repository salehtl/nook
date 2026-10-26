// nook planner data: the rooms on kakapo (GET /api/rooms, contract §2.7) and the scans still on their way
// (GET /api/scan/jobs, §5), merged by name, polled, and cached on this device for the offline list.
//
// createData({ engine }) → data
//   start()                 first refresh, then poll: every 5 s while a scan is queued or training, every 30 s while
//                           kakapo isn't answering, else every 60 s
//   refresh()               fetch rooms + jobs now → Promise
//   retry()                 refresh now and restart the poll timer (Try again) → Promise
//   getRooms()              [room]  newest first: the §2.7 room object plus
//                           { title (display: the rename, else a friendly date), titleSet, splats, train_seconds,
//                             steps, quality ('high'|'draft', from the job or guessed from its steps), psnr, job }
//                           (training numbers from the room's done job, or null)
//   getScans()              [scan]  queued / training / failed / cancelled jobs, minus dismissed ones:
//                           the §5 job plus { title, word: 'Queued'|'Preparing'|'Training'|'Failed'|'Cancelled' }
//   getRoom(name) / getScan(name)   by room name (getScan: the newest unfinished job for that name)
//   getJob(id)              any job by id (done ones too), as listed in getScans() when it's there
//   getState()              { loaded, offline, asOf (ms of the data shown), retryAt (ms of the next poll while offline),
//                             roomsApi, jobsApi, active (a scan is busy) }
// Actions (Promises; they reject with a reported error)
//   rename(name, title)     PUT /api/rooms/<name> with the title (empty title → back to the date)
//   trash(name)             DELETE /api/rooms/<name> (moves it to .trash on kakapo)
//   cancelScan(jobId)       POST /api/scan/jobs/<id>/cancel
//   dismissScan(jobId)      hide a failed or cancelled scan on this device
// Events (data.events; e.detail)
//   'rooms' { rooms }   'scans' { scans }   'offline' { offline, asOf }
//   'scan-ready' { job, room }   a scan finished while this page was open
// Helpers: friendlyDate(iso|Date), relDate(iso|Date) ("Today, 09:36"), clock(iso|Date) ("09:36"), scanDate(name),
//   roomTitle(room), statusWord(job), fmtBytes(n), fmtSplats(n), fmtMinutes(seconds), fmtEta(seconds)
// The list follows the engine: a saved room, a new thumbnail or a saved layout refresh it.
const ROOMS_KEY = 'nook.rooms.cache'
const DISMISSED_KEY = 'nook.scans.dismissed'
const FAST = 5000, SLOW = 60000, OFFLINE = 30000
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')
// "Sun 26 Oct, 09:36" (local time)
export function friendlyDate(when) {
  const d = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const asDate = (when) => (when instanceof Date ? when : new Date(when))
export const clock = (when) => { const d = asDate(when); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
// "Today, 09:36", "Yesterday, 18:02", else the friendly date
export function relDate(when) {
  const d = asDate(when)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  return diff === 0 ? `Today, ${clock(d)}` : diff === 1 ? `Yesterday, ${clock(d)}` : friendlyDate(d)
}
// The capture time in a scan name (scan-YYYYMMDD-HHMMSS, the phone's local time), or null.
export function scanDate(name) {
  const m = /^scan-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name || '')
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}
export const roomTitle = (r) => (r?.title && String(r.title).trim()) || friendlyDate(scanDate(r?.name) || r?.created) || r?.name || ''
export function statusWord(job) {
  if (!job) return ''
  if (job.status === 'queued') return 'Queued'
  if (job.status === 'training') return job.stage === 'preparing' || job.stage === 'building trainer' || job.stage === 'waiting' ? 'Preparing' : 'Training'
  return { done: 'Ready', failed: 'Failed', cancelled: 'Cancelled' }[job.status] || job.status
}
export const fmtBytes = (n) => (!(n > 0) ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
export const fmtSplats = (n) => (!(n > 0) ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n))
export const fmtMinutes = (s) => (!(s > 0) ? '' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`)
export const fmtEta = (s) => (!(s > 0) ? '' : s < 60 ? 'less than a minute left' : `about ${Math.round(s / 60)} min left`)

export function createData({ engine = null } = {}) {
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  const report = (msg, e) => (engine ? engine.reportError(msg, e) : new Error(`${msg}: ${e?.message || e}`))
  const cache = store.get(ROOMS_KEY)
  const state = { loaded: false, offline: false, asOf: null, retryAt: null, roomsApi: null, jobsApi: null }
  let rawRooms = Array.isArray(cache?.rooms) ? cache.rooms : []
  let jobs = Array.isArray(cache?.jobs) ? cache.jobs : []
  let rooms = [], scans = []
  let dismissed = new Set(store.get(DISMISSED_KEY) || [])
  const seen = new Map() // job id → status seen while this page is open
  const pendingReady = new Map() // job id → job that turned done; announced once its room is listed
  let timer = null, running = false, inflight = null, timerMs = 0

  async function getJson(url, opts) {
    let res
    try { res = await fetch(url, opts) } catch (e) { const err = new Error(`could not reach ${url} (${e.message})`); err.offline = true; throw err }
    let body = null
    try { body = await res.json() } catch { /* not JSON */ }
    if (!res.ok) { const err = new Error(body?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
    return body
  }

  function merge() {
    const byName = new Map()
    for (const j of jobs) if (j.status === 'done' && j.name && !byName.has(j.name)) byName.set(j.name, j) // newest first
    rooms = rawRooms.map((r) => {
      const job = byName.get(r.name) || null
      const res = job?.result || {}
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const steps = num(res.steps)
      const quality = res.quality ?? (steps ? (steps >= 20000 ? 'high' : 'draft') : null)
      return { ...r, titleSet: !!r.title, title: roomTitle(r), splats: num(res.splats), train_seconds: num(res.seconds),
        steps, quality, psnr: num(res.psnr), job }
    })
    scans = jobs.filter((j) => j.status !== 'done' && !(dismissed.has(j.id) && (j.status === 'failed' || j.status === 'cancelled')))
      .map(decorate)
    emit('rooms', { rooms: rooms.slice() })
    emit('scans', { scans: scans.slice() })
  }

  function decorate(j) { return { ...j, title: friendlyDate(scanDate(j.name) || j.created) || j.name, word: statusWord(j) } }

  function setOffline(offline) {
    if (offline === state.offline) return
    state.offline = offline
    emit('offline', { offline, asOf: state.asOf })
  }

  async function fetchJobs() {
    try {
      const body = await getJson('/api/scan/jobs')
      state.jobsApi = true
      return Array.isArray(body?.jobs) ? body.jobs : []
    } catch (e) {
      if (e.status === 404 || e.status === 502 || e.status === 503 || e.status === 405) { state.jobsApi = false; return [] }
      throw e
    }
  }

  async function refreshNow() {
    let roomsBody = null, nextJobs = null, offline = false
    const [r, j] = await Promise.allSettled([getJson('/api/rooms'), fetchJobs()])
    if (r.status === 'fulfilled' && Array.isArray(r.value?.rooms)) { roomsBody = r.value; state.roomsApi = true }
    else if (r.status === 'rejected' && r.reason?.offline) offline = true
    else if (r.status === 'fulfilled' || r.reason?.status === 404) state.roomsApi = false
    if (j.status === 'fulfilled') nextJobs = j.value
    else if (j.reason?.offline) offline = true
    if (roomsBody) rawRooms = roomsBody.rooms
    else if (state.roomsApi === false) rawRooms = []
    if (nextJobs) {
      for (const job of nextJobs) {
        const before = seen.get(job.id)
        if (before && before !== 'done' && job.status === 'done') pendingReady.set(job.id, { job, tries: 0 })
        seen.set(job.id, job.status)
      }
      jobs = nextJobs
    }
    if (!offline) {
      state.asOf = Date.now()
      store.set(ROOMS_KEY, { rooms: rawRooms, jobs, at: state.asOf })
    } else if (!state.asOf) state.asOf = cache?.at || null
    state.loaded = true
    merge()
    setOffline(offline)
    for (const [id, p] of pendingReady) {
      const room = rooms.find((x) => x.name === p.job.name) || null
      if (!room && state.roomsApi !== false && ++p.tries < 3) continue // not listed yet: wait for the next refresh
      pendingReady.delete(id)
      emit('scan-ready', { job: p.job, room })
    }
  }

  function refresh() {
    if (!inflight) {
      inflight = refreshNow().finally(() => {
        inflight = null
        // A refresh outside the poll (Rooms opened, Try again, a rename) found a busy scan: poll fast from now on.
        if (running && timerMs > FAST && active() && !document.hidden) schedule()
      })
    }
    return inflight
  }

  const active = () => jobs.some((j) => j.status === 'queued' || j.status === 'training')
  function schedule() {
    clearTimeout(timer)
    if (!running) return
    const ms = document.hidden ? SLOW : active() ? FAST : state.offline ? OFFLINE : SLOW
    state.retryAt = Date.now() + ms
    timerMs = ms
    timer = setTimeout(tick, ms)
  }
  async function tick() {
    try { await refresh() } catch { /* offline state is set; keep polling */ }
    // A job turned done but its room isn't listed yet (the trainer writes it last): ask again once.
    if (pendingReady.size && state.roomsApi) { try { await refresh() } catch { /* ignore */ } }
    schedule()
  }
  function start() {
    if (running) return refresh()
    running = true
    document.addEventListener('visibilitychange', () => { if (!document.hidden && running) { clearTimeout(timer); tick() } })
    if (rawRooms.length || jobs.length) merge() // the last-known list while the first refresh runs
    const p = refresh()
    p.finally(schedule)
    return p
  }
  function stop() { running = false; clearTimeout(timer) }

  // --- actions
  async function rename(name, title) {
    const t = typeof title === 'string' ? title.trim().slice(0, 120) : ''
    try {
      const cfg = await getJson(`/api/rooms/${encodeURIComponent(name)}`)
      const body = { ...cfg, title: t || null }
      delete body.saved
      await getJson(`/api/rooms/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (e) { throw report(e.offline ? "Not renamed: kakapo isn't answering" : `Could not rename "${name}"`, e) }
    if (engine && engine.getRoomName() === name) engine.setRoomTitle(t || null)
    const r = rawRooms.find((x) => x.name === name)
    if (r) r.title = t || null
    merge()
    quietRefresh()
  }
  async function trash(name) {
    let res
    try { res = await getJson(`/api/rooms/${encodeURIComponent(name)}`, { method: 'DELETE' }) } catch (e) {
      throw report(e.offline ? "Not moved to the trash: kakapo isn't answering" : `Could not move "${name}" to the trash`, e)
    }
    rawRooms = rawRooms.filter((x) => x.name !== name)
    merge()
    quietRefresh()
    return res
  }
  async function cancelScan(jobId) {
    let job
    try { job = await getJson(`/api/scan/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }) } catch (e) {
      throw report(e.status === 409 ? 'That scan has already finished' : e.offline ? "Not cancelled: kakapo isn't answering" : 'Could not cancel the scan', e)
    }
    jobs = jobs.map((j) => (j.id === jobId && job ? job : j))
    merge()
    quietRefresh()
    return job
  }
  function dismissScan(jobId) {
    dismissed.add(jobId)
    // keep only ids that still exist, so the list doesn't grow forever
    dismissed = new Set([...dismissed].filter((id) => id === jobId || jobs.some((j) => j.id === id)))
    store.set(DISMISSED_KEY, [...dismissed])
    merge()
  }
  const quietRefresh = () => { refresh().catch(() => {}) }

  // Follow the engine: thumbnails, Save room (aligned) and saved layouts change what the list shows.
  if (engine?.events) {
    engine.events.addEventListener('thumb', (e) => {
      const r = rawRooms.find((x) => x.name === e.detail?.name)
      if (r) { r.thumb_url = e.detail.url; r.thumb_v = Date.now(); merge() }
    })
    engine.events.addEventListener('room', (e) => {
      const { phase, name } = e.detail || {}
      if (phase === 'saved' && name) { const r = rawRooms.find((x) => x.name === name); if (r) { r.aligned = true; merge() } quietRefresh() }
    })
    engine.events.addEventListener('layouts', (e) => { if (e.detail?.name && running) quietRefresh() })
  }

  return {
    events,
    start,
    stop,
    refresh,
    retry: () => { clearTimeout(timer); return running ? tick() : refresh() },
    getRooms: () => rooms.slice(),
    getScans: () => scans.slice(),
    getRoom: (name) => rooms.find((r) => r.name === name) || null,
    getJob: (id) => { const s = scans.find((x) => x.id === id), j = s || jobs.find((x) => x.id === id); return s || (j ? decorate(j) : null) },
    getScan: (name) => scans.find((s) => s.name === name && (s.status === 'queued' || s.status === 'training')) || scans.find((s) => s.name === name) || null,
    getState: () => ({ ...state, active: active() }),
    rename,
    trash,
    cancelScan,
    dismissScan,
  }
}
