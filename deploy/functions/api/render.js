// POST /api/render on the hosted copy: same request/response as planner/serve.py (contract §2.6).
// Needs the FAL_KEY Pages secret; results go to R2 (renders/<name>.jpg) and metadata to KV (render:<name>).
import { json, error, readJson } from '../../lib/shared.js'

const MODELS = {
  kontext: { endpoint: 'fal-ai/flux-pro/kontext', args: (img, prompt) => ({ image_url: img, prompt, output_format: 'jpeg' }), cost: () => 0.04 },
  'nano-banana': { endpoint: 'fal-ai/nano-banana/edit', args: (img, prompt) => ({ image_urls: [img], prompt, output_format: 'jpeg' }), cost: () => 0.0398 },
  qwen: { endpoint: 'fal-ai/qwen-image-edit', args: (img, prompt) => ({ image_url: img, prompt, output_format: 'jpeg' }), cost: (mp) => Math.round(0.03 * mp * 10000) / 10000 },
}
const DEFAULT_PROMPT = 'Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, soft natural daylight, subtle contact shadows. Do not add, remove or move anything.'

// Width x height of a JPEG from its SOF marker, for the qwen per-megapixel price.
function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null
    const m = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3]
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] }
    i += 2 + len
  }
  return null
}

export async function onRequestPost({ env, request }) {
  let body
  try { body = await readJson(request) } catch (res) { return res }
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(body?.image || '')
  if (!m) return error(400, 'image must be a data:image/jpeg or data:image/png base64 URL')
  const modelName = body.model || 'kontext'
  const model = MODELS[modelName]
  if (!model) return error(400, `unknown model '${modelName}' (choose from ${Object.keys(MODELS).join(', ')})`)
  if (!env.FAL_KEY) return error(503, 'FAL_KEY not set on the hosted copy: run `npx wrangler pages secret put FAL_KEY --project-name nook` from nook/deploy')

  const input = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
  const prompt = body.prompt || DEFAULT_PROMPT
  const res = await fetch(`https://fal.run/${model.endpoint}`, {
    method: 'POST',
    headers: { authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(model.args(body.image, prompt)),
  })
  if (!res.ok) return error(502, `fal ${model.endpoint} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const out = await res.json()
  const url = out?.images?.[0]?.url
  if (!url) return error(502, `fal ${model.endpoint} returned no image`)
  const img = await fetch(url)
  if (!img.ok) return error(502, `could not download the render (HTTP ${img.status})`)

  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  let name = `render-${stamp}`
  for (let n = 2; await env.NOOK_KV.get(`render:${name}`); n++) name = `render-${stamp}-${n}`
  const size = m[1] === 'jpeg' ? jpegSize(input) : null
  const meta = {
    name, url: `/renders/${name}.jpg`, input_url: `/renders/${name}-input.${m[1] === 'png' ? 'png' : 'jpg'}`,
    model: modelName, cost_usd: model.cost(size ? (size.w * size.h) / 1e6 : 1), mock: false, prompt,
    created: now.toISOString(), view: body.view || null, layout: body.layout || null, hosted: true,
  }
  await env.NOOK_R2.put(`renders/${name}.jpg`, img.body, { httpMetadata: { contentType: 'image/jpeg' } })
  await env.NOOK_R2.put(`renders/${name}-input.${m[1] === 'png' ? 'png' : 'jpg'}`, input, { httpMetadata: { contentType: `image/${m[1]}` } })
  await env.NOOK_KV.put(`render:${name}`, JSON.stringify(meta))
  return json(200, meta)
}
