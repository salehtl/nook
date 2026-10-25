// Shared helpers for the Pages Functions. Mirrors planner/serve.py (contract §2.1).
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PLACEHOLDER_ROOM = { version: 1, placeholder: { w: 3.5, d: 4, h: 2.7 } }
const MAX_BODY = 32 * 1024 * 1024

export const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const error = (status, message) => json(status, { error: message })

export async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0)
  if (len > MAX_BODY) throw error(413, 'body too large')
  try { return await request.json() } catch { throw error(400, 'body must be JSON') }
}

const TYPES = { glb: 'model/gltf-binary', gltf: 'model/gltf+json', json: 'application/json', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', csv: 'text/csv', ply: 'application/octet-stream', spz: 'application/octet-stream', splat: 'application/octet-stream', ksplat: 'application/octet-stream', sog: 'application/octet-stream' }

// Serve `${prefix}/${path}` from R2, with ETag revalidation. Everything sits behind Access, so caching is private.
export async function serveR2(env, request, prefix, parts) {
  const path = (parts || []).join('/')
  if (!path || parts.some((p) => p === '..' || p.startsWith('.'))) return error(404, 'not found')
  const key = `${prefix}/${path}`
  const obj = await env.NOOK_R2.get(key, { onlyIf: request.headers })
  if (!obj) return error(404, `${key} not found`)
  const headers = new Headers({ 'cache-control': 'private, no-cache', etag: obj.httpEtag })
  headers.set('content-type', obj.httpMetadata?.contentType || TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream')
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers })
  headers.set('content-length', String(obj.size))
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers })
}
