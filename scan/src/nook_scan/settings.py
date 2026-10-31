"""Training settings (contract §4.9, §4.9.1): the quality presets, scaled to the capture, and the retrain settings'
ranges. Stdlib only, so the jobs server can resolve and check settings without numpy.

Every setting maps 1:1 to a `nook-scan train` flag (FLAGS) and to a retrain setting (§5.1).
"""

from . import gpu

K_STEPS_PER_FRAME = 25             # §4.9.1: 978 frames -> about 25k steps. On scan-20261030-154924 pose refinement matched
                                   # 40k steps' score in half the time; 12k lost detail. The cap keeps a run near 30 min.
STEPS_MIN, STEPS_MAX = 20_000, 30_000
DRAFT_MAX_SPLATS = 1_200_000       # v1's cap, kept for --quality draft
# Rough: added to `eta_s` for colmap_poses. One whole run on 8 threads: 1,074 frames took 23,000 s, of which bundle
# adjustment 18,500 s (scan-20261030-154924, docs/plans/sharpness.md). The real time varies with the room.
COLMAP_SECONDS_PER_FRAME = 22

# Quality presets, for gsplat on kakapo's RTX 2060. `high` was tuned on the first real scan (scan-20261026-093654:
# 517 frames, 1920x1440, auto exposure) and judged by Spark on held-out frames as evals/scan_quality.sh does: 20k
# steps, full resolution, SH degree 3, window seeds 10 m out gave 21.85 dB in 16.4 min, 2.5 GB VRAM. v3 scales its
# steps with the capture (steps = None here: see resolve). `draft` is v1: 10k steps at 1280 px.
PRESETS = {
    "draft": {"steps": 10000, "max_image_size": 1280, "sh_degree": 1, "far_seeds": 0.0},
    "high": {"steps": None, "max_image_size": 1920, "sh_degree": 3, "far_seeds": 10.0},
}

# setting -> (type, min, max), as in §4.9.1's table
RANGES = {
    "steps": (int, 1_000, 200_000),
    "train_max_splats": (int, 100_000, 4_000_000),
    "deliver_max_splats": (int, 100_000, 4_000_000),
    "max_image_size": (int, 640, 3840),
    "stills_max_size": (int, 640, 4032),
    "sh_degree": (int, 0, 3),
    "pose_opt": (bool, None, None),
    "holdout_every": (int, 0, 50),
    "colmap_poses": (bool, None, None),
}
KEYS = tuple(RANGES)
FLAGS = {"steps": "--steps", "train_max_splats": "--max-splats", "deliver_max_splats": "--deliver-max-splats",
         "max_image_size": "--max-image-size", "stills_max_size": "--stills-max-size", "sh_degree": "--sh-degree",
         "pose_opt": "--pose-opt", "holdout_every": "--holdout-every", "colmap_poses": "--colmap-poses"}


def n_train(n_frames: int, holdout_every: int, test_walk=()) -> int:
    """Training frames left after --holdout-every (frames with index % N == 0 are held out) and without the test walk
    (`test_walk`: its frame indices, contract §4.8)."""
    held = len(range(0, n_frames, holdout_every)) if holdout_every > 0 else 0
    return n_frames - held - sum(1 for i in test_walk if not (holdout_every > 0 and i % holdout_every == 0))


def scaled_steps(n: int) -> int:
    return min(STEPS_MAX, max(STEPS_MIN, K_STEPS_PER_FRAME * n))


def resolve(n_frames: int, quality: str = "high", given: dict | None = None, test_walk=()) -> dict:
    """The settings a run uses: the preset, scaled to the capture's training frames, overridden by `given` (explicit
    flags or a retrain's settings; None values count as not given). Doesn't range-check: see check()."""
    g = {k: v for k, v in (given or {}).items() if v is not None}
    pre = PRESETS[quality]
    holdout = g.get("holdout_every", 0)
    s = {"steps": g.get("steps", pre["steps"] or scaled_steps(n_train(n_frames, holdout, test_walk)))}
    s["train_max_splats"] = g.get("train_max_splats", gpu.train_max_splats() if quality == "high" else DRAFT_MAX_SPLATS)
    s["deliver_max_splats"] = g.get("deliver_max_splats", min(gpu.DELIVER_MAX_SPLATS, s["train_max_splats"]))
    s["max_image_size"] = g.get("max_image_size", pre["max_image_size"])
    s["stills_max_size"] = g.get("stills_max_size", s["max_image_size"])  # §4.10 stills: the same size unless asked
    s["sh_degree"] = g.get("sh_degree", pre["sh_degree"])
    s["pose_opt"] = bool(g.get("pose_opt", quality == "high"))
    s["holdout_every"] = holdout
    s["colmap_poses"] = bool(g.get("colmap_poses", False))
    return s


def check(given: dict) -> str | None:
    """The first problem with a retrain's settings (an unknown key or a value out of range), naming the key, or None."""
    for k, v in given.items():
        if k not in RANGES:
            return f"unknown setting {k!r}: use one of {', '.join(KEYS)}"
        typ, lo, hi = RANGES[k]
        if typ is bool:
            if not isinstance(v, bool):
                return f"{k} must be true or false, got {v!r}"
        elif isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi or (k == "holdout_every" and v == 1):
            return f"{k} must be a whole number from {lo:,} to {hi:,}" + (" (0 for none, or at least 2)" if k == "holdout_every" else "") + f", got {v!r}"
    if given.get("deliver_max_splats", 0) > given.get("train_max_splats", RANGES["train_max_splats"][2]):
        return "deliver_max_splats can't be more than train_max_splats: the room can't keep more splats than it trained"
    return None


def summary(n_frames: int, quality: str = "high", given: dict | None = None, test_walk=()) -> dict:
    """`--dry-run` and the server's /defaults: {"n_train", "settings", "eta_s"}."""
    s = resolve(n_frames, quality, given, test_walk)
    eta = gpu.eta_s(s["steps"], s["train_max_splats"])
    if s["colmap_poses"]:  # every frame, held out or not, goes through COLMAP
        eta += COLMAP_SECONDS_PER_FRAME * n_frames
    return {"n_train": n_train(n_frames, s["holdout_every"], test_walk), "settings": s, "eta_s": eta}


def as_flags(s: dict) -> list[str]:
    """Settings as `nook-scan train` flags (the bool settings are switches)."""
    out = []
    for k, v in s.items():
        if k == "pose_opt" and not v:
            out += ["--no-pose-opt"]  # on by default in the high preset, so off has to be said
        elif RANGES[k][0] is bool:
            out += [FLAGS[k]] if v else []
        else:
            out += [FLAGS[k], str(v)]
    return out
