"""nook-scan CLI (contract §4.6, §4.9, §4.9.1, §5): `check` a capture, `train` it into room/<name>.spz/.ply +
room/room.json (and room/<name>.room.json), or `serve` the jobs API."""

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
from . import capture, dataset, gpu, photometric, poses, post, room, roomplan, trainer
from .settings import PRESETS
from . import settings as settings_mod
from .ply import write_splats
from .spz import write_spz

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
    t = sub.add_parser("train", help="train a capture with gsplat (kakapo's NVIDIA GPU) and write <room-dir>/<name>.spz/.ply and room.json")
    t.add_argument("capture", help="capture .zip (as AirDropped from the app) or its unzipped folder")
    t.add_argument("--name", default="scan", help="output name: <room-dir>/<name>.ply (default: scan)")
    t.add_argument("--room-dir", default=str(REPO / "room"), help="where room.json lives (default: the repo's room/)")
    t.add_argument("--quality", choices=sorted(PRESETS), default="high",
                   help="draft: 10k steps at 1280 px (minutes); high: steps scaled to the capture, "
                        f"{settings_mod.K_STEPS_PER_FRAME} per training frame within {settings_mod.STEPS_MIN:,}-{settings_mod.STEPS_MAX:,} (default)")
    t.add_argument("--steps", type=int, help="training steps (default: from --quality)")
    t.add_argument("--holdout-every", type=int, default=0, help="leave out frames with index %% N == 0 from training (default: 0, use all)")
    t.add_argument("--max-image-size", type=int, help="downscale video frames to this long side before training (default: from --quality)")
    t.add_argument("--stills-max-size", type=int, help="the same for high-resolution stills (default: --max-image-size)")
    t.add_argument("--max-splats", type=int, help="training cap on the number of splats (default: "
                                                  f"{gpu.TRAIN_MAX_SPLATS['small']:,} on a GPU with up to {gpu.SMALL_VRAM_GB} GB, "
                                                  f"{gpu.TRAIN_MAX_SPLATS['large']:,} above; {settings_mod.DRAFT_MAX_SPLATS:,} for draft)")
    t.add_argument("--deliver-max-splats", type=int, help=f"prune the cropped room to this many splats, faintest and smallest first "
                                                          f"(default: {gpu.DELIVER_MAX_SPLATS:,}, at most --max-splats)")
    t.add_argument("--keep-full-ply", action="store_true", help="also write the unpruned crop as <name>.full.ply")
    t.add_argument("--sh-degree", type=int, choices=range(4), metavar="{0-3}", help="spherical-harmonics degree of the splat (default: from --quality; 3 is ~2.5x bigger)")
    t.add_argument("--pose-opt", action="store_true", help="refine the camera poses along with the splats (nook-gsplat --pose-opt)")
    t.add_argument("--dry-run", action="store_true", help='print the settings this run would use, {"n_train", "settings", "eta_s"}, and exit')
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
    # A retrain (contract §5.1): the room starts from its parent's config and doesn't repoint room.json.
    t.add_argument("--parent", help=argparse.SUPPRESS)
    t.add_argument("--title", help=argparse.SUPPRESS)
    t.add_argument("--keep-current", action="store_true", help=argparse.SUPPRESS)
    s = sub.add_parser("serve", help="run the jobs server (contract §5): upload captures, train them one at a time")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8095)
    s.add_argument("--data-dir", default="~/.nook-scan", help="uploads, jobs.json and logs (default: ~/.nook-scan)")
    s.add_argument("--room-dir", default=str(REPO / "room"), help="where trained rooms go; the folder the web app serves as /room/")
    s.add_argument("--steps", type=int, help="passed to every training run, unless a retrain sets its own")
    s.add_argument("--quality", choices=sorted(PRESETS), help="passed to every upload's training run (default: high); "
                                                              "retrains always start from the scaled high settings")
    s.add_argument("--max-splats", type=int, help="training cap passed to every training run, unless a retrain sets its own")
    s.add_argument("--gpu-lock", help="hold this file's flock while training, so other GPU users wait (default: none)")
    s.add_argument("--allowed-host", action="append", default=[], metavar="NAME",
                   help="also answer requests with this Host name (repeatable; loopback names always work)")
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


