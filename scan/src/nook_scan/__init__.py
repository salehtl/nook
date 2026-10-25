"""nook-scan: turn a nook-scan capture (contract §4) into the room splat the planner uses."""

from pathlib import Path


class ScanError(Exception):
    """A failure the user can act on. The message is printed as one stderr line."""


SCAN_DIR = Path(__file__).resolve().parents[2]  # scan/
REPO = SCAN_DIR.parent
TOOLS = SCAN_DIR / ".tools"


def say(msg: str) -> None:
    """Progress goes to stdout (stderr is reserved for the one-line error)."""
    print(f"nook-scan: {msg}", flush=True)
