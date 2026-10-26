"""`train --refine-poses` (contract §4.11): run nook-poses (VGGT, anchored to ARKit) on the prepared dataset, so the
trainer starts from refined camera poses. Held-out frames (transforms_val.json) keep their ARKit poses.

NOOK_POSES_BIN names the executable; otherwise `nook-poses` on PATH (kakapo: `nix build .#nook-poses`).
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

from . import ScanError, say


def binary() -> str:
    found = os.environ.get("NOOK_POSES_BIN") or shutil.which("nook-poses")
    if not found:
        raise ScanError("--refine-poses needs nook-poses, which runs on kakapo's NVIDIA GPU (nix build .#nook-poses, "
                        "then set NOOK_POSES_BIN), or train without --refine-poses")
    return found


def refine(data_dir: Path) -> dict:
    """Replace data_dir/transforms.json with refined poses (the ARKit original stays as transforms.arkit.json).
    Returns nook-poses' summary: frames, shift_cm_median, shift_cm_max, rot_deg_median, seconds, ..."""
    tf = data_dir / "transforms.json"
    backup, refined = data_dir / "transforms.arkit.json", data_dir / "transforms.refined.json"
    shutil.copyfile(tf, backup)
    say("refining camera poses with nook-poses (VGGT)")
    p = subprocess.Popen([binary(), str(data_dir), "--out", str(refined)], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, errors="replace", bufsize=1)
    lines = []
    try:
        for line in p.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if line.startswith("nook-poses: "):
                say(f"  poses: {line[len('nook-poses: '):]}")
        rc = p.wait()
    except BaseException:  # interrupted or cancelled: never leave it running on the GPU
        p.kill()
        p.wait()
        raise
    try:
        summary = json.loads(lines[-1]) if rc == 0 and lines else None
    except json.JSONDecodeError:
        summary = None
    if summary is None or not refined.is_file():
        why = next((l.split("error:", 1)[1].strip() for l in reversed(lines) if l.startswith("nook-poses: error:")),
                   lines[-1][:200] if lines else f"exit {rc}")
        raise ScanError(f"pose refinement failed: {why}")
    os.replace(refined, tf)
    return summary
