import { json } from '../../lib/shared.js'

export async function onRequestGet({ env }) {
  const renders = []
  let cursor
  do {
    const page = await env.NOOK_KV.list({ prefix: 'render:', cursor })
    for (const k of page.keys) { const m = await env.NOOK_KV.get(k.name, 'json'); if (m) renders.push(m) }
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)
  return json(200, { renders: renders.sort((a, b) => (a.created < b.created ? 1 : -1)) })
}
