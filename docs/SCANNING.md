# Scanning the room

About 20 minutes total. You need the iPhone (with LiDAR), a tape measure, and the room emptied.

## 1. Prepare

- **Empty the room** of the two pieces of furniture. Anything left in the scan is baked in and can't be cleanly removed later.
- **Even light**: daytime, curtains open but no harsh sun patches. Turn on ceiling lights only if the room is dim. Lighting is baked into the splat, so this is the light you'll see in the planner.
- **Measure one long wall** at floor level, corner to corner, and note it, e.g. "window wall 3.42 m". It's used to set exact scale.
- Close cupboard doors, and tidy cables and things on the walls.

## 2. Capture (Scaniverse, free)

1. Open Scaniverse → **New scan** → **Splat** mode (not Mesh). Choose the largest size/range option.
2. Start in a corner. Walk the perimeter **slowly**, phone at chest height, pointed across the room toward the opposite walls.
3. Do a **second loop at knee height**, pointed slightly down, so the floor and skirting are covered.
4. Do a **third pass pointed up** at the ceiling edges and the tops of windows.
5. Fill gaps: corners, behind the door, the window reveals. The on-screen overlay shows what's covered.
6. Stop and process **on device**, with the highest quality setting.

Tips: move the phone smoothly, without jerky turns. Overlap is good. Avoid pointing at a bright window for long, because the exposure swings.

## 3. Export

Share → Export → **SPZ** (preferred, small) or **PLY**. AirDrop it to the Mac and put it in `nook/room/` (e.g. `room/scan.spz`). It's git-ignored, so it stays local.

Optional: Polycam **Room** mode (RoomPlan) gives a dimensioned floor plan. Handy for checking measurements, but not needed.

## 4. Align in the planner

```bash
npm run serve
```

Open `http://localhost:8765/planner/`, drop the scan file on the page (or set `"splat": "room/scan.spz"` in `room/room.json`), then in the **Alignment** panel:

1. **Yaw / pitch / roll** until the floor is flat and the walls line up with the grid.
2. **Pick floor**: click the floor. That point becomes y = 0.
3. **Two-point scale**: click both ends of the wall you measured and type the length in meters.
4. **Save**. This writes `room/room.json`, which is versioned.

Then ask me to start placing furniture.
