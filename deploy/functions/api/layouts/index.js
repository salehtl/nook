import { SLUG, json } from '../../../lib/shared.js'

export async function onRequestGet({ env }) {
  const names = []
  let cursor
  do {
    const page = await env.NOOK_KV.list({ prefix: 'layout:', cursor })
    for (const k of page.keys) { const n = k.name.slice(7); if (SLUG.test(n)) names.push(n) }
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)
  return json(200, { layouts: names.sort() })
}
