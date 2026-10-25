"""nook-scan CLI (contract §4.6): `check` a capture, or `train` it into room/<name>.ply + room/room.json."""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import warnings
from pathlib import Path

import numpy as np

from . import REPO, ScanError, say
from . import brush, capture, dataset, post, room
from .ply import write_splats

DEFAULT_STEPS = 10000
DEFAULT_MAX_IMAGE = 1280
DEFAULT_SH = 1  # view-dependent color: 1 keeps glossy floors plausible at 40% of the file size of degree 3
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class Parser(argparse.ArgumentParser):
    def error(self, message):  # one stderr line instead of usage + error
        print(f"nook-scan: error: {message} (see nook-scan {self.prog.split()[-1] if ' ' in self.prog else ''} --help)".replace("  ", " "), file=sys.stderr)
        sys.exit(2)


def build_parser() -> Parser:
    p = Parser(prog="nook-scan", description="Train a nook-scan iPhone capture into the planner's room splat (contract §4).")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=Parser)
    c = sub.add_parser("check", help="validate a capture (folder or .zip) against contract §4.5")
    c.add_argument("capture")
    t = sub.add_parser("train", help="train a capture with Brush and write <room-dir>/<name>.ply and room.json")
    t.add_argument("capture", help="capture .zip (as AirDropped from the app) or its unzipped folder")
    t.add_argument("--name", default="scan", help="output name: <room-dir>/<name>.ply (default: scan)")
    t.add_argument("--room-dir", default=str(REPO / "room"), help="where room.json lives (default: the repo's room/)")
    t.add_argument("--steps", type=int, default=DEFAULT_STEPS, help=f"training steps (default: {DEFAULT_STEPS})")
    t.add_argument("--holdout-every", type=int, default=0, help="leave out frames with index %% N == 0 from training (default: 0, use all)")
    t.add_argument("--max-image-size", type=int, default=DEFAULT_MAX_IMAGE, help=f"downscale images to this long side before training (default: {DEFAULT_MAX_IMAGE})")
    t.add_argument("--sh-degree", type=int, default=DEFAULT_SH, choices=range(4), metavar="{0-3}", help=f"spherical-harmonics degree of the splat (default: {DEFAULT_SH}; 3 is ~2.5x bigger)")
    return p


def cmd_check(args) -> int:
    with tempfile.TemporaryDirectory(prefix="nook-scan-") as tmp:
        root = capture.open_capture(args.capture, Path(tmp))
        cap, errs = capture.validate(root)
        if errs:
            for e in errs:
                print(f"FAIL {e}")
            more = f" (+{len(errs) - 1} more problems listed above)" if len(errs) > 1 else ""
            raise ScanError(errs[0] + more)
        pos = cap.poses()[:, :3, 3]
        t, m = cap.transforms, cap.meta
        depth = sum(1 for f in cap.frames if f.get("depth_file_path"))
        print(f"ok   {root.name}: {len(cap.frames)} frames {t['w']}x{t['h']}, lidar={m['lidar']}, depth={depth}, "
              f"seeds={'yes' if t.get('ply_file_path') else 'no'}, span {np.linalg.norm(np.ptp(pos, axis=0)):.2f} m, floor_y={m.get('floor_y')}")
    return 0


