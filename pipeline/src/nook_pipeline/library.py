"""library.json upserts and costs.csv rows (contract §3.5). All writes are atomic (temp file, then rename)."""
import csv
import io
import json
import os
from pathlib import Path

from . import NookError

COSTS_HEADER = ["date", "id", "engine", "cost_usd", "mock", "input"]


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load(lib_dir: Path) -> dict:
    """The current library (empty if there is none). Refuses to continue on a corrupt file, so it's never clobbered."""
    path = lib_dir / "library.json"
    if not path.exists():
        return {"version": 1, "items": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise NookError(f"{path} can't be read ({e}); fix or move it first") from None
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("items"), list):
        raise NookError(f"{path} isn't a version 1 library ({{\"version\": 1, \"items\": [...]}}); fix or move it first")
    return data


def upsert(lib_dir: Path, data: dict, entry: dict) -> bool:
    """Insert or replace the entry with entry["id"], write library.json, and say whether it replaced one."""
    items = data["items"]
    idx = [i for i, it in enumerate(items) if isinstance(it, dict) and it.get("id") == entry["id"]]
    if idx:
        items[idx[0]] = entry
        for i in reversed(idx[1:]):
            del items[i]
    else:
        items.append(entry)
    atomic_write(lib_dir / "library.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return bool(idx)


def append_cost(lib_dir: Path, date: str, item_id: str, engine: str, cost: float, mock: bool, source: str) -> None:
    path = lib_dir / "costs.csv"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if not text.strip():
        text = ",".join(COSTS_HEADER) + "\n"
    elif not text.endswith("\n"):
        text += "\n"
    row = io.StringIO()
    csv.writer(row, lineterminator="\n").writerow(
        [date, item_id, engine, f"{cost:.2f}", "true" if mock else "false", source])
    atomic_write(path, text + row.getvalue())
