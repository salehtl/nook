"""The trainer: gsplat (CUDA) through the nook-gsplat CLI (gsplat/nook_gsplat.py), on kakapo's NVIDIA GPU.

nook-scan prepares the dataset (dataset.prepare: training frames, scaled images, seed points) and hands that folder
to nook-gsplat, which writes a 3DGS PLY in capture world coordinates; cropping, the floor and room.json happen back
in nook-scan (post.py, room.py). gsplat replaced Brush on 2026-10-26: the same held-out quality on the first real
scan in half the time (16 vs 33 min on the RTX 2060) and two thirds of the VRAM.

NOOK_GSPLAT_BIN names the executable (the Nix package sets it); otherwise `nook-gsplat` on PATH.
"""
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from . import ScanError, say

NAME = "gsplat"
STEP = re.compile(r"\bstep (\d+)/(\d+)\s+splats (\d+)k")


def _fmt(secs: float) -> str:
    secs = int(secs)
    return f"{secs // 60}m{secs % 60:02d}s"


def binary() -> str:
    found = os.environ.get("NOOK_GSPLAT_BIN") or shutil.which("nook-gsplat")
    if not found:
        raise ScanError("nook-gsplat is not installed here: training needs kakapo's NVIDIA GPU, where the nook "
                        "package provides it (or set NOOK_GSPLAT_BIN)")
    return found


def train_log() -> Path:
    """Where the trainer's output goes: NOOK_SCAN_TRAIN_LOG (the jobs server sets one per job), else the temp folder."""
    return Path(os.environ.get("NOOK_SCAN_TRAIN_LOG") or Path(tempfile.gettempdir()) / "nook-scan-last-train.log").expanduser()


def train(data_dir: Path, out_dir: Path, steps: int, max_image_size: int, sh_degree: int, max_splats: int,
          progress_every: float = 20.0, stills_max_size: int | None = None, pose_opt: bool = False) -> dict:
    """Train the prepared dataset in `data_dir`. Returns {"ply": Path, "psnr": None}.

    `stills_max_size` sizes the frames dataset.prepare marked as stills; it's only passed on when it differs from
    `max_image_size` (the same thing otherwise), and `--pose-opt` only when on, so older nook-gsplat builds still run.

    Re-emits nook-gsplat's `step X/Y` lines as `training: step X/Y, ...` every `progress_every` seconds; the jobs
    server reads those for its progress bar.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    ply = out_dir / "trained.ply"
    cmd = [binary(), str(data_dir), "--out", str(ply), "--steps", str(steps), "--max-splats", str(max_splats),
           "--max-image-size", str(max_image_size), "--sh-degree", str(sh_degree)]
    if stills_max_size and stills_max_size != max_image_size:
        cmd += ["--stills-max-size", str(stills_max_size)]
    if pose_opt:
        cmd += ["--pose-opt"]
    cmd += os.environ.get("NOOK_GSPLAT_ARGS", "").split()  # experiments, e.g. "--pose-opt-lr 2e-5"
    log = train_log()
    log.parent.mkdir(parents=True, exist_ok=True)
    say(f"training with {NAME}: {steps} steps, up to {max_splats:,} splats, SH degree {sh_degree}"
        f"{', refining poses' if pose_opt else ''} (log: {log})")
    started, shown = time.time(), 0.0
    with open(log, "w", encoding="utf-8") as lf:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             text=True, errors="replace", bufsize=1)
        try:
            for line in p.stdout:
                lf.write(line)
                m = STEP.search(line)
                if m and time.time() - shown >= progress_every:
                    shown = time.time()
                    done, total, elapsed = int(m[1]), int(m[2]), time.time() - started
                    left = f", about {_fmt(elapsed * (total - done) / done)} left" if done else ""
                    say(f"  training: step {done}/{total}, {m[3]}k splats, {_fmt(elapsed)} elapsed{left}")
            rc = p.wait()
        except BaseException:  # interrupted or cancelled: never leave training running on the GPU
            p.kill()
            p.wait()
            raise
    if rc != 0 or not ply.is_file():
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        why = next((l.split("nook-gsplat:", 1)[1].strip() for l in reversed(lines) if "nook-gsplat:" in l), f"exit {rc}")
        raise ScanError(f"training failed: {why} (log: {log})")
    say(f"  training: step {steps}/{steps}, done in {_fmt(time.time() - started)}")
    return {"ply": ply, "psnr": None}
