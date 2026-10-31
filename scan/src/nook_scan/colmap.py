"""`train --colmap-poses` (contract §4.9.1): refine a prepared dataset's ARKit poses with COLMAP. SIFT, matching on
pose-derived pairs, triangulation at the known poses, then bundle adjustment of the poses (intrinsics fixed), twice.
The result is aligned back onto the ARKit frame (similarity, Umeyama on camera centers).

Opt-in: it took 6.4 hours on a 1,074-frame room (8 threads). It gave the best room in the tests (docs/plans/sharpness.md).
Training and held-out frames are refined together, as in that test.

NOOK_COLMAP_BIN names the executable; otherwise `colmap` on PATH. CPU only.
"""
import json
import math
import os
import re
import resource
import shutil
import sqlite3
import subprocess
import time
from collections import deque
from pathlib import Path

import numpy as np

from . import ScanError, say

FEATURES = 8192            # SIFT features per image, at the prepared image's full size
PAIRS_K = 30               # matched neighbours per image
ROUNDS = 2                 # triangulation + bundle adjustment
BA_ITERS = 200
TIME_NEIGHBOURS = 4        # frames before and after that are always matched
PAIR_MAX_DEG = 60          # neighbours look within this angle ...
PAIR_MAX_M = 2.5           # ... and stand within this distance
MAX_SHIFT_M = 1.0          # outlier guard: a camera that moves further than this from ARKit keeps its ARKit pose ...
MAX_ROT_DEG = 15.0         # ... or turns further than this. One test moved a poorly seen camera 6 m and 52 degrees.
MIN_REFINED_SHARE = 0.5    # fewer refined cameras than this share means COLMAP failed on this capture
ALIGN_SAMPLES = 200         # small samples tried for the first alignment fit
MIN_SCALE = 0.8              # ARKit is metric, so the alignment scale must stay near 1 (0.96-1.04 in the tests)
ORIENT_WEIGHT = 0.1        # the share of the cameras' orientations in the alignment's rotation fit
SAY_EVERY_S = 30.0
GL2CV = np.diag([1.0, -1, -1, 1])
LOG_PREFIX = re.compile(r"^[IWEF]\d{8} [\d:.]+\s+\d+\s+\S+:\d+\]\s*")


def binary() -> str:
    given = os.environ.get("NOOK_COLMAP_BIN")
    found = shutil.which(given or "colmap")
    if not found:
        raise ScanError(f"--colmap-poses needs COLMAP, and {'NOOK_COLMAP_BIN=' + given if given else 'colmap on PATH'} was not found: "
                        "set NOOK_COLMAP_BIN to the binary, or train without --colmap-poses")
    return found


