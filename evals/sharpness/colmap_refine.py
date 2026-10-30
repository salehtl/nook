"""Refine a prepared dataset's ARKit poses with COLMAP: SIFT, matching on pose-derived pairs, triangulation at the
known poses, then bundle adjustment of the poses (intrinsics fixed), twice. The result is aligned back onto the ARKit
frame (similarity, Umeyama on camera centers) and written as a new dataset (images symlinked).

colmap_refine.py SRC_DS DST_DS WORK_DIR [--pairs-k 30] [--rounds 2]"""
import argparse, json, math, os, shutil, sqlite3, subprocess, sys, time
from pathlib import Path
import numpy as np

p = argparse.ArgumentParser()
p.add_argument("src"); p.add_argument("dst"); p.add_argument("work")
p.add_argument("--pairs-k", type=int, default=30)
p.add_argument("--rounds", type=int, default=2)
p.add_argument("--features", type=int, default=8192)
a = p.parse_args()
src = Path(a.src) / "data"; work = Path(a.work); work.mkdir(parents=True, exist_ok=True)
db = work / "db.db"
T = json.loads((src / "transforms.json").read_text()); V = json.loads((src / "transforms_val.json").read_text())
frames = [(f, "train") for f in T["frames"]] + [(f, "val") for f in V["frames"]]
names = [Path(f["file_path"]).name for f, _ in frames]
by_name = {Path(f["file_path"]).name: (f, k) for f, k in frames}
GL2CV = np.diag([1.0, -1, -1, 1])
c2w = {n: np.array(by_name[n][0]["transform_matrix"]) @ GL2CV for n in names}

def run(*cmd):
    t0 = time.time()
    r = subprocess.run(["colmap", *map(str, cmd)], capture_output=True, text=True)
    if r.returncode:
        print(r.stdout[-3000:], r.stderr[-3000:]); sys.exit(f"colmap {cmd[0]} failed")
    print(f"colmap {cmd[0]}: {time.time() - t0:.0f} s", flush=True)
    return r.stdout + r.stderr

imgdir = work / "images"
if not imgdir.exists():
    imgdir.mkdir()
    for n in names:
        os.symlink((src / "images" / n).resolve(), imgdir / n)
if not db.exists():
    run("feature_extractor", "--database_path", db, "--image_path", imgdir, "--ImageReader.camera_model", "PINHOLE",
        "--ImageReader.single_camera_per_image", 1, "--FeatureExtraction.use_gpu", 0,
        "--SiftExtraction.max_num_features", a.features)
con = sqlite3.connect(db)
rows = con.execute("select image_id, name, camera_id from images").fetchall()
ids = {n: (i, c) for i, n, c in rows}
# our intrinsics into the database cameras (PINHOLE = model 1)
for n, (i, c) in ids.items():
    f = by_name[n][0]
    params = np.array([f["fl_x"], f["fl_y"], f["cx"], f["cy"]], np.float64)
    con.execute("update cameras set model=1, width=?, height=?, params=?, prior_focal_length=1 where camera_id=?",
                (f["w"], f["h"], params.tobytes(), c))
con.commit()

# pairs: nearby cameras looking the same way, ranked by distance + angle, k per image, plus +-4 in time
C = np.stack([c2w[n][:3, 3] for n in names]); Z = np.stack([c2w[n][:3, 2] for n in names])
pairs = set()
order = sorted(range(len(names)), key=lambda k: int(Path(names[k]).stem))
for r, k in enumerate(order):
    for s in range(1, 5):
        if r + s < len(order):
            pairs.add(tuple(sorted((k, order[r + s]))))
for k in range(len(names)):
    d = np.linalg.norm(C - C[k], axis=1); ang = np.degrees(np.arccos(np.clip(Z @ Z[k], -1, 1)))
    ok = (ang < 60) & (d < 2.5); ok[k] = False
    cand = np.where(ok)[0]
    cand = cand[np.argsort(d[cand] + ang[cand] / 40)][:a.pairs_k]
    for j in cand:
        pairs.add(tuple(sorted((k, j))))
if not (work / "matched").exists():
    (work / "pairs.txt").write_text("".join(f"{names[i]} {names[j]}\n" for i, j in sorted(pairs)))
    print(f"{len(pairs)} pairs", flush=True)
    run("matches_importer", "--database_path", db, "--match_list_path", work / "pairs.txt", "--match_type", "pairs",
        "--FeatureMatching.use_gpu", 0)
    (work / "matched").touch()

def qvec(R):
    from scipy.spatial.transform import Rotation
    x, y, z, w = Rotation.from_matrix(R).as_quat()
    return w, x, y, z

