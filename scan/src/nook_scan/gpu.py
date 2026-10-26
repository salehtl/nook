"""What GPU the trainer runs on, how big a splat it can hold, and how Brush finds the Vulkan driver on Linux.

Platform-neutral: macOS uses Metal (nothing to configure). Linux uses Vulkan on an NVIDIA GPU, and on NixOS the driver
lives under /run/opengl-driver instead of /usr/share/vulkan.
"""

import functools
import glob
import os
import platform
import shutil
import subprocess
import sys

from . import ScanError

NIXOS_DRIVER = "/run/opengl-driver"
NIXOS_ICD_DIR = NIXOS_DRIVER + "/share/vulkan/icd.d"
# Where nvidia-smi lives when it isn't on a service's PATH (NixOS puts the driver's tools in the system profile).
NVIDIA_SMI = ("nvidia-smi", "/run/current-system/sw/bin/nvidia-smi", "/usr/bin/nvidia-smi")

MAX_SPLATS_LARGE = 1_500_000   # Spark still loads the room PLY in the browser next to the furniture
MAX_SPLATS_SMALL = 1_000_000   # safe on an 8 GB or smaller GPU (kakapo: RTX 2060, 6 GB) at full resolution
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
    """Apple silicon shares system memory, so it gets the large cap. A discrete GPU gets it only when it is known to
    have more than SMALL_VRAM_GB; an unknown or small one (6 GB on kakapo) gets the small cap."""
    if sys.platform == "darwin":
        return MAX_SPLATS_LARGE
    vram = info()["vram_gb"]
    return MAX_SPLATS_LARGE if vram and vram >= SMALL_VRAM_GB else MAX_SPLATS_SMALL


def trainer_env(base: dict | None = None) -> dict:
    """Environment for the Brush process. On Linux it makes sure the Vulkan loader can find the GPU driver:
    VK_ICD_FILENAMES / VK_DRIVER_FILES if set (checked), else the NixOS driver directory when it exists."""
    env = dict(os.environ if base is None else base)
    if not sys.platform.startswith("linux"):
        return env
    given = env.get("VK_ICD_FILENAMES") or env.get("VK_DRIVER_FILES")
    if given:
        name = "VK_ICD_FILENAMES" if env.get("VK_ICD_FILENAMES") else "VK_DRIVER_FILES"
        missing = [p for p in given.split(os.pathsep) if p and not os.path.exists(p)]  # files or (VK_DRIVER_FILES) folders
        if missing:
            raise ScanError(f"{name} points at {missing[0]}, which does not exist: "
                            f"set it to the NVIDIA ICD json (on NixOS {NIXOS_ICD_DIR}/nvidia_icd.json) or unset it")
        return env
    if os.path.isdir(NIXOS_ICD_DIR):
        icds = sorted(glob.glob(os.path.join(NIXOS_ICD_DIR, "*.json")))
        nvidia = [p for p in icds if "nvidia" in os.path.basename(p)]
        if nvidia or icds:
            env["VK_ICD_FILENAMES"] = os.pathsep.join(nvidia or icds)
        # The ICD json names libGLX_nvidia by path or by soname; make the soname resolvable too.
        lib = NIXOS_DRIVER + "/lib"
        if os.path.isdir(lib) and lib not in env.get("LD_LIBRARY_PATH", "").split(os.pathsep):
            env["LD_LIBRARY_PATH"] = os.pathsep.join(p for p in (env.get("LD_LIBRARY_PATH"), lib) if p)
    return env
