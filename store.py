"""Read side of the agent-trace store.

Deliberately decoupled from the recorder: the backend reads the files the recorder writes, and
tails them for live frames. Nothing is shared in memory, because ``plugin_api.py`` is imported by
file location by the web server and cannot reliably import a sibling module, and because reaching
into core to register a shared object would violate the catalog's "no core override" rule.

Layout (one shard per session per day, every record kind together):

    <plugin dir>/data/traces/YYYY-MM-DD/<session_id>.jsonl   one JSON object per line, each with
                                                             a `record` discriminator:
                                                             "trace" | "span" | "blob" | "status"
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Iterator, Optional

TRACE_SUMMARY_KEYS = (
    "id", "session_id", "turn_id", "platform", "model", "provider", "started_at", "ended_at",
    "duration_ms", "status", "totals", "capture_mode", "user_message", "seq",
)


def _trace_order_key(record: dict) -> tuple[float, int, str]:
    """Newest-first ordering that stays deterministic across a coarse clock.

    ``started_at`` alone is not enough: platforms with low ``time.time()`` resolution (Windows ticks
    at ~15.6 ms) hand several traces the same value, and then the list order falls back to whatever
    order the shard files happened to be read in. ``seq`` is the recorder's monotonic creation
    counter, so it reproduces real creation order; ``id`` is a last resort for a record written
    before ``seq`` existed.
    """
    return (float(record.get("started_at") or 0), int(record.get("seq") or 0),
            str(record.get("id") or ""))


def _iter_lines(path: Path, *, start: int = 0) -> Iterator[tuple[dict, int]]:
    """Yield ``(record, byte_offset_after_line)`` for each parseable JSON line.

    A torn final line is normal: the writer appends without a lock while a reader may be mid-file.
    A line that does not parse is skipped rather than raising.
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            if start:
                fh.seek(start)
            offset = start
            for line in fh:
                offset += len(line.encode("utf-8", errors="replace"))
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line), offset
                except Exception:
                    continue
    except FileNotFoundError:
        return
    except OSError:
        return


def shard_paths(data_dir: Path | str, *, newest_first: bool = True) -> list[Path]:
    root = Path(data_dir) / "traces"
    if not root.is_dir():
        return []
    paths = [p for p in root.rglob("*.jsonl") if p.is_file()]
    try:
        paths.sort(key=lambda p: p.stat().st_mtime, reverse=newest_first)
    except OSError:
        pass
    return paths


def iter_records(data_dir: Path | str, *, kind: Optional[str] = None) -> Iterator[dict]:
    for path in shard_paths(data_dir, newest_first=False):
        for record, _ in _iter_lines(path):
            if kind is None or record.get("record") == kind:
                yield record


# ── traces ───────────────────────────────────────────────────────────────────────────────────
def list_traces(data_dir: Path | str, *, session_id: Optional[str] = None,
                limit: int = 50, since: Optional[float] = None) -> list[dict]:
    """Newest-first trace summaries. Reads trace records only."""
    out: list[dict] = []
    for record in iter_records(data_dir, kind="trace"):
        if session_id and record.get("session_id") != session_id:
            continue
        if since is not None and float(record.get("started_at") or 0) < float(since):
            continue
        out.append({k: record.get(k) for k in TRACE_SUMMARY_KEYS if k in record})
    out.sort(key=_trace_order_key, reverse=True)
    return out[: max(1, int(limit))]


def find_trace(data_dir: Path | str, trace_id: str) -> tuple[Optional[dict], Optional[Path]]:
    for path in shard_paths(data_dir):
        for record, _ in _iter_lines(path):
            if record.get("record") == "trace" and record.get("id") == trace_id:
                return record, path
    return None, None


def load_trace(data_dir: Path | str, trace_id: str) -> Optional[dict]:
    """A trace plus its flat span array. Blob bodies are intentionally excluded."""
    trace, path = find_trace(data_dir, trace_id)
    if trace is None or path is None:
        return None
    spans = [record for record, _ in _iter_lines(path)
             if record.get("record") == "span" and record.get("trace_id") == trace_id]
    spans.sort(key=lambda s: (float(s.get("started_at") or 0), s.get("depth") or 0))
    return {"trace": trace, "spans": spans}


def load_span(data_dir: Path | str, trace_id: str, span_id: str) -> Optional[dict]:
    _, path = find_trace(data_dir, trace_id)
    if path is None:
        return None
    for record, _ in _iter_lines(path):
        if record.get("record") == "span" and record.get("id") == span_id:
            return record
    return None


# ── blobs ────────────────────────────────────────────────────────────────────────────────────
def load_blob(data_dir: Path | str, blob_id: str, *, trace_id: Optional[str] = None) -> Optional[dict]:
    """One blob record including its body.

    ``trace_id`` narrows the read to a single shard. Without it the store is scanned newest-first,
    which is bounded by the retention caps and is what a caller holding only a blob id needs.
    """
    if trace_id:
        _, path = find_trace(data_dir, trace_id)
        if path is not None:
            for record, _ in _iter_lines(path):
                if record.get("record") == "blob" and record.get("id") == blob_id:
                    return record
    for path in shard_paths(data_dir):
        for record, _ in _iter_lines(path):
            if record.get("record") == "blob" and record.get("id") == blob_id:
                return record
    return None


# ── live tail (the socket's source, and the polling fallback's source) ───────────────────────
def tail_state(data_dir: Path | str) -> dict[str, int]:
    """Current byte size per shard, used as the tailing cursor."""
    state: dict[str, int] = {}
    for path in shard_paths(data_dir, newest_first=False):
        try:
            state[str(path)] = path.stat().st_size
        except OSError:
            continue
    return state


def tail_since(data_dir: Path | str, state: dict[str, int]) -> list[dict]:
    """New records written since ``state`` was captured. Updates ``state`` in place.

    A shard that disappeared (retention pruning) is dropped from the cursor; a shard that shrank is
    re-read from the start, because its content changed identity.
    """
    records: list[dict] = []
    for path in shard_paths(data_dir, newest_first=False):
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            state.pop(key, None)
            continue
        start = state.get(key, 0)
        if start > size:
            start = 0
        if start == size:
            continue
        for record, _ in _iter_lines(path, start=start):
            records.append(record)
        state[key] = size
    return records


# ── status and maintenance ───────────────────────────────────────────────────────────────────
def read_status(data_dir: Path | str) -> Optional[dict]:
    """The recorder's self-reported status, refreshed on its sweep tick."""
    try:
        path = Path(data_dir) / "status.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["status_age_s"] = round(max(0.0, time.time() - float(data.get("written_at") or 0)), 1)
        return data
    except Exception:
        return None


def clear_store(data_dir: Path | str) -> dict[str, int]:
    """Delete every shard. Returns files removed and bytes freed."""
    files = 0
    freed = 0
    for path in shard_paths(data_dir, newest_first=False):
        try:
            freed += path.stat().st_size
            path.unlink()
            files += 1
        except OSError:
            continue
    try:
        (Path(data_dir) / "status.json").unlink()
    except OSError:
        pass
    return {"files": files, "bytes": freed}


def store_bytes(data_dir: Path | str) -> int:
    try:
        return sum(p.stat().st_size for p in Path(data_dir).rglob("*") if p.is_file())
    except OSError:
        return 0


def count_spans(data_dir: Path | str) -> int:
    total = 0
    for _ in iter_records(data_dir, kind="span"):
        total += 1
    return total