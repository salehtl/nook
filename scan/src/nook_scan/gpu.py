"""What GPU the trainer runs on (kakapo's NVIDIA card), how many splats it trains, and how fast (contract §4.9.1).

The caps are constants per GPU class, never computed from free VRAM, so `nook-scan train --dry-run` gives the same
answer on the Mac as on kakapo. A machine whose GPU is unknown (the Mac, a service without nvidia-smi) counts as the
small class, kakapo's.
"""

import functools
import glob
import os
import platform
import shutil
import subprocess
import sys

# Where nvidia-smi lives when it isn't on a service's PATH (NixOS puts the driver's tools in the system profile).
NVIDIA_SMI = ("nvidia-smi", "/run/current-system/sw/bin/nvidia-smi", "/usr/bin/nvidia-smi")

SMALL_VRAM_GB = 10             # the small class: 6-10 GB (kakapo's RTX 2060); above this, the large class
# Training caps (`train_max_splats`). 1.5M on the RTX 2060 peaked at 2.74 GB and keeps a room near 30 min; it's also the
# delivery cap, so nothing trained is pruned for size. More splats gave a small gain and cost time (docs/plans/sharpness.md).
TRAIN_MAX_SPLATS = {"small": 1_500_000, "large": 3_000_000}
# What the room is pruned to after cropping (`deliver_max_splats`): Spark loads it in the browser and on phones,
# next to the furniture.
DELIVER_MAX_SPLATS = 1_500_000
# Speed for `eta_s`: seconds per 1,000 steps per million splats, whole run (preparing, training, cropping, writing).
# Measured on the RTX 2060, run s1-G: 25k steps at 1.5M splats, 978 frames at 1920 px, the ramp and pose refinement:
# 1,452 s training, plus about 100 s preparing and finishing. The large class isn't measured; it uses the same number.
SECONDS_PER_KSTEP_MSPLAT = {"small": 1552 / (25 * 1.5), "large": 1552 / (25 * 1.5)}


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


@functools.cache
def info() -> dict:
    """{"name": GPU name or None, "vram_gb": dedicated memory or None (unified memory on Apple silicon)}."""
    if sys.platform == "darwin":
        chip = _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.machine()
        return {"name": chip if chip.startswith("Apple") else (chip or None), "vram_gb": None}
    for smi in NVIDIA_SMI:
        if shutil.which(smi) or os.path.isfile(smi):
            out = _run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
            if out:
                name, _, mib = out.splitlines()[0].rpartition(",")
                try:
                    return {"name": name.strip(), "vram_gb": round(float(mib) / 1024, 1)}
                except ValueError:
                    return {"name": out.splitlines()[0].strip(), "vram_gb": None}
    for path in sorted(glob.glob("/proc/driver/nvidia/gpus/*/information")):
        try:
            for line in open(path):
                if line.startswith("Model:"):
                    return {"name": line.split(":", 1)[1].strip(), "vram_gb": None}
        except OSError:
            pass
    return {"name": None, "vram_gb": None}


def gpu_class() -> str:
    """"large" only on a GPU known to have more than SMALL_VRAM_GB; an unknown or small one (6 GB on kakapo) is "small"."""
    vram = info()["vram_gb"]
    return "large" if vram and vram > SMALL_VRAM_GB else "small"


def train_max_splats() -> int:
    return TRAIN_MAX_SPLATS[gpu_class()]


def eta_s(steps: int, max_splats: int) -> int:
    """Estimated seconds for a whole training run at this cap (the splat count grows to the cap early on)."""
    return round(SECONDS_PER_KSTEP_MSPLAT[gpu_class()] * steps / 1000 * max_splats / 1e6)