def resolve(args, n_frames: int) -> dict:
    """The effective settings (§4.9.1 keys): the preset scaled to the capture, overridden by explicit flags. The CLI's
    limits are looser than the retrain ranges (settings.RANGES), so evals can train tiny runs."""
    s = settings_mod.resolve(n_frames, args.quality, {
        "steps": args.steps, "train_max_splats": args.max_splats, "deliver_max_splats": args.deliver_max_splats,
        "max_image_size": args.max_image_size, "stills_max_size": args.stills_max_size, "sh_degree": args.sh_degree,
        "pose_opt": args.pose_opt or None, "holdout_every": args.holdout_every})
    if s["holdout_every"] < 0 or s["holdout_every"] == 1:
        raise ScanError("--holdout-every must be 0 (off) or at least 2")
    if s["steps"] < 100:
        raise ScanError(f"--steps {s['steps']} is too few: use at least 100 (--quality draft uses {PRESETS['draft']['steps']})")
    if s["max_image_size"] < 64 or s["stills_max_size"] < 64:
        raise ScanError("--max-image-size and --stills-max-size must be at least 64 px")
    if s["train_max_splats"] < 10_000 or s["deliver_max_splats"] < 10_000:
        raise ScanError("--max-splats and --deliver-max-splats must be at least 10000")
    if s["deliver_max_splats"] > s["train_max_splats"]:
        raise ScanError(f"--deliver-max-splats {s['deliver_max_splats']:,} is more than the training cap {s['train_max_splats']:,}: "
                        "lower it or raise --max-splats")
    return s


