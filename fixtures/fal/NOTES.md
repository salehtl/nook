# fal fixtures

**Status: REAL**, captured 2026-10-25 with `fixtures/capture_fal.py` on `evals/golden/morris-chair.jpg` (prompt `armchair`; Trellis 2 at 512p). Total cost $0.27.

Kept verbatim: `request.json`, `response.json`, `input.jpg` and the GLBs. Two changes to keep the repo light:
- The SAM 3D splat is decimated to every 8th splat (763,680 → 95,460). Same file name and format.
- `objects_bundle.zip` (41 MB) is left out. It duplicates the GLB and splat, and the pipeline never fetches it.

## Engine frames (measured)

| Engine | Asset | Frame | Notes |
|---|---|---|---|
| sam3d | `model_glb` | canonical object frame: +Y up, front +Z, about 1 unit in size | Bounds ±0.40 × ±0.50 × ±0.46. The backrest is toward −Z. |
| sam3d | `gaussian_splat` | **camera space** of the input photo | Posed by `metadata[0]`: `rotation` is a quaternion **[w, x, y, z]**, plus `translation` (z ≈ 2.56 m in front of the camera) and uniform `scale`. To reach the GLB frame: `p_glb = Rx(−90°) · R(q) · (p − t) / s`, which aligns with the GLB surface to a median of 1.6 cm. Implemented in `pipeline/src/nook_pipeline/frames.py` (`sam3d_splat_to_glb`). |
| trellis2 | `model_glb` | +Y up, front +Z, about 1 unit in size | Bounds ±0.40 × ±0.48 × ±0.50. |

Units are arbitrary in every case (not metric), so `--dims` always sets the real size.

The splat has no `f_rest_*` (DC color only), about 764k splats for one armchair (52 MB). Large for a single piece of furniture, but Spark handles it.

## Mock layout

`<slug>/request.json` is the arguments sent, `<slug>/response.json` is the response verbatim, `<slug>/files/` holds the linked files (by URL basename) that the pipeline fetches, and `<slug>/input.*` is the image that was sent.