def _cores() -> list[int]:
    """Half of the cores this process may use, the highest ones."""
    allowed = sorted(os.sched_getaffinity(0))
    return allowed[-max(1, len(allowed) // 2):]


def _run(exe: str, cores: list[int], label: str, cmd: str, *args) -> None:
    """Run one COLMAP command at low priority on `cores`, with its progress through `say`. bundle_adjuster has no
    thread flag, so the CPU affinity is what holds every command to half the machine."""
    def limit():
        os.nice(10)
        os.sched_setaffinity(0, cores)

    say(f"preparing: COLMAP poses: {label}")
    started = last = time.time()
    tail = deque(maxlen=20)
    p = subprocess.Popen([exe, cmd, "--log_target", "stderr", "--log_color", "0", *map(str, args)],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, errors="replace",
                         bufsize=1, env=dict(os.environ, OMP_NUM_THREADS=str(len(cores))), preexec_fn=limit)
    try:
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            text = LOG_PREFIX.sub("", line)
            if "Final cost" in text or time.time() - last >= SAY_EVERY_S:
                last = time.time()
                say(f"preparing: COLMAP poses: {label}: {' '.join(text.split())[:120]}")
        rc = p.wait()
    except BaseException:  # interrupted or cancelled: never leave it running
        p.kill()
        p.wait()
        raise
    if rc:
        why = next((l for l in reversed(tail) if l[0] in "EF" and LOG_PREFIX.match(l)), tail[-1] if tail else "no output")
        raise ScanError(f"pose refinement failed: colmap {cmd} exited with {rc}: {' '.join(LOG_PREFIX.sub('', why).split())[:200]}")
    say(f"preparing: COLMAP poses: {label}: {time.time() - started:.0f} s")


def quat_from_matrix(m: np.ndarray) -> tuple[float, float, float, float]:
    """(w, x, y, z) of a rotation matrix, the largest component first for accuracy."""
    t = np.trace(m)
    k = int(np.argmax(np.diag(m)))
    if t >= m[k, k]:
        q = [1 + t, m[2, 1] - m[1, 2], m[0, 2] - m[2, 0], m[1, 0] - m[0, 1]]
    else:
        i, j = (k + 1) % 3, (k + 2) % 3
        q = [0.0, 0.0, 0.0, 0.0]
        q[0] = m[j, i] - m[i, j]
        q[k + 1] = 1 + 2 * m[k, k] - t
        q[i + 1] = m[i, k] + m[k, i]
        q[j + 1] = m[j, k] + m[k, j]
    q = np.array(q) / np.linalg.norm(q)
    return tuple(float(x) for x in q)


def matrix_from_quat(w: float, x: float, y: float, z: float) -> np.ndarray:
    n = math.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def _pairs(names: list[str], c2w: dict, k: int) -> set[tuple[int, int]]:
    """Nearby cameras looking the same way, ranked by distance + angle, `k` per image, plus neighbours in time."""
    C = np.stack([c2w[n][:3, 3] for n in names])
    Z = np.stack([c2w[n][:3, 2] for n in names])
    pairs = set()
    order = sorted(range(len(names)), key=lambda i: int(Path(names[i]).stem))
    for r, i in enumerate(order):
        for s in range(1, TIME_NEIGHBOURS + 1):
            if r + s < len(order):
                pairs.add(tuple(sorted((i, order[r + s]))))
    for i in range(len(names)):
        d = np.linalg.norm(C - C[i], axis=1)
        ang = np.degrees(np.arccos(np.clip(Z @ Z[i], -1, 1)))
        ok = (ang < PAIR_MAX_DEG) & (d < PAIR_MAX_M)
        ok[i] = False
        cand = np.nonzero(ok)[0]
        for j in cand[np.argsort(d[cand] + ang[cand] / 40)][:k]:
            pairs.add(tuple(sorted((i, int(j)))))
    return pairs


def _write_model(d: Path, ids: dict, entry: dict, c2w: dict) -> None:
    d.mkdir(parents=True)
    cams, imgs = [], []
    for n, (i, c) in sorted(ids.items(), key=lambda x: x[1][0]):
        f = entry[n]
        cams.append(f"{c} PINHOLE {f['w']} {f['h']} {f['fl_x']} {f['fl_y']} {f['cx']} {f['cy']}\n")
        w2c = np.linalg.inv(c2w[n])
        q = quat_from_matrix(w2c[:3, :3])
        t = w2c[:3, 3]
        imgs.append(f"{i} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} {c} {n}\n\n")
    (d / "cameras.txt").write_text("".join(cams))
    (d / "images.txt").write_text("".join(imgs))
    (d / "points3D.txt").write_text("")


def _read_poses(d: Path) -> dict:
    """Camera-to-world (OpenCV) by image name, from a text model. An image is two lines, and its second line may be empty."""
    lines = [l for l in (d / "images.txt").read_text().splitlines() if not l.startswith("#")]
    out = {}
    for l in lines[::2]:
        s = l.split()
        if len(s) < 10:
            continue
        w, x, y, z, tx, ty, tz = map(float, s[1:8])
        w2c = np.eye(4)
        w2c[:3, :3] = matrix_from_quat(w, x, y, z)
        w2c[:3, 3] = [tx, ty, tz]
        out[s[9]] = np.linalg.inv(w2c)
    return out


def _similarity(new: dict, c2w: dict, names: list[str]) -> tuple[float, np.ndarray, np.ndarray]:
    """s, R, t so that s R (refined center) + t fits the ARKit center: Umeyama on the cameras' centers. The cameras'
    orientations get a small share of the rotation fit: on a short, nearly straight walk the centers alone leave the
    turn about that line free, and on a whole room they barely count."""
    X = np.stack([new[n][:3, 3] for n in names])
    Y = np.stack([c2w[n][:3, 3] for n in names])
    mx, my = X.mean(0), Y.mean(0)
    Xc, Yc = X - mx, Y - my
    orient = np.mean([c2w[n][:3, :3] @ new[n][:3, :3].T for n in names], axis=0)
    H = Yc.T @ Xc / len(X) + ORIENT_WEIGHT * math.sqrt((Xc ** 2).sum() * (Yc ** 2).sum()) / len(X) * orient
    U, _, Vt = np.linalg.svd(H)
    D = np.eye(3)
    D[2, 2] = -1.0 if np.linalg.det(U @ Vt) < 0 else 1.0
    R = U @ D @ Vt
    below = float((Xc ** 2).sum())
    s = float(((R @ Xc.T).T * Yc).sum() / below) if below > 0 else 1.0
    return s, R, my - s * R @ mx


def _moved(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """How far apart two poses are: meters, degrees."""
    dR = a[:3, :3].T @ b[:3, :3]
    return float(np.linalg.norm(a[:3, 3] - b[:3, 3])), math.degrees(math.acos(np.clip((np.trace(dR) - 1) / 2, -1, 1)))


def _align(new: dict, c2w: dict) -> tuple[float, dict, list[str]]:
    """The refined poses in the ARKit frame, and the cameras that pass the outlier guard. An outlier must not pull the
    fit that moves every other camera: the first fits use the half of the cameras that fit best, and the last ones
    every camera that passes the guard, until that set stops changing."""
    def fit(names):
        s, R, t = _similarity(new, c2w, names)
        aligned = {}
        for n, m in new.items():
            a = m.copy()
            a[:3, :3] = R @ m[:3, :3]
            a[:3, 3] = s * R @ m[:3, 3] + t
            aligned[n] = a
        return s, aligned

    names = list(new)
    # Start from the small sample whose fit has the lowest median shift: a fit to all cameras can collapse the scale on an
    # outlier, and then every camera looks close to it.
    rng = np.random.default_rng(0)
    best = np.inf
    for _ in range(ALIGN_SAMPLES):
        sample = [names[i] for i in rng.choice(len(names), min(6, len(names)), replace=False)]
        _, aligned = fit(sample)
        med = float(np.median([_moved(c2w[n], aligned[n])[0] for n in names]))
        if med < best:
            best, keep = med, sample
    for _ in range(3):
        _, aligned = fit(keep)
        keep = sorted(names, key=lambda n: _moved(c2w[n], aligned[n])[0])[:max(3, len(names) // 2)]
    for _ in range(5):
        s, aligned = fit(keep)
        good = [n for n in names if (lambda d: d[0] <= MAX_SHIFT_M and d[1] <= MAX_ROT_DEG)(_moved(c2w[n], aligned[n]))]
        if set(good) == set(keep) or len(good) < 3:
            break
        keep = good
    return s, aligned, good


def refine(data_dir: Path, features: int = FEATURES, pairs_k: int = PAIRS_K, rounds: int = ROUNDS, ba_iters: int = BA_ITERS) -> dict:
    """Replace the poses in data_dir/transforms.json and transforms_val.json with refined ones. The originals stay as
    transforms.arkit.json and transforms_val.arkit.json. Nothing changes when it fails. Returns the stats."""
    started = time.time()
    exe = binary()
    docs = {fn: json.loads((data_dir / fn).read_text()) for fn in ("transforms.json", "transforms_val.json") if (data_dir / fn).is_file()}
    entry = {Path(f["file_path"]).name: f for d in docs.values() for f in d["frames"]}
    names = list(entry)
    c2w = {}
    for n, f in entry.items():
        m = np.array(f["transform_matrix"], dtype=np.float64)
        m[3] = [0, 0, 0, 1]
        c2w[n] = m @ GL2CV
    cores = _cores()
    threads = len(cores)
    work = data_dir.parent / "colmap"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        db = work / "db.db"
        (work / "images.txt").write_text("".join(f"{n}\n" for n in names))
        _run(exe, cores, f"SIFT features in {len(names)} images on {threads} threads (this and the next steps take hours on a whole room)",
             "feature_extractor", "--database_path", db, "--image_path", data_dir / "images", "--image_list_path", work / "images.txt",
             "--ImageReader.camera_model", "PINHOLE", "--ImageReader.single_camera_per_image", 1, "--FeatureExtraction.use_gpu", 0,
             "--FeatureExtraction.num_threads", threads, "--SiftExtraction.max_num_features", features)
        con = sqlite3.connect(db)
        ids = {n: (i, c) for i, n, c in con.execute("select image_id, name, camera_id from images")}
        for n, (_, c) in ids.items():  # our intrinsics into the database's cameras (PINHOLE = model 1)
            f = entry[n]
            params = np.array([f["fl_x"], f["fl_y"], f["cx"], f["cy"]], np.float64)
            con.execute("update cameras set model=1, width=?, height=?, params=?, prior_focal_length=1 where camera_id=?",
                        (f["w"], f["h"], params.tobytes(), c))
        con.commit()
        con.close()

        pairs = _pairs(names, c2w, pairs_k)
        (work / "pairs.txt").write_text("".join(f"{names[i]} {names[j]}\n" for i, j in sorted(pairs)))
        _run(exe, cores, f"matching {len(pairs)} pairs", "matches_importer", "--database_path", db, "--match_list_path", work / "pairs.txt",
             "--match_type", "pairs", "--FeatureMatching.use_gpu", 0, "--FeatureMatching.num_threads", threads)

        cur = work / "known"
        _write_model(cur, ids, entry, c2w)
        for r in range(rounds):
            tri, ba = work / f"tri{r}", work / f"ba{r}"
            tri.mkdir()
            ba.mkdir()
            _run(exe, cores, f"triangulation, round {r + 1} of {rounds}", "point_triangulator", "--database_path", db,
                 "--image_path", data_dir / "images", "--input_path", cur, "--output_path", tri, "--clear_points", 1, "--refine_intrinsics", 0,
                 "--Mapper.num_threads", threads)
            _run(exe, cores, f"bundle adjustment, round {r + 1} of {rounds}", "bundle_adjuster", "--input_path", tri, "--output_path", ba,
                 "--BundleAdjustment.refine_focal_length", 0, "--BundleAdjustment.refine_principal_point", 0,
                 "--BundleAdjustment.refine_extra_params", 0, "--BundleAdjustment.refine_sensor_from_rig", 0,
                 "--BundleAdjustmentCeres.max_num_iterations", ba_iters, "--BundleAdjustmentCeres.use_gpu", 0)
            cur = ba
        _run(exe, cores, "reading the refined poses", "model_converter", "--input_path", cur, "--output_path", cur, "--output_type", "TXT")
        new = {n: m for n, m in _read_poses(cur).items() if n in c2w}
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if len(new) < 3:
        raise ScanError(f"pose refinement failed: COLMAP placed only {len(new)} of {len(names)} cameras: train without --colmap-poses")
    scale, aligned, good = _align(new, c2w)
    if not MIN_SCALE <= scale <= 1 / MIN_SCALE:
        raise ScanError(f"pose refinement failed: COLMAP's walk is {scale:.2f} x ARKit's after alignment, too far from 1 to trust: "
                        "train without --colmap-poses")
    if len(good) < MIN_REFINED_SHARE * len(names):
        raise ScanError(f"pose refinement failed: only {len(good)} of {len(names)} cameras stayed within {MAX_SHIFT_M:g} m and "
                        f"{MAX_ROT_DEG:g} degrees of ARKit: train without --colmap-poses")
    accepted = set(good)
    outliers = [{"frame": n, "shift_m": round(d[0], 3), "rot_deg": round(d[1], 2)}
                for n, d in ((n, _moved(c2w[n], aligned[n])) for n in new if n not in accepted)]
    moved = np.array([_moved(c2w[n], aligned[n]) for n in good])
    shift, rot = moved[:, 0] * 100, moved[:, 1]

    for fn, d in docs.items():
        shutil.copyfile(data_dir / fn, data_dir / fn.replace(".json", ".arkit.json"))
        for f in d["frames"]:
            n = Path(f["file_path"]).name
            if n in accepted:
                f["transform_matrix"] = (aligned[n] @ GL2CV).tolist()
        tmp = data_dir / f".{fn}.tmp"
        tmp.write_text(json.dumps(d))
        os.replace(tmp, data_dir / fn)
    return {"method": "colmap", "frames": len(names), "refined": len(good), "unregistered": len(names) - len(new),
            "outliers": len(outliers), "outlier_frames": outliers[:20], "scale": round(scale, 5), "pairs": len(pairs),
            "shift_cm_median": round(float(np.median(shift)), 2), "shift_cm_p90": round(float(np.percentile(shift, 90)), 2),
            "shift_cm_max": round(float(shift.max()), 2), "rot_deg_median": round(float(np.median(rot)), 3),
            "rot_deg_p90": round(float(np.percentile(rot, 90)), 3), "rot_deg_max": round(float(rot.max()), 3),
            "seconds": round(time.time() - started, 1), "threads": threads, "features": features, "pairs_k": pairs_k,
            "rounds": rounds, "ba_iters": ba_iters, "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024)}
