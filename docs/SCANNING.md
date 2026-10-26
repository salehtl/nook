# Scanning the room

About 20 minutes. You need the iPhone (with LiDAR) with **Nook Scan** from TestFlight, and the room as you want it captured. Anything left in the room is baked into the scan.

## 1. Prepare

- **Even light:** daytime, curtains open but no harsh sun patches. Lighting is baked into the splat, so this is the light you'll see in the planner. The app locks exposure and white balance about a second into the scan, so start facing a typical part of the room, not the window.
- Close cupboard doors, and tidy cables and things on the walls.

## 2. Capture (Nook Scan)

1. **New Scan.** Hold the phone steady until the lock icon shows (exposure and white balance locked).
2. **Pass 1:** walk the perimeter slowly at chest height, looking across the room.
3. **Pass 2:** a lower loop with the phone tilted down, so the floor and skirting are covered.
4. **Pass 3:** walk through the middle.
5. The app tells you when each pass has covered enough of the room. A red "slow down" means frames are being skipped.
6. **Done.**

## 3. Send to kakapo

On the saved scan, tap **Send to kakapo**. The app uploads it (it keeps going in the background), kakapo trains it on its GPU (about 16 minutes), and the room appears in the planner by itself. **Open room** opens it (`https://nook.salehtl.com/planner/?room=<name>`). Every room you've scanned stays in **Rooms** (tap the room name at the top). Your phone needs the home Wi-Fi or Tailscale.

## 4. Check the alignment

The room arrives level and at real height (ARKit knows gravity and the floor). The first time a room opens, **Check room** shows its measured size and whether the floor is level. Use **Pick floor** or **Check size** (two points a known distance apart) if it's off, or **Fine-tune** (yaw if the walls aren't square to the grid), then **Save room**. The seated and standing views start where the phone was during the scan; the arrows in the walk bar (or `[` and `]`) step through those positions.
