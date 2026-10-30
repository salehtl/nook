# Scanning the room

About 20 minutes. You need the iPhone (with LiDAR) with **Nook Scan** from TestFlight, and the room as you want it captured. Anything left in the room is baked into the scan.

## 1. Prepare

- **Even light:** daytime, curtains open but no harsh sun patches. Lighting is baked into the splat, so this is the light you'll see in the planner. The app locks exposure and white balance about a second into the scan, so start facing a typical part of the room, not the window.
- Close cupboard doors, and tidy cables and things on the walls.
- Keep people and pets out of the room.
- Turn on Do Not Disturb: a call ends the scan.

## 2. Capture (Nook Scan)

Hold the phone upright throughout. Allow 3 to 5 minutes.

1. **New Scan.** Hold the phone steady until the lock icon shows (exposure and white balance locked).
2. **Pass 1:** walk the perimeter slowly at chest height, with the phone level, looking across the room.
3. **Pass 2:** walk the loop again with the phone above head height, tilted down, so the floor and furniture tops are covered.
4. **Pass 3:** walk the loop again with the phone at knee height, tilted up, keeping walls in view, not just the ceiling.
5. **Test walk:** cross the room on a new route, looking around normally, first at seated height, then standing. These frames are how the room gets scored.
6. The app tells you when each pass has covered enough of the room, and when to raise, lower or tilt the phone. A red "slow down" means frames will blur.
7. Walk at a slow stroll, and never spin on the spot: turn as you walk, about 20 seconds for a full turn.
8. **Done.** If a pass is still missing, the app asks before it finishes.
9. **Room shell** (phones with LiDAR): the app then measures the room's walls, floor, doors and windows with RoomPlan, in about a minute. From where you are, sweep the phone slowly across every wall, corner, door and window. **Skip** keeps the scan without it; turn it off in Settings › Measure the room shell.

## 3. Send to kakapo

On the saved scan, tap **Send to kakapo**. The app uploads it (it keeps going in the background), kakapo trains it on its GPU (the time depends on how many photos the scan has; the planner shows an estimate), and the room appears in the planner by itself. **Open room** opens it (`https://nook.salehtl.com/planner/?room=<name>`). Every room you've scanned stays in **Rooms** (tap the room name at the top). Your phone needs the home Wi-Fi or Tailscale.

## 4. Check the alignment

The room arrives level and at real height (ARKit knows gravity and the floor). The first time a room opens, **Check room** shows its measured size and whether the floor is level. Use **Pick floor** or **Check size** (two points a known distance apart) if it's off, or **Fine-tune** (yaw if the walls aren't square to the grid), then **Save room**. The seated and standing views start where the phone was during the scan; the arrows in the walk bar (or `[` and `]`) step through those positions.