def cmd_train(args) -> int:
    started = time.time()
    if not SLUG.match(args.name):
        raise ScanError(f"--name {args.name!r} must be a slug (lowercase letters, digits and dashes, e.g. reading-room)")
    if args.steps < 100:
        raise ScanError(f"--steps {args.steps} is too few: use at least 100 (default {DEFAULT_STEPS})")
    if args.holdout_every < 0 or args.holdout_every == 1:
        raise ScanError("--holdout-every must be 0 (off) or at least 2")
    if args.max_image_size < 64:
        raise ScanError("--max-image-size must be at least 64 px")
    room_dir = Path(args.room_dir).expanduser()
    if room_dir.exists() and not room_dir.is_dir():
        raise ScanError(f"--room-dir {room_dir} is a file, not a folder")
    existing = room.read_existing(room_dir)

    work = Path(tempfile.mkdtemp(prefix="nook-scan-"))
    try:
        root = capture.open_capture(args.capture, work)
        cap = capture.load(root)
        say(f"capture {root.name}: {len(cap.frames)} frames, valid")
        prep = dataset.prepare(cap, work, args.holdout_every, args.max_image_size)
        say(f"dataset: {prep.n_train} training frames, {prep.n_eval} held out, {len(prep.seeds)} seed points ({prep.seed_source})")
        if not len(prep.seeds):
            say("warning: no seed points or depth in this capture, Brush starts from random splats (expect a blurrier room)")
        cams = cap.poses()[:, :3, 3]
        floor_y, floor_source = cap.meta.get("floor_y"), "ARKit floor plane in meta.json"
        if floor_y is None:
            floor_y, floor_source = post.estimate_floor(prep.seeds, cams), f"estimated from {prep.seed_source} points"
        if floor_y is None:
            raise ScanError("can't tell where the floor is (no ARKit floor plane in meta.json and no seed points or LiDAR depth below the camera): "
                            "scan again with the floor in view")
        say(f"floor at y = {floor_y:.3f} m ({floor_source})")

        binary = brush.ensure()
        result = brush.train(binary, prep.data_dir, work / "out", args.steps, prep.long_side, args.sh_degree)
        splats, stats = post.crop(result["ply"], prep.seeds, cams)
        say(f"cropped {stats['outside']} splats outside the captured volume and {stats['transparent']} near-transparent ones: "
            f"{stats['kept']} of {stats['trained']} kept")

        ply_path = room_dir / f"{args.name}.ply"
        room_json = room_dir / "room.json"
        new_room = room.updated(existing, ply_path, room_dir, floor_y)
        ply_tmp = work / "final.ply"
        write_splats(ply_tmp, splats)

        # Commit: nothing touches room-dir until everything above has succeeded.
        created = not room_dir.exists()
        room_dir.mkdir(parents=True, exist_ok=True)
        staged = room_dir / f".{args.name}.ply.tmp-{os.getpid()}"
        try:
            shutil.copyfile(ply_tmp, staged)
            os.replace(staged, ply_path)
            room.write_atomic(room_json, (json.dumps(new_room, indent=2) + "\n").encode())
        except OSError as e:
            staged.unlink(missing_ok=True)
            if created:
                shutil.rmtree(room_dir, ignore_errors=True)
            raise ScanError(f"cannot write into {room_dir}: {e.strerror}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    summary = {
        "name": args.name, "ply": str(ply_path), "room_json": str(room_json), "splats": int(len(splats)),
        "floor_y": round(float(floor_y), 4), "steps": args.steps, "seconds": round(time.time() - started, 1),
        "trainer": brush.NAME, "psnr": result["psnr"], "floor_source": floor_source,
        "frames": {"train": prep.n_train, "held_out": prep.n_eval}, "seeds": prep.seed_source,
    }
    print(json.dumps(summary), flush=True)
    return 0


def main() -> None:
    # stderr is reserved for the single error line: silence numpy floating-point chatter
    # (Accelerate's det/matmul can raise spurious RuntimeWarnings on Apple silicon).
    warnings.simplefilter("ignore")
    np.seterr(all="ignore")
    args = build_parser().parse_args()
    try:
        sys.exit(cmd_check(args) if args.cmd == "check" else cmd_train(args))
    except ScanError as e:
        print(f"nook-scan: error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("nook-scan: interrupted: nothing was written to the room folder", file=sys.stderr)
        sys.exit(130)
    except Exception as e:  # noqa: BLE001 - one line, no traceback (contract §4.6)
        if os.environ.get("NOOK_SCAN_DEBUG"):
            raise
        msg = " ".join(str(e).split())[:200]
        print(f"nook-scan: unexpected error ({type(e).__name__}: {msg}): re-run with NOOK_SCAN_DEBUG=1 for details", file=sys.stderr)
        sys.exit(1)
