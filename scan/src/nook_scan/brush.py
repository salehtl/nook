"""Brush (https://github.com/ArthurBrussee/brush): built from source at a pinned tag into scan/.tools/, then run headless.

Set NOOK_BRUSH_BIN to use a Brush binary built elsewhere (e.g. with Nix on kakapo) instead of building one here.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import TOOLS, ScanError, gpu, say

REPO_URL = "https://github.com/ArthurBrussee/brush"
TAG = "v0.3.0"
COMMIT = "3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486"  # what TAG points at; verified after cloning
NAME = f"brush {TAG}"
ENV_BIN = ("NOOK_BRUSH_BIN", "NOOK_SCAN_BRUSH")  # the second is the v1 name, still honored

SRC = TOOLS / "brush-src"
TARGET = TOOLS / "brush-target"
BIN = TOOLS / "bin" / f"brush-{TAG}"
BUILD_LOG = TOOLS / "brush-build.log"
TRAIN_LOG = TOOLS / "last-train.log"  # NOOK_SCAN_TRAIN_LOG overrides it (the jobs server keeps one log per job)
REFINE_EVERY = 200  # Brush's default; it logs "Refine iter N" at that interval, which is all the progress it prints


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


def train_log() -> Path:
    """Where Brush's output goes: NOOK_SCAN_TRAIN_LOG, else scan/.tools/, else the temp folder (read-only installs)."""
    if os.environ.get("NOOK_SCAN_TRAIN_LOG"):
        return Path(os.environ["NOOK_SCAN_TRAIN_LOG"]).expanduser()
    try:
        TOOLS.mkdir(parents=True, exist_ok=True)
        if os.access(TOOLS, os.W_OK):
            return TRAIN_LOG
    except OSError:
        pass
    return Path(tempfile.gettempdir()) / "nook-scan-last-train.log"


def override() -> Path | None:
    for var in ENV_BIN:
        value = os.environ.get(var)
        if value:
            path = Path(shutil.which(value) or value).expanduser()
            if not (path.is_file() and os.access(path, os.X_OK)):
                raise ScanError(f"{var}={value} is not an executable Brush binary: fix the path, or unset it to build Brush {TAG} automatically")
            return path
    return None


def trainer_name(binary: Path | None = None) -> str:
    """"brush v0.3.0" for the pinned build; for an override, the version the binary reports."""
    binary = binary or override()
    if binary is None or binary == BIN:
        return NAME
    try:
        out = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=20).stdout.split()
    except (OSError, subprocess.SubprocessError):
        out = []
    return f"brush {out[-1]}" if out and re.fullmatch(r"v?\d+\.\d+.*", out[-1]) else f"brush ({binary.name})"


def ensure() -> Path:
    """Return the Brush binary, building it on first use (git clone at TAG + cargo build --release)."""
    path = override()
    if path:
        return path
    if BIN.is_file() and os.access(BIN, os.X_OK):
        return BIN
    git_hint = "install the Xcode command line tools (xcode-select --install)" if sys.platform == "darwin" else "install git"
    for tool, hint in (("git", git_hint), ("cargo", "install Rust from https://rustup.rs")):
        if not shutil.which(tool):
            raise ScanError(f"{tool} not found, needed once to build the Brush trainer: {hint}, then re-run "
                            f"(or set NOOK_BRUSH_BIN to a Brush binary built elsewhere)")

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