def cmd_train(args) -> int:
    started = time.time()
    if not SLUG.match(args.name):
        raise ScanError(f"--name {args.name!r} must be a slug (lowercase letters, digits and dashes, e.g. reading-room)")
    if args.parent is not None and not SLUG.match(args.parent):
        raise ScanError(f"--parent {args.parent!r} must be a room name (a slug)")
    if args.dry_run:  # the capture's frame count is all it needs: read it without unzipping
        n_frames = capture.peek(args.capture)["frames"]
        print(json.dumps(settings_mod.summary(n_frames, args.quality, resolve(args, n_frames))), flush=True)
        return 0
    room_dir = Path(args.room_dir).expanduser()
    if room_dir.exists() and not room_dir.is_dir():
        raise ScanError(f"--room-dir {room_dir} is a file, not a folder")
    room.read_existing(room_dir)  # fail fast on a broken room.json; it is re-read at commit time
    if args.refine_poses:
        poses.binary()  # fail fast when nook-poses isn't installed here
    far_seeds = args.far_seeds if args.far_seeds is not None else PRESETS[args.quality]["far_seeds"]

    work = Path(tempfile.mkdtemp(prefix="nook-scan-"))
    try:
        say("preparing: checking the capture")
        root = capture.open_capture(args.capture, work)
        cap = capture.load(root)
        cfg = resolve(args, len(cap.frames))
        say(f"capture {root.name}: {len(cap.frames)} frames, valid ({args.quality} quality: {cfg['steps']} steps, "
            f"images up to {cfg['max_image_size']} px, up to {cfg['train_max_splats']:,} splats in training and "
            f"{cfg['deliver_max_splats']:,} delivered)")
        seeds = dataset.seed_points(cap)
        room_seeds = seeds[0]  # the room itself: floor estimate and crop bounds (far seeds are added below)
        train_frames = [i for i in range(len(cap.frames)) if not dataset.is_held_out(i, cfg["holdout_every"])]
        if far_seeds > 0 and seeds[1] is not None:
            far, far_rgb = dataset.far_points(cap, train_frames, far_seeds)
            if len(far):
                say(f"window seeds: {len(far)} points {far_seeds:g} m out, where LiDAR saw nothing bright")
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
        prep = dataset.prepare(cap, work, cfg["holdout_every"], cfg["max_image_size"], seeds=seeds, gains=gains,
                               stills_max_size=cfg["stills_max_size"])
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
                               cfg["train_max_splats"], args.progress_every,
                               stills_max_size=cfg["stills_max_size"] if prep.stills else None, pose_opt=cfg["pose_opt"])
        if args.keep_raw:
            shutil.copyfile(result["ply"], Path(args.keep_raw).expanduser())
        say("finishing: cropping floaters and writing the room")
        full, stats = post.crop(result["ply"], room_seeds, cams, cap, train_frames)
        say(f"cropped {stats['outside']} splats outside the captured volume and {stats['transparent']} near-transparent ones, "
            f"kept {stats['window']} seen through windows: {stats['kept']} of {stats['trained']} kept")
        splats = post.prune(full, cfg["deliver_max_splats"])
        if len(splats) < len(full):
            say(f"pruned {len(full) - len(splats):,} splats with the least opacity x volume: {len(splats):,} delivered")

        ply_path = room_dir / f"{args.name}.ply"
        spz_path = room_dir / f"{args.name}.spz"
        room_json = room_dir / "room.json"
        own_json = room_dir / f"{args.name}.room.json"  # the room's own config (§2.7), kept when a later scan repoints room.json
        retrain = args.parent is not None or args.keep_current
        if retrain:
            # A retrain (§5.1): the same capture, so its parent's world frame, alignment and look; room.json stays put.
            new_room = room.retrained(room.read_config(room_dir, args.parent) if args.parent else {}, args.parent,
                                      spz_path, room_dir, floor_y, args.title)
            views = room.viewpoints(cap, floor_y, new_room["transform"])
            new_room["viewpoints"] = views or None
        else:
            # The planner loads the compact SPZ (~5x smaller, same rendering); the PLY stays alongside, full precision.
            # Re-read room.json: training takes minutes and the planner may have saved it (e.g. its look) meanwhile.
            views = room.viewpoints(cap, floor_y)
            new_room = room.updated(room.read_existing(room_dir), spz_path, room_dir, floor_y, views)
            if args.title:
                new_room["title"] = args.title
        say(f"viewpoints: {len(views)} camera poses at least {room.MIN_EYE_M} m above the floor")
        extras = {f"{args.name}.{k}": v for k, v in roomplan.files(root, cap.meta).items()}  # <name>.roomplan.json/.usdz
        if extras:
            say(f"room shell: {', '.join(extras)} from RoomPlan, in the capture's world frame")
        ply_tmp, spz_tmp = work / "final.ply", work / "final.spz"
        write_splats(ply_tmp, splats)
        write_spz(spz_tmp, splats)
        if args.keep_full_ply:
            write_splats(work / "full.ply", full)

        # Commit: nothing touches room-dir until everything above has succeeded. A cancel (SIGTERM) arriving now
        # waits until every file is in place, so room.json never points at a missing PLY.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        created = not room_dir.exists()
        room_dir.mkdir(parents=True, exist_ok=True)
        pid = os.getpid()
        config = (json.dumps(new_room, indent=2) + "\n").encode()
        files = [(ply_path, ply_tmp), (spz_path, spz_tmp)]                      # (destination, source file or bytes)
        if args.keep_full_ply:
            files.append((room_dir / f"{args.name}.full.ply", work / "full.ply"))
        files += [(room_dir / n, data) for n, data in extras.items()]
        files.append((own_json, config))
        if not retrain:
            files.append((room_json, config))                                     # last: it points at the rest
        staged = [(dst, dst.with_name(f".{dst.name}.tmp-{pid}"), src) for dst, src in files]
        try:
            for dst, tmp, src in staged:
                if isinstance(src, bytes):
                    tmp.write_bytes(src)
                else:
                    shutil.copyfile(src, tmp)
            for dst, tmp, _ in staged:
                os.replace(tmp, dst)
            for ext in ("roomplan.json", "roomplan.usdz"):  # a previous training of this name had a room shell, this one doesn't
                if f"{args.name}.{ext}" not in extras:
                    (room_dir / f"{args.name}.{ext}").unlink(missing_ok=True)
        except OSError as e:
            for _, tmp, _ in staged:
                tmp.unlink(missing_ok=True)
            if created:
                shutil.rmtree(room_dir, ignore_errors=True)
            raise ScanError(f"cannot write into {room_dir}: {e.strerror}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    summary = {
        "name": args.name, "ply": str(ply_path), "spz": str(spz_path), "room_json": str(own_json if retrain else room_json),
        "splats": int(len(splats)), "delivered_splats": int(len(splats)), "cropped_splats": int(len(full)),
        "floor_y": round(float(floor_y), 4), "steps": cfg["steps"], "seconds": round(time.time() - started, 1),
        "trainer": trainer.NAME, "psnr": result["psnr"], "floor_source": floor_source,
        "frames": {"train": prep.n_train, "held_out": prep.n_eval}, "seeds": prep.seed_source,
        "quality": args.quality, "max_image_size": prep.long_side, "max_splats": cfg["train_max_splats"],
        "photometric": gains is not None, "sh_degree": cfg["sh_degree"], "viewpoints": len(views),
        "poses": pose_summary, "settings": cfg, "parent": args.parent,
        "roomplan": f"{room_dir / args.name}.roomplan.json" if extras else None,
        "full_ply": str(room_dir / f"{args.name}.full.ply") if args.keep_full_ply else None,
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
