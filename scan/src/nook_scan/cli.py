"""nook-scan CLI (contract §4.6, §4.9, §5): `check` a capture, `train` it into room/<name>.ply + room/room.json,
or `serve` the jobs API."""

import argparse
import json
import os
import re
import shutil
import signal
import sys
import tempfile
import time
import warnings
from pathlib import Path

import numpy as np

from . import REPO, ScanError, say
from . import capture, dataset, gpu, photometric, poses, post, room, trainer
from .ply import write_splats
from .spz import write_spz

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Quality presets (contract §4.9), for gsplat on kakapo's RTX 2060. Tuned on the first real scan
# (scan-20261026-093654: 517 frames, 1920x1440, auto exposure) and judged by Spark on held-out frames as
# evals/scan_quality.sh does: high = 20k steps, full resolution, SH degree 3, window seeds 10 m out: 21.85 dB in
# 16.4 min, 2.5 GB VRAM (Brush with its own tuning: 22.03 dB in 33.5 min, 3.8 GB). Exposure-locked captures (app 0.2)
# remove most of the error that is left.
PRESETS = {
    "draft": {"steps": 10000, "max_image_size": 1280, "sh_degree": 1, "far_seeds": 0.0},
    "high": {"steps": 20000, "max_image_size": 1920, "sh_degree": 3, "far_seeds": 10.0},
}


class Parser(argparse.ArgumentParser):
    def error(self, message):  # one stderr line instead of usage + error
        print(f"nook-scan: error: {message} (see nook-scan {self.prog.split()[-1] if ' ' in self.prog else ''} --help)".replace("  ", " "), file=sys.stderr)
        sys.exit(2)


def build_parser() -> Parser:
    p = Parser(prog="nook-scan", description="Train a nook-scan iPhone capture into the planner's room splat (contract §4).")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=Parser)
    c = sub.add_parser("check", help="validate a capture (folder or .zip) against contract §4.5")
    c.add_argument("capture")
    t = sub.add_parser("train", help="train a capture with gsplat (kakapo's NVIDIA GPU) and write <room-dir>/<name>.spz/.ply and room.json")
    t.add_argument("capture", help="capture .zip (as AirDropped from the app) or its unzipped folder")
    t.add_argument("--name", default="scan", help="output name: <room-dir>/<name>.ply (default: scan)")
    t.add_argument("--room-dir", default=str(REPO / "room"), help="where room.json lives (default: the repo's room/)")
    t.add_argument("--quality", choices=sorted(PRESETS), default="high",
                   help="draft: 10k steps at 1280 px (minutes); high: tuned for a sharp room (default, ~16 min on kakapo's RTX 2060)")
    t.add_argument("--steps", type=int, help="training steps (default: from --quality)")
    t.add_argument("--holdout-every", type=int, default=0, help="leave out frames with index %% N == 0 from training (default: 0, use all)")
    t.add_argument("--max-image-size", type=int, help="downscale images to this long side before training (default: from --quality)")
    t.add_argument("--max-splats", type=int, help=f"cap on the number of splats (default: {gpu.MAX_SPLATS_LARGE:,} on a GPU with "
                                                  f"{gpu.SMALL_VRAM_GB} GB or more, {gpu.MAX_SPLATS_SMALL:,} below)")
    t.add_argument("--sh-degree", type=int, choices=range(4), metavar="{0-3}", help="spherical-harmonics degree of the splat (default: from --quality; 3 is ~2.5x bigger)")
    t.add_argument("--far-seeds", type=float, metavar="M",
                   help="seed what the windows show this many meters out, where LiDAR saw nothing (0 = off; default: from --quality)")
    t.add_argument("--photometric", action="store_true",
                   help="even out exposure and white balance between frames before training (captures without exposure lock). "
                        "Off by default: the room looks more even, but held-out photos keep their own exposure, so it scores lower")
    t.add_argument("--refine-poses", action="store_true",
                   help="refine the ARKit camera poses with nook-poses (VGGT, kakapo) before training (contract §4.11)")
    # Tuning and server plumbing, not for everyday use.
    t.add_argument("--keep-raw", help=argparse.SUPPRESS)
    t.add_argument("--progress-every", type=float, default=20.0, help=argparse.SUPPRESS)
    s = sub.add_parser("serve", help="run the jobs server (contract §5): upload captures, train them one at a time")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8095)
    s.add_argument("--data-dir", default="~/.nook-scan", help="uploads, jobs.json and logs (default: ~/.nook-scan)")
    s.add_argument("--room-dir", default=str(REPO / "room"), help="where trained rooms go; the folder the web app serves as /room/")
    s.add_argument("--steps", type=int, help="passed to every training run")
    s.add_argument("--quality", choices=sorted(PRESETS), help="passed to every training run (default: the trainer's, high)")
    s.add_argument("--max-splats", type=int, help="passed to every training run")
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
              f"seeds={'yes' if t.get('ply_file_path') else 'no'}, span {np.linalg.norm(np.ptp(pos, axis=0)):.2f} m, floor_y={m.get('floor_y')}, "
              f"exposure_locked={m.get('exposure_locked')}")
    return 0


