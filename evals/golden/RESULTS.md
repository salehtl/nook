# Engine comparison

## 2026-10-25: Morris chair (clean product shot, 348 × 400 px)

| | SAM 3D (`sam3d`) | Trellis 2 (`trellis2`, 512p) |
|---|---|---|
| Cost | $0.02 | $0.25 |
| Shape | Correct: slatted arms, loose cushions, proportions within 2.7% of the real dims after a height-only fit | Correct, same proportions |
| Color and texture | Faithful: brown leather, golden oak | Drifted to grey/black leather, with speckle artifacts on the seat |
| Splat | Yes, aligned with the mesh after the pose fix | No |
| Files | 1.6 MB GLB + 52 MB splat | 16 MB GLB |

**Default: `sam3d`.** Use `trellis2` only when SAM 3D fails on a specific piece. Clean product shots don't need it.

Screenshot: `evals/out/e2e/real-lib.png` (regenerate with `node evals/library_in_planner.mjs <library.json>` after replaying the capture).

Still to test: a styled-room photo (SAM 3D's strength is pulling one object out of clutter) and thin or complex pieces such as a floor lamp or a cane chair.

## 2026-10-25: "Render this view" models (planner orbit view, 2 Morris chairs, placeholder room)

| Model | Price | Time | Camera and layout | Changes |
|---|---|---|---|---|
| `nano-banana` | $0.0398 | 9.8 s | **kept exactly** | added a rug; soft, believable shadows |
| `kontext` | $0.04 | 8.8 s | **re-framed**: zoomed in and re-angled | none beyond the camera |
| `qwen` | $0.0307 | 55.5 s | kept | turned the floor to wood; chairs shifted slightly |

**Default: `nano-banana`.** Layout fidelity is the point of a planning render. The test view is a hard case (a "dollhouse" against a black void), so re-check with a seated view inside the real scanned room.
Images: `renders/render-20261025-1446*.jpg`. Comparison grid: [render-models.jpg](render-models.jpg).