def train(binary: Path, data_dir: Path, out_dir: Path, steps: int, max_resolution: int, sh_degree: int,
          max_splats: int, extra: list[str] | None = None, progress_every: float = 20.0) -> dict:
    """Run Brush headless on a Nerfstudio dataset folder. Returns {"ply": Path, "psnr": held-out PSNR or None}.

    Brush only logs every REFINE_EVERY steps, so a ticker prints `training: step X/Y` every `progress_every` seconds,
    interpolating from the measured step rate (never past the next logged step). The jobs server reads these lines.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(binary), str(data_dir),
           "--total-steps", str(steps),
           "--growth-stop-iter", str(max(1, steps // 2)),
           "--max-resolution", str(max_resolution),
           "--export-path", str(out_dir), "--export-name", "trained.ply",
           "--export-every", str(steps + 1),  # export only at the last step
           "--eval-every", str(steps),  # score held-out frames once, at the end
           "--max-splats", str(max_splats),
           "--sh-degree", str(sh_degree),
           "--refine-every", str(REFINE_EVERY),
           "--seed", "42", *(extra or [])]
    env = dict(gpu.trainer_env(), RUST_LOG="warn,brush_cli=info,brush_process=info", RUST_BACKTRACE="0", NO_COLOR="1")
    started = time.time()
    lock = threading.Lock()
    st = {"iter": 0, "t": None, "rate": None, "splats": 0, "psnr": None, "shown": 0, "loop": None}
    refine = re.compile(r"Refine iter (\d+), (\d+) splats")
    evalre = re.compile(r"Eval iter (\d+): PSNR ([0-9.]+)")
    done = threading.Event()

    def on_line(line: str):
        now = time.time()
        with lock:
            if m := refine.search(line):
                it = int(m[1])
                t0, i0 = (st["t"], st["iter"]) if st["t"] else (st["loop"] or started, 0)
                if now > t0 and it > i0:
                    st["rate"] = (it - i0) / (now - t0)
                st["iter"], st["t"], st["splats"] = it, now, int(m[2])
            elif m := evalre.search(line):
                st["psnr"] = float(m[2])
            elif "Start training loop" in line:
                st["loop"] = now
        if "Loaded dataset" in line:
            say("  " + line.split("]", 1)[-1].strip())

    def ticker():
        while not done.wait(progress_every):
            with lock:
                if st["loop"] is None:
                    continue
                est = st["iter"]
                if st["rate"] and st["t"]:
                    est = min(st["iter"] + st["rate"] * (time.time() - st["t"]), st["iter"] + REFINE_EVERY - 1)
                est = int(min(max(est, st["shown"]), steps))
                st["shown"] = est
                splats = st["splats"]
            el = time.time() - started
            left = f", about {_fmt(el / est * (steps - est))} left" if est else ""
            say(f"  training: step {est}/{steps}, {splats / 1000:.0f}k splats, {_fmt(el)} elapsed{left}")

    say(f"training with {NAME if binary == BIN else binary}: {steps} steps (progress every {progress_every:g} s)")
    log_path = train_log()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    tick = threading.Thread(target=ticker, daemon=True)
    tick.start()
    try:
        with open(log_path, "w") as log:
            log.write("$ " + " ".join(cmd) + "\n")
            rc = _run_logged(cmd, log, env=env, on_line=on_line)
    finally:
        done.set()
    ply = out_dir / "trained.ply"
    if rc or not ply.is_file():
        lines = [l for l in _last_lines(log_path) if not l.startswith("$ ")]
        err = next((l for l in reversed(lines) if "rror" in l or "panicked" in l), lines[-1] if lines else f"Brush exited with code {rc}")
        low = err.lower()
        if any(k in low for k in ("adapter", "vulkan", "no suitable", "backend")):
            hint = "Brush found no usable GPU: on Linux check the NVIDIA driver and VK_ICD_FILENAMES"
        elif any(k in low for k in ("out of memory", "outofmemory", "allocation")):
            hint = "the GPU ran out of memory: re-run with a lower --max-splats or --max-image-size"
        elif "image" in low:
            hint = "check the capture images"
        else:
            hint = "re-run; if it repeats, try --max-image-size 960"
        raise ScanError(f"Brush training failed ({err[:160]}): {hint} (full log: {log_path})")
    say(f"Brush finished {steps} steps in {_fmt(time.time() - started)}"
        + (f", held-out PSNR {st['psnr']:.2f} dB (Brush renderer)" if st["psnr"] is not None else ""))
    say(f"  training: step {steps}/{steps}, {st['splats'] / 1000:.0f}k splats, {_fmt(time.time() - started)} elapsed")
    return {"ply": ply, "psnr": st["psnr"]}
