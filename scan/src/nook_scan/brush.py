"""Brush (https://github.com/ArthurBrussee/brush): built from source at a pinned tag into scan/.tools/, then run headless."""

import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from . import TOOLS, ScanError, say

REPO_URL = "https://github.com/ArthurBrussee/brush"
TAG = "v0.3.0"
COMMIT = "3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486"  # what TAG points at; verified after cloning
NAME = f"brush {TAG}"

SRC = TOOLS / "brush-src"
TARGET = TOOLS / "brush-target"
BIN = TOOLS / "bin" / f"brush-{TAG}"
BUILD_LOG = TOOLS / "brush-build.log"
TRAIN_LOG = TOOLS / "last-train.log"
MAX_SPLATS = 1_500_000  # keeps the room PLY loadable by Spark in the browser next to the furniture


def _fmt(secs: float) -> str:
    secs = int(secs)
    return f"{secs // 60}m{secs % 60:02d}s"


def _run_logged(cmd: list[str], log, cwd: Path | None = None, env: dict | None = None, on_line=None) -> int:
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors="replace", bufsize=1)
    try:
        for line in p.stdout:
            log.write(line)
            if on_line:
                on_line(line.rstrip("\n"))
        return p.wait()
    except BaseException:  # interrupted or terminated: don't leave Brush training in the background
        p.kill()
        p.wait()
        raise


def _last_lines(path: Path, n: int = 40) -> list[str]:
    try:
        return [l.strip() for l in path.read_text(errors="replace").splitlines()[-n:] if l.strip()]
    except OSError:
        return []


def ensure() -> Path:
    """Return the Brush binary, building it on first use (git clone at TAG + cargo build --release)."""
    override = os.environ.get("NOOK_SCAN_BRUSH")
    if override:
        if not os.access(override, os.X_OK):
            raise ScanError(f"NOOK_SCAN_BRUSH={override} is not an executable: unset it to build Brush automatically")
        return Path(override)
    if BIN.is_file() and os.access(BIN, os.X_OK):
        return BIN
    for tool, hint in (("git", "install the Xcode command line tools (xcode-select --install)"),
                       ("cargo", "install Rust from https://rustup.rs")):
        if not shutil.which(tool):
            raise ScanError(f"{tool} not found, needed once to build the Brush trainer: {hint}, then re-run")

    TOOLS.mkdir(parents=True, exist_ok=True)
    started = time.time()
    say(f"building the Brush trainer ({TAG}) from source (first run only, up to ~10 minutes)")
    with open(BUILD_LOG, "w") as log:
        head = subprocess.run(["git", "-C", str(SRC), "rev-parse", "HEAD"], capture_output=True, text=True) if SRC.is_dir() else None
        if not head or head.returncode or head.stdout.strip() != COMMIT:
            shutil.rmtree(SRC, ignore_errors=True)
            say(f"  cloning {REPO_URL} at {TAG}")
            rc = _run_logged(["git", "-c", "advice.detachedHead=false", "clone", "--depth", "1", "--branch", TAG, REPO_URL, str(SRC)], log)
            if rc:
                raise ScanError(f"could not clone Brush from {REPO_URL} (git exit {rc}): check your internet connection, then re-run (log: {BUILD_LOG})")
            head = subprocess.run(["git", "-C", str(SRC), "rev-parse", "HEAD"], capture_output=True, text=True)
            if head.stdout.strip() != COMMIT:
                shutil.rmtree(SRC, ignore_errors=True)
                raise ScanError(f"Brush tag {TAG} no longer points at {COMMIT[:10]}: refusing to build an unpinned trainer (update COMMIT in scan/src/nook_scan/brush.py)")
        state = {"n": 0, "last": time.time()}

        def progress(line: str):
            if line.lstrip().startswith("Compiling "):
                state["n"] += 1
                if time.time() - state["last"] > 15:
                    state["last"] = time.time()
                    say(f"  compiling Brush: {state['n']} crates done (about 560 in all), {_fmt(time.time() - started)} elapsed")
            elif line.lstrip().startswith("Downloaded ") and time.time() - state["last"] > 15:
                state["last"] = time.time()
                say("  downloading Rust dependencies")

        say("  cargo build --release (progress every 15 s)")
        env = dict(os.environ, CARGO_TARGET_DIR=str(TARGET), CARGO_TERM_COLOR="never")
        rc = _run_logged(["cargo", "build", "--release", "--locked", "-p", "brush-app", "--bin", "brush_app"], log, cwd=SRC, env=env, on_line=progress)
    if rc:
        err = next((l for l in _last_lines(BUILD_LOG, 200) if l.startswith("error")), f"cargo exit {rc}")
        raise ScanError(f"building Brush failed ({err[:160]}): update Rust with `rustup update`, then re-run (full log: {BUILD_LOG})")
    built = TARGET / "release" / "brush_app"
    if not built.is_file():
        raise ScanError(f"cargo finished but {built} is missing: delete {TOOLS} and re-run (log: {BUILD_LOG})")
    BIN.parent.mkdir(parents=True, exist_ok=True)
    tmp = BIN.with_suffix(".tmp")
    shutil.copy2(built, tmp)
    os.replace(tmp, BIN)
    shutil.rmtree(TARGET, ignore_errors=True)  # ~2.5 GB of build intermediates; the binary is all we need
    say(f"Brush {TAG} built in {_fmt(time.time() - started)}: {BIN}")
    return BIN


