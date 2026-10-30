"""Per-stretch coverage against score: how the phone moved and how many similar training frames each stretch has.
coverage.py DATA_DIR CAPTURE_DIR METRICS_JSON BLUR_JSON FLOOR_Y"""
import json, math, statistics as st, sys
from collections import defaultdict
from pathlib import Path

data, cap_dir, metrics, blur, floor = sys.argv[1:6]
floor = float(floor)
T = json.loads((Path(data) / "transforms.json").read_text())["frames"]
V = json.loads((Path(data) / "transforms_val.json").read_text())["frames"]
cap = json.loads((Path(cap_dir) / "transforms.json").read_text())["frames"]
b = json.loads(Path(blur).read_text())
S = json.loads(Path(metrics).read_text())["stretches"]
S = list(S.values()) if isinstance(S, dict) else S


def pos(f):
    m = f["transform_matrix"]
    return m[0][3], m[1][3], m[2][3]


def look(f):
    m = f["transform_matrix"]
    return -m[0][2], -m[1][2], -m[2][2]


P = [(pos(f), look(f)) for f in T]
G = defaultdict(list)
for f in V:
    G[f["stretch"]].append(f)
print("stretch pass height look speed deg/s nearest_cm similar lpips psnr")
for k, F in sorted(G.items()):
    near, similar = [], []
    for f in F:
        p, w = pos(f), look(f)
        ds = [(math.dist(p, q), math.degrees(math.acos(max(-1, min(1, sum(a * c for a, c in zip(w, v))))))) for q, v in P]
        near.append(min(d for d, _ in ds))
        similar.append(sum(a < 20 and d < 0.5 for d, a in ds))  # within 50 cm and 20 degrees
    idx = [int(Path(f["file_path"]).stem) for f in F]
    print(k, cap[idx[0]].get("pass"), f"{st.mean(pos(f)[1] - floor for f in F):.2f}",
          f"{st.mean(math.degrees(math.asin(look(f)[1])) for f in F):+.0f}", f"{st.median(b[i]['m_s'] for i in idx):.2f}",
          f"{st.median(b[i]['deg_s'] for i in idx):.1f}", f"{100 * st.mean(near):.0f}", f"{st.mean(similar):.0f}",
          f"{S[k]['lpips']:.3f}", f"{S[k]['psnr']:.2f}")
