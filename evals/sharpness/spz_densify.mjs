// SYNTHETIC test rooms for the delivery-cap measurements: densify an SPZ v2 to a target splat count by repeating its
// splats with a small position jitter, shrinking every splat by sqrt(k) so the room's surface coverage stays about the
// same. This is not what a longer training produces: it only loads the renderer with more splats.
//   node evals/sharpness/spz_densify.mjs <in.spz> <out.spz> <target count> [jitter mm = 6]
import fs from 'node:fs'
import zlib from 'node:zlib'

const [inPath, outPath, targetArg, jitterArg] = process.argv.slice(2)
const raw = zlib.gunzipSync(fs.readFileSync(inPath), { maxOutputLength: 2 ** 32 })
const version = raw.readUInt32LE(4), n = raw.readUInt32LE(8), shDegree = raw[12], fracBits = raw[13]
if (raw.readUInt32LE(0) !== 0x5053474e || version !== 2) throw new Error(`need an SPZ v2 file, got version ${version}`)
const shDim = { 0: 0, 1: 9, 2: 24, 3: 45 }[shDegree]
const T = Number(targetArg), k = T / n
if (!(T > n)) throw new Error('the target must be above the file count')
const jitter = Math.round((Number(jitterArg ?? 6) / 1000) * 2 ** fracBits)
const dScale = Math.round(16 * Math.log(Math.sqrt(k))) // byte = (ln(scale) + 10) * 16
const sizes = [9, 1, 3, 3, 3, shDim]
const out = Buffer.alloc(16 + T * sizes.reduce((a, b) => a + b, 0))
raw.copy(out, 0, 0, 16)
out.writeUInt32LE(T, 8)
let inOff = 16, outOff = 16
sizes.forEach((sz, attr) => {
  for (let i = 0; i < T; i++) {
    const src = inOff + (i % n) * sz, dst = outOff + i * sz
    if (attr === 0) {
      for (let c = 0; c < 3; c++) {
        let v = raw.readIntLE(src + c * 3, 3)
        if (i >= n) v += Math.round((Math.random() * 2 - 1) * jitter)
        out.writeIntLE(v, dst + c * 3, 3)
      }
    } else if (attr === 3) {
      for (let c = 0; c < 3; c++) out[dst + c] = Math.max(0, raw[src + c] - dScale)
    } else raw.copy(out, dst, src, src + sz)
  }
  inOff += n * sz; outOff += T * sz
})
fs.writeFileSync(outPath, zlib.gzipSync(out, { level: 6 }))
console.log(JSON.stringify({ in: n, out: T, shDegree, fracBits, jitterUnits: jitter, dScale, bytes: fs.statSync(outPath).size }))