def train(binary: Path, data_dir: Path, out_dir: Path, steps: int, max_resolution: int, sh_degree: int) -> dict:
    """Run Brush headless on a Nerfstudio dataset folder. Returns {"ply": Path, "psnr": held-out PSNR or None}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(binary), str(data_dir),
           "--total-steps", str(steps),
           "--growth-stop-iter", str(max(1, steps // 2)),
           "--max-resolution", str(max_resolution),
           "--export-path", str(out_dir), "--export-name", "trained.ply",
           "--export-every", str(steps + 1),  # export only at the last step
           "--eval-every", str(steps),  # score held-out frames once, at the end
           "--max-splats", str(MAX_SPLATS),
           "--sh-degree", str(sh_degree),
           "--seed", "42"]
    env = dict(os.environ, RUST_LOG="warn,brush_cli=info,brush_process=info", RUST_BACKTRACE="0", NO_COLOR="1")
    started = time.time()
    state = {"last": started, "iter": 0, "splats": 0, "psnr": None}
    refine = re.compile(r"Refine iter (\d+), (\d+) splats")
    evalre = re.compile(r"Eval iter (\d+): PSNR ([0-9.]+)")

    def progress(line: str):
        if m := refine.search(line):
            state["iter"], state["splats"] = int(m[1]), int(m[2])
        elif m := evalre.search(line):
            state["psnr"] = float(m[2])
        elif "Loaded dataset" in line:
            say("  " + line.split("]", 1)[-1].strip())
        now = time.time()
        if state["iter"] and now - state["last"] > 20:
            state["last"] = now
            el = now - started
            eta = el / state["iter"] * (steps - state["iter"])
            say(f"  training: step {state['iter']}/{steps}, {state['splats'] / 1000:.0f}k splats, {_fmt(el)} elapsed, about {_fmt(eta)} left")

    say(f"training with {NAME}: {steps} steps (progress every 20 s)")
    TRAIN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(TRAIN_LOG, "w") as log:
        log.write("$ " + " ".join(cmd) + "\n")
        rc = _run_logged(cmd, log, env=env, on_line=progress)
    ply = out_dir / "trained.ply"
    if rc or not ply.is_file():
        lines = [l for l in _last_lines(TRAIN_LOG) if not l.startswith("$ ")]
        err = next((l for l in reversed(lines) if "rror" in l or "panicked" in l), lines[-1] if lines else f"Brush exited with code {rc}")
        hint = "check the capture images" if "image" in err.lower() else "re-run; if it repeats, try --max-image-size 960"
        raise ScanError(f"Brush training failed ({err[:160]}): {hint} (full log: {TRAIN_LOG})")
    say(f"Brush finished {steps} steps in {_fmt(time.time() - started)}"
        + (f", held-out PSNR {state['psnr']:.2f} dB (Brush renderer)" if state["psnr"] is not None else ""))
    return {"ply": ply, "psnr": state["psnr"]}
