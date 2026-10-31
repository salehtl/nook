"""Offline checks of the scan-side sharpness work: seeds rebuilt from depth, the test walk, pass 4, the floor warning,
COLMAP pose refinement (with the stand-in evals/sharpness/fake_colmap.py, so no COLMAP needed).

Usage: $SPY -I evals/sharpness/scan_checks.py [REAL_CAPTURE_DIR ...]   ($SPY is nook-scan's python, ~/nook-exp/env.sh)
Needs numpy, pillow and jsonschema. No GPU: `train` runs with evals/fake_gsplat.py. Each real capture gets the floor
check and the seed checks. Prints ok/FAIL lines and exits non-zero on any failure.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scan" / "src"))
from nook_scan import ScanError, capture, colmap, dataset, post, room, settings  # noqa: E402
from nook_scan.ply import read_vertices  # noqa: E402
from nook_scan.ply import write_points  # noqa: E402

failures = 0


def check(name: str, ok, detail="") -> None:
    global failures
    print(f"{'ok  ' if ok else 'FAIL'} {name}{f': {detail}' if detail != '' else ''}")
    failures += not ok


def patched_contract(tmp: Path) -> Path:
    """The schema with the §4.8 patch applied, in a folder for NOOK_CONTRACT_DIR. A no-op once the patch has landed."""
    d = tmp / "contract"
    shutil.copytree(REPO / "contract", d)
    s = json.loads((d / "capture.schema.json").read_text())
    props = s["properties"]["transforms"]["properties"]["frames"]["items"]["properties"]
    props["pass"]["enum"] = [1, 2, 3, 4]
    props["test_walk"] = {"type": "boolean"}
    (d / "capture.schema.json").write_text(json.dumps(s))
    return d


def small_capture(tmp: Path, name: str) -> Path:
    d = tmp / name
    shutil.copytree(REPO / "fixtures" / "capture-small", d)
    return d


def edit(root: Path, fn) -> None:
    t, m = json.loads((root / "transforms.json").read_text()), json.loads((root / "meta.json").read_text())
    fn(t, m)
    (root / "transforms.json").write_text(json.dumps(t))
    (root / "meta.json").write_text(json.dumps(m))


def load(root: Path) -> capture.Capture:
    return capture.Capture(root, json.loads((root / "transforms.json").read_text()), json.loads((root / "meta.json").read_text()))


def plane_capture(tmp: Path, name: str) -> Path:
    """Forty frames at y = 0: 0-29 look down at a floor 1.3 m below, 30-39 look up at a ceiling 2 m above. Frame 5's
    depth says 0.5 m, so anything it feeds lands at y = -0.5, which no other frame sees. points.ply is all floor."""
    root = tmp / name
    (root / "images").mkdir(parents=True)
    (root / "depth").mkdir()
    w, h = 64, 48
    down = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]   # columns: camera x, y, z (the camera looks along -z, so -z is world -y)
    up = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]     # looks along world +y
    frames = []
    for i in range(40):
        name_ = f"{i + 1:06d}"
        Image.fromarray(np.full((h, w, 3), 128, np.uint8)).save(root / f"images/{name_}.jpg", quality=90)
        mm = 1300 if i < 30 else 2000
        if i == 5:
            mm = 500
        Image.fromarray(np.full((h, w), mm, np.uint16)).save(root / f"depth/{name_}.png")
        r = np.array(down if i < 30 else up, float)
        m = np.eye(4)
        m[:3, :3] = r
        m[0, 3] = i * 0.05
        frames.append({"file_path": f"images/{name_}.jpg", "depth_file_path": f"depth/{name_}.png",
                       "transform_matrix": m.tolist(), "timestamp": float(i)})
    n = dataset.PLY_SEED_CAP
    rng = np.random.default_rng(0)
    xyz = np.stack([rng.uniform(-1, 3, n), np.full(n, -1.3), rng.uniform(-1, 1, n)], 1).astype(np.float32)
    write_points(root / "points.ply", xyz, np.full((n, 3), 128, np.uint8))
    (root / "transforms.json").write_text(json.dumps({"camera_model": "OPENCV", "fl_x": 50.0, "fl_y": 50.0, "cx": 32.0, "cy": 24.0, "w": w, "h": h,
                                                      "ply_file_path": "points.ply", "frames": frames}))
    (root / "meta.json").write_text(json.dumps({"version": 1, "app": "nook-scan", "app_version": "test", "lidar": True,
                                                "world": "arkit-gravity-y-up-meters", "created": "2026-10-30T00:00:00Z",
                                                "frame_count": 40, "floor_y": -1.3}))
    return root


def seed_checks(tmp: Path) -> None:
    root = plane_capture(tmp, "planes")
    cap = load(root)
    xyz, rgb, source = dataset.seed_points(cap)
    check("cap hit + depth: seeds come from depth", source == "depth", source)
    check("cap hit: upward frames feed seeds (ceiling at y = 2)", (np.abs(xyz[:, 1] - 2) < 0.01).any())
    check("one seed per 2 cm voxel", len(np.unique(np.floor(xyz.astype(np.float64) / 0.02).astype(np.int64), axis=0)) == len(xyz))
    check("frame 5 feeds seeds when allowed", (np.abs(xyz[:, 1] + 0.5) < 0.01).any())
    xyz, _, source = dataset.seed_points(cap, [i for i in range(40) if i != 5])
    check("a frame left out of `frames` feeds no seeds", source == "depth" and not (np.abs(xyz[:, 1] + 0.5) < 0.01).any())

    thin, _ = dataset._seeds_from_depth(cap, list(range(40)), 50)
    check("over the budget: voxels grow, floor and ceiling both stay", len(thin) <= 50 and (thin[:, 1] > 1).any() and (thin[:, 1] < -1).any(), len(thin))

    edit(root, lambda t, m: t["frames"][30:] and [f.update(test_walk=True) for f in t["frames"][30:]])
    xyz, _, source = dataset.seed_points(load(root))
    check("test-walk frames never feed seeds", source == "depth" and not (xyz[:, 1] > 1).any())
    xyz, _, _ = dataset.seed_points(load(root), list(range(40)))
    check("... even when `frames` names them", not (xyz[:, 1] > 1).any())
    edit(root, lambda t, m: [f.pop("test_walk") for f in t["frames"][30:]])

    small = small_capture(tmp, "small")
    _, _, source = dataset.seed_points(load(small))
    check("under the cap: points.ply stays", source == "points.ply", source)
    no_depth = small_capture(tmp, "no-depth")
    edit(no_depth, lambda t, m: [f.pop("depth_file_path") for f in t["frames"]])
    _, _, source = dataset.seed_points(load(no_depth))
    check("no depth maps: points.ply stays", source == "points.ply", source)
    capped_no_depth = tmp / "capped-no-depth"
    shutil.copytree(root, capped_no_depth)
    edit(capped_no_depth, lambda t, m: [f.pop("depth_file_path") for f in t["frames"]])
    xyz, _, source = dataset.seed_points(load(capped_no_depth))
    check("cap hit but no depth maps: points.ply stays", source == "points.ply" and len(xyz) == dataset.PLY_SEED_CAP, source)
    no_ply = small_capture(tmp, "no-ply")
    edit(no_ply, lambda t, m: t.pop("ply_file_path"))
    _, _, source = dataset.seed_points(load(no_ply))
    check("no points.ply: seeds come from depth", source == "depth", source)

    a = np.random.default_rng(1).uniform(-2, 2, (5000, 3))
    far = a * 5
    lo, hi = post.captured_bounds(a, np.zeros((1, 3)))
    check("captured_bounds sees only what it is given: cmd_train passes room_seeds, not the far seeds", (hi < far.max(0)).all())


def settings_checks() -> None:
    check("n_train: old call unchanged", settings.n_train(100, 10) == 90 and settings.n_train(100, 0) == 100)
    check("n_train: test walk comes off", settings.n_train(100, 0, range(90, 100)) == 90)
    check("n_train: a frame both held out and on the walk counts once", settings.n_train(100, 10, range(90, 100)) == 81)
    check("steps scale with training frames only",
          settings.resolve(1000, "high", {}, range(500, 1000))["steps"] == settings.scaled_steps(500))


def validity_checks(tmp: Path, contract: Path) -> None:
    old = small_capture(tmp, "old-capture")
    os.environ.pop("NOOK_CONTRACT_DIR", None)
    check("today's schema: an old capture is valid", not capture.validate(old)[1])
    new = small_capture(tmp, "new-capture")
    edit(new, lambda t, m: [t["frames"][i].update({"pass": 4, "test_walk": True}) for i in (1, 2)])
    errs = capture.validate(new)[1]
    print(f"note today's contract/capture.schema.json on pass 4: {'accepted (patch landed)' if not errs else 'rejected (patch not landed yet)'}")
    os.environ["NOOK_CONTRACT_DIR"] = str(contract)
    check("patched schema: an old capture is valid", not capture.validate(old)[1])
    check("patched schema: pass 4 and test_walk are valid", not capture.validate(new)[1], capture.validate(new)[1][:1])
    bad = small_capture(tmp, "bad-capture")
    edit(bad, lambda t, m: t["frames"][1].update({"pass": 5}))
    check("patched schema: pass 5 is not valid", bool(capture.validate(bad)[1]))
    bad = small_capture(tmp, "bad-capture-2")
    edit(bad, lambda t, m: t["frames"][1].update({"test_walk": "yes"}))
    check("patched schema: test_walk must be a boolean", bool(capture.validate(bad)[1]))


def prepare_checks(tmp: Path) -> None:
    root = small_capture(tmp, "walk-capture")
    walk = [36, 37, 38, 39]
    edit(root, lambda t, m: [t["frames"][i].update({"pass": 4, "test_walk": True}) for i in walk])
    cap = load(root)
    work = tmp / "prep1"
    p = dataset.prepare(cap, work, 10, 480, held_out={7, 8})
    val = json.loads((p.data_dir / "transforms_val.json").read_text())["frames"]
    train = json.loads((p.data_dir / "transforms.json").read_text())["frames"]
    got = sorted(int(f["file_path"][7:13]) for f in val)
    check("val = holdout rule + explicit held_out + test walk", got == sorted({0, 10, 20, 30, 7, 8, *walk}), got)
    check("train + val = all frames, no overlap", len(train) + len(val) == 40 and p.n_train == len(train) and p.n_eval == len(val))
    check("training_frames matches", dataset.training_frames(cap, 10, {7, 8}) == sorted(int(f["file_path"][7:13]) for f in train))
    p = dataset.prepare(cap, tmp / "prep2", 0, 480)
    check("old prepare call: only the walk is held out", p.n_eval == 4 and p.n_train == 36)
    check("is_held_out keeps the every-N rule", dataset.is_held_out(20, 10) and not dataset.is_held_out(21, 10) and not dataset.is_held_out(1, 0))

    poses = cap.poses()
    frames = cap.frames
    for f in frames:
        f.pop("test_walk", None)
    for i, f in enumerate(frames):
        f["test_walk"] = i % 2 == 0   # the walk takes every other frame
    views = room.viewpoints(cap, -1.35)
    allowed = [poses[i][:3, 3] for i in range(40) if i % 2]
    check("viewpoints are never test-walk frames", views and all(
        any(np.allclose(np.array(v["position"]) - [0, 1.35, 0], p, atol=1e-3) for p in allowed) for v in views), len(views))


def floor_checks(tmp: Path) -> None:
    cams = np.array([[0, 0.32, 0]] * 5, float)
    check("floor -1.30, camera 0.32: no warning", post.floor_warning(-1.30, cams) is None)
    for floor in (-0.5, -3.9):
        check(f"floor {floor}, camera 0.32: warning", post.floor_warning(floor, cams) is not None, post.floor_warning(floor, cams))
    rng = np.random.default_rng(0)
    seeds = np.vstack([np.c_[rng.uniform(-3, 3, 5000), np.full(5000, -1.3), rng.uniform(-3, 3, 5000)],
                       rng.uniform([-3, -1.3, -3], [3, 2, 3], (3000, 3))])
    line = post.floor_warning(-3.9, cams, seeds)
    check("the warning says what the seed points suggest", "suggest y = -1.3" in line, line)
    check("no suggestion when nothing plausible backs one", "suggest" not in post.floor_warning(-3.9, cams, seeds[:50]))


def train_checks(tmp: Path, contract: Path) -> None:
    fake = tmp / "fake-gsplat"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} -I {REPO / 'evals/fake_gsplat.py'} \"$@\"\n")
    fake.chmod(0o755)
    env = dict(os.environ, NOOK_GSPLAT_BIN=str(fake), FAKE_GSPLAT_SECONDS="0", NOOK_CONTRACT_DIR=str(contract),
               PYTHONPATH=str(REPO / "scan" / "src"))

    def run(*args):
        return subprocess.run([sys.executable, "-m", "nook_scan", *args], capture_output=True, text=True, env=env, timeout=600)

    root = small_capture(tmp, "scan-20261030-000001")
    walk = [36, 37, 38, 39]
    edit(root, lambda t, m: [t["frames"][i].update({"pass": 4, "test_walk": True}) for i in walk])
    r = run("train", str(root), "--dry-run", "--holdout-every", "10")
    check("--dry-run counts training frames without the walk", r.returncode == 0 and json.loads(r.stdout.splitlines()[-1])["n_train"] == 32, r.stdout.strip()[-200:] or r.stderr)

    r = run("train", str(root), "--name", "good", "--room-dir", str(tmp / "room"), "--steps", "100", "--holdout-every", "10")
    ok = r.returncode == 0
    check("train with a test walk runs", ok, "" if ok else (r.stderr or r.stdout)[-300:])
    if ok:
        s = json.loads(r.stdout.splitlines()[-1])
        check("last line: frames count the walk", s["frames"] == {"train": 32, "held_out": 8, "test_walk": 4}, s["frames"])
        check("last line: floor_warning is null on a plausible floor", s["floor_warning"] is None, s["floor_warning"])
        check("under the cap with a test walk and depth: seeds from depth", s["seeds"] == "depth", s["seeds"])

    bad = small_capture(tmp, "scan-20261030-000002")
    edit(bad, lambda t, m: m.update(floor_y=-3.9))
    r = run("check", str(bad))
    check("`check` prints the warning", r.returncode == 0 and any(l.startswith("warn ") for l in r.stdout.splitlines()), r.stdout.strip()[-400:])
    r = run("train", str(bad), "--name", "bad", "--room-dir", str(tmp / "room"), "--steps", "100")
    ok = r.returncode == 0
    check("train with a bad floor runs", ok, "" if ok else (r.stderr or r.stdout)[-300:])
    if ok:
        s = json.loads(r.stdout.splitlines()[-1])
        check("last line: floor_warning is recorded", bool(s["floor_warning"]), s["floor_warning"])
        check("the warning goes through `say`", "nook-scan: warning: floor_y -3.90" in r.stdout)
        check("floor_y is not replaced", s["floor_y"] == -3.9, s["floor_y"])


def fake_colmap(tmp: Path) -> Path:
    fake = tmp / "fake-colmap"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} -I {REPO / 'evals/sharpness/fake_colmap.py'} \"$@\"\n")
    fake.chmod(0o755)
    return fake


def colmap_checks(tmp: Path) -> None:
    """colmap.refine on a prepared dataset. The stand-in moves the world by a similarity and each camera by up to 2 cm."""
    os.environ["NOOK_COLMAP_BIN"] = str(fake_colmap(tmp))
    qx = colmap.quat_from_matrix(np.array([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]]))
    check("quaternion of 90 degrees about z", np.allclose(qx, [2 ** -0.5, 0, 0, 2 ** -0.5]), qx)
    rng = np.random.default_rng(0)
    ok = True
    for _ in range(200):  # every branch, with a large w and with each large axis
        q = rng.normal(size=4)
        q[rng.integers(4)] *= 10
        q = q / np.linalg.norm(q)
        back = colmap.quat_from_matrix(colmap.matrix_from_quat(*q))
        ok &= bool(np.allclose(colmap.matrix_from_quat(*back), colmap.matrix_from_quat(*q)) and min(np.linalg.norm(back - q), np.linalg.norm(back + q)) < 1e-9)
    check("quaternion round trip", ok)

    def prepared(name, holdout=10):
        cap = load(small_capture(tmp, f"colmap-{name}"))
        return cap, dataset.prepare(cap, tmp / f"colmap-prep-{name}", holdout, 480)

    def matrices(data, fn="transforms.json"):
        return {f["file_path"]: np.array(f["transform_matrix"]) for f in json.loads((data / fn).read_text())["frames"]}

    cap, p = prepared("plain")
    before, before_val = matrices(p.data_dir), matrices(p.data_dir, "transforms_val.json")
    s = colmap.refine(p.data_dir)
    after, after_val = matrices(p.data_dir), matrices(p.data_dir, "transforms_val.json")
    check("refined: every camera", s["refined"] == 40 and s["outliers"] == 0 and s["unregistered"] == 0, s)
    check("poses changed, in train and held out", all(not np.array_equal(before[k], after[k]) for k in before) and all(not np.array_equal(before_val[k], after_val[k]) for k in before_val))
    moved = [np.linalg.norm(before[k][:3, 3] - after[k][:3, 3]) for k in before]
    # 2 cm per round, two rounds. Without the alignment the world is 30 cm and 5 degrees away.
    check("alignment holds: within 5 cm of ARKit", max(moved) < 0.05, f"max {max(moved) * 100:.2f} cm, scale {s['scale']}")
    check("alignment finds the world's scale", abs(s["scale"] - 1 / 1.02 ** 2) < 0.01, s["scale"])
    check("rotations stay rotations", all(np.allclose(m[:3, :3] @ m[:3, :3].T, np.eye(3), atol=1e-6) for m in after.values()))
    check("backups hold the ARKit poses", all(np.array_equal(v, before[k]) for k, v in matrices(p.data_dir, "transforms.arkit.json").items())
          and all(np.array_equal(v, before_val[k]) for k, v in matrices(p.data_dir, "transforms_val.arkit.json").items()))
    keys = lambda fn: sorted(json.loads((p.data_dir / fn).read_text())["frames"][0])  # noqa: E731
    check("other frame keys stay", keys("transforms.json") == keys("transforms.arkit.json"))
    check("COLMAP's work folder is gone", not (p.data_dir.parent / "colmap").exists())
    dataset.apply_poses(cap, p.data_dir)
    check("apply_poses moves the capture onto the refined poses", all(
        np.array_equal(cap.frames[int(k[7:13])]["transform_matrix"], m) for k, m in {**after, **after_val}.items()))

    _, p = prepared("no-val", 0)
    check("no transforms_val.json: runs", not (p.data_dir / "transforms_val.json").exists() and colmap.refine(p.data_dir)["refined"] == 40)

    _, p = prepared("outlier")
    before = matrices(p.data_dir)
    os.environ["FAKE_COLMAP_OUTLIER"] = "000005.jpg"
    s = colmap.refine(p.data_dir)
    del os.environ["FAKE_COLMAP_OUTLIER"]
    after = matrices(p.data_dir)
    check("outlier: reported with the count", s["outliers"] == 1 and s["refined"] == 39 and s["outlier_frames"][0]["frame"] == "000005.jpg", s["outlier_frames"])
    check("outlier: keeps its exact ARKit pose", np.array_equal(after["images/000005.jpg"], before["images/000005.jpg"]))
    others = [np.linalg.norm(before[k][:3, 3] - after[k][:3, 3]) for k in before if k != "images/000005.jpg"]
    check("outlier: doesn't pull the others' alignment", max(others) < 0.05, f"max {max(others) * 100:.2f} cm")

    _, p = prepared("drop")
    before = matrices(p.data_dir)
    os.environ["FAKE_COLMAP_DROP"] = "000005.jpg"
    s = colmap.refine(p.data_dir)
    del os.environ["FAKE_COLMAP_DROP"]
    check("a camera COLMAP didn't place keeps its pose", s["unregistered"] == 1 and np.array_equal(matrices(p.data_dir)["images/000005.jpg"], before["images/000005.jpg"]), s["unregistered"])

    def refused(p, env):
        os.environ.update(env)
        try:
            colmap.refine(p.data_dir)
            return ""
        except ScanError as e:
            return str(e)
        finally:
            for k in env:
                del os.environ[k]

    _, p = prepared("broken")
    before = (p.data_dir / "transforms.json").read_bytes()
    msg = refused(p, {"FAKE_COLMAP_BREAK": "1"})
    check("most cameras out of the guard: fails, dataset untouched", "train without --colmap-poses" in msg and (p.data_dir / "transforms.json").read_bytes() == before
          and not (p.data_dir / "transforms.arkit.json").exists(), msg)
    msg = refused(p, {"FAKE_COLMAP_FAIL": "bundle_adjuster"})
    check("a COLMAP failure: one line with COLMAP's error", "bundle_adjuster exited with 3: fake failure" in msg and "\n" not in msg
          and (p.data_dir / "transforms.json").read_bytes() == before and not (p.data_dir.parent / "colmap").exists(), msg)

    os.environ["NOOK_COLMAP_BIN"] = str(tmp / "no-such-colmap")
    msg = refused(p, {})
    check("missing binary: fails fast, names the fix", "NOOK_COLMAP_BIN" in msg and "\n" not in msg, msg)
    del os.environ["NOOK_COLMAP_BIN"]


def colmap_settings_checks() -> None:
    s = settings.resolve(1000)
    check("colmap_poses is off by default", s["colmap_poses"] is False and "--colmap-poses" not in settings.as_flags(s))
    on = settings.resolve(1000, "high", {"colmap_poses": True})
    check("colmap_poses on: a switch", settings.as_flags(on).count("--colmap-poses") == 1 and "True" not in settings.as_flags(on))
    check("colmap_poses must be a bool", "colmap_poses" in (settings.check({"colmap_poses": "yes"}) or "") and settings.check({"colmap_poses": True}) is None)
    off, with_it = settings.summary(1000), settings.summary(1000, "high", {"colmap_poses": True})
    check("eta_s counts COLMAP's time", with_it["eta_s"] - off["eta_s"] == settings.COLMAP_SECONDS_PER_FRAME * 1000, (off["eta_s"], with_it["eta_s"]))


def colmap_train_checks(tmp: Path, contract: Path) -> None:
    fake = tmp / "fake-gsplat-c"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} -I {REPO / 'evals/fake_gsplat.py'} \"$@\"\n")
    fake.chmod(0o755)
    env = dict(os.environ, NOOK_GSPLAT_BIN=str(fake), FAKE_GSPLAT_SECONDS="0", NOOK_CONTRACT_DIR=str(contract),
               PYTHONPATH=str(REPO / "scan" / "src"), NOOK_COLMAP_BIN=str(fake_colmap(tmp)))

    def run(*args, **more):
        return subprocess.run([sys.executable, "-m", "nook_scan", *args], capture_output=True, text=True, env={**env, **more}, timeout=600)

    root = small_capture(tmp, "scan-20261030-000003")
    room_dir = tmp / "colmap-room"
    common = ("--room-dir", str(room_dir), "--steps", "100", "--holdout-every", "10")
    r = run("train", str(root), "--refine-poses", "--colmap-poses")
    check("--refine-poses and --colmap-poses conflict", r.returncode == 2 and "not allowed with" in r.stderr and len(r.stderr.splitlines()) == 1, r.stderr.strip())
    off = json.loads(run("train", str(root), "--dry-run").stdout.splitlines()[-1])
    on = json.loads(run("train", str(root), "--dry-run", "--colmap-poses").stdout.splitlines()[-1])
    check("--dry-run: setting and eta_s", on["settings"]["colmap_poses"] and not off["settings"]["colmap_poses"] and on["eta_s"] > off["eta_s"], (off["eta_s"], on["eta_s"]))
    r = run("train", str(root), "--dry-run", "--colmap-poses", NOOK_COLMAP_BIN=str(tmp / "none"))
    check("--dry-run doesn't need COLMAP", r.returncode == 0, r.stderr.strip())
    r = run("train", str(root), "--name", "c-missing", *common, "--colmap-poses", NOOK_COLMAP_BIN=str(tmp / "none"))
    check("missing COLMAP: fails before any work", r.returncode == 1 and "preparing" not in r.stdout and "NOOK_COLMAP_BIN" in r.stderr, r.stderr.strip())

    r = run("train", str(root), "--name", "c-arkit", *common)
    arkit = json.loads(r.stdout.splitlines()[-1])
    check("off: no COLMAP, pose_refinement is null", arkit["pose_refinement"] is None and arkit["settings"]["colmap_poses"] is False and "COLMAP" not in r.stdout)
    r = run("train", str(root), "--name", "c-refined", *common, "--colmap-poses")
    ok = r.returncode == 0
    check("train --colmap-poses runs", ok, "" if ok else (r.stderr or r.stdout)[-300:])
    if ok:
        s = json.loads(r.stdout.splitlines()[-1])
        p = s["pose_refinement"]
        check("last line: pose_refinement", p and p["method"] == "colmap" and p["refined"] == 40 and p["seeds"]["rebuilt"] and p["seeds"]["source"] == "depth", p)
        check("last line: settings.colmap_poses", s["settings"]["colmap_poses"] is True and s["seeds"] == "depth")
        lines = [l for l in r.stdout.splitlines() if l.startswith("nook-scan:")]
        check("progress reaches the server: preparing: lines in order", any(l.startswith("nook-scan: preparing: COLMAP poses: bundle adjustment") for l in lines)
              and any("seeds rebuilt from depth" in l for l in lines))
        a, b = (json.loads((room_dir / f"c-{n}.room.json").read_text())["viewpoints"] for n in ("arkit", "refined"))
        far = max(np.linalg.norm(np.array(x["position"]) - y["position"]) for x, y in zip(a, b))
        check("viewpoints use the refined poses", len(a) == len(b) and 0 < far < 0.1, f"up to {far * 100:.2f} cm")
        # fake_gsplat's splats are the seeds, so this is points.ply as the trainer got it
        va, vb = read_vertices(room_dir / "c-arkit.ply"), read_vertices(room_dir / "c-refined.ply")
        check("the trainer got the rebuilt seeds", len(va) != len(vb) or not np.array_equal(va["x"], vb["x"]), f"{len(va)} and {len(vb)} splats")

    no_depth = small_capture(tmp, "scan-20261030-000004")
    edit(no_depth, lambda t, m: [f.pop("depth_file_path") for f in t["frames"]])
    r = run("train", str(no_depth), "--name", "c-nodepth", *common, "--colmap-poses")
    ok = r.returncode == 0
    check("no depth maps: runs, seeds stay points.ply", ok and json.loads(r.stdout.splitlines()[-1])["pose_refinement"]["seeds"] == {"rebuilt": False, "points": json.loads(r.stdout.splitlines()[-1])["pose_refinement"]["seeds"]["points"], "source": "points.ply"}, "" if ok else r.stderr[-300:])

    r = run("train", str(root), "--name", "c-outlier", *common, "--colmap-poses", FAKE_COLMAP_OUTLIER="000005.jpg")
    check("an outlier is reported as a warning", r.returncode == 0 and "warning: 1 cameras keep their ARKit poses" in r.stdout and "000005.jpg" in r.stdout, r.stderr[-200:])

    pidfile = tmp / "colmap.pid"
    p = subprocess.Popen([sys.executable, "-m", "nook_scan", "train", str(root), "--name", "c-cancel", *common, "--colmap-poses"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env={**env, "FAKE_COLMAP_HANG": str(pidfile)})
    for _ in range(600):
        if pidfile.is_file() and pidfile.read_text():
            break
        time.sleep(0.1)
    child = int(pidfile.read_text())
    alive = Path(f"/proc/{child}").exists()
    p.terminate()
    err = p.communicate(timeout=60)[1]
    time.sleep(0.2)
    check("cancel kills COLMAP", alive and not Path(f"/proc/{child}").exists() and p.returncode == 130 and not (room_dir / "c-cancel.ply").exists(), err.strip())


def colmap_server_checks(tmp: Path, contract: Path) -> None:
    """A retrain with colmap_poses, through a real `nook-scan serve` with the stand-in trainer and COLMAP."""
    fake = tmp / "fake-gsplat-s"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} -I {REPO / 'evals/fake_gsplat.py'} \"$@\"\n")
    fake.chmod(0o755)
    env = dict(os.environ, NOOK_GSPLAT_BIN=str(fake), FAKE_GSPLAT_SECONDS="0", NOOK_CONTRACT_DIR=str(contract),
               PYTHONPATH=str(REPO / "scan" / "src"), NOOK_COLMAP_BIN=str(fake_colmap(tmp)))
    name = "scan-20261030-000005"
    root = small_capture(tmp, name)
    zip_path = tmp / f"{name}.zip"
    with zipfile.ZipFile(zip_path, "w") as z:
        for f in root.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(tmp))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}/api/scan"

    def call(method, path, body=None, raw=None):
        headers = {"X-Nook": "1", "Content-Type": "application/zip" if raw else "application/json"}
        req = urllib.request.Request(base + path, method=method, data=raw or (json.dumps(body).encode() if body is not None else None), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def finished(jid):
        for _ in range(600):
            job = call("GET", f"/jobs/{jid}")[1]
            if job["status"] not in ("queued", "training"):
                return job
            time.sleep(0.2)
        return job

    server = subprocess.Popen([sys.executable, "-m", "nook_scan", "serve", "--port", str(port), "--data-dir", str(tmp / "serve-data"),
                               "--room-dir", str(tmp / "serve-room"), "--quality", "draft"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    try:
        for _ in range(100):
            try:
                call("GET", "/health")
                break
            except OSError:
                time.sleep(0.2)
        code, job = call("POST", "/captures", raw=zip_path.read_bytes())
        check("server: upload", code == 202, code)
        job = finished(job["id"])
        check("server: an upload runs no COLMAP", job["status"] == "done" and job["settings"]["colmap_poses"] is False and job["result"]["pose_refinement"] is None, job["message"])
        code, d = call("GET", f"/captures/{name}/defaults")
        check("server: /defaults has colmap_poses off", code == 200 and d["settings"]["colmap_poses"] is False)
        code, d = call("POST", f"/captures/{name}/retrain", {"settings": {"colmap_poses": "yes"}})
        check("server: a bad value is refused, naming the key", code == 400 and "colmap_poses" in d["error"], d)
        code, job = call("POST", f"/captures/{name}/retrain", {"settings": {"colmap_poses": True, "steps": 1000}})
        check("server: retrain accepted", code == 202, job)
        job = finished(job["id"])
        check("server: the retrain ran COLMAP", job["status"] == "done" and job["settings"]["colmap_poses"] is True and job["result"]["pose_refinement"]["refined"] == 40, job["message"])
    finally:
        server.terminate()
        server.wait(timeout=30)


def real_checks(path: str) -> None:
    root = Path(path)
    cap = load(root)
    cams = cap.poses()[:, :3, 3]
    floor = cap.meta["floor_y"]
    print(f"note {root.name}: floor_y {floor:.2f}, camera y median {np.median(cams[:, 1]):.2f}")
    check(f"{root.name}: no floor warning", post.floor_warning(floor, cams) is None)
    train = dataset.training_frames(cap, 10)
    xyz, rgb, source = dataset.seed_points(cap, train)
    near = lambda y: float((np.abs(y - floor) < 0.1).mean())  # noqa: E731
    print(f"note {root.name}: {source}, {len(xyz)} seeds, {near(xyz[:, 1]):.1%} within 10 cm of the floor")
    check(f"{root.name}: seeds rebuilt from depth", source == "depth" and len(xyz) <= dataset.DEPTH_MAX_SEEDS)
    far, far_rgb = dataset.far_points(cap, train, 10.0)
    check(f"{root.name}: room + far seeds fit MAX_SEEDS", len(xyz) + len(far) <= dataset.MAX_SEEDS, f"{len(xyz)} + {len(far)}")
    line = post.floor_warning(floor - 2.6, cams, xyz)
    check(f"{root.name}: a floor 2.6 m too low warns and suggests about the real one", line and "suggest" in line, line)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="nook-scan-checks-") as t:
        tmp = Path(t)
        contract = patched_contract(tmp)
        seed_checks(tmp)
        settings_checks()
        validity_checks(tmp, contract)
        prepare_checks(tmp)
        floor_checks(tmp)
        train_checks(tmp, contract)
        colmap_settings_checks()
        colmap_checks(tmp)
        colmap_train_checks(tmp, contract)
        colmap_server_checks(tmp, contract)
        for path in sys.argv[1:]:
            real_checks(path)
    print(f"{'FAILED: ' + str(failures) if failures else 'all passed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