def write_model(d: Path, poses: dict):
    d.mkdir(parents=True, exist_ok=True)
    cams, imgs = [], []
    for n, (i, c) in sorted(ids.items(), key=lambda x: x[1][0]):
        f = by_name[n][0]
        cams.append(f"{c} PINHOLE {f['w']} {f['h']} {f['fl_x']} {f['fl_y']} {f['cx']} {f['cy']}\n")
        w2c = np.linalg.inv(poses[n])
        qw, qx, qy, qz = qvec(w2c[:3, :3]); t = w2c[:3, 3]
        imgs.append(f"{i} {qw} {qx} {qy} {qz} {t[0]} {t[1]} {t[2]} {c} {n}\n\n")
    (d / "cameras.txt").write_text("".join(cams)); (d / "images.txt").write_text("".join(imgs)); (d / "points3D.txt").write_text("")

def read_poses(d: Path) -> dict:
    run("model_converter", "--input_path", d, "--output_path", d, "--output_type", "TXT")
    from scipy.spatial.transform import Rotation
    out = {}
    lines = [l for l in (d / "images.txt").read_text().splitlines() if l and not l.startswith("#")]
    for l in lines[::2]:
        s = l.split()
        if len(s) < 10:
            continue
        qw, qx, qy, qz, tx, ty, tz = map(float, s[1:8])
        w2c = np.eye(4); w2c[:3, :3] = Rotation.from_quat([qx, qy, qz, qw]).as_matrix(); w2c[:3, 3] = [tx, ty, tz]
        out[s[9]] = np.linalg.inv(w2c)
    return out

poses = dict(c2w)
known = work / "known"; write_model(known, poses)
cur = known
for r in range(a.rounds):
    tri = work / f"tri{r}"; ba = work / f"ba{r}"
    for d in (tri, ba):
        shutil.rmtree(d, ignore_errors=True); d.mkdir()
    out = run("point_triangulator", "--database_path", db, "--image_path", imgdir, "--input_path", cur, "--output_path", tri,
              "--clear_points", 1, "--refine_intrinsics", 0)
    print("\n".join(l for l in out.splitlines() if "points" in l.lower() or "error" in l.lower())[-600:])
    out = run("bundle_adjuster", "--input_path", tri, "--output_path", ba, "--BundleAdjustment.refine_focal_length", 0,
              "--BundleAdjustment.refine_principal_point", 0, "--BundleAdjustment.refine_extra_params", 0,
              "--BundleAdjustment.refine_sensor_from_rig", 0, "--BundleAdjustmentCeres.max_num_iterations", 200)
    print("\n".join(l for l in out.splitlines() if "cost" in l.lower() or "error" in l.lower() or "residual" in l.lower())[-1200:])
    cur = ba
new = read_poses(cur)
missing = [n for n in names if n not in new]
print(f"refined {len(new)} of {len(names)} cameras; {len(missing)} not registered keep ARKit poses")
# similarity aligning refined centers onto ARKit centers
common = [n for n in names if n in new]
X = np.stack([new[n][:3, 3] for n in common]); Y = np.stack([c2w[n][:3, 3] for n in common])
mx, my = X.mean(0), Y.mean(0); Xc, Yc = X - mx, Y - my
U, S, Vt = np.linalg.svd(Yc.T @ Xc / len(X)); D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(U @ Vt))
R = U @ D @ Vt; s = (S * np.diag(D)).sum() / (Xc ** 2).sum() * len(X); t = my - s * R @ mx
print(f"alignment scale {s:.5f}")
shift, rot = [], []
final = {}
for n in names:
    if n in new:
        m = new[n].copy(); m[:3, :3] = R @ m[:3, :3]; m[:3, 3] = s * R @ m[:3, 3] + t
    else:
        m = c2w[n]
    final[n] = m
    shift.append(np.linalg.norm(m[:3, 3] - c2w[n][:3, 3]) * 100)
    dR = c2w[n][:3, :3].T @ m[:3, :3]; rot.append(math.degrees(math.acos(np.clip((np.trace(dR) - 1) / 2, -1, 1))))
shift, rot = np.array(shift), np.array(rot)
print(f"pose change vs ARKit: shift cm p50 {np.median(shift):.2f} p90 {np.percentile(shift, 90):.2f} max {shift.max():.2f}; "
      f"rotation deg p50 {np.median(rot):.3f} p90 {np.percentile(rot, 90):.3f} max {rot.max():.3f}")
dst = Path(a.dst) / "data"
shutil.rmtree(dst.parent, ignore_errors=True); (dst / "images").mkdir(parents=True)
for n in os.listdir(src / "images"):
    os.symlink((src / "images" / n).resolve(), dst / "images" / n)
shutil.copy(src / "points.ply", dst / "points.ply")
for doc, fn in ((T, "transforms.json"), (V, "transforms_val.json")):
    d = json.loads(json.dumps(doc))
    for f in d["frames"]:
        f["transform_matrix"] = (final[Path(f["file_path"]).name] @ GL2CV).tolist()
    (dst / fn).write_text(json.dumps(d))
json.dump({"shift_cm": shift.tolist(), "rot_deg": rot.tolist(), "names": names, "scale": s}, open(Path(a.dst) / "pose_change.json", "w"))
