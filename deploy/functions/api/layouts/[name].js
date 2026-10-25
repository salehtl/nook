import { SLUG, json, error, readJson } from '../../../lib/shared.js'

export async function onRequestGet({ env, params }) {
  if (!SLUG.test(params.name)) return error(404, `no layout named ${params.name}`)
  const data = await env.NOOK_KV.get(`layout:${params.name}`, 'json')
  return data ? json(200, data) : error(404, `no layout named ${params.name}`)
}

export async function onRequestPut({ env, params, request }) {
  if (!SLUG.test(params.name)) return error(400, `layout name must be a slug like 'cozy-corner', got '${params.name}'`)
  let data
  try { data = await readJson(request) } catch (res) { return res }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return error(400, 'layout must be a JSON object')
  await env.NOOK_KV.put(`layout:${params.name}`, JSON.stringify(data))
  return json(200, { ok: true, name: params.name })
}