def resolve(args) -> dict:
    """The effective training settings: the preset, overridden by explicit flags."""
    pre = PRESETS[args.quality]
    cfg = {
        "steps": args.steps if args.steps is not None else pre["steps"],
        "max_image_size": args.max_image_size if args.max_image_size is not None else pre["max_image_size"],
        "max_splats": args.max_splats if args.max_splats is not None else gpu.default_max_splats(),
        "sh_degree": args.sh_degree if args.sh_degree is not None else pre["sh_degree"],
        "far_seeds": args.far_seeds if args.far_seeds is not None else pre["far_seeds"],
    }
    if cfg["steps"] < 100:
        raise ScanError(f"--steps {cfg['steps']} is too few: use at least 100 (--quality draft uses {PRESETS['draft']['steps']})")
    if cfg["max_image_size"] < 64:
        raise ScanError("--max-image-size must be at least 64 px")
    if cfg["max_splats"] < 10_000:
        raise ScanError(f"--max-splats {cfg['max_splats']} is too few: use at least 10000")
    return cfg


def cmd_train(args) -> int:
    started = time.time()
    if not SLUG.match(args.name):
        raise ScanError(f"--name {args.name!r} must be a slug (lowercase letters, digits and dashes, e.g. reading-room)")
    cfg = resolve(args)
    if args.holdout_every < 0 or args.holdout_every == 1:
        raise ScanError("--holdout-every must be 0 (off) or at least 2")
    room_dir = Path(args.room_dir).expanduser()
    if room_dir.exists() and not room_dir.is_dir():
        raise ScanError(f"--room-dir {room_dir} is a file, not a folder")
    room.read_existing(room_dir)  # fail fast on a broken room.json; it is re-read at commit time
    if args.refine_poses:
        poses.binary()  # fail fast when nook-poses isn't installed here

    work = Path(tempfile.mkdtemp(prefix="nook-scan-"))
    try:
        say("preparing: checking the capture")
        root = capture.open_capture(args.capture, work)
        cap = capture.load(root)
        say(f"capture {root.name}: {len(cap.frames)} frames, valid ({args.quality} quality: {cfg['steps']} steps, "
            f"images up to {cfg['max_image_size']} px, up to {cfg['max_splats']:,} splats)")
        seeds = dataset.seed_points(cap)
        room_seeds = seeds[0]  # the room itself: floor estimate and crop bounds (far seeds are added below)
        train_frames = [i for i in range(len(cap.frames)) if not dataset.is_held_out(i, args.holdout_every)]
        if cfg["far_seeds"] > 0 and seeds[1] is not None:
            far, far_rgb = dataset.far_points(cap, train_frames, cfg["far_seeds"])
            if len(far):
                say(f"window seeds: {len(far)} points {cfg['far_seeds']:g} m out, where LiDAR saw nothing bright")
                seeds = (np.concatenate([seeds[0], far]), np.concatenate([seeds[1], far_rgb]), seeds[2])
        gains = None
        if args.photometric:
            g = photometric.measure(cap, train_frames, room_seeds)
            if g is None:
                say("photometric: not enough seed points seen from enough frames to measure exposure, images left as shot")
            else:
                say(f"photometric: exposure varies by {g.spread_ev:.2f} EV across frames (5-95%); evened out, the same surface "
                    f"differs by {g.residual_after:.2f} EV between frames instead of {g.residual_before:.2f} EV"
                    + (" (exposure was locked)" if cap.meta.get("exposure_locked") is True else ""))
                gains = g.gains
        say("preparing: writing the training images")
        prep = dataset.prepare(cap, work, args.holdout_every, cfg["max_image_size"], seeds=seeds, gains=gains)
        say(f"dataset: {prep.n_train} training frames, {prep.n_eval} held out, {len(prep.seeds)} seed points ({prep.seed_source})")
        if not len(prep.seeds):
            say("warning: no seed points or depth in this capture, the trainer starts from random splats (expect a blurrier room)")
        pose_summary = None
        if args.refine_poses:
            pose_summary = poses.refine(prep.data_dir)
            say(f"poses refined: median shift {pose_summary['shift_cm_median']} cm (max {pose_summary['shift_cm_max']}), "
                f"rotation median {pose_summary['rot_deg_median']} deg, in {pose_summary['seconds']:.0f} s")
        cams = cap.poses()[:, :3, 3]
        floor_y, floor_source = cap.meta.get("floor_y"), "ARKit floor plane in meta.json"
        if floor_y is None:
            floor_y, floor_source = post.estimate_floor(room_seeds, cams), f"estimated from {prep.seed_source} points"
        if floor_y is None:
            raise ScanError("can't tell where the floor is (no ARKit floor plane in meta.json and no seed points or LiDAR depth below the camera): "
                            "scan again with the floor in view")
        say(f"floor at y = {floor_y:.3f} m ({floor_source})")

        result = trainer.train(prep.data_dir, work / "out", cfg["steps"], prep.long_side, cfg["sh_degree"],
                               cfg["max_splats"], args.progress_every)
        if args.keep_raw:
            shutil.copyfile(result["ply"], Path(args.keep_raw).expanduser())
        say("finishing: cropping floaters and writing the room")
        splats, stats = post.crop(result["ply"], room_seeds, cams, cap, train_frames)
        say(f"cropped {stats['outside']} splats outside the captured volume and {stats['transparent']} near-transparent ones, "
            f"kept {stats['window']} seen through windows: {stats['kept']} of {stats['trained']} kept")

        views = room.viewpoints(cap, floor_y)
        say(f"viewpoints: {len(views)} camera poses at least {room.MIN_EYE_M} m above the floor")
        ply_path = room_dir / f"{args.name}.ply"
        spz_path = room_dir / f"{args.name}.spz"
        room_json = room_dir / "room.json"
        # The planner loads the compact SPZ (~5x smaller, same rendering); the PLY stays alongside, full precision.
        # Re-read room.json: training takes minutes and the planner may have saved it (e.g. its look) meanwhile.
        new_room = room.updated(room.read_existing(room_dir), spz_path, room_dir, floor_y, views)
        ply_tmp, spz_tmp = work / "final.ply", work / "final.spz"
        write_splats(ply_tmp, splats)
        write_spz(spz_tmp, splats)

        # Commit: nothing touches room-dir until everything above has succeeded. A cancel (SIGTERM) arriving now
        # waits until both files are in place, so room.json never points at a missing PLY.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        created = not room_dir.exists()
        room_dir.mkdir(parents=True, exist_ok=True)
        staged = room_dir / f".{args.name}.ply.tmp-{os.getpid()}"
        staged_spz = room_dir / f".{args.name}.spz.tmp-{os.getpid()}"
        staged_json = room_dir / f".room.json.tmp-{os.getpid()}"
        try:
            shutil.copyfile(ply_tmp, staged)
            shutil.copyfile(spz_tmp, staged_spz)
            staged_json.write_bytes((json.dumps(new_room, indent=2) + "\n").encode())
            os.replace(staged, ply_path)
            os.replace(staged_spz, spz_path)
            os.replace(staged_json, room_json)
        except OSError as e:
            for p in (staged, staged_spz, staged_json):
                p.unlink(missing_ok=True)
            if created:
                shutil.rmtree(room_dir, ignore_errors=True)
            raise ScanError(f"cannot write into {room_dir}: {e.strerror}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    summary = {
        "name": args.name, "ply": str(ply_path), "spz": str(spz_path), "room_json": str(room_json), "splats": int(len(splats)),
        "floor_y": round(float(floor_y), 4), "steps": cfg["steps"], "seconds": round(time.time() - started, 1),
        "trainer": trainer.NAME, "psnr": result["psnr"], "floor_source": floor_source,
        "frames": {"train": prep.n_train, "held_out": prep.n_eval}, "seeds": prep.seed_source,
        "quality": args.quality, "max_image_size": prep.long_side, "max_splats": cfg["max_splats"],
        "photometric": gains is not None, "sh_degree": cfg["sh_degree"], "viewpoints": len(views),
        "poses": pose_summary,
    }
    print(json.dumps(summary), flush=True)
    return 0


def _terminate(signum, frame):
    raise KeyboardInterrupt


def main() -> None:
    # stderr is reserved for the single error line: silence numpy floating-point chatter
    # (Accelerate's det/matmul can raise spurious RuntimeWarnings on Apple silicon).
    warnings.simplefilter("ignore")
    np.seterr(all="ignore")
    args = build_parser().parse_args()
    if args.cmd == "serve":
        from . import serve
        sys.exit(serve.main(args))
    signal.signal(signal.SIGTERM, _terminate)
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
