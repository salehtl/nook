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
