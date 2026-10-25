# fal fixtures

**Status: SYNTHETIC.** These responses follow fal's documented response schemas, but the files are the Khronos
SheenChair, offset and rescaled (built by `fixtures/make_fal_mock.py`). They are good enough to build and test
plumbing and normalization offline. They say nothing about the real engines' coordinate frames.

## Engine frames (assumed until a real capture replaces this file)

| Engine | Up axis | Front | Units | Notes |
|---|---|---|---|---|
| sam3d `model_glb` | +Y | +Z | arbitrary | same frame as `gaussian_splat` |
| sam3d `gaussian_splat` | +Y | +Z | arbitrary | standard 3DGS PLY |
| trellis2 `model_glb` | +Y | +Z | arbitrary | |

The pipeline should keep each engine's default orientation in one obvious place (a small table or dict), so updating
it after the real capture is a one-line change.

## Mock layout

`<slug>/request.json` is the arguments sent, `<slug>/response.json` is the response verbatim, `<slug>/files/` holds
every file the response links (by URL basename), and `<slug>/input.*` is the image that was sent.
