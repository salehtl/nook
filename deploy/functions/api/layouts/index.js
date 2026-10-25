import { SLUG, json } from '../../../lib/shared.js'

// KV list() can lag new keys by up to ~60 s, so saves also maintain an index key ("layouts"), which reads
// back immediately. The list is unioned in so layouts written by other means still show up.
export async function onRequestGet({ env }) {
  const names = new Set((await env.NOOK_KV.get('layouts', 'json')) || [])
  let cursor
  do {
    const page = await env.NOOK_KV.list({ prefix: 'layout:', cursor })
    for (const k of page.keys) names.add(k.name.slice(7))
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)
  return json(200, { layouts: [...names].filter((n) => SLUG.test(n)).sort() })
}
