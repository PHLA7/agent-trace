"""agent-trace backend — read-only routes over the recorder's local store.

Mounted by Hermes at ``/api/plugins/agent-trace/``. Imported from this file by path, so it cannot
use package-relative imports; it loads its own read layer (``../store.py``) explicitly instead, and
that module is pure stdlib with no dependency on this package.

The backend never writes: the recorder owns the store. Two consequences worth stating plainly,
because they are what make this half easy to review:

- No credentials, no env reads, no network. Every route reads local files under the plugin's own
  data directory.
- One route mutates anything (``DELETE /traces``), and it requires an explicit ``confirm=true``.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

log = logging.getLogger(__name__)

router = APIRouter()

_HERE = Path(__file__).resolve().parent
_PLUGIN_DIR = _HERE.parent
_DATA_DIR = _PLUGIN_DIR / "data"

_STORE_MODULE_NAME = "agent_trace_store"
MAX_LIVE_RECORDS = 500


def _store() -> Any:
    """Load ``../store.py`` by path as a standalone module.

    The web server imports *this* file by location, so this package has no importable name and a
    relative import would fail. Loading the read layer by path is the honest fix; the alternative
    would be duplicating ~200 lines of read logic into this file.
    """
    cached = sys.modules.get(_STORE_MODULE_NAME)
    if cached is not None:
        return cached
    path = _PLUGIN_DIR / "store.py"
    if not path.is_file():
        raise HTTPException(status_code=500, detail="agent-trace: store.py is missing")
    spec = importlib.util.spec_from_file_location(_STORE_MODULE_NAME, path)
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=500, detail="agent-trace: store.py could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_STORE_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


# ── cursor helpers (the /live channel) ───────────────────────────────────────────────────────
def _encode_cursor(state: dict[str, int]) -> str:
    """Encode a shard→size map as an opaque cursor. Relative paths, so no local paths leak."""
    rel: dict[str, int] = {}
    for raw, size in state.items():
        try:
            rel[str(Path(raw).relative_to(_DATA_DIR))] = int(size)
        except (ValueError, OSError):
            rel[Path(raw).name] = int(size)
    return base64.urlsafe_b64encode(
        json.dumps(rel, separators=(",", ":")).encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> Optional[dict[str, int]]:
    """Decode a cursor back into absolute shard paths. ``None`` when it is unusable."""
    if not cursor:
        return None
    try:
        rel = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(rel, dict):
        return None
    out: dict[str, int] = {}
    for name, size in rel.items():
        try:
            out[str(_DATA_DIR / str(name))] = int(size)
        except (TypeError, ValueError):
            continue
    return out


# ── routes ───────────────────────────────────────────────────────────────────────────────────
@router.get("/status")
def status() -> dict[str, Any]:
    """Recorder health. The recorder publishes this file on its sweep tick, so it can be stale."""
    store = _store()
    data = store.read_status(_DATA_DIR)
    if data is None:
        return {
            "enabled": False,
            "reason": "the recorder has not published a status yet",
            "capture_mode": None,
            "telemetry_schema_version": None,
            "store_bytes": store.store_bytes(_DATA_DIR),
        }
    data["enabled"] = True
    data["store_bytes"] = store.store_bytes(_DATA_DIR)
    return data


@router.get("/traces")
def traces(session_id: Optional[str] = Query(None), limit: int = Query(50, ge=1, le=500),
           since: Optional[float] = Query(None)) -> list[dict[str, Any]]:
    """Newest-first trace summaries. Reads trace records only, never blob bodies."""
    return _store().list_traces(_DATA_DIR, session_id=session_id, limit=limit, since=since)


@router.get("/traces/{trace_id}")
def trace_detail(trace_id: str) -> dict[str, Any]:
    """One trace with its flat span array."""
    payload = _store().load_trace(_DATA_DIR, trace_id)
    if payload is None:
        raise HTTPException(status_code=404, detail=f"trace {trace_id!r} not found")
    return payload


@router.get("/blobs/{blob_id}")
def blob_detail(blob_id: str, trace_id: Optional[str] = Query(None)) -> dict[str, Any]:
    """One blob body. Passing ``trace_id`` narrows the read to a single shard."""
    record = _store().load_blob(_DATA_DIR, blob_id, trace_id=trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"blob {blob_id!r} not found")
    return record


@router.get("/live")
def live(cursor: Optional[str] = Query(None), session_id: Optional[str] = Query(None)) -> dict[str, Any]:
    """Records written since ``cursor``. Blob bodies are omitted; fetch them by id.

    This is the only live channel, deliberately: ``plugins.isolation: host`` runs the backend out of
    process where a websocket upgrade cannot be served, and ``ctx.socket`` is a no-op on OAuth
    remotes. An incremental poll behaves identically in every deployment.
    """
    store = _store()
    state = _decode_cursor(cursor) if cursor else None
    if state is None:
        # First call: hand back a cursor at the current end so the client only sees new records.
        return {"cursor": _encode_cursor(store.tail_state(_DATA_DIR)), "records": [],
                "session_id": session_id}

    records = store.tail_since(_DATA_DIR, state)
    truncated = len(records) > MAX_LIVE_RECORDS
    out: list[dict[str, Any]] = []
    for record in records[:MAX_LIVE_RECORDS]:
        kind = record.get("record")
        if kind == "blob":
            out.append({"type": "blob", "trace_id": record.get("trace_id"),
                        "span_id": record.get("span_id"), "blob_id": record.get("id")})
        elif kind == "span":
            # Frame vocabulary, not record shape: the desktop half already routes anything
            # carrying `span`/`trace` into its frame reducer, so no client-side translation.
            out.append({"type": "span.start" if record.get("status") == "running" else "span.end",
                        "trace_id": record.get("trace_id"), "span": record})
        elif kind == "trace":
            out.append({"type": "trace.start" if record.get("ended_at") is None else "trace.end",
                        "trace": record})
    return {"cursor": _encode_cursor(state), "records": out, "truncated": truncated,
            "session_id": session_id}


@router.delete("/traces")
def clear(confirm: bool = Query(False)) -> dict[str, Any]:
    """Delete every shard. Requires ``confirm=true`` so a stray DELETE cannot wipe the store."""
    if not confirm:
        raise HTTPException(status_code=400, detail="pass confirm=true to clear the trace store")
    return _store().clear_store(_DATA_DIR)