import { PLACEHOLDER_ROOM, json, error, readJson } from '../../lib/shared.js'

export async function onRequestGet({ env }) {
  return json(200, (await env.NOOK_KV.get('room', 'json')) || PLACEHOLDER_ROOM)
}

export async function onRequestPut({ env, request }) {
  let data
  try { data = await readJson(request) } catch (res) { return res }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('version' in data)) {
    return error(400, "room must be a JSON object with a 'version' field")
  }
  await env.NOOK_KV.put('room', JSON.stringify(data))
  return json(200, { ok: true })
}
