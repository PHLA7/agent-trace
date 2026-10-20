"""agent-trace recorder — observer hooks to a span model to a local JSONL store.

Design rules taken from Hermes' own observer-hook contract
(``website/docs/developer-guide/observer-hooks.md``):

- Hooks do no file I/O and hold no locks. They serialise an event and ``put_nowait`` it onto a
  bounded queue; a daemon writer thread drains it. A full queue drops and counts, because stalling
  a user's turn is never an acceptable way to record telemetry.
- Callbacks are fail-open. Every handler swallows its own exceptions.
- Only the hooks this plugin consumes are registered, so core does not build payloads nobody reads.

The span model is frozen in ``docs/SPEC.md``.
"""

from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

TELEMETRY_SCHEMA_VERSION = "hermes.observer.v1"

DEFAULT_CAPTURE_MODE = "sanitized"
DEFAULT_QUEUE_MAX = 10000
DEFAULT_RETENTION_TRACES = 200
DEFAULT_RETENTION_MB = 50
STALE_AFTER_S = 60.0

MAX_FIELD_CHARS = 12000
MAX_DEPTH = 4
MAX_ITEMS = 50
MAX_FILES = 50

CAPTURE_MODES = ("metadata", "sanitized", "full")

# ── redaction ────────────────────────────────────────────────────────────────────────────────
# Pattern-based defence in depth, not a DLP guarantee. Mirrors the capture-mode design of the
# official langfuse plugin (metadata / sanitized / full) so the two behave alike.
_REDACTIONS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pem", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b")),
    ("openai", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b")),
    ("slack", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("aws", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{12,}")),
)

# Key-name/value assignments: keep the name (it is useful context), redact only the value.
_ASSIGN_VALUE_RE = re.compile(
    r"(?i)\b(api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|"
    r"client[_-]?secret|private[_-]?key)\b\s*[:=]\s*[\"']?([^\s\"',}]{6,})")


def redact(text: str) -> tuple[str, int]:
    """Replace secret-shaped runs with ``«redacted:kind»``. Returns ``(text, count)``."""
    if not text:
        return text, 0
    count = 0
    for kind, pattern in _REDACTIONS:
        text, n = pattern.subn(f"«redacted:{kind}»", text)
        count += n
    text, n = _ASSIGN_VALUE_RE.subn(lambda m: f"{m.group(1)}=«redacted:assign»", text)
    return text, count + n


def _truncate(value: Any, *, depth: int = 0) -> tuple[Any, bool]:
    """Bound a JSON-ish value by depth, per-field chars and collection items."""
    if depth > MAX_DEPTH:
        return "<max-depth>", True
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        clipped = False
        for i, (k, v) in enumerate(value.items()):
            if i >= MAX_ITEMS:
                out["<more>"] = len(value) - MAX_ITEMS
                clipped = True
                break
            cv, c = _truncate(v, depth=depth + 1)
            out[str(k)] = cv
            clipped = clipped or c
        return out, clipped
    if isinstance(value, (list, tuple)):
        out_list = []
        clipped = False
        for i, v in enumerate(value):
            if i >= MAX_ITEMS:
                out_list.append(f"<{len(value) - MAX_ITEMS} more>")
                clipped = True
                break
            cv, c = _truncate(v, depth=depth + 1)
            out_list.append(cv)
            clipped = clipped or c
        return out_list, clipped
    if isinstance(value, str):
        if len(value) > MAX_FIELD_CHARS:
            return value[:MAX_FIELD_CHARS], True
        return value, False
    if value is None or isinstance(value, (int, float, bool)):
        return value, False
    return str(value)[:MAX_FIELD_CHARS], False


def _pricing_enabled() -> bool:
    """Whether cost estimation may import Hermes' pricing module at all.

    ``AGENT_TRACE_PRICING=off`` exists so a user who objects to a plugin reading core internals can
    have this plugin touch none of them, at the price of ``cost_usd`` reporting as ``null``.
    """
    return (os.environ.get("AGENT_TRACE_PRICING") or "").strip().lower() not in (
        "off", "0", "false", "no")


def _cost_for(model: str, usage: dict[str, int], provider: str, base_url: str) -> Optional[float]:
    """Cost via Hermes' own pricing tables. ``None`` when unknown — never a fabricated zero.

    This imports a core module, which admission rule 9 warns about without failing. It is the same
    trade the official langfuse plugin makes, and the alternative is inventing numbers. Disable it
    entirely with ``AGENT_TRACE_PRICING=off``.
    """
    if not _pricing_enabled():
        return None
    try:
        from agent.usage_pricing import estimate_usage_cost, normalize_usage
    except Exception:
        return None
    if not model:
        return None
    try:
        canonical = normalize_usage(
            {
                "input_tokens": usage.get("input", 0),
                "output_tokens": usage.get("output", 0),
                "cache_read_input_tokens": usage.get("cache_read", 0),
                "cache_creation_input_tokens": usage.get("cache_write", 0),
                "output_tokens_details": {"reasoning_tokens": usage.get("reasoning", 0)},
            },
            provider=provider or None,
        )
        result = estimate_usage_cost(model, canonical, provider=provider or None,
                                     base_url=base_url or None)
    except Exception:
        return None
    if result is None:
        return None
    amount = getattr(result, "amount_usd", None)
    if amount is None or getattr(result, "status", "") == "unknown":
        return None
    try:
        return float(amount)
    except Exception:
        return None


def _tokens_from_usage(usage: Any) -> dict[str, int]:
    """Canonicalise a provider usage dict into the five buckets, provider-agnostically."""
    if not isinstance(usage, dict):
        return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0}

    def pick(*paths: tuple[str, ...]) -> int:
        for path in paths:
            cur: Any = usage
            for key in path:
                if not isinstance(cur, dict):
                    cur = None
                    break
                cur = cur.get(key)
            if isinstance(cur, (int, float)) and cur:
                return int(cur)
        return 0

    input_tokens = pick(("input_tokens",), ("prompt_tokens",))
    output_tokens = pick(("output_tokens",), ("completion_tokens",))
    cache_read = pick(("cache_read_input_tokens",), ("prompt_tokens_details", "cached_tokens"),
                      ("prompt_cache_hit_tokens",), ("cached_tokens",))
    cache_write = pick(("cache_creation_input_tokens",), ("prompt_tokens_details", "cache_write_tokens"),
                       ("prompt_tokens_details", "cache_creation_input_tokens"), ("cache_write_tokens",))
    reasoning = pick(("output_tokens_details", "reasoning_tokens"),
                     ("completion_tokens_details", "reasoning_tokens"), ("reasoning_tokens",))
    # OpenAI-style totals include the cache buckets; subtract them back out to match core.
    if pick(("prompt_tokens",)) and input_tokens == pick(("prompt_tokens",)):
        input_tokens = max(0, input_tokens - cache_read - cache_write)
    return {"input": input_tokens, "output": output_tokens, "cache_read": cache_read,
            "cache_write": cache_write, "reasoning": reasoning}


@dataclass
class Span:
    id: str
    trace_id: str
    kind: str
    name: str
    parent_id: Optional[str] = None
    started_at: float = 0.0
    ended_at: Optional[float] = None
    status: str = "running"
    depth: int = 0
    meta: dict[str, Any] = field(default_factory=dict)
    tokens: dict[str, int] = field(default_factory=dict)
    cost_usd: Optional[float] = None
    args_ref: Optional[str] = None
    result_ref: Optional[str] = None
    error: Optional[dict[str, str]] = None

    def duration_ms(self) -> Optional[int]:
        if self.ended_at is None:
            return None
        return int(round((self.ended_at - self.started_at) * 1000))

    def to_json(self) -> dict[str, Any]:
        out = dict(self.__dict__)
        out["duration_ms"] = self.duration_ms()
        return out


@dataclass
class Trace:
    id: str
    session_id: str
    turn_id: str
    profile: str = ""
    platform: str = ""
    model: str = ""
    provider: str = ""
    base_url: str = ""
    user_message: Optional[str] = None
    started_at: float = 0.0
    ended_at: Optional[float] = None
    status: str = "running"
    capture_mode: str = DEFAULT_CAPTURE_MODE
    root: str = ""
    stale: bool = False
    totals: dict[str, Any] = field(default_factory=lambda: {
        "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
        "cache_write_tokens": 0, "reasoning_tokens": 0, "cost_usd": None,
        "api_calls": 0, "tool_calls": 0, "subagents": 0,
    })

    def to_json(self) -> dict[str, Any]:
        out = dict(self.__dict__)
        out["duration_ms"] = (None if self.ended_at is None
                              else int(round((self.ended_at - self.started_at) * 1000)))
        out["telemetry_schema_version"] = TELEMETRY_SCHEMA_VERSION
        return out


class Recorder:
    """Accumulates spans from observer hooks and drains them to disk off the agent's thread."""

    def __init__(self, data_dir: Path, *, capture_mode: str = DEFAULT_CAPTURE_MODE,
                 queue_max: int = DEFAULT_QUEUE_MAX,
                 retention_traces: int = DEFAULT_RETENTION_TRACES,
                 retention_mb: int = DEFAULT_RETENTION_MB) -> None:
        self.data_dir = Path(data_dir)
        self.capture_mode = capture_mode if capture_mode in CAPTURE_MODES else DEFAULT_CAPTURE_MODE
        self.retention_traces = int(retention_traces)
        self.retention_mb = int(retention_mb)
        self._queue: queue.Queue[tuple[str, dict, str]] = queue.Queue(maxsize=int(queue_max))
        self._traces: dict[str, Trace] = {}
        self._spans: dict[str, Span] = {}
        self._session_turn: dict[str, str] = {}      # session_id -> active turn/trace id
        self._child_session: dict[str, str] = {}     # child_session_id -> subagent span id
        self._task_parent: dict[str, str] = {}       # child task_id -> subagent span id
        self._lock = threading.RLock()
        self._subscribers: list[queue.Queue] = []
        self.spans_recorded = 0
        self.dropped = 0
        self._stopping = threading.Event()
        self._writer = threading.Thread(target=self._drain, name="agent-trace-writer", daemon=True)
        self._writer.start()

    # ── plumbing ───────────────────────────────────────────────────────────────────────────
    def _now(self) -> float:
        return time.time()

    def _enqueue(self, kind: str, record: dict, session_id: str) -> None:
        # One shard per session per day holds every record kind; a `record` discriminator is what
        # makes blob lookup a single-file read instead of a store-wide scan.
        record.setdefault("record", kind)
        try:
            self._queue.put_nowait((kind, record, session_id or "_unknown"))
        except queue.Full:
            self.dropped += 1

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _publish(self, frame: dict) -> None:
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(frame)
            except queue.Full:
                pass

    def status(self) -> dict[str, Any]:
        return {
            "enabled": True,
            "capture_mode": self.capture_mode,
            "telemetry_schema_version": TELEMETRY_SCHEMA_VERSION,
            "spans_recorded": self.spans_recorded,
            "dropped": self.dropped,
            "open_spans": len([s for s in self._spans.values() if s.status == "running"]),
            "store_bytes": _dir_bytes(self.data_dir),
            "retention": {"traces": self.retention_traces, "mb": self.retention_mb},
            "queue_depth": self._queue.qsize(),
        }

    def shutdown(self) -> None:
        """Flush what is queued without letting a stalled writer hold process teardown."""
        self._stopping.set()
        deadline = time.time() + 2.0
        while self._queue.unfinished_tasks and time.time() < deadline:
            time.sleep(0.05)

    # ── capture ────────────────────────────────────────────────────────────────────────────
    def _blob_id(self, span_id: str, field_name: str) -> str:
        return f"bl_{span_id}_{field_name}"

    def _capture(self, trace: Trace, span: Span, field_name: str, value: Any) -> Optional[str]:
        """Store a payload out of band and return its blob id (or None when nothing to store)."""
        if value is None or value == "" or value == {} or value == []:
            return None
        blob_id = self._blob_id(span.id, field_name)
        encoding = "json" if isinstance(value, (dict, list, tuple)) else "text"

        if self.capture_mode == "metadata":
            if encoding == "json":
                shape: Any = {"omitted": True, "type": "json",
                              "keys": sorted(str(k) for k in value)[:MAX_ITEMS]} if isinstance(value, dict) \
                    else {"omitted": True, "type": "json", "items": len(value)}
            else:
                shape = {"omitted": True, "type": "text", "chars": len(str(value))}
            body: Any = shape
            chars = len(json.dumps(shape))
            redactions = 0
            truncated = False
        else:
            bounded, truncated = _truncate(value)
            if self.capture_mode == "sanitized":
                text = json.dumps(bounded, ensure_ascii=False, default=str)
                text, redactions = redact(text)
                if encoding == "json":
                    try:
                        body = json.loads(text)
                    except Exception:
                        body = text
                else:
                    body = text
                chars = len(text)
            else:  # full
                body = bounded
                chars = len(json.dumps(bounded, ensure_ascii=False, default=str))
                redactions = 0

        self._enqueue("blob", {
            "id": blob_id, "trace_id": trace.id, "span_id": span.id, "field": field_name,
            "encoding": encoding, "chars": chars, "truncated": bool(truncated),
            "redactions": redactions, "captured_at": self._now(), "body": body,
        }, trace.session_id)
        return blob_id

    # ── span bookkeeping ───────────────────────────────────────────────────────────────────
    def _anon_span_id(self, prefix: str, session_id: str) -> str:
        with self._lock:
            n = len(self._spans)
        return f"sp_{prefix}_anon_{session_id or 's'}_{n}"

    def _active_turn(self, session_id: str) -> Optional[str]:
        with self._lock:
            return self._session_turn.get(session_id or "")

    def _open_span(self, trace: Trace, span: Span) -> Span:
        parent_depth = 0
        with self._lock:
            if span.parent_id and (parent := self._spans.get(span.parent_id)):
                parent_depth = parent.depth
            elif span.parent_id is None:
                span.parent_id = None
            span.depth = parent_depth + 1
            self._spans[span.id] = span
        self._publish({"type": "span.start", "trace": trace.to_json(), "span": span.to_json()})
        return span

    def _close_span(self, span: Span, *, status: str, trace: Optional[Trace] = None) -> None:
        # A span the stale sweep closed keeps its unknown end: we know it ran, we do not know for
        # how long, and a duration invented from "when we gave up" would be a fabrication.
        if span.ended_at is None and not span.meta.get("stale"):
            span.ended_at = self._now()
        span.status = status
        if trace is not None:
            self._publish({"type": "span.end", "trace": trace.to_json(), "span": span.to_json()})
            self._enqueue("span", span.to_json(), trace.session_id)

    def _parent_for_child(self, *, session_id: str, task_id: str, turn_id: str,
                          trace: Trace) -> Optional[str]:
        """Attach a nested event to its subagent when it belongs to a child agent."""
        with self._lock:
            if task_id and task_id in self._task_parent:
                return self._task_parent[task_id]
            if session_id and session_id in self._child_session:
                return self._child_session[session_id]
        return trace.root

    # ── trace lifecycle ────────────────────────────────────────────────────────────────────
    def _trace_for(self, *, session_id: str, turn_id: str, create: bool = True,
                   task_id: str = "") -> Optional[Trace]:
        """Resolve the trace an event belongs to.

        A subagent runs as its own agent on its own session, so its tool calls, API attempts and
        nested children arrive with the *child's* identifiers and no trace of their own. Those
        events belong to the subagent's parent trace, reached through the subagent span. Without
        this fallback a child's tool calls would be silently dropped, which would defeat the point
        of the delegation tree.
        """
        key = turn_id or f"anon-{session_id}"
        with self._lock:
            existing = self._traces.get(key)
            if existing is not None:
                return existing
            if not create:
                parent_span_id = self._subagent_span_id(session_id, task_id)
                if parent_span_id:
                    span = self._spans.get(parent_span_id)
                    if span is not None:
                        for trace in self._traces.values():
                            if trace.id == span.trace_id:
                                return trace
                return None
            trace = Trace(
                id=f"tr_{key}", session_id=session_id or "", turn_id=turn_id or "",
                started_at=self._now(), capture_mode=self.capture_mode, root=f"sp_{key}",
            )
            self._traces[key] = trace
            self._session_turn[session_id or ""] = key
            root = Span(id=trace.root, trace_id=trace.id, kind="turn", name="turn",
                        parent_id=None, started_at=trace.started_at, depth=0)
            self._spans[root.id] = root
        self._publish({"type": "trace.start", "trace": trace.to_json()})
        return trace

    def _newest_running_span(self, trace_id: str, *, kind: str) -> Optional[Span]:
        """The most recently started still-open span of a kind, used when an id is missing.

        A completion whose call id is empty (or a provider that reused one) must close the span
        that is actually open rather than opening a fresh duplicate: two spans for one call reads
        as a wrong tree, which is worse than a degraded one.
        """
        with self._lock:
            candidates = [s for s in self._spans.values()
                          if s.trace_id == trace_id and s.kind == kind and s.status == "running"]
        if not candidates:
            return None
        return max(candidates, key=lambda s: s.started_at)

    def _subagent_span_id(self, session_id: str, task_id: str) -> Optional[str]:
        """The subagent span a child-session event belongs to, if any."""
        with self._lock:
            if session_id and session_id in self._child_session:
                return self._child_session[session_id]
            if task_id and task_id in self._task_parent:
                return self._task_parent[task_id]
        return None

    def _finish_trace(self, trace: Trace, status: str) -> None:
        with self._lock:
            if trace.ended_at is None:
                trace.ended_at = self._now()
            trace.status = status
            # Close anything still open, so a crashed child never renders as forever-busy. The turn's
            # own span takes the trace's outcome; everything else left open was abandoned, so it is
            # cancelled rather than reported as a success the trace never reached.
            root_status = "ok" if status == "ok" else "cancelled"
            for span in list(self._spans.values()):
                if span.trace_id != trace.id or span.status != "running":
                    continue
                self._close_span(span, status=root_status if span.id == trace.root else "cancelled",
                                 trace=trace)
            self._enqueue("trace", trace.to_json(), trace.session_id)
            self._session_turn.pop(trace.session_id, None)
        self._publish({"type": "trace.end", "trace": trace.to_json()})

    # ── hooks ──────────────────────────────────────────────────────────────────────────────
    def on_pre_llm_call(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=kw.get("turn_id") or "")
            if trace is None:
                return
            with self._lock:
                root = self._spans.get(trace.root)
            if root is None:
                return
            trace.model = trace.model or (kw.get("model") or "")
            trace.provider = trace.provider or (kw.get("provider") or "")
            trace.platform = trace.platform or (kw.get("platform") or "")
            root.meta.update({
                "is_first_turn": bool(kw.get("is_first_turn")),
                "conversation_length": _safe_len(kw.get("conversation_history")),
            })
            if trace.user_message is None:
                msg = kw.get("user_message")
                trace.user_message = (str(msg)[:500] if msg else None)
                ref = self._capture(trace, root, "args", msg) if msg else None
                if ref:
                    root.args_ref = ref
        except Exception:
            pass

    def on_post_llm_call(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=kw.get("turn_id") or "",
                                    create=False)
            if trace is None:
                return
            with self._lock:
                root = self._spans.get(trace.root)
            if root is not None and kw.get("assistant_response"):
                ref = self._capture(trace, root, "result", kw.get("assistant_response"))
                if ref:
                    root.result_ref = ref
            trace.model = trace.model or (kw.get("model") or "")
            self._finish_trace(trace, "ok")
        except Exception:
            pass

    def on_pre_tool_call(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_id = kw.get("turn_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=turn_id, create=False)
            if trace is None:
                return
            call_id = kw.get("tool_call_id") or ""
            degraded = not (call_id and turn_id)
            span_id = f"sp_tool_{call_id}" if call_id else self._anon_span_id("tool", session_id)
            parent = self._parent_for_child(session_id=session_id, task_id=kw.get("task_id") or "",
                                            turn_id=turn_id, trace=trace)
            span = Span(id=span_id, trace_id=trace.id, kind="tool", name=kw.get("tool_name") or "tool",
                        parent_id=parent, started_at=self._now())
            if degraded:
                span.meta["correlation"] = "degraded"
            with self._lock:
                if span_id in self._spans:  # provider reused a call id; keep the newest
                    self._spans[span_id] = span
                else:
                    self._spans[span_id] = span
            self._open_span(trace, span)
            ref = self._capture(trace, span, "args", kw.get("args"))
            if ref:
                span.args_ref = ref
        except Exception:
            pass

    def on_post_tool_call(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_id = kw.get("turn_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=turn_id, create=False)
            if trace is None:
                return
            call_id = kw.get("tool_call_id") or ""
            with self._lock:
                span = self._spans.get(f"sp_tool_{call_id}") if call_id else None
                if span is not None and span.status != "running":
                    span = None
                if span is None:
                    # An id-less completion closes the span that is genuinely open; only a
                    # completion with nothing open at all gets a synthesised one, marked degraded.
                    span = self._newest_running_span(trace.id, kind="tool")
                if span is None:
                    span_id = f"sp_tool_{call_id}" if call_id else self._anon_span_id("tool", session_id)
                    span = Span(id=span_id, trace_id=trace.id, kind="tool",
                                name=kw.get("tool_name") or "tool",
                                parent_id=self._parent_for_child(
                                    session_id=session_id, task_id=kw.get("task_id") or "",
                                    turn_id=turn_id, trace=trace),
                                started_at=self._now(), meta={"correlation": "degraded"})
                    self._spans[span.id] = span
            duration_ms = kw.get("duration_ms")
            if isinstance(duration_ms, (int, float)) and duration_ms >= 0:
                span.ended_at = span.started_at + (duration_ms / 1000.0)
            ref = self._capture(trace, span, "result", kw.get("result"))
            if ref:
                span.result_ref = ref
            span.meta["tool_name"] = span.name
            if kw.get("error_type"):
                span.error = {"type": str(kw.get("error_type")),
                              "message": str(kw.get("error_message") or "")[:500]}
            if kw.get("middleware_trace"):
                span.meta["middleware_trace_len"] = _safe_len(kw.get("middleware_trace"))
            self._close_span(span, status=str(kw.get("status") or "ok"), trace=trace)
            trace.totals["tool_calls"] += 1
        except Exception:
            pass

    def on_pre_api_request(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=kw.get("turn_id") or "",
                                    create=False)
            if trace is None:
                return
            req_id = kw.get("api_request_id") or ""
            span_id = f"sp_api_{req_id}" if req_id else self._anon_span_id("api", session_id)
            span = Span(id=span_id, trace_id=trace.id, kind="llm",
                        name=kw.get("model") or "llm",
                        parent_id=self._parent_for_child(session_id=session_id,
                                                         task_id=kw.get("task_id") or "",
                                                         turn_id=kw.get("turn_id") or "",
                                                         trace=trace),
                        started_at=float(kw.get("started_at") or self._now()))
            span.meta.update({
                "api_call_count": kw.get("api_call_count"), "retry_count": kw.get("retry_count"),
                "message_count": kw.get("message_count"), "tool_count": kw.get("tool_count"),
                "approx_input_tokens": kw.get("approx_input_tokens"),
                "request_chars": kw.get("request_char_count"),
                "model": kw.get("model"), "provider": kw.get("provider"),
                "base_url": kw.get("base_url"), "api_mode": kw.get("api_mode"),
            })
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            trace.model = trace.model or (kw.get("model") or "")
            trace.provider = trace.provider or (kw.get("provider") or "")
            self._open_span(trace, span)
            ref = self._capture(trace, span, "args", kw.get("request"))
            if ref:
                span.args_ref = ref
        except Exception:
            pass

    def on_post_api_request(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=kw.get("turn_id") or "",
                                    create=False)
            if trace is None:
                return
            req_id = kw.get("api_request_id") or ""
            with self._lock:
                span = self._spans.get(f"sp_api_{req_id}") if req_id else None
                if span is not None and span.status != "running":
                    span = None
                if span is None:
                    span = self._newest_running_span(trace.id, kind="llm")
                if span is None:
                    return
            duration = kw.get("api_duration")
            if isinstance(duration, (int, float)) and duration >= 0:
                span.ended_at = span.started_at + float(duration)
            usage = _tokens_from_usage(kw.get("usage"))
            span.tokens = usage
            span.meta["finish_reason"] = kw.get("finish_reason")
            span.meta["response_model"] = kw.get("response_model") or span.meta.get("model")
            span.meta["assistant_content_chars"] = kw.get("assistant_content_chars")
            span.meta["assistant_tool_call_count"] = kw.get("assistant_tool_call_count")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            span.cost_usd = _cost_for(span.meta.get("model") or trace.model, usage,
                                      trace.provider, span.meta.get("base_url") or "")
            ref = self._capture(trace, span, "result", kw.get("response"))
            if ref:
                span.result_ref = ref
            self._close_span(span, status="ok", trace=trace)
            totals = trace.totals
            totals["input_tokens"] += usage["input"]
            totals["output_tokens"] += usage["output"]
            totals["cache_read_tokens"] += usage["cache_read"]
            totals["cache_write_tokens"] += usage["cache_write"]
            totals["reasoning_tokens"] += usage["reasoning"]
            totals["api_calls"] += 1
            if span.cost_usd is not None:
                totals["cost_usd"] = (totals["cost_usd"] or 0.0) + span.cost_usd
        except Exception:
            pass

    def on_api_request_error(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            trace = self._trace_for(session_id=session_id, turn_id=kw.get("turn_id") or "",
                                    create=False)
            if trace is None:
                return
            req_id = kw.get("api_request_id") or ""
            with self._lock:
                span = self._spans.get(f"sp_api_{req_id}") if req_id else None
                if span is not None and span.status != "running":
                    span = None
                if span is None:
                    span = self._newest_running_span(trace.id, kind="llm")
                if span is None:
                    return
            duration = kw.get("api_duration")
            if isinstance(duration, (int, float)) and duration >= 0:
                span.ended_at = span.started_at + float(duration)
            err = kw.get("error") or {}
            if isinstance(err, dict):
                span.error = {"type": str(err.get("type") or "api_error"),
                              "message": str(err.get("message") or "")[:500]}
            span.meta["status_code"] = kw.get("status_code")
            span.meta["retryable"] = kw.get("retryable")
            span.meta["reason"] = kw.get("reason")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            trace.totals["api_calls"] += 1
            self._close_span(span, status="error", trace=trace)
        except Exception:
            pass

    def on_subagent_start(self, **kw: Any) -> None:
        try:
            parent_session = kw.get("parent_session_id") or ""
            turn_id = kw.get("parent_turn_id") or ""
            trace = self._trace_for(session_id=parent_session, turn_id=turn_id, create=False)
            if trace is None:
                return
            sub_id = kw.get("child_subagent_id") or self._anon_span_id("sub", parent_session)
            parent = trace.root
            with self._lock:
                if (psid := kw.get("parent_subagent_id")) and (p := self._child_session.get(psid)):
                    parent = p
                elif (psid := kw.get("parent_subagent_id")) and f"sp_sub_{psid}" in self._spans:
                    parent = f"sp_sub_{psid}"
            span = Span(id=f"sp_sub_{sub_id}", trace_id=trace.id, kind="subagent",
                        name=(kw.get("child_goal") or "subagent")[:200], parent_id=parent,
                        started_at=self._now())
            span.meta["role"] = kw.get("child_role")
            span.meta["goal"] = kw.get("child_goal")
            span.meta["subagent_id"] = kw.get("child_subagent_id")
            span.meta["child_session_id"] = kw.get("child_session_id")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            with self._lock:
                if kw.get("child_session_id"):
                    self._child_session[kw["child_session_id"]] = span.id
            self._open_span(trace, span)
            trace.totals["subagents"] += 1
        except Exception:
            pass

    def on_subagent_stop(self, **kw: Any) -> None:
        try:
            parent_session = kw.get("parent_session_id") or ""
            trace = self._trace_for(session_id=parent_session, turn_id=kw.get("parent_turn_id") or "",
                                    create=False)
            if trace is None:
                return
            sub_id = kw.get("child_subagent_id") or ""
            with self._lock:
                span = self._spans.get(f"sp_sub_{sub_id}") if sub_id else None
                if span is None or span.status != "running":
                    for candidate in self._spans.values():
                        if (candidate.kind == "subagent" and candidate.status == "running"
                                and candidate.meta.get("child_session_id") == kw.get("child_session_id")):
                            span = candidate
                            break
            if span is None or span.status != "running":
                return
            duration = kw.get("duration_ms")
            if isinstance(duration, (int, float)) and duration >= 0:
                span.ended_at = span.started_at + (duration / 1000.0)
            span.meta["status_label"] = kw.get("status")
            span.meta["summary"] = (str(kw.get("child_summary"))[:500]
                                    if kw.get("child_summary") else None)
            history = kw.get("tool_call_history")
            if history is not None:
                bounded, clipped = _truncate(history)
                span.meta["tool_call_history"] = bounded
                if clipped:
                    span.meta["tool_call_history_truncated"] = True
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            status = "ok" if str(kw.get("status") or "").lower() in ("", "completed", "ok", "success") \
                else str(kw.get("status")).lower()
            self._close_span(span, status=status if status in ("ok", "error", "cancelled") else "ok",
                             trace=trace)
        except Exception:
            pass

    def on_pre_approval_request(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_key") or ""
            turn_key = self._active_turn(session_id)
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is None:
                return
            span = Span(id=f"sp_appr_{abs(hash((session_id, kw.get('command'), self._now()))) & 0xFFFFFFFF:x}",
                        trace_id=trace.id, kind="approval",
                        name=(kw.get("command") or "approval")[:200], parent_id=trace.root,
                        started_at=self._now())
            span.meta["surface"] = kw.get("surface")
            span.meta["pattern_keys"] = kw.get("pattern_keys") or kw.get("pattern_key")
            span.meta["description"] = kw.get("description")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            ref = self._capture(trace, span, "args", {"command": kw.get("command"),
                                                      "description": kw.get("description")})
            if ref:
                span.args_ref = ref
            self._open_span(trace, span)
        except Exception:
            pass

    def on_post_approval_response(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_key") or ""
            turn_key = self._active_turn(session_id)
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is None:
                return
            with self._lock:
                span = None
                for candidate in self._spans.values():
                    if (candidate.kind == "approval" and candidate.status == "running"
                            and candidate.trace_id == trace.id):
                        span = candidate
                        break
            if span is None:
                return
            span.meta["choice"] = kw.get("choice")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            choice = str(kw.get("choice") or "").lower()
            status = "ok" if choice in ("once", "session", "always", "approved", "allow") else "blocked"
            self._close_span(span, status=status, trace=trace)
        except Exception:
            pass

    def on_human_input_request(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_key = self._active_turn(session_id) or self._active_turn(kw.get("session_key") or "")
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is None:
                return
            span = Span(id=f"sp_hi_{kw.get('request_id') or self._anon_span_id('hi', session_id)}",
                        trace_id=trace.id, kind="human_input",
                        name=str(kw.get("kind") or "human input"), parent_id=trace.root,
                        started_at=self._now())
            span.meta["kind"] = kw.get("kind")
            span.meta["platform"] = kw.get("platform")
            # prompt is already force-redacted by core (tools/human_input_hooks.py).
            ref = self._capture(trace, span, "args", kw.get("prompt"))
            if ref:
                span.args_ref = ref
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            self._open_span(trace, span)
        except Exception:
            pass

    def on_human_input_resolved(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_key = self._active_turn(session_id) or self._active_turn(kw.get("session_key") or "")
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is None:
                return
            req_id = kw.get("request_id") or ""
            with self._lock:
                span = self._spans.get(f"sp_hi_{req_id}") if req_id else None
                if span is None:
                    for candidate in self._spans.values():
                        if candidate.kind == "human_input" and candidate.status == "running" \
                                and candidate.trace_id == trace.id:
                            span = candidate
                            break
            if span is None:
                return
            span.meta["outcome"] = kw.get("outcome")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            self._close_span(span, status="ok", trace=trace)
        except Exception:
            pass

    def on_post_compaction(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_key = self._active_turn(session_id)
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is None:
                return
            now = self._now()
            span = Span(id=f"sp_compact_{now:.3f}", trace_id=trace.id, kind="compaction",
                        name="context compaction", parent_id=trace.root, started_at=now, ended_at=now)
            span.meta["compression_count"] = kw.get("compression_count")
            span.meta["in_place"] = kw.get("in_place")
            span.meta = {k: v for k, v in span.meta.items() if v is not None}
            with self._lock:
                self._spans[span.id] = span
            self._close_span(span, status="ok", trace=trace)
        except Exception:
            pass

    def on_session_end(self, **kw: Any) -> None:
        try:
            session_id = kw.get("session_id") or ""
            turn_key = self._active_turn(session_id)
            if turn_key is None:
                return
            trace = self._traces.get(turn_key)
            if trace is not None:
                self._finish_trace(trace, "interrupted" if kw.get("interrupted") else "ok")
        except Exception:
            pass

    # ── writer thread ──────────────────────────────────────────────────────────────────────
    def _day(self) -> str:
        return time.strftime("%Y-%m-%d", time.localtime())

    def _shard(self, kind: str, session_id: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "_unknown")[:120]
        return self.data_dir / "traces" / self._day() / f"{safe}.jsonl"

    def _drain(self) -> None:
        last_tick = 0.0
        while not self._stopping.is_set():
            kind: Optional[str] = None
            record: dict = {}
            session_id = "_unknown"
            try:
                kind, record, session_id = self._queue.get(timeout=0.5)
            except queue.Empty:
                kind = None
            except Exception:
                break
            if kind is not None:
                try:
                    path = self._shard(kind, session_id)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
                    if kind == "span":
                        self.spans_recorded += 1
                except Exception:
                    self.dropped += 1
                finally:
                    self._queue.task_done()
            now = time.time()
            if now - last_tick >= 5.0:
                last_tick = now
                self._sweep_stale()
                self._write_status()

    def _write_status(self) -> None:
        """Publish self-reported status for the backend, which cannot share this process's memory.

        ``plugin_api.py`` is imported by file location by the web server, so the read side cannot
        import this module or hold a reference to this recorder. A small atomically-swapped file is
        the honest, decoupled channel between the two halves.
        """
        try:
            payload = self.status()
            payload["written_at"] = time.time()
            path = self.data_dir / "status.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name("status.json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            pass

    def _sweep_stale(self) -> None:
        """Close what a crash left open, so nothing renders as forever-running.

        Two cases, both real:

        1. A span still open long after its trace ended (a completion that never arrived).
        2. A trace that never ended at all: the process died, or the session was killed mid-turn.
           Without this, a crashed turn exists only in memory and can never be inspected.

        A stale span's ``ended_at`` stays ``None`` and its duration is reported as unknown rather
        than invented: we know it ran, we do not know for how long.
        """
        cutoff = self._now() - STALE_AFTER_S
        unfinished: list[Trace] = []
        try:
            with self._lock:
                ended = {t.id: t for t in self._traces.values() if t.ended_at is not None}
                for span in list(self._spans.values()):
                    if span.status != "running" or span.kind == "turn" or span.started_at >= cutoff:
                        continue
                    trace = ended.get(span.trace_id)
                    if trace is None or (trace.ended_at or 0) >= cutoff:
                        continue
                    span.status = "cancelled"
                    span.meta["stale"] = True
                    self._enqueue("span", span.to_json(), trace.session_id)

                unfinished = [t for t in self._traces.values()
                              if t.ended_at is None and t.started_at < cutoff]
                for trace in unfinished:
                    trace.stale = True
                    for span in self._spans.values():
                        if span.trace_id == trace.id and span.status == "running":
                            span.meta["stale"] = True
            for trace in unfinished:
                self._finish_trace(trace, "cancelled")
        except Exception:
            pass
        try:
            self._prune_retention()
        except Exception:
            pass

    def _prune_retention(self) -> None:
        root = self.data_dir
        files = [p for p in root.rglob("*.jsonl") if p.is_file()]
        if not files:
            return
        total = sum(p.stat().st_size for p in files)
        limit_bytes = self.retention_mb * 1024 * 1024
        if total <= limit_bytes and len(files) <= self.retention_traces:
            return
        for path in sorted(files, key=lambda p: p.stat().st_mtime):
            if total <= limit_bytes and len(files) <= self.retention_traces:
                break
            try:
                total -= path.stat().st_size
                path.unlink()
                files.remove(path)
            except Exception:
                pass


def _safe_len(value: Any) -> int:
    try:
        return len(value)  # type: ignore[arg-type]
    except Exception:
        return 0


def _dir_bytes(path: Path) -> int:
    try:
        return sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file())
    except Exception:
        return 0


def capture_mode_from_env(default: str = DEFAULT_CAPTURE_MODE) -> str:
    mode = (os.environ.get("AGENT_TRACE_CAPTURE") or "").strip().lower()
    return mode if mode in CAPTURE_MODES else default


def enabled_from_env() -> bool:
    return not (os.environ.get("AGENT_TRACE_DISABLED") or "").strip()


def hook_names() -> Iterable[str]:
    """The hooks this recorder consumes — the single source of truth for the manifest."""
    return (
        "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call",
        "pre_api_request", "post_api_request", "api_request_error",
        "subagent_start", "subagent_stop", "pre_approval_request", "post_approval_response",
        "on_human_input_request", "on_human_input_resolved", "post_compaction", "on_session_end",
    )


_HOOK_METHODS = {
    "pre_llm_call": "on_pre_llm_call",
    "post_llm_call": "on_post_llm_call",
    "pre_tool_call": "on_pre_tool_call",
    "post_tool_call": "on_post_tool_call",
    "pre_api_request": "on_pre_api_request",
    "post_api_request": "on_post_api_request",
    "api_request_error": "on_api_request_error",
    "subagent_start": "on_subagent_start",
    "subagent_stop": "on_subagent_stop",
    "pre_approval_request": "on_pre_approval_request",
    "post_approval_response": "on_post_approval_response",
    "on_human_input_request": "on_human_input_request",
    "on_human_input_resolved": "on_human_input_resolved",
    "post_compaction": "on_post_compaction",
    "on_session_end": "on_session_end",
}


def register_hooks(ctx: Any, recorder: Recorder) -> list[str]:
    """Wire every consumed hook. Returns the names actually registered."""
    registered: list[str] = []
    for name in hook_names():
        method = getattr(recorder, _HOOK_METHODS[name], None)
        if method is None:
            continue
        try:
            ctx.register_hook(name, method)
            registered.append(name)
        except Exception:
            continue
    return registered