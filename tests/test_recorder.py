"""Recorder and store tests.

These run against the real recorder, a real queue, a real writer thread and a real temp store: no
clock or filesystem mockery, because the failure modes that matter here (dropped spans, a torn
read, a span that never closes) only appear when the pieces actually move.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pytest

import recorder as rec_mod
import store as store_mod


def drain(rec: rec_mod.Recorder, timeout: float = 5.0) -> None:
    """Wait for the writer thread to empty the queue."""
    deadline = time.time() + timeout
    while rec._queue.unfinished_tasks and time.time() < deadline:
        time.sleep(0.02)
    assert not rec._queue.unfinished_tasks, "writer thread did not drain in time"


@pytest.fixture()
def rec(tmp_path: Path):
    r = rec_mod.Recorder(tmp_path)
    yield r
    r.shutdown()


@pytest.fixture()
def rec_factory(tmp_path: Path):
    """Build recorders with non-default options against the same temp store."""
    created: list[rec_mod.Recorder] = []

    def make(capture_mode: str = "sanitized", **kwargs):
        r = rec_mod.Recorder(tmp_path, capture_mode=capture_mode, **kwargs)
        created.append(r)
        return r

    yield make
    for r in created:
        r.shutdown()


def spans_of(tmp_path: Path, trace_id: str) -> list[dict]:
    payload = store_mod.load_trace(tmp_path, trace_id)
    assert payload is not None, f"trace {trace_id} not found"
    return payload["spans"]


def span_by_id(spans: list[dict], span_id: str) -> dict:
    for span in spans:
        if span["id"] == span_id:
            return span
    raise AssertionError(f"span {span_id} missing; have {[s['id'] for s in spans]}")


# ── unit-level: redaction and bounding ───────────────────────────────────────────────────────
def test_redaction_covers_the_documented_classes():
    text = json.dumps({
        "api_key": "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        "github": "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g",
        "header": "Authorization: Bearer abcdefghijklmnop1234",
        "pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "shell": "curl -H 'x-api-key: zzzzzzzzzzzzzzzz'",
    })
    redacted, count = rec_mod.redact(text)
    assert count >= 5
    assert "sk-abcdefghijklmnop" not in redacted
    assert "ghp_abcdefghijklmnop" not in redacted
    assert "«redacted:" in redacted
    # The key NAME stays legible; only the value goes.
    assert "api_key" in redacted


def test_redaction_keeps_small_assignments_that_are_not_secrets():
    text = "password=abc"          # shorter than the 6-char floor
    redacted, count = rec_mod.redact(text)
    assert count == 0
    assert redacted == text


def test_truncate_bounds_depth_items_and_chars():
    deep = {"a": {"b": {"c": {"d": {"e": {"f": "too deep"}}}}}}
    bounded, clipped = rec_mod._truncate(deep)
    assert clipped is True
    assert "<max-depth>" in json.dumps(bounded)

    wide = {f"k{i}": i for i in range(80)}
    bounded, clipped = rec_mod._truncate(wide)
    assert clipped is True
    assert len(bounded) <= rec_mod.MAX_ITEMS + 1

    long_string = "x" * (rec_mod.MAX_FIELD_CHARS + 500)
    bounded, clipped = rec_mod._truncate(long_string)
    assert clipped is True
    assert len(bounded) == rec_mod.MAX_FIELD_CHARS


def test_tokens_normalised_across_provider_shapes():
    openai = rec_mod._tokens_from_usage({
        "prompt_tokens": 1000, "completion_tokens": 200,
        "prompt_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100},
        "completion_tokens_details": {"reasoning_tokens": 50},
    })
    assert openai == {"input": 500, "output": 200, "cache_read": 400,
                      "cache_write": 100, "reasoning": 50}

    anthropic = rec_mod._tokens_from_usage({
        "input_tokens": 700, "output_tokens": 90,
        "cache_read_input_tokens": 300, "cache_creation_input_tokens": 40,
    })
    assert anthropic["input"] == 700
    assert anthropic["cache_read"] == 300


# ── the turn: a real tree ────────────────────────────────────────────────────────────────────
def test_full_turn_builds_a_tree_with_correct_parents(rec: rec_mod.Recorder, tmp_path: Path):
    now = time.time()
    rec.on_pre_llm_call(session_id="s1", turn_id="t1", user_message="go", model="m1",
                        provider="p1", platform="desktop", is_first_turn=True)
    rec.on_pre_api_request(session_id="s1", turn_id="t1", api_request_id="a1", model="m1",
                           provider="p1", api_call_count=1, started_at=now)
    rec.on_post_api_request(session_id="s1", turn_id="t1", api_request_id="a1",
                            usage={"prompt_tokens": 100, "completion_tokens": 20},
                            api_duration=1.25, finish_reason="tool_calls")
    rec.on_pre_tool_call(session_id="s1", turn_id="t1", tool_call_id="c1", tool_name="terminal",
                         args={"command": "ls -la"})
    rec.on_post_tool_call(session_id="s1", turn_id="t1", tool_call_id="c1", tool_name="terminal",
                          result="ok", status="ok", duration_ms=120)
    rec.on_subagent_start(parent_session_id="s1", parent_turn_id="t1",
                          child_session_id="child1", child_subagent_id="sub1",
                          child_role="researcher", child_goal="find the thing")
    # A child runs as its own agent: its tool call arrives on the child's session, empty turn.
    rec.on_pre_tool_call(session_id="child1", turn_id="", task_id="child-task",
                         tool_call_id="c2", tool_name="read_file", args={"path": "/x"})
    rec.on_post_tool_call(session_id="child1", turn_id="", task_id="child-task",
                          tool_call_id="c2", tool_name="read_file", result="data",
                          status="ok", duration_ms=30)
    rec.on_subagent_stop(parent_session_id="s1", parent_turn_id="t1",
                         child_session_id="child1", child_subagent_id="sub1",
                         status="completed", child_summary="found it", duration_ms=900)
    rec.on_post_llm_call(session_id="s1", turn_id="t1", assistant_response="done", model="m1")
    drain(rec)

    spans = spans_of(tmp_path, "tr_t1")
    by_kind = {}
    for span in spans:
        by_kind.setdefault(span["kind"], []).append(span)
    assert {s["status"] for s in spans} == {"ok"}, "every span must be closed, none left running"

    turn = by_kind["turn"][0]
    assert turn["id"] == "sp_t1"
    assert turn["parent_id"] is None
    assert turn["depth"] == 0

    api = span_by_id(spans, "sp_api_a1")
    assert api["parent_id"] == turn["id"]
    assert api["depth"] == 1
    assert api["tokens"] == {"input": 100, "output": 20, "cache_read": 0,
                             "cache_write": 0, "reasoning": 0}
    assert api["meta"]["finish_reason"] == "tool_calls"

    tool = span_by_id(spans, "sp_tool_c1")
    assert tool["parent_id"] == turn["id"]
    assert tool["duration_ms"] == 120

    sub = span_by_id(spans, "sp_sub_sub1")
    assert sub["parent_id"] == turn["id"]
    assert sub["meta"]["goal"] == "find the thing"

    # The headline: the child's own tool call hangs off the subagent, not the turn.
    child_tool = span_by_id(spans, "sp_tool_c2")
    assert child_tool["parent_id"] == sub["id"]
    assert child_tool["depth"] == 2

    totals = store_mod.load_trace(tmp_path, "tr_t1")["trace"]["totals"]
    assert totals["api_calls"] == 1
    assert totals["tool_calls"] == 2
    assert totals["subagents"] == 1
    assert totals["input_tokens"] == 100


def test_blob_bodies_are_stored_out_of_band_and_redacted(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="s2", turn_id="t2", user_message="hello")
    rec.on_pre_tool_call(session_id="s2", turn_id="t2", tool_call_id="c9", tool_name="terminal",
                         args={"command": "curl -H 'Authorization: Bearer abcdefghijklmnop1234' x"})
    rec.on_post_tool_call(session_id="s2", turn_id="t2", tool_call_id="c9", tool_name="terminal",
                          result="ok", status="ok", duration_ms=5)
    rec.on_post_llm_call(session_id="s2", turn_id="t2", assistant_response="hi")
    drain(rec)

    span = span_by_id(spans_of(tmp_path, "tr_t2"), "sp_tool_c9")
    blob = store_mod.load_blob(tmp_path, span["args_ref"], trace_id="tr_t2")
    assert blob is not None
    # Read the decoded string, not a re-dump: json.dumps escapes the «guillemets» to \u00ab.
    text = blob["body"]["command"]
    assert "«redacted:" in text
    assert "abcdefghijklmnop1234" not in text
    assert blob["redactions"] >= 1


def test_metadata_mode_stores_no_content(rec_factory, tmp_path: Path):
    rec = rec_factory("metadata")
    rec.on_pre_llm_call(session_id="s3", turn_id="t3", user_message="secret words here")
    rec.on_pre_tool_call(session_id="s3", turn_id="t3", tool_call_id="c3", tool_name="terminal",
                         args={"command": "echo secret"})
    rec.on_post_tool_call(session_id="s3", turn_id="t3", tool_call_id="c3", tool_name="terminal",
                          result="out", status="ok", duration_ms=1)
    rec.on_post_llm_call(session_id="s3", turn_id="t3", assistant_response="answer")
    drain(rec)

    blob = store_mod.load_blob(tmp_path, "bl_sp_tool_c3_args", trace_id="tr_t3")
    assert blob is not None
    assert blob["body"]["omitted"] is True
    assert "secret" not in json.dumps(blob["body"])
    # Structure survives even when content does not.
    assert blob["body"]["type"] == "json"
    assert "command" in blob["body"]["keys"]


# ── failure modes ────────────────────────────────────────────────────────────────────────────
def test_close_before_open_synthesises_a_closed_span(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="s4", turn_id="t4", user_message="x")
    # No pre_tool_call: only the completion arrives (a native runtime emitted one callback).
    rec.on_post_tool_call(session_id="s4", turn_id="t4", tool_call_id="orphan", tool_name="terminal",
                          result="out", status="ok", duration_ms=7)
    rec.on_post_llm_call(session_id="s4", turn_id="t4", assistant_response="y")
    drain(rec)

    span = span_by_id(spans_of(tmp_path, "tr_t4"), "sp_tool_orphan")
    assert span["status"] == "ok"
    assert span["meta"]["correlation"] == "degraded"
    assert span["duration_ms"] == 7


def test_missing_turn_id_uses_synthetic_ids_not_one_span(rec: rec_mod.Recorder, tmp_path: Path):
    """Empty turn_id must not collapse every call into a single span."""
    rec.on_pre_llm_call(session_id="s5", turn_id="", user_message="x")
    for i in (1, 2):
        rec.on_pre_tool_call(session_id="s5", turn_id="", tool_call_id="", tool_name=f"tool{i}",
                             args={"i": i})
        rec.on_post_tool_call(session_id="s5", turn_id="", tool_call_id="", tool_name=f"tool{i}",
                              result="r", status="ok", duration_ms=1)
    rec.on_post_llm_call(session_id="s5", turn_id="", assistant_response="y")
    drain(rec)

    spans = spans_of(tmp_path, "tr_anon-s5")
    tools = [s for s in spans if s["kind"] == "tool"]
    assert len(tools) == 2, f"expected two distinct spans, got {[s['id'] for s in tools]}"
    assert {t["meta"].get("correlation") for t in tools} == {"degraded"}


def test_stale_sweep_closes_a_turn_that_never_ended(rec: rec_mod.Recorder, tmp_path: Path):
    """A crashed turn must still be inspectable afterwards, not lost with the process."""
    rec.on_pre_llm_call(session_id="s6", turn_id="t6", user_message="x")
    rec.on_pre_tool_call(session_id="s6", turn_id="t6", tool_call_id="never", tool_name="terminal",
                         args={"command": "sleep 999"})
    # Neither the tool completion nor post_llm_call ever arrives: the turn died mid-flight.
    aged = time.time() - rec_mod.STALE_AFTER_S - 5
    with rec._lock:
        rec._traces["t6"].started_at = aged
        for span in rec._spans.values():
            if span.status == "running":
                span.started_at = aged
    rec._sweep_stale()
    drain(rec)

    payload = store_mod.load_trace(tmp_path, "tr_t6")
    assert payload is not None
    assert payload["trace"]["status"] == "cancelled"
    assert payload["trace"]["stale"] is True

    span = span_by_id(payload["spans"], "sp_tool_never")
    assert span["status"] == "cancelled"
    assert span["meta"]["stale"] is True
    assert span["duration_ms"] is None, "an unknown duration must not be invented"


def test_interrupted_session_closes_the_trace(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="s7", turn_id="t7", user_message="x")
    rec.on_session_end(session_id="s7", interrupted=True)
    drain(rec)
    payload = store_mod.load_trace(tmp_path, "tr_t7")
    assert payload["trace"]["status"] == "interrupted"
    assert all(s["status"] == "cancelled" for s in payload["spans"])


def test_hook_error_is_contained(rec: rec_mod.Recorder, tmp_path: Path):
    """A handler must swallow its own exceptions: telemetry may never break a turn."""
    rec.on_pre_llm_call(session_id="s8", turn_id="t8", user_message="x")
    rec.on_post_tool_call(session_id="s8", turn_id="t8", tool_call_id=object(),  # type: ignore[arg-type]
                          tool_name="terminal", result=None, status="ok")
    rec.on_post_llm_call(session_id="s8", turn_id="t8", assistant_response="y")
    drain(rec)
    assert store_mod.load_trace(tmp_path, "tr_t8") is not None


def test_full_queue_drops_and_counts_rather_than_blocking(tmp_path: Path):
    """Telemetry must never stall a turn: a full queue drops and counts instead."""
    rec = rec_mod.Recorder(tmp_path, queue_max=1)
    rec.on_pre_llm_call(session_id="s9", turn_id="t9", user_message="x")   # fills the queue
    rec._stopping.set()                 # stop the writer so nothing drains
    for i in range(50):
        rec.on_pre_tool_call(session_id="s9", turn_id="t9", tool_call_id=f"c{i}",
                             tool_name="t", args={"i": i})
    assert rec.dropped > 0
    assert rec.status()["dropped"] == rec.dropped
    rec._stopping.clear()
    rec.shutdown()


# ── store read paths ────────────────────────────────────────────────────────────────────────
def test_store_lists_loads_and_clears(rec: rec_mod.Recorder, tmp_path: Path):
    for n in (1, 2):
        rec.on_pre_llm_call(session_id="sl", turn_id=f"tt{n}", user_message=f"m{n}")
        rec.on_post_llm_call(session_id="sl", turn_id=f"tt{n}", assistant_response="r")
    rec.on_pre_llm_call(session_id="other", turn_id="tt3", user_message="m3")
    rec.on_post_llm_call(session_id="other", turn_id="tt3", assistant_response="r")
    drain(rec)

    everything = store_mod.list_traces(tmp_path)
    assert len(everything) == 3
    assert everything == sorted(everything, key=lambda t: t["started_at"], reverse=True)

    one_session = store_mod.list_traces(tmp_path, session_id="sl")
    assert {t["turn_id"] for t in one_session} == {"tt1", "tt2"}

    assert store_mod.list_traces(tmp_path, limit=1)[0]["turn_id"] == "tt3"
    assert store_mod.load_trace(tmp_path, "tr_nope") is None
    assert store_mod.load_blob(tmp_path, "bl_nope") is None

    freed = store_mod.clear_store(tmp_path)
    assert freed["files"] >= 1
    assert store_mod.list_traces(tmp_path) == []


def test_torn_final_line_is_skipped_not_fatal(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="st", turn_id="torn", user_message="x")
    rec.on_post_llm_call(session_id="st", turn_id="torn", assistant_response="y")
    drain(rec)

    shard = next((tmp_path / "traces").rglob("*.jsonl"))
    with shard.open("a", encoding="utf-8") as fh:
        fh.write('{"record":"span","id":"truncated"')      # no newline, no closing brace
    assert store_mod.load_trace(tmp_path, "tr_torn") is not None
    assert len(store_mod.list_traces(tmp_path)) == 1


def test_status_file_roundtrip(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="sx", turn_id="tx", user_message="x")
    rec.on_post_llm_call(session_id="sx", turn_id="tx", assistant_response="y")
    drain(rec)
    rec._write_status()
    status = store_mod.read_status(tmp_path)
    assert status is not None
    assert status["capture_mode"] == "sanitized"
    assert status["telemetry_schema_version"] == rec_mod.TELEMETRY_SCHEMA_VERSION
    assert status["spans_recorded"] >= 1   # the turn's own span is the only one a bare turn closes
    assert status["status_age_s"] >= 0


def test_live_tail_returns_only_new_records(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="sv", turn_id="tv", user_message="x")
    rec.on_post_llm_call(session_id="sv", turn_id="tv", assistant_response="y")
    drain(rec)

    cursor = store_mod.tail_state(tmp_path)
    assert store_mod.tail_since(tmp_path, cursor) == []

    rec.on_pre_llm_call(session_id="sv", turn_id="tw", user_message="x2")
    rec.on_post_llm_call(session_id="sv", turn_id="tw", assistant_response="y2")
    drain(rec)
    fresh = store_mod.tail_since(tmp_path, cursor)
    assert [r["record"] for r in fresh if r["record"] == "trace"]
    assert all(r.get("turn_id") != "tv" for r in fresh if r["record"] == "trace")


def test_retention_prunes_oldest_first(rec_factory, tmp_path: Path):
    rec = rec_factory("metadata", retention_mb=1, retention_traces=1)
    for n in range(3):
        rec.on_pre_llm_call(session_id=f"sd{n}", turn_id=f"td{n}", user_message="x")
        rec.on_post_llm_call(session_id=f"sd{n}", turn_id=f"td{n}", assistant_response="y")
        drain(rec)
        time.sleep(0.01)
        rec._prune_retention()
    remaining = {p.stat().st_mtime for p in (tmp_path / "traces").rglob("*.jsonl")}
    assert len(remaining) <= 1, "retention.traces=1 must leave at most one shard"


def test_span_ids_are_stable_and_scheme_compliant(rec: rec_mod.Recorder, tmp_path: Path):
    rec.on_pre_llm_call(session_id="si", turn_id="ti", user_message="x")
    rec.on_pre_api_request(session_id="si", turn_id="ti", api_request_id="ai", model="m",
                           provider="p", started_at=time.time())
    rec.on_post_api_request(session_id="si", turn_id="ti", api_request_id="ai", usage={},
                            api_duration=0.5)
    rec.on_post_llm_call(session_id="si", turn_id="ti", assistant_response="y")
    drain(rec)

    ids = {s["id"] for s in spans_of(tmp_path, "tr_ti")}
    assert ids == {"sp_ti", "sp_api_ai"}
    for span_id in ids:
        assert re.fullmatch(r"sp_[A-Za-z0-9._:\-]+", span_id), span_id


def test_cost_is_null_and_the_core_import_skippable(monkeypatch):
    """Rule 9 warns about the pricing import; a user must be able to switch it off completely.

    And a cost that cannot be resolved is ``None``, never ``0.0``: a fabricated zero would read as
    "this turn was free".
    """
    monkeypatch.setenv("AGENT_TRACE_PRICING", "off")
    assert rec_mod._pricing_enabled() is False
    usage = {"input": 100, "output": 10, "cache_read": 0, "cache_write": 0, "reasoning": 0}
    assert rec_mod._cost_for("some-model", usage, "openai", "") is None

    monkeypatch.delenv("AGENT_TRACE_PRICING", raising=False)
    assert rec_mod._pricing_enabled() is True

    for value in ("0", "false", "no", "OFF", " off "):
        monkeypatch.setenv("AGENT_TRACE_PRICING", value)
        assert rec_mod._pricing_enabled() is False, value