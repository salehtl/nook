"""Offline checks of the scan-side sharpness work: seeds rebuilt from depth, the test walk, pass 4, the floor warning.

Usage: $SPY -I evals/sharpness/scan_checks.py [REAL_CAPTURE_DIR ...]   ($SPY is nook-scan's python, ~/nook-exp/env.sh)
Needs numpy, pillow and jsonschema. No GPU: `train` runs with evals/fake_gsplat.py. Each real capture gets the floor
check and the seed checks. Prints ok/FAIL lines and exits non-zero on any failure.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scan" / "src"))
from nook_scan import capture, dataset, post, room, settings  # noqa: E402
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
        for path in sys.argv[1:]:
            real_checks(path)
    print(f"{'FAILED: ' + str(failures) if failures else 'all passed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
