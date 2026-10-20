"""Backend route tests.

`plugin_api.py` is loaded the way the web server loads it — by file path, so it has no parent
package — and its handlers are called directly. That exercises the real read paths, the cursor
encoding, and the confirm gate without standing up an HTTP server.

Needs fastapi to import the router (`uv run --with pytest --with fastapi pytest tests`).
"""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

import pytest

import recorder as rec_mod
import store as store_mod

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

fastapi = pytest.importorskip("fastapi", reason="the plugin backend is a FastAPI router")
HTTPException = fastapi.HTTPException


def drain(rec: rec_mod.Recorder, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while rec._queue.unfinished_tasks and time.time() < deadline:
        time.sleep(0.02)


def load_api(data_dir: Path):
    """Import the backend exactly as the web server does, then point it at a temp store.

    The module resolves its data directory from its own file location, so redirecting the global is
    what keeps the test out of the real plugin directory.
    """
    path = ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("agent_trace_api_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module._DATA_DIR = data_dir
    return module


@pytest.fixture()
def store_and_api(tmp_path: Path):
    rec = rec_mod.Recorder(tmp_path)
    _write_a_turn(rec, turn="t1", session="s1")
    drain(rec)
    rec._write_status()
    api = load_api(tmp_path)
    yield rec, api, tmp_path
    rec.shutdown()


def _write_a_turn(rec: rec_mod.Recorder, *, turn: str, session: str) -> None:
    rec.on_pre_llm_call(session_id=session, turn_id=turn, user_message="do the thing",
                        model="test-model", provider="test-provider", platform="desktop")
    rec.on_pre_api_request(session_id=session, turn_id=turn, api_request_id=f"a_{turn}",
                           model="test-model", provider="test-provider", started_at=time.time())
    rec.on_post_api_request(session_id=session, turn_id=turn, api_request_id=f"a_{turn}",
                            usage={"prompt_tokens": 120, "completion_tokens": 30},
                            api_duration=0.9, finish_reason="tool_calls")
    rec.on_pre_tool_call(session_id=session, turn_id=turn, tool_call_id=f"c_{turn}",
                         tool_name="terminal", args={"command": "echo hi"})
    rec.on_post_tool_call(session_id=session, turn_id=turn, tool_call_id=f"c_{turn}",
                          tool_name="terminal", result="hi", status="ok", duration_ms=12)
    rec.on_post_llm_call(session_id=session, turn_id=turn, assistant_response="done")


# ── status ───────────────────────────────────────────────────────────────────────────────────
def test_status_reports_the_recorder(store_and_api):
    _, api, _ = store_and_api
    status = api.status()
    assert status["enabled"] is True
    assert status["capture_mode"] == "sanitized"
    assert status["telemetry_schema_version"] == rec_mod.TELEMETRY_SCHEMA_VERSION
    assert status["spans_recorded"] >= 3


def test_status_before_the_recorder_ever_runs(tmp_path: Path):
    """A fresh install has no status file; the route must describe that state, not crash."""
    api = load_api(tmp_path)
    status = api.status()
    assert status["enabled"] is False
    assert "status" in status["reason"]


# ── traces ───────────────────────────────────────────────────────────────────────────────────
def test_traces_lists_newest_first_and_filters_by_session(store_and_api):
    rec, api, _ = store_and_api
    _write_a_turn(rec, turn="t2", session="s2")
    drain(rec)

    everything = api.traces(session_id=None, limit=50, since=None)
    assert [t["turn_id"] for t in everything][:1] == ["t2"]
    assert {t["turn_id"] for t in everything} == {"t1", "t2"}

    one = api.traces(session_id="s1", limit=50, since=None)
    assert [t["turn_id"] for t in one] == ["t1"]

    assert len(api.traces(session_id=None, limit=1, since=None)) == 1
    assert api.traces(session_id=None, limit=50, since=time.time() + 60) == []


def test_trace_detail_returns_the_span_tree(store_and_api):
    _, api, _ = store_and_api
    payload = api.trace_detail("tr_t1")
    spans = payload["spans"]
    ids = {s["id"] for s in spans}
    assert ids == {"sp_t1", "sp_api_a_t1", "sp_tool_c_t1"}

    root = next(s for s in spans if s["id"] == "sp_t1")
    assert root["parent_id"] is None
    assert all(s["status"] == "ok" for s in spans)
    assert payload["trace"]["totals"]["input_tokens"] == 120


def test_unknown_trace_is_404(store_and_api):
    _, api, _ = store_and_api
    with pytest.raises(HTTPException) as excinfo:
        api.trace_detail("tr_nope")
    assert excinfo.value.status_code == 404


# ── blobs ────────────────────────────────────────────────────────────────────────────────────
def test_blob_detail_serves_the_body_and_404s_missing(store_and_api):
    _, api, _ = store_and_api
    span = next(s for s in api.trace_detail("tr_t1")["spans"] if s["id"] == "sp_tool_c_t1")
    assert span["args_ref"], "the tool call must have stored its arguments"

    blob = api.blob_detail(span["args_ref"], trace_id="tr_t1")
    assert blob["body"]["command"] == "echo hi"
    assert blob["field"] == "args"

    with pytest.raises(HTTPException) as excinfo:
        api.blob_detail("bl_nope", trace_id="tr_t1")
    assert excinfo.value.status_code == 404


# ── live ─────────────────────────────────────────────────────────────────────────────────────
def test_live_hands_back_a_cursor_and_then_only_new_frames(store_and_api):
    rec, api, _ = store_and_api

    first = api.live(cursor=None, session_id=None)
    assert first["records"] == [] and isinstance(first["cursor"], str)

    _write_a_turn(rec, turn="t2", session="s2")
    drain(rec)

    second = api.live(cursor=first["cursor"], session_id=None)
    types = [r["type"] for r in second["records"]]
    assert "trace.end" in types, types
    assert set(types) <= {"trace.start", "trace.end", "span.start", "span.end", "blob"}
    for record in second["records"]:
        if record["type"].startswith("span"):
            assert isinstance(record["span"], dict)

    # The cursor advances: nothing is replayed twice.
    third = api.live(cursor=second["cursor"], session_id=None)
    assert third["records"] == []


def test_live_with_a_corrupt_cursor_starts_fresh(store_and_api):
    _, api, _ = store_and_api
    res = api.live(cursor="not-base64-!!", session_id=None)
    assert res["records"] == [] and isinstance(res["cursor"], str)


def test_live_omits_blob_bodies(store_and_api):
    rec, api, _ = store_and_api
    cursor = api.live(cursor=None, session_id=None)["cursor"]
    _write_a_turn(rec, turn="t3", session="s3")
    drain(rec)

    for record in api.live(cursor=cursor, session_id=None)["records"]:
        if record["type"] == "blob":
            assert "body" not in record
            assert record["blob_id"].startswith("bl_")


# ── clear ────────────────────────────────────────────────────────────────────────────────────
def test_clear_requires_confirm(store_and_api):
    _, api, tmp_path = store_and_api
    with pytest.raises(HTTPException) as excinfo:
        api.clear(confirm=False)
    assert excinfo.value.status_code == 400
    assert store_mod.list_traces(tmp_path), "an unconfirmed clear must delete nothing"

    result = api.clear(confirm=True)
    assert result["files"] >= 1
    assert store_mod.list_traces(tmp_path) == []