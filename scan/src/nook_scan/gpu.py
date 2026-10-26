"""What GPU the trainer runs on (kakapo's NVIDIA card) and how many splats it can hold."""

import functools
import glob
import os
import platform
import shutil
import subprocess
import sys

# Where nvidia-smi lives when it isn't on a service's PATH (NixOS puts the driver's tools in the system profile).
NVIDIA_SMI = ("nvidia-smi", "/run/current-system/sw/bin/nvidia-smi", "/usr/bin/nvidia-smi")

MAX_SPLATS_LARGE = 1_500_000   # Spark still loads the room PLY in the browser next to the furniture
MAX_SPLATS_SMALL = 1_200_000   # gsplat on kakapo's RTX 2060 (6 GB) peaks at ~2.5 GB with this cap at full resolution
SMALL_VRAM_GB = 10


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


def default_max_splats() -> int:
    """The large cap only on a GPU known to have SMALL_VRAM_GB or more; an unknown or small one (6 GB on kakapo) gets
    the small cap."""
    vram = info()["vram_gb"]
    return MAX_SPLATS_LARGE if vram and vram >= SMALL_VRAM_GB else MAX_SPLATS_SMALL
