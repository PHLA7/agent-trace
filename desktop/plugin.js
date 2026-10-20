/**
 * agent-trace — the desktop half of the `agent-trace` package.
 *
 * Renders an agent turn as an interactive span graph: a Jaeger-style waterfall
 * by default, an indented tree view on demand, with a detail inspector and a
 * history browser backed by the Python half's read-only routes.
 *
 * Contract: `docs/SPEC.md` (frozen). Console version `hermes.observer.v1`.
 * Backend namespace: `/api/plugins/agent-trace/` — `GET /status`, `GET /live`,
 * `GET /traces`, `GET /traces/{id}`, `GET /blobs/{id}`, `DELETE /traces?confirm`.
 *
 * Data paths, in precedence order:
 *   1. live gateway events through `ctx.onEvent` (turns, tools, subagents,
 *      usage ticks) — the always-available path;
 *   2. backend records through an incremental cursor poll of `GET /live?cursor=…`
 *      (trace/span start+end frames, emitted already in the frame vocabulary the
 *      store ingests). There is no websocket by design: with
 *      `plugins.isolation: host` the plugin backend runs out of process, where a
 *      websocket upgrade cannot be carried (see
 *      `hermes_cli/web_server_dashboard.py`), and `ctx.socket` is additionally a
 *      no-op on OAuth remotes;
 *   3. the app's React Query client polling `GET /traces…` — the fallback that
 *      keeps the docked pane honest whenever the cursor poll cannot run.
 *
 * Hard constraints honoured here: only `@hermes/plugin-sdk`, `react` and
 * `react/jsx-runtime` are imported; no eval / dynamic import / DOM querying of
 * core markup; UI written with `jsx()`/`jsxs()` because the file loads
 * uncompiled; theme variables only (no colour literals anywhere, including
 * comments-free string scans); `ctx.storage` holds preferences only — never
 * trace content.
 *
 * Two module-level budgets keep a long-lived window sane: the span store keeps
 * at most `MAX_SPANS` spans per trace, and each session keeps the last
 * `RING_LIMIT` raw events for the settings Debug sub-page.
 */

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  computed,
  CopyButton,
  DecodeText,
  EmptyState,
  haptic,
  host,
  KEYBINDS_AREA,
  ListRow,
  LogView,
  PALETTE_AREA,
  PANES_AREA,
  queryClient,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Tip,
  ToggleRow,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

/** Plugin id — must equal the package folder name (`desktop-plugins/agent-trace`). */
const ID = 'agent-trace'

/** Route + storage keys. */
const TRACE_PATH = '/trace'
const KEY_VIEW_MODE = 'viewMode'
const KEY_FILTERS = 'filters'
const KEY_PANE_VISIBLE = 'paneVisible'
const KEY_DEBUG = 'debugReveal'
const KEY_BATCH = 'batchSize'

/** Rendering budgets for the UI half (the store's own budgets are in the block below). */
const ROW_BATCH = 60
const PANE_BATCH = 40

/** Live gateway events this half consumes (no `message.delta`, deliberately). */
const LIVE_EVENTS = [
  'tool.start',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'tool.output_risk',
  'message.start',
  'message.complete',
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.progress',
  'subagent.thinking',
  'subagent.tool',
  'subagent.complete',
  'session.usage'
]

// ════════════════════════════════════════════════════════════════════════════
// STORE-REDUCER-START
//
// Everything between these two markers is a PURE, dependency-free module: no
// imports, no atoms, no `Date.now()` reads that are not passed in as `nowMs`.
// Copy the block verbatim into a scratch `.mjs` and run it under node to
// exercise the out-of-order paths.
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA_VERSION = 'hermes.observer.v1'
const SPAN_KINDS = ['turn', 'llm', 'tool', 'subagent', 'approval', 'human_input', 'compaction']

const SPAN_STATUS = { RUNNING: 'running', OK: 'ok', ERROR: 'error', BLOCKED: 'blocked', CANCELLED: 'cancelled' }
const TRACE_STATUS = { RUNNING: 'running', OK: 'ok', ERROR: 'error', INTERRUPTED: 'interrupted', COMPACTED: 'compacted' }

/** `meta.correlation: "degraded"` — SPEC section 2's degenerate-id rule. */
const DEGRADED = 'degraded'

/** Store budgets. A live window can run for days; these bound its memory. */
const RING_LIMIT = 50
const STALE_AFTER_MS = 60_000
const MAX_SPANS_PER_TRACE = 4000
const MAX_LAYOUT_ROWS = 2000

/** Backend frame types pushed over `WS /events` (SPEC section 6). */
const FRAME_TYPES = ['trace.start', 'trace.end', 'span.start', 'span.end']

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function pickNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function pickStr(v) {
  return typeof v === 'string' && v.length ? v : null
}

/**
 * An identity key (`tool_id`, `subagent_id`, …). Strings pass through; a finite
 * number is coerced rather than treated as missing, so a numeric id still keys
 * the same span instead of spawning a second one. Anything else is absent.
 */
function pickKey(v) {
  if (typeof v === 'string' && v.length) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function pickList(v) {
  return Array.isArray(v) ? v : null
}

function sec(ms) {
  return ms / 1000
}

/** Ids stay string-safe even when core coerced a missing value to `""`. */
function safeId(v) {
  const s = String(v == null ? '' : v)
  const cleaned = s.replace(/[^A-Za-z0-9_.:@-]+/g, '_')
  return cleaned.length ? cleaned : 'anon'
}

function emptyTokens(seed) {
  const t = isObj(seed) ? seed : {}
  return {
    input: pickNum(t.input) ?? 0,
    output: pickNum(t.output) ?? 0,
    cache_read: pickNum(t.cache_read) ?? 0,
    cache_write: pickNum(t.cache_write) ?? 0,
    reasoning: pickNum(t.reasoning) ?? 0
  }
}

/** A usage payload from either the wire (`*_tokens`) or a spec span (`input`). */
function normalizeTokens(u) {
  if (!isObj(u)) return null
  return {
    input: pickNum(u.input_tokens ?? u.input) ?? 0,
    output: pickNum(u.output_tokens ?? u.output) ?? 0,
    cache_read: pickNum(u.cache_read_tokens ?? u.cache_read) ?? 0,
    cache_write: pickNum(u.cache_write_tokens ?? u.cache_write) ?? 0,
    reasoning: pickNum(u.reasoning_tokens ?? u.reasoning) ?? 0
  }
}

function tokensAreEmpty(tk) {
  return !tk || !(tk.input || tk.output || tk.cache_read || tk.cache_write || tk.reasoning)
}

function emptySpan(id) {
  return {
    id: String(id),
    parent_id: null,
    trace_id: null,
    session_id: null,
    kind: 'tool',
    name: '',
    started_at: null,
    ended_at: null,
    duration_ms: 0,
    status: SPAN_STATUS.RUNNING,
    depth: 0,
    meta: {},
    tokens: emptyTokens(null),
    cost_usd: null,
    args_ref: null,
    result_ref: null,
    error: null,
    /** Where this span came from: `live` (gateway events) or `backend` (store). */
    origin: 'live',
    /** Last local update, ms — drives stale reconciliation. */
    touched_at: 0
  }
}

function emptyTrace(id) {
  return {
    id: String(id),
    session_id: null,
    turn_id: null,
    profile: null,
    platform: null,
    model: null,
    provider: null,
    user_message: null,
    started_at: null,
    ended_at: null,
    duration_ms: 0,
    status: TRACE_STATUS.RUNNING,
    totals: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: null,
      api_calls: 0,
      tool_calls: 0,
      subagents: 0
    },
    capture_mode: null,
    root: null,
    telemetry_schema_version: SCHEMA_VERSION,
    origin: 'live',
    touched_at: 0
  }
}

function emptyStore() {
  return {
    updatedAt: 0,
    traces: {},
    spans: {},
    /** session_id → trace_id of the session's current live turn. */
    liveTrace: {},
    /** session_id → span_id of the open turn span. */
    openTurn: {},
    /** session_id → monotonic counter for synthetic (degraded) ids. */
    counters: {},
    /** session_id → last RING_LIMIT raw events, verbatim. */
    events: {},
    /** session_id → last `session.usage` tick. */
    usage: {},
    /** session_id → tool name currently generating (payload carries no id). */
    generating: {}
  }
}

/** Spans recorded for one trace — the cap's counter. */
function countSpansForTrace(store, traceId) {
  let n = 0
  for (const id in store.spans) {
    const s = store.spans[id]
    if (s && s.trace_id === traceId) n += 1
  }
  return n
}

/**
 * Immutably write one span. `origin` is preserved from the existing record; a
 * NEW span past MAX_SPANS_PER_TRACE is refused and counted on the trace, so a
 * pathological turn cannot grow the store without bound.
 */
function putSpan(store, span) {
  const prev = store.spans[span.id]
  if (!prev && span.trace_id && countSpansForTrace(store, span.trace_id) >= MAX_SPANS_PER_TRACE) {
    const trace = store.traces[span.trace_id]
    if (!trace) return store
    return {
      ...store,
      traces: {
        ...store.traces,
        [span.trace_id]: { ...trace, spans_capped: (pickNum(trace.spans_capped) ?? 0) + 1 }
      }
    }
  }
  const next = prev ? { ...prev, ...span, origin: prev.origin, meta: { ...prev.meta, ...span.meta } } : span
  return { ...store, spans: { ...store.spans, [span.id]: next } }
}

function putTrace(store, trace) {
  const prev = store.traces[trace.id]
  return { ...store, traces: { ...store.traces, [trace.id]: prev ? { ...prev, ...trace, origin: prev.origin } : trace } }
}

/**
 * Field-level merge for a span, tolerant of either arrival order.
 *
 * `freshWins` names the AUTHORITATIVE side — it supplies durations, refs,
 * writer-computed depth and terminal facts. The other side still wins for a
 * status the authoritative side has not yet terminalised. Call sites: a close
 * (`true`), a late opening (`false`), a REST snapshot (`true`).
 *
 * Rules (both directions):
 *   - a terminal status is never downgraded back to `running`;
 *   - a non-null `ended_at` / `error` / `*_ref` is never cleared by a null;
 *   - a non-zero duration is never cleared by a zero;
 *   - tokens/cost only move when the incoming side actually carries values.
 */
function mergeSpan(prev, incoming, freshWins) {
  const a = freshWins ? prev : incoming
  const b = freshWins ? incoming : prev
  const statusTerminal = (s) => s === SPAN_STATUS.OK || s === SPAN_STATUS.ERROR || s === SPAN_STATUS.BLOCKED || s === SPAN_STATUS.CANCELLED
  let status = a && a.status ? a.status : b.status
  if (b.status && statusTerminal(b.status) && !statusTerminal(status)) status = b.status
  const tokens = !tokensAreEmpty(b.tokens) ? b.tokens : a && a.tokens ? a.tokens : emptyTokens(null)
  return {
    ...(a || {}),
    ...(b || {}),
    id: b.id || a.id,
    parent_id: b.parent_id ?? a.parent_id ?? null,
    trace_id: b.trace_id || a.trace_id || null,
    session_id: b.session_id || a.session_id || null,
    kind: b.kind || a.kind || 'tool',
    name: b.name || a.name || '',
    started_at: pickNum(b.started_at) ?? pickNum(a.started_at),
    ended_at: pickNum(b.ended_at) ?? pickNum(a.ended_at),
    duration_ms: pickNum(b.duration_ms) > 0 ? b.duration_ms : a.duration_ms || 0,
    status: status || SPAN_STATUS.RUNNING,
    depth: pickNum(b.depth) ?? pickNum(a.depth) ?? 0,
    meta: { ...(a.meta || {}), ...(b.meta || {}) },
    tokens,
    cost_usd: b.cost_usd ?? a.cost_usd ?? null,
    args_ref: b.args_ref ?? a.args_ref ?? null,
    result_ref: b.result_ref ?? a.result_ref ?? null,
    error: isObj(b.error) ? b.error : isObj(a.error) ? a.error : null,
    origin: (a && a.origin) || (b && b.origin) || 'live',
    touched_at: pickNum(b.touched_at) ?? pickNum(a.touched_at) ?? 0
  }
}

/** The session's open turn span, or null. */
function openTurnSpan(store, sessionId) {
  const spanId = sessionId ? store.openTurn[sessionId] : null
  return spanId && store.spans[spanId] ? store.spans[spanId] : null
}

function bumpCounter(store, sessionId) {
  const key = sessionId || '(none)'
  const n = (pickNum(store.counters[key]) ?? 0) + 1
  return { store: { ...store, counters: { ...store.counters, [key]: n } }, n }
}

/** Append one raw event to the session's ring buffer (bounded, memory only). */
function pushEvent(store, sessionId, type, payload, nowMs) {
  const key = sessionId || '(no session)'
  const prev = pickList(store.events[key]) || []
  const entry = { at: nowMs, type, payload: isObj(payload) ? payload : {} }
  const next = prev.length >= RING_LIMIT ? prev.slice(prev.length - RING_LIMIT + 1).concat([entry]) : prev.concat([entry])
  return { ...store, events: { ...store.events, [key]: next } }
}

function withSpan(store, span) {
  const prev = store.spans[span.id]
  const merged = prev ? mergeSpan(prev, span, false) : span
  return putSpan(store, merged)
}

/**
 * Open (or re-open) a span without ever discarding a close already received.
 * When the close landed first its `started_at` (derived from the supplied
 * duration) is kept, so the printed duration and the rendered bar agree; the
 * late opening's own timestamp is preserved in `meta.opening_arrived_at`.
 */
function openSpan(store, span) {
  const prev = store.spans[span.id]
  if (!prev) return putSpan(store, span)
  const merged = mergeSpan(prev, span, false)
  merged.started_at = pickNum(prev.started_at) ?? pickNum(span.started_at)
  const late = pickNum(span.started_at)
  const known = pickNum(prev.started_at)
  merged.meta = { ...(merged.meta || {}), out_of_order_open: true }
  if (late != null && known != null && late !== known) merged.meta.opening_arrived_at = late
  return putSpan(store, merged)
}

function withTrace(store, trace) {
  const prev = store.traces[trace.id]
  return putTrace(store, prev ? { ...trace, origin: prev.origin } : trace)
}

/** `message.start` — open a new turn, closing a still-open previous one. */
function startTurn(store, sessionId, nowMs) {
  let next = store
  const prevSpan = openTurnSpan(store, sessionId)
  if (prevSpan) {
    // No `message.complete` ever arrived for the previous turn; end it honestly
    // rather than letting it render as forever-busy.
    const ended = sec(nowMs)
    const fixed = mergeSpan(
      prevSpan,
      {
        ...prevSpan,
        status: SPAN_STATUS.CANCELLED,
        ended_at: ended,
        duration_ms: Math.max(0, Math.round((ended - (pickNum(prevSpan.started_at) ?? ended)) * 1000)),
        meta: { ...(prevSpan.meta || {}), superseded: true }
      },
      true
    )
    next = putSpan(next, fixed)
    const prevTrace = next.traces[prevSpan.trace_id]
    if (prevTrace) {
      next = putTrace(next, {
        ...prevTrace,
        ended_at: ended,
        duration_ms: Math.max(0, Math.round((ended - (pickNum(prevTrace.started_at) ?? ended)) * 1000)),
        status: TRACE_STATUS.INTERRUPTED,
        touched_at: nowMs
      })
    }
    next = { ...next, openTurn: { ...next.openTurn, [sessionId]: null } }
  }

  const bumped = bumpCounter(next, sessionId)
  next = bumped.store
  const turnId = (sessionId || 'session') + ':' + bumped.n
  const traceId = 'tr_' + safeId(turnId)
  const rootSpanId = 'sp_' + safeId(turnId)
  const started = sec(nowMs)
  const trace = {
    ...emptyTrace(traceId),
    session_id: sessionId || null,
    turn_id: turnId,
    started_at: started,
    status: TRACE_STATUS.RUNNING,
    root: rootSpanId,
    origin: 'live',
    touched_at: nowMs
  }
  const root = {
    ...emptySpan(rootSpanId),
    trace_id: traceId,
    session_id: sessionId || null,
    kind: 'turn',
    name: 'turn ' + bumped.n,
    started_at: started,
    meta: { is_first_turn: bumped.n === 1 },
    origin: 'live',
    touched_at: nowMs
  }
  return {
    ...next,
    traces: { ...next.traces, [traceId]: trace },
    spans: { ...next.spans, [rootSpanId]: root },
    liveTrace: { ...next.liveTrace, [sessionId]: traceId },
    openTurn: { ...next.openTurn, [sessionId]: rootSpanId }
  }
}

/** Map an arbitrary outcome string onto the spec's span/trace status enums. */
function statusFromOutcome(outcome, fallback) {
  const s = pickStr(outcome) ? String(outcome).toLowerCase() : ''
  if (s.indexOf('error') >= 0 || s === 'failed') return SPAN_STATUS.ERROR
  if (s.indexOf('interrupt') >= 0 || s.indexOf('abort') >= 0 || s.indexOf('cancel') >= 0) return SPAN_STATUS.CANCELLED
  if (s.indexOf('block') >= 0 || s.indexOf('denied') >= 0) return SPAN_STATUS.BLOCKED
  if (s.indexOf('compact') >= 0 || s === 'ok' || s === 'success' || s === 'completed' || s === 'stop') return SPAN_STATUS.OK
  return fallback || SPAN_STATUS.OK
}

function traceStatusFromSpan(status, compacted) {
  if (compacted) return TRACE_STATUS.COMPACTED
  if (status === SPAN_STATUS.ERROR) return TRACE_STATUS.ERROR
  if (status === SPAN_STATUS.CANCELLED) return TRACE_STATUS.INTERRUPTED
  if (status === SPAN_STATUS.OK) return TRACE_STATUS.OK
  return TRACE_STATUS.RUNNING
}

/**
 * Close a span by id, creating it if its opening never arrived.
 *
 * An explicit duration (`duration_s` / `duration_ms`) is authoritative per
 * SPEC section 1, so the span's `started_at` is derived from
 * `ended_at - duration` — the printed duration can never contradict the
 * rendered bar. The timestamp the openings claimed is kept in
 * `meta.opened_at` when the two disagree.
 */
function closeSpanById(store, spanId, patch, nowMs) {
  const explicitMs = pickNum(patch.duration_ms) ?? (pickNum(patch.duration_s) != null ? Math.round(patch.duration_s * 1000) : null)
  const base = { ...patch, id: spanId, touched_at: nowMs }
  if (explicitMs != null) base.duration_ms = explicitMs

  const prev = store.spans[spanId]
  let merged
  if (prev) {
    merged = mergeSpan(prev, base, true)
  } else {
    const endedAt = pickNum(base.ended_at)
    merged = {
      ...emptySpan(spanId),
      ...base,
      started_at: endedAt != null && explicitMs != null ? endedAt - explicitMs / 1000 : pickNum(base.started_at),
      meta: { ...(isObj(base.meta) ? base.meta : {}), opening_missing: true }
    }
  }

  const endedAt = pickNum(merged.ended_at)
  if (explicitMs != null && endedAt != null) {
    const observed = pickNum(merged.started_at)
    if (observed != null && Math.abs((endedAt - observed) * 1000 - explicitMs) > 1) {
      merged.meta = { ...(merged.meta || {}), opened_at: observed }
    }
    merged.started_at = endedAt - explicitMs / 1000
    merged.duration_ms = explicitMs
  }
  return putSpan(store, merged)
}

/**
 * Resolve the parent for a tool / subagent span.
 *
 * Order: an explicit `parent_id` (a nested subagent), then a `delegation_id`
 * already seen in the store, then the session's open turn. The span's OWN id is
 * never a candidate — the `subagent_id` branch this used to check could only
 * ever return itself, which parented every identified subagent to itself.
 */
function resolveParentId(store, sessionId, identity) {
  const childSession = pickKey(identity && identity.child_session_id)
  const parentKey = pickKey(identity && identity.parent_id)
  if (parentKey) return 'sp_sub_' + safeId(parentKey)
  const delegation = pickKey(identity && identity.delegation_id)
  if (delegation) {
    for (const id in store.spans) {
      const s = store.spans[id]
      if (s && s.kind === 'subagent' && s.meta && s.meta.delegation_id === delegation) return id
    }
  }
  const turn = openTurnSpan(store, sessionId)
  if (turn) return turn.id
  const childTurn = childSession ? openTurnSpan(store, childSession) : null
  return childTurn ? childTurn.id : null
}

/**
 * One `subagent.*` event. All identity fields are genuinely optional: with no
 * `subagent_id` and no `parent_id` the span is keyed on `task_index` (or a
 * counter) and flagged `meta.correlation: "degraded"`, which the renderer
 * turns into flat rows instead of a guessed tree.
 */
function applySubagentEvent(store, sessionId, type, payload, nowMs) {
  let next = store
  const subagentId = pickKey(payload.subagent_id)
  let key = subagentId ? 'sp_sub_' + safeId(subagentId) : null
  if (!key) {
    const taskIndex = pickNum(payload.task_index)
    if (taskIndex != null) {
      key = 'sp_sub_anon_' + safeId(sessionId || 'session') + '_t' + safeId(taskIndex)
    } else {
      const bumped = bumpCounter(next, sessionId)
      next = bumped.store
      key = 'sp_sub_anon_' + safeId(sessionId || 'session') + '_' + bumped.n
    }
  }
  const traceId = store.liveTrace[sessionId] || null
  const parentId = resolveParentId(next, sessionId, payload)
  const degraded = !subagentId
  const existing = next.spans[key]
  const goal = pickStr(payload.goal) || pickStr(payload.summary) || (existing && existing.name) || 'subagent'
  const baseMeta = {
    ...(existing && isObj(existing.meta) ? existing.meta : {}),
    role: pickStr(payload.role) ?? (existing && existing.meta ? existing.meta.role : null),
    goal,
    subagent_id: subagentId,
    child_session_id: pickStr(payload.child_session_id),
    delegation_id: pickStr(payload.delegation_id),
    task_count: pickNum(payload.task_count),
    task_index: pickNum(payload.task_index),
    depth: pickNum(payload.depth),
    model: pickStr(payload.model),
    toolsets: pickList(payload.toolsets),
    api_calls: pickNum(payload.api_calls),
    tool_count: pickNum(payload.tool_count),
    files_read: pickList(payload.files_read),
    files_written: pickList(payload.files_written),
    output_tail: pickStr(payload.output_tail),
    tool_name: pickStr(payload.tool_name),
    tool_preview: pickStr(payload.tool_preview),
    summary: pickStr(payload.summary),
    correlation: degraded ? DEGRADED : null
  }
  for (const k in baseMeta) {
    if (baseMeta[k] === null || baseMeta[k] === undefined) delete baseMeta[k]
  }

  const tokens = normalizeTokens({
    input_tokens: payload.input_tokens,
    output_tokens: payload.output_tokens,
    reasoning_tokens: payload.reasoning_tokens
  })

  const common = {
    id: key,
    trace_id: existing && existing.trace_id ? existing.trace_id : traceId,
    session_id: sessionId || null,
    kind: 'subagent',
    name: goal,
    parent_id: parentId,
    meta: baseMeta,
    origin: 'live',
    touched_at: nowMs
  }

  if (type === 'subagent.spawn_requested' || type === 'subagent.start') {
    const opened = {
      ...emptySpan(key),
      ...common,
      started_at: existing ? existing.started_at : sec(nowMs),
      status: existing && existing.status !== SPAN_STATUS.RUNNING ? existing.status : SPAN_STATUS.RUNNING
    }
    next = openSpan(next, opened)
    next = bumpTraceTotal(next, traceId, 'subagents')
    return next
  }

  if (type === 'subagent.complete') {
    const ended = sec(nowMs)
    const durSec = pickNum(payload.duration_seconds)
    const started = existing && pickNum(existing.started_at) != null ? existing.started_at : ended - (durSec || 0)
    const status = statusFromOutcome(payload.status, SPAN_STATUS.OK)
    next = closeSpanById(
      next,
      key,
      {
        ...common,
        started_at: started,
        ended_at: ended,
        duration_ms: durSec != null ? Math.round(durSec * 1000) : Math.max(0, Math.round((ended - started) * 1000)),
        status,
        tokens: tokensAreEmpty(tokens) ? undefined : tokens
      },
      nowMs
    )
    return next
  }

  // progress / thinking / tool: merge into the (possibly not-yet-opened) span.
  const patch = {
    ...common,
    started_at: existing ? existing.started_at : sec(nowMs),
    status: existing && existing.status ? existing.status : SPAN_STATUS.RUNNING
  }
  if (type === 'subagent.thinking') {
    patch.meta = { ...baseMeta, thinking: pickStr(payload.text) || true }
  }
  if (!tokensAreEmpty(tokens)) patch.tokens = tokens
  next = openSpan(next, { ...emptySpan(key), ...patch })
  return next
}

function bumpTraceTotal(store, traceId, key) {
  if (!traceId) return store
  const trace = store.traces[traceId]
  if (!trace) return store
  const totals = { ...trace.totals }
  totals[key] = (pickNum(totals[key]) ?? 0) + 1
  return putTrace(store, { ...trace, totals })
}

/** Add one to a trace total without inventing values for the others. */
function setTraceUsage(store, traceId, usage, nowMs) {
  if (!traceId) return store
  const trace = store.traces[traceId]
  if (!trace) return store
  return putTrace(store, { ...trace, usage_tick: usage, touched_at: nowMs })
}

function finish(store, nowMs) {
  return { ...store, updatedAt: nowMs }
}

/** Ingest a backend frame (`{ type, trace, span }`, SPEC section 6). */
function ingestFrame(store, frame, nowMs) {
  const type = pickStr(frame.type)
  if (!type) return store
  let next = store
  const traceIn = isObj(frame.trace) ? frame.trace : null
  const spanIn = isObj(frame.span) ? frame.span : null
  const sessionId = traceIn && pickStr(traceIn.session_id) ? traceIn.session_id : ''

  if (type === 'trace.start' || type === 'trace.end') {
    if (traceIn && pickStr(traceIn.id)) {
      const incoming = { ...emptyTrace(traceIn.id), ...traceIn, origin: 'backend', touched_at: nowMs }
      if (!isObj(incoming.totals)) incoming.totals = emptyTrace(traceIn.id).totals
      next = withTrace(next, incoming)
      if (sessionId) {
        next = { ...next, liveTrace: { ...next.liveTrace, [sessionId]: traceIn.id } }
      }
      if (type === 'trace.end') {
        const endedAt = pickNum(incoming.ended_at) ?? sec(nowMs)
        next = putTrace(next, {
          ...next.traces[traceIn.id],
          ended_at: endedAt,
          duration_ms: pickNum(incoming.duration_ms) ?? Math.max(0, Math.round((endedAt - (pickNum(incoming.started_at) ?? endedAt)) * 1000)),
          status: pickStr(incoming.status) || TRACE_STATUS.OK,
          touched_at: nowMs
        })
      }
    }
  } else if (spanIn && pickStr(spanIn.id)) {
    const incoming = { ...emptySpan(spanIn.id), ...spanIn, origin: 'backend', touched_at: nowMs }
    if (!isObj(incoming.tokens)) incoming.tokens = emptyTokens(null)
    if (!isObj(incoming.meta)) incoming.meta = {}
    if (type === 'span.end') {
      const endedAt = pickNum(incoming.ended_at) ?? sec(nowMs)
      incoming.ended_at = endedAt
      incoming.duration_ms =
        pickNum(incoming.duration_ms) ?? Math.max(0, Math.round((endedAt - (pickNum(incoming.started_at) ?? endedAt)) * 1000))
      next = closeSpanById(next, incoming.id, incoming, nowMs)
    } else {
      next = openSpan(next, incoming)
    }
  }
  return pushEvent(next, sessionId, 'frame:' + type, frame, nowMs)
}

/**
 * THE ingest. `raw` is either a gateway event (`{ type, session_id, payload }`
 * — `payload` is optional: `message.start` carries none) or a backend frame
 * (`{ type, trace, span }`). Pure; returns the store.
 */
function ingest(store, raw, nowMs) {
  const now = pickNum(nowMs) ?? 0
  if (!isObj(raw)) return store
  const type = pickStr(raw.type)
  if (!type) return store

  // Frames are recognised by their type, not by the presence of a payload —
  // `message.start` has no payload at all and must not be mistaken for one.
  if (FRAME_TYPES.includes(type)) return finish(ingestFrame(store, raw, now), now)
  if (!isObj(raw.payload) && (isObj(raw.span) || isObj(raw.trace))) return finish(ingestFrame(store, raw, now), now)

  const sessionId = pickStr(raw.session_id) ? raw.session_id : ''
  const payload = isObj(raw.payload) ? raw.payload : {}
  let next = pushEvent(store, sessionId, type, payload, now)

  switch (type) {
    case 'message.start': {
      next = startTurn(next, sessionId, now)
      return finish(next, now)
    }
    case 'message.complete': {
      const turn = openTurnSpan(next, sessionId)
      const traceId = next.liveTrace[sessionId] || (turn && turn.trace_id) || null
      const compacted = pickStr(payload.compaction) != null
      const status = statusFromOutcome(payload.outcome ?? payload.status, SPAN_STATUS.OK)
      const ended = sec(now)
      const usage = normalizeTokens(payload.usage)
      const totals = traceId && next.traces[traceId] ? { ...next.traces[traceId].totals } : null
      if (totals && !tokensAreEmpty(usage)) {
        totals.input_tokens = (pickNum(totals.input_tokens) ?? 0) + (usage.input || 0)
        totals.output_tokens = (pickNum(totals.output_tokens) ?? 0) + (usage.output || 0)
        totals.cache_read_tokens = (pickNum(totals.cache_read_tokens) ?? 0) + (usage.cache_read || 0)
        totals.cache_write_tokens = (pickNum(totals.cache_write_tokens) ?? 0) + (usage.cache_write || 0)
        totals.reasoning_tokens = (pickNum(totals.reasoning_tokens) ?? 0) + (usage.reasoning || 0)
      }
      const startedAt = turn && pickNum(turn.started_at) != null ? turn.started_at : ended
      const spanId = turn ? turn.id : 'sp_' + safeId((sessionId || 'session') + ':late')
      next = closeSpanById(
        next,
        spanId,
        {
          id: spanId,
          trace_id: traceId,
          session_id: sessionId || null,
          kind: 'turn',
          name: turn ? turn.name : 'turn (opening missing)',
          parent_id: null,
          started_at: startedAt,
          ended_at: ended,
          duration_ms: Math.max(0, Math.round((ended - startedAt) * 1000)),
          status,
          tokens: tokensAreEmpty(usage) ? undefined : usage,
          meta: { ...(turn && turn.meta ? turn.meta : {}), turn_end: true }
        },
        now
      )
      if (traceId && next.traces[traceId]) {
        next = putTrace(next, {
          ...next.traces[traceId],
          ended_at: ended,
          duration_ms: Math.max(0, Math.round((ended - (pickNum(startedAt) ?? ended)) * 1000)),
          status: traceStatusFromSpan(status, compacted),
          totals: totals || next.traces[traceId].totals,
          touched_at: now
        })
      }
      next = { ...next, openTurn: { ...next.openTurn, [sessionId]: null } }
      return finish(next, now)
    }
    case 'tool.start': {
      const toolId = pickKey(payload.tool_id)
      let spanId = toolId ? 'sp_tool_' + safeId(toolId) : null
      let degraded = false
      if (!spanId) {
        const bumped = bumpCounter(next, sessionId)
        next = bumped.store
        spanId = 'sp_tool_anon_' + safeId(sessionId || 'session') + '_' + bumped.n
        degraded = true
      }
      const traceId = next.liveTrace[sessionId] || null
      const turn = openTurnSpan(next, sessionId)
      const name = pickStr(payload.name) || 'tool'
      next = openSpan(next, {
        ...emptySpan(spanId),
        trace_id: traceId,
        session_id: sessionId || null,
        kind: 'tool',
        name,
        parent_id: turn ? turn.id : null,
        started_at: sec(now),
        status: SPAN_STATUS.RUNNING,
        meta: {
          tool_name: name,
          tool_id: toolId,
          correlation: degraded ? DEGRADED : null,
          context: pickStr(payload.context),
          args_text: pickStr(payload.args_text),
          preview: pickStr(payload.preview),
          labels: pickList(payload.labels),
          args: isObj(payload.args) ? payload.args : null
        },
        origin: 'live',
        touched_at: now
      })
      next = bumpTraceTotal(next, traceId, 'tool_calls')
      return finish(next, now)
    }
    case 'tool.complete': {
      const toolId = pickKey(payload.tool_id)
      let spanId = toolId ? 'sp_tool_' + safeId(toolId) : null
      if (!spanId) {
        // No id to key on: attribute to the newest running tool span of the
        // session rather than inventing a second span for the same call.
        const running = []
        for (const id in next.spans) {
          const s = next.spans[id]
          if (s && s.session_id === sessionId && s.kind === 'tool' && s.status === SPAN_STATUS.RUNNING) running.push(s)
        }
        running.sort((a, b) => (pickNum(b.started_at) ?? 0) - (pickNum(a.started_at) ?? 0))
        if (running.length) spanId = running[0].id
      }
      if (!spanId) {
        const bumped = bumpCounter(next, sessionId)
        next = bumped.store
        spanId = 'sp_tool_anon_' + safeId(sessionId || 'session') + '_' + bumped.n
      }
      const durSec = pickNum(payload.duration_s)
      const ended = sec(now)
      const started = durSec != null ? ended - durSec : null
      const status = statusFromOutcome(payload.status, SPAN_STATUS.OK)
      const existing = next.spans[spanId]
      next = closeSpanById(
        next,
        spanId,
        {
          id: spanId,
          trace_id: existing ? existing.trace_id : next.liveTrace[sessionId] || null,
          session_id: sessionId || null,
          kind: 'tool',
          name: pickStr(payload.name) || (existing ? existing.name : 'tool'),
          parent_id: existing ? existing.parent_id : resolveParentId(next, sessionId, {}),
          started_at: pickNum(existing && existing.started_at) ?? started ?? ended,
          ended_at: durSec != null ? ended : ended,
          duration_ms: durSec != null ? Math.round(durSec * 1000) : undefined,
          status,
          meta: {
            tool_name: pickStr(payload.name) || (existing && existing.name) || 'tool',
            tool_id: toolId,
            summary: pickStr(payload.summary),
            result_text: pickStr(payload.result_text),
            revision: pickStr(payload.revision),
            inline_diff: !!payload.inline_diff,
            todos: pickList(payload.todos),
            labels: pickList(payload.labels),
            result: isObj(payload.result) ? payload.result : null
          },
          result_ref: existing ? existing.result_ref : null,
          origin: 'live',
          touched_at: now
        },
        now
      )
      return finish(next, now)
    }
    case 'tool.generating': {
      const name = pickStr(payload.name)
      return finish({ ...next, generating: { ...next.generating, [sessionId]: name || null } }, now)
    }
    case 'tool.progress': {
      let spanId = pickKey(payload.tool_id) ? 'sp_tool_' + safeId(payload.tool_id) : null
      if (!spanId) {
        for (const id in next.spans) {
          const s = next.spans[id]
          if (s && s.session_id === sessionId && s.kind === 'tool' && s.status === SPAN_STATUS.RUNNING) spanId = id
        }
      }
      if (!spanId || !next.spans[spanId]) return finish(next, now)
      const prev = next.spans[spanId]
      next = putSpan(next, {
        ...prev,
        meta: {
          ...prev.meta,
          progress: {
            progress: pickNum(payload.progress),
            total: pickNum(payload.total),
            percent: pickNum(payload.percent),
            message: pickStr(payload.message)
          }
        },
        touched_at: now
      })
      return finish(next, now)
    }
    case 'tool.output_risk': {
      const spanId = pickKey(payload.tool_id) ? 'sp_tool_' + safeId(payload.tool_id) : null
      if (!spanId || !next.spans[spanId]) return finish(next, now)
      const prev = next.spans[spanId]
      next = putSpan(next, {
        ...prev,
        meta: {
          ...prev.meta,
          risk: {
            risk: pickStr(payload.risk),
            findings: pickList(payload.findings),
            redacted: payload.redacted === true
          }
        },
        touched_at: now
      })
      return finish(next, now)
    }
    case 'session.usage': {
      const usage = normalizeTokens(payload)
      const snapshot = {
        at: now,
        input_tokens: usage ? usage.input : 0,
        output_tokens: usage ? usage.output : 0,
        cache_read_tokens: usage ? usage.cache_read : 0,
        cache_write_tokens: usage ? usage.cache_write : 0,
        reasoning_tokens: usage ? usage.reasoning : 0,
        cost_usd: pickNum(payload.cost_usd),
        api_calls: pickNum(payload.api_calls),
        model: pickStr(payload.model),
        raw: payload
      }
      next = { ...next, usage: { ...next.usage, [sessionId]: snapshot } }
      next = setTraceUsage(next, next.liveTrace[sessionId] || null, snapshot, now)
      return finish(next, now)
    }
    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.thinking':
    case 'subagent.tool':
    case 'subagent.complete': {
      next = applySubagentEvent(next, sessionId, type, payload, now)
      return finish(next, now)
    }
    default:
      return finish(next, now)
  }
}

/**
 * Conservative merge of a REST snapshot (`GET /traces/{id}`) into the store.
 * The snapshot is the authoritative side (it carries the terminal facts, the
 * blob refs and the writer-computed depth), while a locally running span keeps
 * its live status until the snapshot terminalises it.
 */
function mergeTraceSnapshot(store, trace, spans, nowMs) {
  const now = pickNum(nowMs) ?? 0
  if (!isObj(trace) || !pickStr(trace.id)) return store
  let next = store
  const incoming = { ...emptyTrace(trace.id), ...trace, origin: 'backend', touched_at: now }
  if (!isObj(incoming.totals)) incoming.totals = emptyTrace(trace.id).totals
  const prev = next.traces[trace.id]
  if (prev) {
    // Never downgrade a terminal trace back to running.
    if (incoming.status === TRACE_STATUS.RUNNING && prev.status !== TRACE_STATUS.RUNNING) incoming.status = prev.status
  }
  next = putTrace(next, incoming)
  if (pickStr(incoming.session_id)) {
    next = { ...next, liveTrace: { ...next.liveTrace, [incoming.session_id]: trace.id } }
  }
  const list = pickList(spans) || []
  for (const wire of list) {
    if (!isObj(wire) || !pickStr(wire.id)) continue
    const spanIn = { ...emptySpan(wire.id), ...wire, origin: 'backend', touched_at: now }
    if (!isObj(spanIn.tokens)) spanIn.tokens = emptyTokens(null)
    if (!isObj(spanIn.meta)) spanIn.meta = {}
    const local = next.spans[spanIn.id]
    // The snapshot is authoritative here (terminal facts, refs, wire depth).
    next = putSpan(next, local ? mergeSpan(local, spanIn, true) : spanIn)
  }
  // The snapshot is authoritative about which spans belong to the trace.
  return next
}

/**
 * SPEC section 5's stale pass: a span still running whose trace ended more than
 * 60 s ago is closed as `cancelled` with `meta.stale`, so a crashed turn does
 * not render as forever-busy. Returns the same object when nothing changed.
 */
function reconcileStale(store, nowMs, thresholdMs) {
  const now = pickNum(nowMs) ?? 0
  const limit = pickNum(thresholdMs) ?? STALE_AFTER_MS
  let next = store
  let changed = false
  for (const id in store.spans) {
    const s = store.spans[id]
    if (!s || s.status !== SPAN_STATUS.RUNNING) continue
    const trace = s.trace_id ? store.traces[s.trace_id] : null
    const traceEnded = trace ? pickNum(trace.ended_at) : null
    if (traceEnded == null) continue
    if (sec(now) - traceEnded <= limit / 1000) continue
    const endedAt = traceEnded
    const startedAt = pickNum(s.started_at) ?? endedAt
    next = putSpan(next, {
      ...s,
      status: SPAN_STATUS.CANCELLED,
      ended_at: endedAt,
      duration_ms: Math.max(0, Math.round((endedAt - startedAt) * 1000)),
      meta: { ...s.meta, stale: true },
      touched_at: now
    })
    changed = true
  }
  return changed ? { ...next, updatedAt: now } : store
}

// ── derived selectors (pure) ────────────────────────────────────────────────

/** Every span belonging to the target, whether keyed by trace or by session. */
function spansForTarget(store, target) {
  const out = []
  const wantTrace = target && pickStr(target.traceId)
  const wantSession = target && pickStr(target.sessionId)
  for (const id in store.spans) {
    const s = store.spans[id]
    if (!s) continue
    if (wantTrace) {
      if (s.trace_id === wantTrace) out.push(s)
      continue
    }
    if (wantSession) {
      if (s.session_id === wantSession) {
        out.push(s)
        continue
      }
      const tr = s.trace_id ? store.traces[s.trace_id] : null
      if (tr && tr.session_id === wantSession) out.push(s)
    }
  }
  return out
}

/** Every session seen in the store, newest first (for the history filter). */
function knownSessions(store) {
  const seen = {}
  for (const id in store.traces) {
    const t = store.traces[id]
    if (!t || !pickStr(t.session_id)) continue
    const at = pickNum(t.started_at) ?? 0
    if (!seen[t.session_id] || at > seen[t.session_id]) seen[t.session_id] = at
  }
  return Object.keys(seen)
    .map((sid) => ({ session_id: sid, at: seen[sid] }))
    .sort((a, b) => b.at - a.at)
    .map((row) => row.session_id)
}

function resolveDepth(span, byId) {
  if (span.meta && span.meta.correlation === DEGRADED) return 1
  let d = 0
  let cur = span
  const guard = {}
  while (cur && cur.parent_id && d < 24) {
    if (guard[cur.id]) break
    guard[cur.id] = true
    const parent = byId[cur.parent_id]
    if (!parent) break
    d += 1
    cur = parent
  }
  if (d === 0 && span.parent_id && !byId[span.parent_id]) {
    const wire = pickNum(span.depth)
    if (wire != null && wire > 0) d = wire
  }
  return d
}

function spanEndAt(span, nowMs) {
  const ended = pickNum(span.ended_at)
  if (ended != null) return ended
  if (span.status === SPAN_STATUS.RUNNING) return sec(pickNum(nowMs) ?? 0)
  return pickNum(span.started_at)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The single derivation both renderers share: a flat, ordered row list with
 * depth and time offsets expressed as PERCENTAGES of the trace span, so no
 * pixel geometry is ever computed from a measured container.
 */
function computeLayout(store, target, filters, nowMs) {
  const now = pickNum(nowMs) ?? 0
  const all = spansForTarget(store, target)
  const trace = target && pickStr(target.traceId) ? store.traces[target.traceId] || null : null
  const f = isObj(filters) ? filters : {}
  const kindFilter = pickStr(f.kind)
  const statusFilter = pickStr(f.status)
  const q = pickStr(f.query)
  const ql = q ? q.toLowerCase() : ''

  const byId = {}
  for (const s of all) byId[s.id] = s

  // An emitter that sends no `kind` must not collapse into the "all" filter
  // option (whose id is ''), so kinds are grouped under an explicit label.
  const kindOf = (s) => pickStr(s.kind) || 'unknown'

  const visible = []
  for (const s of all) {
    if (kindFilter && kindOf(s) !== kindFilter) continue
    if (statusFilter && s.status !== statusFilter) continue
    if (ql) {
      const hay = (String(s.name || '') + ' ' + String((s.meta && s.meta.tool_name) || '')).toLowerCase()
      if (hay.indexOf(ql) < 0) continue
    }
    visible.push(s)
  }

  const counts = {}
  const statusCounts = {}
  let running = 0
  let degraded = 0
  for (const s of visible) {
    counts[kindOf(s)] = (counts[kindOf(s)] || 0) + 1
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1
    if (s.status === SPAN_STATUS.RUNNING) running += 1
    if (s.meta && s.meta.correlation === DEGRADED) degraded += 1
  }

  if (!visible.length) {
    return {
      trace,
      rows: [],
      totalMs: 0,
      t0: null,
      t1: null,
      counts,
      statusCounts,
      running,
      degraded,
      spanCount: all.length,
      filteredOut: all.length,
      truncated: false
    }
  }

  let t0 = Infinity
  let t1 = -Infinity
  for (const s of visible) {
    const st = pickNum(s.started_at)
    if (st != null) t0 = Math.min(t0, st)
    const en = spanEndAt(s, now)
    if (en != null) t1 = Math.max(t1, en)
  }
  if (!Number.isFinite(t0)) t0 = sec(now) - 1
  if (!Number.isFinite(t1) || t1 < t0) t1 = t0 + 0.001
  const totalMs = Math.max(1, (t1 - t0) * 1000)

  const rows = visible.map((s) => {
    const started = pickNum(s.started_at)
    const ended = spanEndAt(s, now)
    const durationMs = started != null && ended != null ? Math.max(0, Math.round((ended - started) * 1000)) : pickNum(s.duration_ms) ?? 0
    const offsetPct = started != null ? clamp(((started - t0) * 1000 / totalMs) * 100, 0, 100) : 0
    return {
      span: s,
      id: s.id,
      depth: resolveDepth(s, byId),
      offsetMs: started != null ? Math.max(0, Math.round((started - t0) * 1000)) : 0,
      offsetPct,
      widthPct: clamp(durationMs / totalMs * 100, 0.4, Math.max(0.4, 100 - offsetPct)),
      durationMs,
      running: s.status === SPAN_STATUS.RUNNING,
      degraded: !!(s.meta && s.meta.correlation === DEGRADED)
    }
  })

  const sortByStart = (a, b) => {
    const as = pickNum(a.span.started_at) ?? 0
    const bs = pickNum(b.span.started_at) ?? 0
    if (as !== bs) return as - bs
    const ae = pickNum(a.span.ended_at) ?? 0
    const be = pickNum(b.span.ended_at) ?? 0
    if (ae !== be) return ae - be
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  rows.sort(sortByStart)

  let truncated = false
  const rendered = rows.length > MAX_LAYOUT_ROWS ? (truncated = true, rows.slice(0, MAX_LAYOUT_ROWS)) : rows

  const offsetById = {}
  for (const r of rendered) offsetById[r.id] = r.offsetPct

  const ordered = rendered.map((r) => ({ ...r, parentOffsetPct: r.span.parent_id ? offsetById[r.span.parent_id] ?? null : null }))

  return {
    trace,
    rows: ordered,
    totalMs,
    t0,
    t1,
    counts,
    statusCounts,
    running,
    degraded,
    spanCount: all.length,
    filteredOut: all.length - visible.length,
    truncated
  }
}

/**
 * Tree view: the same rows, re-ordered as a pre-order walk of the parent map.
 * A row is a root only when its parent is NOT among the rendered rows — a
 * degraded (flat) row is still a child of its turn, it is just never nested
 * deeper than one level (see `resolveDepth`).
 */
function orderAsTree(rows) {
  const byId = {}
  for (const r of rows) byId[r.id] = r
  const children = {}
  const roots = []
  for (const r of rows) {
    const pid = r.span.parent_id
    if (pid && byId[pid]) {
      if (!children[pid]) children[pid] = []
      children[pid].push(r)
    } else {
      roots.push(r)
    }
  }
  const byStart = (a, b) => {
    const as = pickNum(a.span.started_at) ?? 0
    const bs = pickNum(b.span.started_at) ?? 0
    return as === bs ? (a.id < b.id ? -1 : 1) : as - bs
  }
  roots.sort(byStart)
  for (const pid in children) children[pid].sort(byStart)
  const out = []
  const guard = {}
  const walk = (row) => {
    if (guard[row.id]) return
    guard[row.id] = true
    out.push(row)
    const kids = children[row.id]
    if (kids) for (const k of kids) walk(k)
  }
  for (const r of roots) walk(r)
  // Anything unreachable (a parent cycle) still renders, flat.
  for (const r of rows) if (!guard[r.id]) out.push(r)
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// STORE-REDUCER-END
// ════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// 2. FORMATTERS (pure, shared by every surface)
// ─────────────────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  const v = pickNum(ms)
  if (v == null || v < 0) return '—'
  if (v < 1000) return Math.round(v) + 'ms'
  if (v < 60_000) return (v / 1000).toFixed(v < 10_000 ? 2 : 1) + 's'
  const m = Math.floor(v / 60_000)
  const s = Math.round((v % 60_000) / 1000)
  return m + 'm ' + s + 's'
}

function fmtCount(n) {
  const v = pickNum(n)
  if (v == null) return '—'
  return v.toLocaleString()
}

/** `cost_usd` is null when no pricing table resolved the model — never invent 0. */
function fmtCost(v) {
  const n = pickNum(v)
  if (n == null) return '—'
  if (n === 0) return '0'
  return '$' + (Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4))
}

function fmtTokens(tk) {
  if (!isObj(tk)) return '—'
  const parts = []
  if (tk.input) parts.push('in ' + fmtCount(tk.input))
  if (tk.output) parts.push('out ' + fmtCount(tk.output))
  if (tk.cache_read) parts.push('cache-r ' + fmtCount(tk.cache_read))
  if (tk.cache_write) parts.push('cache-w ' + fmtCount(tk.cache_write))
  if (tk.reasoning) parts.push('reasoning ' + fmtCount(tk.reasoning))
  return parts.length ? parts.join(' · ') : '—'
}

function shortId(v) {
  const s = String(v == null ? '' : v)
  if (s.length <= 20) return s
  return s.slice(0, 10) + '…' + s.slice(-6)
}

function fmtBytes(v) {
  const n = pickNum(v)
  if (n == null) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtClock(epochSec) {
  const s = pickNum(epochSec)
  if (s == null) return '—'
  try {
    const d = new Date(s * 1000)
    if (!Number.isFinite(d.getTime())) return '—'
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch (e) {
    return '—'
  }
}

function messageOf(err) {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  if (pickStr(err.message)) return err.message
  try {
    return String(err)
  } catch (e) {
    return 'unknown error'
  }
}

/**
 * JSON.stringify with a size cap — the raw-event view is a diagnostic, and a
 * single 2 MB tool result must not freeze the settings page.
 */
function jsonPreview(value, maxString) {
  const cap = pickNum(maxString) ?? 2000
  const seen = []
  try {
    return JSON.stringify(
      value,
      (key, v) => {
        if (typeof v === 'string' && v.length > cap) return v.slice(0, cap) + '… (' + (v.length - cap) + ' chars omitted)'
        if (Array.isArray(v) && v.length > 200) return v.slice(0, 200).concat(['… ' + (v.length - 200) + ' more items'])
        if (isObj(v)) {
          if (seen.indexOf(v) >= 0) return '[circular]'
          seen.push(v)
        }
        return v
      },
      2
    )
  } catch (e) {
    return String(value)
  }
}

/** Status → theme variable. Theme vars only; no colour literals, ever. */
function statusColor(status) {
  if (status === SPAN_STATUS.ERROR) return 'var(--ui-error)'
  if (status === SPAN_STATUS.BLOCKED) return 'var(--ui-error)'
  if (status === SPAN_STATUS.CANCELLED) return 'var(--ui-text-quaternary)'
  if (status === SPAN_STATUS.RUNNING) return 'var(--ui-accent)'
  return 'var(--ui-success)'
}

function statusBadgeVariant(status) {
  if (status === SPAN_STATUS.ERROR || status === SPAN_STATUS.BLOCKED) return 'destructive'
  if (status === SPAN_STATUS.RUNNING) return 'default'
  return 'muted'
}

const KIND_CODICON = {
  turn: 'comment-discussion',
  llm: 'server-process',
  tool: 'tools',
  subagent: 'organization',
  approval: 'shield',
  human_input: 'account',
  compaction: 'archive'
}

/** The bar colours come from the spec's status enum, not from a guess. */
function compactKey(pct) {
  const v = pickNum(pct)
  if (v == null) return '—'
  return Math.round(v) + '%'
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. STORE WIRING — atoms, the live ingest path, backend probe
// ─────────────────────────────────────────────────────────────────────────────

/** The one store. Read with `.get()` in handlers; `useValue` in leaves. */
const $state = atom(emptyStore())

/** A 1 s render clock so running spans grow without any data polling. */
const $nowMs = atom(Date.now())

/** Backend capability probe: `{ probed, enabled, error, detail }`. */
const $status = atom({ probed: false, enabled: false, error: null, detail: null })

/** Preferences (mirrored to `ctx.storage` — never trace content). */
const $viewMode = atom('waterfall')
const $filters = atom({ kind: '', status: '', query: '' })
const $selectedSpanId = atom(null)
const $selectedTraceId = atom(null)
const $paneVisible = atom(true)
const $debugReveal = atom(false)
const $batchSize = atom(ROW_BATCH)

/** Derived: is the backend answering? */
const $backendOn = computed($status, (s) => !!(s && s.probed && s.enabled))

/** Derived: the chart the docked pane renders (focused session, live). */
const $paneLayout = computed([$state, host.state.focusedSessionId, $filters, $nowMs], (store, sid, filters, now) => {
  const target = { sessionId: sid || null }
  let layout = computeLayout(store, target, filters, now)
  if (!layout.rows.length && !sid) {
    // No focused session yet: fall back to the newest live turn in the store.
    const sessions = knownSessions(store)
    if (sessions.length) layout = computeLayout(store, { sessionId: sessions[0] }, filters, now)
  }
  return layout
})

/** Derived: the chart the /trace page renders (selected trace, else live). */
const $pageLayout = computed(
  [$state, $selectedTraceId, $filters, $nowMs, host.state.focusedSessionId],
  (store, traceId, filters, now, sid) => {
    if (traceId) return computeLayout(store, { traceId }, filters, now)
    return computeLayout(store, { sessionId: sid || null }, filters, now)
  }
)

/** Derived: the currently inspected span. */
const $selectedSpan = computed([$state, $selectedSpanId], (store, spanId) => (spanId && store.spans[spanId] ? store.spans[spanId] : null))

/** Derived: the raw ring buffer for the session the user is looking at. */
const $debugEvents = computed([$state, host.state.focusedSessionId], (store, sid) => {
  const key = sid || '(no session)'
  const own = pickList(store.events[key])
  if (own) return { session_id: sid || null, events: own }
  const keys = Object.keys(store.events)
  if (!keys.length) return { session_id: null, events: [] }
  let bestKey = keys[0]
  let bestLen = (pickList(store.events[bestKey]) || []).length
  for (const k of keys) {
    const len = (pickList(store.events[k]) || []).length
    if (len > bestLen) {
      bestLen = len
      bestKey = k
    }
  }
  return { session_id: bestKey === '(no session)' ? null : bestKey, events: pickList(store.events[bestKey]) || [] }
})

/** ctx handle + REST door, captured in `register` (components need them). */
let CTX = null
let REST = null

/** Dispatch one gateway event / backend frame through the pure reducer. */
function dispatch(raw) {
  const now = Date.now()
  const next = reconcileStale(ingest($state.get(), raw, now), now)
  $state.set(next)
}

/** Merge a REST snapshot (trace + spans) into the store. */
function mergeSnapshot(trace, spans) {
  const now = Date.now()
  const next = reconcileStale(mergeTraceSnapshot($state.get(), trace, spans, now), now)
  $state.set(next)
}

/** Drop backend-origin traces (after the store is cleared server-side). */
function clearBackendSpans() {
  const store = $state.get()
  const spans = {}
  const traces = {}
  for (const id in store.spans) {
    const s = store.spans[id]
    if (s && s.origin === 'backend') continue
    spans[id] = s
  }
  for (const id in store.traces) {
    const t = store.traces[id]
    if (t && t.origin === 'backend') continue
    traces[id] = t
  }
  $state.set({ ...store, spans, traces, updatedAt: Date.now() })
}

function readStored(key, fallback) {
  try {
    const v = CTX && CTX.storage ? CTX.storage.get(key) : null
    return v == null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function writeStored(key, value) {
  try {
    if (CTX && CTX.storage) CTX.storage.set(key, value)
  } catch (e) {
    /* storage is a preference cache; a failure must never break the pane */
  }
}

function applyStoredPrefs() {
  const mode = readStored(KEY_VIEW_MODE, 'waterfall')
  $viewMode.set(mode === 'tree' ? 'tree' : 'waterfall')

  const stored = readStored(KEY_FILTERS, null)
  if (isObj(stored)) {
    $filters.set({
      kind: pickStr(stored.kind) || '',
      status: pickStr(stored.status) || '',
      query: ''
    })
  }
  $paneVisible.set(readStored(KEY_PANE_VISIBLE, true) !== false)
  $debugReveal.set(readStored(KEY_DEBUG, false) === true)
  const batch = pickNum(readStored(KEY_BATCH, ROW_BATCH))
  $batchSize.set(clamp(batch == null ? ROW_BATCH : batch, 20, 400))
}

function setViewMode(mode) {
  const next = mode === 'tree' ? 'tree' : 'waterfall'
  $viewMode.set(next)
  writeStored(KEY_VIEW_MODE, next)
}

function setFilters(patch) {
  const next = { ...$filters.get(), ...(isObj(patch) ? patch : {}) }
  $filters.set(next)
  writeStored(KEY_FILTERS, { kind: next.kind, status: next.status })
}

function setDebugReveal(on) {
  $debugReveal.set(on === true)
  writeStored(KEY_DEBUG, on === true)
}

function setBatchSize(n) {
  const next = clamp(pickNum(n) ?? ROW_BATCH, 20, 400)
  $batchSize.set(next)
  writeStored(KEY_BATCH, next)
}

/**
 * The first-run capability probe: exactly one `GET /status`. A failure is a
 * normal state (the agent half is off, or the gateway predates the routes) and
 * degrades the plugin to live-event-only. It never throws out of `register`.
 */
function probeBackend() {
  if (!REST) {
    $status.set({ probed: true, enabled: false, error: 'rest door unavailable', detail: null })
    return
  }
  Promise.resolve()
    .then(() => REST('/status'))
    .then((res) => {
      if (!isObj(res)) {
        $status.set({ probed: true, enabled: false, error: 'empty /status', detail: null })
        return
      }
      $status.set({ probed: true, enabled: res.enabled === true, error: null, detail: res })
    })
    .catch((err) => {
      $status.set({ probed: true, enabled: false, error: messageOf(err), detail: null })
    })
}

function invalidateTraces() {
  try {
    queryClient.invalidateQueries({ queryKey: ['agent-trace', 'traces'] })
    queryClient.invalidateQueries({ queryKey: ['agent-trace', 'trace'] })
  } catch (e) {
    /* the query client is app-owned; a throw here must not break a click */
  }
}

async function clearStoreAndRefresh() {
  if (!REST) throw new Error('rest door unavailable')
  const res = await REST('/traces?confirm=true', { method: 'DELETE' })
  clearBackendSpans()
  invalidateTraces()
  return res
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. QUERIES — the app's React Query client; never a hand-rolled poll loop
// ─────────────────────────────────────────────────────────────────────────────

const TRACES_KEY = ['agent-trace', 'traces']
const TRACE_KEY = (id) => ['agent-trace', 'trace', id]
const BLOB_KEY = (id) => ['agent-trace', 'blob', id]
const STATUS_KEY = ['agent-trace', 'status']

/** `GET /traces` — newest first, filtered by session. */
function useTraceList(sessionId) {
  const on = useValue($backendOn)
  return useQuery({
    queryKey: TRACES_KEY.concat([sessionId || '']),
    enabled: on,
    // Polling fallback: `ctx.socket` is a no-op on OAuth remotes, so the list
    // must not depend on the live frames to stay current.
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
    staleTime: 3000,
    retry: 1,
    queryFn: async () => {
      if (!REST) return []
      const path = sessionId ? '/traces?session_id=' + encodeURIComponent(sessionId) + '&limit=50' : '/traces?limit=50'
      const res = await REST(path)
      const list = pickList(res) || []
      list.sort((a, b) => (pickNum(b.started_at) ?? 0) - (pickNum(a.started_at) ?? 0))
      return list
    }
  })
}

/** `GET /traces/{id}` — the full trace plus its flat spans, merged into the store. */
function useTraceDetail(traceId) {
  const on = useValue($backendOn)
  return useQuery({
    queryKey: TRACE_KEY(traceId || 'none'),
    enabled: on && !!traceId,
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
    staleTime: 3000,
    retry: 1,
    queryFn: async () => {
      if (!REST || !traceId) return null
      const res = await REST('/traces/' + encodeURIComponent(traceId))
      if (!isObj(res)) return null
      mergeSnapshot(res, res.spans)
      return res
    }
  })
}

/** `GET /status` — re-read while a settings page is open. */
function useStatusDetail(enabled) {
  return useQuery({
    queryKey: STATUS_KEY,
    enabled: !!enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 2000,
    retry: 1,
    queryFn: async () => {
      if (!REST) return null
      const res = await REST('/status')
      if (isObj(res)) $status.set({ probed: true, enabled: res.enabled === true, error: null, detail: res })
      return res
    }
  })
}

/** `GET /blobs/{id}` — lazily, only once a span with a blob ref is selected. */
function useBlob(blobId) {
  const on = useValue($backendOn)
  return useQuery({
    queryKey: BLOB_KEY(blobId || 'none'),
    enabled: on && !!blobId,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      if (!REST || !blobId) return null
      const res = await REST('/blobs/' + encodeURIComponent(blobId))
      return isObj(res) ? res : null
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SHARED UI PIECES — small components, one job each
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The waterfall / tree plot.
 *
 * Geometry is CSS-driven: the SVG maps `viewBox="0 0 100 N"` (N rendered rows)
 * onto a grid cell whose height comes from the row stack beside it, so a pane
 * resize needs no measurement and no `ResizeObserver`. Bars are percentage
 * rects; tree connectors are thin rects (fill, never stroke, because
 * `preserveAspectRatio="none"` scales the two axes independently).
 */
function SpanChart({ layout, mode, limit, selectedId, onSelect, t }) {
  const rows = layout.rows.slice(0, limit)
  const count = rows.length
  const chartHeight = count > 0 ? count * 1.5 + 'rem' : '0rem'

  const connectors = []
  if (mode === 'tree') {
    const indexById = {}
    for (let i = 0; i < rows.length; i += 1) indexById[rows[i].id] = i
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      if (row.depth <= 0 || row.parentOffsetPct == null) continue
      const pid = row.span.parent_id
      const parentIndex = pid ? indexById[pid] : null
      if (parentIndex == null) continue
      const x = row.parentOffsetPct
      const top = Math.min(parentIndex, i)
      const height = Math.abs(i - parentIndex) || 0
      connectors.push(
        jsx('rect', {
          key: 'v-' + row.id,
          x: x,
          y: top,
          width: 0.12,
          height: Math.max(1, height),
          style: { fill: 'var(--ui-stroke-secondary)' }
        })
      )
      connectors.push(
        jsx('rect', {
          key: 'h-' + row.id,
          x: Math.min(x, row.offsetPct),
          y: i + 0.46,
          width: Math.max(0.12, Math.abs(row.offsetPct - x)),
          height: 0.08,
          style: { fill: 'var(--ui-stroke-secondary)' }
        })
      )
    }
  }

  const svgChildren = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const selected = row.id === selectedId
    svgChildren.push(
      jsx('rect', {
        key: 'hit-' + row.id,
        x: 0,
        y: i,
        width: 100,
        height: 1,
        style: { fill: 'transparent' },
        className: 'cursor-pointer',
        onClick: () => onSelect(row.id)
      })
    )
    const bar = jsxs(
      'g',
      {
        children: [
          jsx('rect', {
            x: row.offsetPct,
            y: i + 0.24,
            width: row.widthPct,
            height: 0.52,
            rx: 1,
            style: { fill: statusColor(row.span.status) },
            opacity: row.span.status === SPAN_STATUS.CANCELLED ? 0.5 : 0.9
          }),
          row.running
            ? jsx('animate', {
                attributeName: 'opacity',
                values: '0.95;0.4;0.95',
                dur: '1.4s',
                repeatCount: 'indefinite'
              })
            : null,
          jsx('title', { children: row.span.name || row.span.id })
        ]
      },
      'bar-' + row.id
    )
    svgChildren.push(bar)
    if (selected) {
      svgChildren.push(
        jsx('rect', {
          key: 'sel-' + row.id,
          x: row.offsetPct,
          y: i + 0.1,
          width: row.widthPct,
          height: 0.8,
          rx: 1,
          style: { fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 0.06 }
        })
      )
    }
  }

  const axis = [0, 0.25, 0.5, 0.75, 1].map((f, idx) =>
    jsx('span', {
      key: 'tick-' + idx,
      className: cn('tabular-nums text-[0.6rem] text-(--ui-text-quaternary)', idx === 4 && 'text-right'),
      children: fmtDuration(layout.totalMs * f)
    })
  )

  const ticks = jsx('span', {
    className: 'grid flex-1 grid-cols-5',
    children: axis
  })

  return jsxs('div', {
    className: 'flex w-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-stroke-secondary) pb-0.5',
        children: [
          jsx('span', { className: 'w-14 shrink-0 text-[0.6rem] text-(--ui-text-quaternary)', children: t('axisOffset') }),
          ticks,
          jsx('span', { className: 'w-16 shrink-0 text-right text-[0.6rem] text-(--ui-text-quaternary)', children: t('axisDuration') })
        ]
      }),
      jsxs('div', {
        className: 'grid grid-cols-[minmax(7rem,14rem)_minmax(0,1fr)] items-start',
        children: [
          jsx('div', {
            className: 'flex flex-col',
            children: rows.map((row) =>
              jsxs(
                'div',
                {
                  key: 'label-' + row.id,
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => onSelect(row.id),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(row.id)
                    }
                  },
                  className: cn(
                    'flex h-6 min-w-0 cursor-pointer items-center gap-1.5 pr-2',
                    row.id === selectedId ? 'bg-(--chrome-action)' : 'hover:bg-(--chrome-action-hover)'
                  ),
                  children: [
                    jsx('span', { className: 'shrink-0', style: { width: row.depth * 10 }, children: null }),
                    jsx('span', {
                      className: 'shrink-0 text-[0.6rem] tabular-nums text-(--ui-text-quaternary)',
                      children: row.offsetMs > 0 ? '+' + fmtDuration(row.offsetMs) : ''
                    }),
                    jsx(Codicon, {
                      name: KIND_CODICON[row.span.kind] || 'circle-outline',
                      size: '0.7rem',
                      className: 'shrink-0 text-(--ui-text-tertiary)'
                    }),
                    jsx(Tip, {
                      label: row.span.name || row.span.id,
                      children: jsx('span', {
                        className: cn(
                          'min-w-0 flex-1 truncate text-[0.6875rem]',
                          row.span.status === SPAN_STATUS.ERROR ? 'text-(--ui-error)' : 'text-(--ui-text-secondary)'
                        ),
                        children: row.span.name || row.span.id
                      })
                    }),
                    row.degraded
                      ? jsx(Badge, { variant: 'outline', size: 'xs', className: 'shrink-0', children: t('badgeFlat') })
                      : null,
                    row.span.meta && row.span.meta.stale
                      ? jsx(Badge, { variant: 'outline', size: 'xs', className: 'shrink-0', children: t('badgeStale') })
                      : null,
                    row.span.meta && row.span.meta.risk && row.span.meta.risk.risk
                      ? jsx(Badge, { variant: 'destructive', size: 'xs', className: 'shrink-0', children: String(row.span.meta.risk.risk) })
                      : null
                  ]
                },
                row.id + '|' + row.span.kind
              )
            )
          }),
          jsx('div', {
            className: 'relative min-w-0',
            style: { height: chartHeight },
            children: jsx('svg', {
              className: 'absolute inset-0 h-full w-full',
              viewBox: '0 0 100 ' + Math.max(1, count),
              preserveAspectRatio: 'none',
              'aria-hidden': 'true',
              children: connectors.concat(svgChildren)
            })
          })
        ]
      }),
      count === 0
        ? jsx('div', { className: 'px-2 py-3', children: jsx(EmptyState, { title: t('noSpansTitle'), description: t('noSpansHint') }) })
        : null
    ]
  })
}

/** The row of duration / status facts under a chart header. */
function ChartTotals({ layout, t }) {
  const kinds = Object.keys(layout.counts)
  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-1.5 text-[0.625rem] text-(--ui-text-quaternary)',
    children: [
      jsx('span', {
        children: t('chartSummary', fmtCount(layout.rows.length), fmtCount(layout.spanCount), fmtDuration(layout.totalMs))
      }),
      layout.running
        ? jsx(Badge, { variant: 'default', size: 'xs', children: t('chartRunning', fmtCount(layout.running)) })
        : null,
      layout.degraded
        ? jsx(Badge, { variant: 'outline', size: 'xs', children: t('chartDegraded', fmtCount(layout.degraded)) })
        : null,
      layout.filteredOut
        ? jsx(Badge, { variant: 'muted', size: 'xs', children: t('chartFiltered', fmtCount(layout.filteredOut)) })
        : null,
      layout.truncated
        ? jsx(Badge, { variant: 'outline', size: 'xs', children: t('chartTruncated', fmtCount(MAX_LAYOUT_ROWS)) })
        : null,
      ...kinds.map((k) => jsx(Badge, { key: 'k-' + k, variant: 'outline', size: 'xs', children: k + ' ' + fmtCount(layout.counts[k]) }))
    ]
  })
}

/**
 * View-mode switch + filters for the /trace page. The docked pane stays an
 * unfiltered waterfall on purpose: it is the live view, and its 260px height
 * belongs to spans, not to controls.
 */
function FilterBar({ t }) {
  const filters = useValue($filters)
  const mode = useValue($viewMode)
  const layout = useValue($pageLayout)
  const kinds = Object.keys(layout.counts)
  const statuses = Object.keys(layout.statusCounts)
  const kindOptions = [{ id: '', label: t('filterAll') }].concat(kinds.map((k) => ({ id: k, label: k })))

  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-2',
    children: [
      jsx(SegmentedControl, {
        value: mode,
        onChange: (v) => setViewMode(v),
        options: [
          { id: 'waterfall', label: t('viewWaterfall') },
          { id: 'tree', label: t('viewTree') }
        ]
      }),
      jsx(SearchField, {
        placeholder: t('filterName'),
        value: filters.query,
        onChange: (v) => setFilters({ query: v }),
        containerClassName: 'w-44'
      }),
      jsx(SegmentedControl, {
        value: filters.kind,
        onChange: (v) => setFilters({ kind: v }),
        options: kindOptions
      }),
      jsx(SegmentedControl, {
        value: filters.status,
        onChange: (v) => setFilters({ status: v }),
        options: [{ id: '', label: t('filterAll') }].concat(statuses.map((s) => ({ id: s, label: s })))
      })
    ]
  })
}

/** One-line honesty note when the backend cannot answer. */
function BackendOffLine({ t }) {
  const status = useValue($status)
  if (!status.probed || status.enabled) return null
  return jsx('div', {
    className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
    children: t('backendOff')
  })
}

function KvRow({ label, value, mono }) {
  return jsxs('div', {
    className: 'grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-2 text-[0.6875rem]',
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', {
        className: cn('min-w-0 break-words text-(--ui-text-secondary)', mono && 'font-mono tabular-nums'),
        children: value
      })
    ]
  })
}

/**
 * The detail inspector for one span: identity, timings, tokens, cost, error,
 * and — when a Python backend answers — the args/result blob fetched lazily
 * through `GET /blobs/{blob_id}`.
 */
function SpanInspector({ compact, t }) {
  const span = useValue($selectedSpan)
  const backendOn = useValue($backendOn)
  const [blobKind, setBlobKind] = useState('result')

  // Every hook runs unconditionally before the no-selection return, so a span
  // disappearing under the inspector (filters, a new trace) cannot desync the
  // hook order.
  const argsRef = span ? pickStr(span.args_ref) : null
  const resultRef = span ? pickStr(span.result_ref) : null
  const hasArgs = !!argsRef
  const hasResult = !!resultRef
  const activeKind = blobKind === 'args' && hasArgs ? 'args' : hasResult ? 'result' : hasArgs ? 'args' : null
  const blobId = activeKind === 'args' ? argsRef : activeKind === 'result' ? resultRef : null
  const blob = useBlob(blobId)

  if (!span) {
    return jsx('div', {
      className: 'flex h-full items-start justify-center pt-4',
      children: jsx(EmptyState, { title: t('noSelectionTitle'), description: t('noSelectionHint') })
    })
  }

  const errorText = isObj(span.error)
    ? (pickStr(span.error.type) ? span.error.type + ': ' : '') + (pickStr(span.error.message) || '')
    : null
  const meta = isObj(span.meta) ? span.meta : {}
  const risk = isObj(meta.risk) ? meta.risk : null
  const progress = isObj(meta.progress) ? meta.progress : null
  const filesRead = pickList(meta.files_read) || []
  const filesWritten = pickList(meta.files_written) || []

  const body = blob.data
  let bodyText = ''
  if (body) {
    const encoding = pickStr(body.encoding)
    if (encoding === 'text' && typeof body.body === 'string') bodyText = body.body
    else bodyText = jsonPreview(body.body !== undefined ? body.body : body, compact ? 1200 : 6000)
  }

  const blobControls = hasArgs || hasResult
    ? jsx(SegmentedControl, {
        value: activeKind || 'result',
        onChange: (v) => setBlobKind(v),
        options: [
          ...(hasArgs ? [{ id: 'args', label: t('blobArgs') }] : []),
          ...(hasResult ? [{ id: 'result', label: t('blobResult') }] : [])
        ]
      })
    : null

  return jsxs('div', {
    className: 'flex min-h-0 flex-col gap-2 p-2 text-[0.6875rem]',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Codicon, {
            name: KIND_CODICON[span.kind] || 'circle-outline',
            size: '0.8rem',
            className: 'shrink-0 text-(--ui-text-tertiary)'
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate font-medium text-(--ui-text-secondary)',
            children: span.name || span.id
          }),
          span.status === SPAN_STATUS.RUNNING
            ? jsx(DecodeText, { text: span.status, className: 'shrink-0 text-[0.625rem] text-(--ui-accent)' })
            : jsx(Badge, { variant: statusBadgeVariant(span.status), size: 'xs', children: span.status })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-0.5',
        children: [
          jsx(KvRow, { label: t('detailKind'), value: pickStr(span.kind) || '—' }),
          jsx(KvRow, { label: t('detailId'), value: span.id, mono: true }),
          jsx(KvRow, { label: t('detailTrace'), value: span.trace_id || '—', mono: true }),
          jsx(KvRow, { label: t('detailParent'), value: span.parent_id || '—', mono: true }),
          jsx(KvRow, { label: t('detailDepth'), value: String(pickNum(span.depth) ?? 0), mono: true }),
          jsx(KvRow, { label: t('detailStarted'), value: fmtClock(span.started_at), mono: true }),
          jsx(KvRow, { label: t('detailDuration'), value: fmtDuration(span.duration_ms), mono: true }),
          jsx(KvRow, { label: t('detailTokens'), value: fmtTokens(span.tokens), mono: true }),
          jsx(KvRow, { label: t('detailCost'), value: fmtCost(span.cost_usd), mono: true }),
          jsx(KvRow, { label: t('detailOrigin'), value: span.origin === 'backend' ? t('originBackend') : t('originLive') }),
          risk && risk.risk ? jsx(KvRow, { label: t('detailRisk'), value: String(risk.risk) }) : null,
          progress && (progress.percent != null || progress.message)
            ? jsx(KvRow, {
                label: t('detailProgress'),
                value: (progress.percent != null ? compactKey(progress.percent) + ' ' : '') + (progress.message || '')
              })
            : null,
          meta.blocked_by ? jsx(KvRow, { label: t('detailBlockedBy'), value: String(meta.blocked_by) }) : null,
          risk && pickList(risk.findings) ? jsx(KvRow, { label: t('detailFindings'), value: fmtCount((risk.findings || []).length) + ' ' + t('items') }) : null,
          filesRead.length ? jsx(KvRow, { label: t('detailFilesRead'), value: filesRead.slice(0, 6).join('\n') }) : null,
          filesWritten.length ? jsx(KvRow, { label: t('detailFilesWritten'), value: filesWritten.slice(0, 6).join('\n') }) : null,
          meta.output_tail ? jsx(KvRow, { label: t('detailOutputTail'), value: meta.output_tail }) : null
        ]
      }),
      errorText
        ? jsxs('div', {
            className: 'flex flex-col gap-0.5 rounded border border-(--ui-stroke-secondary) p-1.5',
            children: [
              jsxs('div', { className: 'flex items-center gap-1.5 text-(--ui-error)', children: [
                jsx(Codicon, { name: 'error', size: '0.7rem' }),
                jsx('span', { children: t('detailError') })
              ] }),
              jsx('div', { className: 'break-words text-(--ui-text-secondary)', children: errorText })
            ]
          })
        : null,
      (hasArgs || hasResult) && backendOn
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-2',
                children: [
                  jsx('span', { className: 'text-(--ui-text-quaternary)', children: t('blobTitle') }),
                  blobControls
                ]
              }),
              blob.isPending
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('blobLoading') })
                : blob.isError
                  ? jsx('div', { className: 'text-(--ui-error)', children: t('blobError', messageOf(blob.error)) })
                  : bodyText
                    ? jsxs('div', {
                        className: 'flex flex-col gap-1',
                        children: [
                          jsx(LogView, { className: compact ? 'max-h-40' : 'max-h-96', children: bodyText }),
                          jsxs('div', {
                            className: 'flex items-center gap-2 text-[0.625rem] text-(--ui-text-quaternary)',
                            children: [
                              jsx('span', { className: 'flex-1', children: t('blobMeta', fmtCount(body && body.chars), body && body.truncated ? t('yes') : t('no'), fmtCount(body && body.redactions)) }),
                              jsx(CopyButton, { text: bodyText, className: 'h-6 px-1.5 text-[0.625rem]', label: t('copyBlob') })
                            ]
                          })
                        ]
                      })
                    : jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('blobEmpty') })
            ]
          })
        : (hasArgs || hasResult)
          ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('blobBackendOff') })
          : null,
      jsx('div', {
        className: 'flex items-center gap-2',
        children: jsx(CopyButton, {
          text: jsonPreview(span, 4000),
          className: 'h-6 px-1.5 text-[0.625rem]',
          label: t('copySpan')
        })
      })
    ]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE DOCKED PANE — the focused session's live waterfall
// ─────────────────────────────────────────────────────────────────────────────

function TracePane() {
  const t = usePluginI18n(ID)
  const layout = useValue($paneLayout)
  const sid = useValue(host.state.focusedSessionId)
  const selectedId = useValue($selectedSpanId)
  const status = useValue($status)
  const state = useValue($state)
  // The pane's own batch budget: small so a 260px pane paints instantly, and
  // independent of the page's row-batch preference.
  const [shown, setShown] = useState(PANE_BATCH)
  const generating = sid ? state.generating[sid] : null
  const usage = sid ? state.usage[sid] : null

  const running = layout.rows.filter((r) => r.running)
  const newestRunning = running.length ? running[running.length - 1] : null

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-1.5 p-2',
    style: { minWidth: 0 },
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Codicon, { name: 'graph', size: '0.8rem', className: 'text-(--ui-text-tertiary)' }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-secondary)',
            children: sid ? shortId(sid) : t('noFocusedSession')
          }),
          generating ? jsx(Badge, { variant: 'default', size: 'xs', children: t('generating', generating) }) : null,
          usage ? jsx('span', { className: 'tabular-nums text-[0.625rem] text-(--ui-text-quaternary)', children: fmtTokens({ input: usage.input_tokens, output: usage.output_tokens, reasoning: usage.reasoning_tokens }) }) : null,
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            className: cn(
              'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[0.625rem]',
              'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
            ),
            onClick: () => {
              haptic('tap')
              host.navigate(TRACE_PATH)
            },
            children: t('openPage')
          })
        ]
      }),
      jsx(ChartTotals, { layout, t }),
      newestRunning
        ? jsx('button', {
            type: 'button',
            className: 'w-fit text-[0.625rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            onClick: () => {
              haptic('tap')
              $selectedSpanId.set(newestRunning.span.id)
            },
            children: t('inspectRunning', newestRunning.span.name || newestRunning.span.id)
          })
        : null,
      jsxs('div', {
        className: 'min-h-0 flex-1 overflow-auto',
        style: { minWidth: 0 },
        children: [
          jsx(BackendOffLine, { t }),
          jsx(SpanChart, {
            layout,
            mode: 'waterfall',
            limit: shown,
            selectedId,
            onSelect: (id) => {
              haptic('tap')
              $selectedSpanId.set(id)
            },
            t
          }),
          layout.rows.length > shown
            ? jsx('button', {
                type: 'button',
                className: 'mt-1 text-[0.625rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
                onClick: () => setShown(shown + PANE_BATCH),
                children: t('showMore', fmtCount(layout.rows.length - shown))
              })
            : null
        ]
      }),
      jsx('div', {
        className: 'max-h-32 min-h-0 overflow-auto border-t border-(--ui-stroke-secondary)',
        children: jsx(SpanInspector, { compact: true, t })
      }),
      status.probed && !status.enabled && status.error
        ? jsx('div', { className: 'text-[0.5625rem] text-(--ui-text-quaternary)', children: t('probeFailed', status.error) })
        : null
    ]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE /trace PAGE — history browser + trace detail
// ─────────────────────────────────────────────────────────────────────────────

function TraceListItem({ entry, selected, onOpen, t }) {
  const totals = isObj(entry.totals) ? entry.totals : {}
  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    onClick: () => onOpen(entry.id),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(entry.id)
      }
    },
    className: cn(
      'flex min-w-0 cursor-pointer flex-col gap-0.5 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
      selected ? 'bg-(--chrome-action)' : 'hover:bg-(--chrome-action-hover)'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx(Badge, { variant: statusBadgeVariant(entry.status), size: 'xs', children: entry.status || '—' }),
          jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-secondary)', children: fmtClock(entry.started_at) + ' · ' + fmtDuration(entry.duration_ms) }),
          jsx('span', { className: 'shrink-0 text-[0.6rem] text-(--ui-text-quaternary)', children: fmtCost(totals.cost_usd) })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-1.5 text-[0.6rem] text-(--ui-text-quaternary)',
        children: [
          jsx('span', { className: 'min-w-0 flex-1 truncate font-mono', children: shortId(entry.id) }),
          jsx('span', { children: t('listTools', fmtCount(totals.tool_calls)) }),
          jsx('span', { children: t('listSubagents', fmtCount(totals.subagents)) })
        ]
      }),
      jsxs('div', {
        className: 'truncate text-[0.6rem] text-(--ui-text-quaternary)',
        children: [shortId(entry.session_id || '—'), entry.model ? ' · ' + entry.model : '']
      })
    ]
  })
}

function TraceDetail({ traceId, t }) {
  const layout = useValue($pageLayout)
  const limit = useValue($batchSize)
  const selectedId = useValue($selectedSpanId)
  const mode = useValue($viewMode)
  const detail = useTraceDetail(traceId)
  const rows = mode === 'tree' ? orderAsTree(layout.rows) : layout.rows
  const shown = Math.min(limit, rows.length)
  const trace = layout.trace
  const totals = trace && isObj(trace.totals) ? trace.totals : {}

  if (!traceId) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center',
      children: jsx(EmptyState, { title: t('pickTraceTitle'), description: t('pickTraceHint') })
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx(Codicon, { name: 'graph', size: '0.8rem', className: 'text-(--ui-text-tertiary)' }),
              jsx('span', { className: 'font-mono text-[0.6875rem] text-(--ui-text-secondary)', children: traceId }),
              trace ? jsx(Badge, { variant: statusBadgeVariant(trace.status), size: 'xs', children: trace.status }) : null,
              trace && trace.model ? jsx(Badge, { variant: 'outline', size: 'xs', children: trace.model }) : null,
              trace && trace.capture_mode ? jsx(Badge, { variant: 'outline', size: 'xs', children: trace.capture_mode }) : null,
              jsx('span', { className: 'flex-1' }),
              detail.isFetching
                ? jsx(Codicon, { name: 'sync', size: '0.7rem', className: 'animate-spin text-(--ui-text-quaternary)' })
                : null
            ]
          }),
          trace
            ? jsxs('div', {
                className: 'flex flex-wrap gap-x-3 gap-y-0.5 text-[0.625rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { children: t('detailSession') + ' ' + shortId(trace.session_id || '—') }),
                  jsx('span', { children: t('detailStarted') + ' ' + fmtClock(trace.started_at) }),
                  jsx('span', { children: t('detailDuration') + ' ' + fmtDuration(trace.duration_ms) }),
                  jsx('span', { children: t('totalsTokens', fmtCount(totals.input_tokens), fmtCount(totals.output_tokens)) }),
                  jsx('span', { children: t('detailCost') + ' ' + fmtCost(totals.cost_usd) }),
                  jsx('span', { children: t('totalsCalls', fmtCount(totals.api_calls), fmtCount(totals.tool_calls), fmtCount(totals.subagents)) })
                ]
              })
            : null,
          jsx(FilterBar, { t }),
          jsx(ChartTotals, { layout, t })
        ]
      }),
      jsxs('div', {
        className: 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] gap-2',
        children: [
          jsx(ScrollArea, {
            className: 'min-h-0',
            children: jsxs('div', {
              children: [
                jsx(SpanChart, {
                  layout,
                  mode,
                  limit: shown,
                  selectedId,
                  onSelect: (id) => {
                    haptic('tap')
                    $selectedSpanId.set(id)
                  },
                  t
                }),
                rows.length > shown
                  ? jsx('button', {
                      type: 'button',
                      className: 'mt-1 text-[0.625rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
                      onClick: () => setBatchSize(Math.min(shown + ROW_BATCH, 400)),
                      children: t('showMore', fmtCount(rows.length - shown))
                    })
                  : null
              ]
            })
          }),
          jsx(ScrollArea, {
            className: 'min-h-0 border-l border-(--ui-stroke-secondary)',
            children: jsx(SpanInspector, { compact: false, t })
          })
        ]
      })
    ]
  })
}

function TracePage() {
  const t = usePluginI18n(ID)
  const backendOn = useValue($backendOn)
  const status = useValue($status)
  const selectedTraceId = useValue($selectedTraceId)
  const store = useValue($state)
  const [sessionFilter, setSessionFilter] = useState('')
  const [query, setQuery] = useState('')

  const list = useTraceList(sessionFilter)
  const sessions = knownSessions(store)
  const entries = (list.data || []).filter((e) => {
    if (!isObj(e)) return false
    if (!query) return true
    const hay = String(e.id || '') + ' ' + String(e.session_id || '') + ' ' + String(e.model || '')
    return hay.toLowerCase().indexOf(query.toLowerCase()) >= 0
  })

  const openTrace = (id) => {
    haptic('tap')
    $selectedTraceId.set(id)
    $selectedSpanId.set(null)
  }

  const noBackend = status.probed && !status.enabled

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsx(Codicon, { name: 'graph', size: '0.9rem', className: 'text-(--ui-text-tertiary)' }),
          jsx('span', { className: 'text-[0.8125rem] font-medium text-(--ui-text-secondary)', children: t('pageTitle') }),
          jsx('span', { className: 'flex-1' }),
          jsx(SearchField, {
            placeholder: t('searchTraces'),
            value: query,
            onChange: (v) => setQuery(v),
            containerClassName: 'w-52'
          }),
          jsx(SegmentedControl, {
            value: sessionFilter,
            onChange: (v) => setSessionFilter(v),
            options: [{ id: '', label: t('allSessions') }].concat(
              sessions.slice(0, 8).map((sid) => ({ id: sid, label: shortId(sid) }))
            )
          }),
          backendOn
            ? jsx('button', {
                type: 'button',
                className: cn('inline-flex h-6 items-center gap-1 rounded px-1.5 text-[0.6875rem]', 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'),
                onClick: () => {
                  haptic('tap')
                  list.refetch()
                  invalidateTraces()
                },
                children: jsx(Codicon, { name: 'refresh', size: '0.75rem' })
              })
            : null
        ]
      }),
      jsxs('div', {
        className: 'grid min-h-0 flex-1 grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]',
        children: [
          jsx(ScrollArea, {
            className: 'min-h-0 border-r border-(--ui-stroke-secondary)',
            children: jsxs('div', {
              children: [
                noBackend
                  ? jsx('div', { className: 'border-b border-(--ui-stroke-secondary) p-2', children: jsx(BackendOffLine, { t }) })
                  : null,
                list.isPending
                  ? jsx('div', { className: 'p-3 text-[0.6875rem] text-(--ui-text-quaternary)', children: t('loading') })
                  : list.isError
                    ? jsx('div', { className: 'p-3 text-[0.6875rem] text-(--ui-error)', children: t('tracesError', messageOf(list.error)) })
                    : entries.length === 0
                      ? jsx('div', {
                          className: 'p-3',
                          children: jsx(EmptyState, {
                            title: noBackend ? t('emptyBackendTitle') : t('emptyTracesTitle'),
                            description: noBackend ? t('emptyBackendHint') : t('emptyTracesHint')
                          })
                        })
                      : entries.map((entry) =>
                          jsx(TraceListItem, { entry, selected: entry.id === selectedTraceId, onOpen: openTrace, t }, entry.id)
                        )
              ]
            })
          }),
          jsx(TraceDetail, { traceId: selectedTraceId, t })
        ]
      })
    ]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SETTINGS — capture mode, retention, clear, /status, raw-event debug
// ─────────────────────────────────────────────────────────────────────────────

function GeneralSettings() {
  const t = usePluginI18n(ID)
  const mode = useValue($viewMode)
  const batch = useValue($batchSize)

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx(ListRow, {
        title: t('settingsViewTitle'),
        description: t('settingsViewHint'),
        action: jsx(SegmentedControl, {
          value: mode,
          onChange: (v) => setViewMode(v),
          options: [
            { id: 'waterfall', label: t('viewWaterfall') },
            { id: 'tree', label: t('viewTree') }
          ]
        })
      }),
      jsx(ListRow, {
        title: t('settingsBatchTitle'),
        description: t('settingsBatchHint'),
        action: jsx(SegmentedControl, {
          value: String(batch),
          onChange: (v) => setBatchSize(Number(v)),
          options: [
            { id: '40', label: '40' },
            { id: '60', label: '60' },
            { id: '120', label: '120' },
            { id: '240', label: '240' }
          ]
        })
      })
    ]
  })
}

function BackendSettings() {
  const t = usePluginI18n(ID)
  const q = useStatusDetail(true)
  const status = useValue($status)
  const detail = isObj(q.data) ? q.data : status.detail
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const retention = isObj(detail) && isObj(detail.retention) ? detail.retention : {}

  const doClear = async () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    try {
      const res = await clearStoreAndRefresh()
      setResult(t('clearDone', fmtCount(isObj(res) ? res.cleared : null)))
    } catch (err) {
      setResult(t('clearFailed', messageOf(err)))
    } finally {
      setBusy(false)
      setArmed(false)
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx(BackendOffLine, { t }),
      jsx(ListRow, {
        title: t('settingsStatusTitle'),
        description: detail
          ? t('settingsStatusHint', detail.telemetry_schema_version || '—', detail.enabled ? t('enabled') : t('disabled'))
          : t('settingsStatusUnknown')
      }),
      jsx(ListRow, {
        title: t('settingsCaptureTitle'),
        description: t('settingsCaptureHint'),
        action: jsx(Badge, { variant: 'outline', size: 'default', children: detail && detail.capture_mode ? String(detail.capture_mode) : '—' })
      }),
      jsx(ListRow, {
        title: t('settingsRetentionTitle'),
        description: t('settingsRetentionHint'),
        action: jsx('span', {
          className: 'tabular-nums text-[0.6875rem] text-(--ui-text-secondary)',
          children: t('settingsRetentionValue', fmtCount(retention.traces), fmtCount(retention.mb))
        })
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx(KvRow, { label: t('settingsSpans'), value: detail ? fmtCount(detail.spans_recorded) : '—', mono: true }),
          jsx(KvRow, { label: t('settingsDropped'), value: detail ? fmtCount(detail.dropped) : '—', mono: true }),
          jsx(KvRow, { label: t('settingsStoreBytes'), value: detail ? fmtBytes(detail.store_bytes) : '—', mono: true })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy || !$backendOn.get(),
            onClick: doClear,
            className: cn('h-7 text-[0.6875rem]', armed && 'text-(--ui-error) border-(--ui-error)'),
            children: armed ? t('clearConfirm') : t('clearTraces')
          }),
          armed
            ? jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                className: 'h-7 text-[0.6875rem]',
                onClick: () => setArmed(false),
                children: t('cancel')
              })
            : null,
          result ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: result }) : null
        ]
      }),
      detail && isObj(detail.retention)
        ? jsx(LogView, { className: 'max-h-40', children: jsonPreview(detail, 2000) })
        : null
    ]
  })
}

/**
 * Deliberately hidden diagnostic: the last 50 raw events per session, verbatim.
 * It is the plugin's own tripwire for fields that change under it, so it stays
 * behind a switch instead of in the reader's way.
 */
function DebugSettings() {
  const t = usePluginI18n(ID)
  const debug = useValue($debugReveal)
  const snapshot = useValue($debugEvents)
  const text = useMemo(() => jsonPreview(snapshot, 1200), [snapshot])

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx(ToggleRow, {
        checked: debug,
        label: t('debugToggle'),
        description: t('debugToggleHint'),
        onChange: (on) => setDebugReveal(on)
      }),
      debug
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('span', { className: 'flex-1 text-[0.6875rem] text-(--ui-text-quaternary)', children: t('debugCount', fmtCount(snapshot.events.length), shortId(snapshot.session_id || t('debugNoSession'))) }),
                  jsx(CopyButton, { text, className: 'h-6 px-1.5 text-[0.625rem]', label: t('copyRaw') })
                ]
              }),
              jsx(LogView, { className: 'max-h-96', children: text })
            ]
          })
        : jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: t('debugHidden') })
    ]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

/** Disposer for the docked pane, so the keybind can add/remove it live. */
let paneDisposer = null

/**
 * Plugin-scoped translation for code that runs OUTSIDE a component — notably
 * `ctx.register` payloads, whose strings are read at registration time. Reads
 * the bundle registered a moment earlier, and falls back to the key rather than
 * to a hardcoded English literal.
 */
function pluginT(key, ...args) {
  try {
    if (CTX && CTX.i18n && typeof CTX.i18n.t === 'function') return CTX.i18n.t(key, ...args)
  } catch (e) {
    /* a missing bundle must not break registration */
  }
  return key
}

function clearDockedPane() {
  if (!paneDisposer) return
  try {
    paneDisposer()
  } catch (e) {
    /* already disposed by the loader */
  }
  paneDisposer = null
}

function registerDockedPane() {
  clearDockedPane()
  if (!CTX || !$paneVisible.get()) return
  try {
    paneDisposer = CTX.register({
      id: 'pane',
      area: PANES_AREA,
      title: pluginT('paneTitle'),
      // SPEC section 8: below the conversation, 260px tall.
      data: { placement: 'bottom', dock: { pane: 'workspace', pos: 'bottom' }, height: '260px' },
      render: () => jsx(TracePane, {})
    })
  } catch (e) {
    paneDisposer = null
  }
}

function toggleDockedPane() {
  const next = !$paneVisible.get()
  $paneVisible.set(next)
  writeStored(KEY_PANE_VISIBLE, next)
  registerDockedPane()
  haptic('tap')
  try {
    host.notify({ kind: 'info', message: pluginT('paneToggleToast', pluginT(next ? 'on' : 'off')) })
  } catch (e) {
    /* toasts are best-effort */
  }
  return next
}

export default {
  id: ID,
  name: 'Agent Trace',
  /** Unified-package desktop half: opt-in, matching the agent half's gate. */
  defaultEnabled: false,

  register(ctx) {
    // Never throw out of register(): a broken probe must not roll the plugin back.
    try {
      CTX = ctx
      REST = ctx.rest
      applyStoredPrefs()

      // All strings live here, 'en' only for now.
      ctx.i18n.register({
        en: {
          paneTitle: 'agent trace',
          pageTitle: 'Agent trace',
          navLabel: 'Trace',
          paletteLabel: 'Show agent trace',
          keybindLabel: 'Toggle agent trace pane',
          settingsTitle: 'Agent Trace',
          settingsBackendTitle: 'Backend',
          settingsDebugTitle: 'Debug',
          on: 'on',
          off: 'off',
          paneToggleToast: state => 'agent trace pane ' + state,
          viewWaterfall: 'Waterfall',
          viewTree: 'Tree',
          axisOffset: 'start',
          axisDuration: 'duration',
          filterAll: 'all',
          filterName: 'Filter spans by name',
          chartSummary: (shown, total, dur) => shown + ' of ' + total + ' spans · ' + dur,
          chartRunning: n => n + ' running',
          chartDegraded: n => n + ' flat',
          chartFiltered: n => n + ' filtered out',
          chartTruncated: n => 'showing first ' + n,
          badgeFlat: 'flat',
          badgeStale: 'stale',
          noSpansTitle: 'No spans',
          noSpansHint: 'Nothing has been recorded for this target yet.',
          noFocusedSession: 'no focused session',
          generating: name => 'generating ' + name,
          openPage: 'Open page',
          inspectRunning: name => 'inspect running: ' + name,
          showMore: n => 'Show ' + n + ' more',
          backendOff: 'Backend off — showing live turns only. Enable the agent half in Settings to keep history.',
          probeFailed: err => 'status probe failed: ' + err,
          noSelectionTitle: 'No span selected',
          noSelectionHint: 'Click a row in the chart to inspect it here.',
          detailKind: 'kind',
          detailId: 'span id',
          detailTrace: 'trace',
          detailParent: 'parent',
          detailDepth: 'depth',
          detailStarted: 'started',
          detailDuration: 'duration',
          detailTokens: 'tokens',
          detailCost: 'cost',
          detailOrigin: 'origin',
          detailRisk: 'output risk',
          detailProgress: 'progress',
          detailBlockedBy: 'blocked by',
          detailFindings: 'findings',
          detailFilesRead: 'files read',
          detailFilesWritten: 'files written',
          detailOutputTail: 'output tail',
          detailError: 'error',
          detailSession: 'session',
          originLive: 'live events',
          originBackend: 'backend store',
          items: 'items',
          yes: 'yes',
          no: 'no',
          blobTitle: 'args / result blob',
          blobArgs: 'args',
          blobResult: 'result',
          blobLoading: 'Fetching blob…',
          blobError: err => 'blob fetch failed: ' + err,
          blobEmpty: 'The blob record has no body.',
          blobBackendOff: 'Blob bodies need the agent half — enable it in Settings to read args and results.',
          blobMeta: (chars, truncated, redactions) => chars + ' chars · truncated ' + truncated + ' · ' + redactions + ' redactions',
          copyBlob: 'Copy blob',
          copySpan: 'Copy span',
          copyRaw: 'Copy raw events',
          loading: 'Loading…',
          tracesError: err => 'Could not read traces: ' + err,
          emptyBackendTitle: 'Backend not enabled',
          emptyBackendHint: 'The agent half is off, so nothing is being recorded. Enable it in Settings → Plugins to keep history.',
          emptyTracesTitle: 'No traces yet',
          emptyTracesHint: 'Traces appear here after the next turn is recorded.',
          pickTraceTitle: 'Pick a trace',
          pickTraceHint: 'Choose a turn on the left to render its span graph.',
          listTools: n => n + ' tools',
          listSubagents: n => n + ' subagents',
          allSessions: 'all sessions',
          searchTraces: 'Filter traces',
          totalsTokens: (input, output) => 'tokens in ' + input + ' / out ' + output,
          totalsCalls: (api, tools, subs) => api + ' api · ' + tools + ' tools · ' + subs + ' subagents',
          settingsViewTitle: 'Default view',
          settingsViewHint: 'The shape of the graph when a trace opens. The docked pane always uses the waterfall.',
          settingsBatchTitle: 'Rows per batch',
          settingsBatchHint: 'How many span rows render at once — a 400-span trace never blocks the pane.',
          settingsStatusTitle: 'Backend status',
          settingsStatusHint: (schema, state) => 'schema ' + schema + ' · backend ' + state,
          settingsStatusUnknown: 'No answer from the backend yet.',
          settingsCaptureTitle: 'Capture mode',
          settingsCaptureHint: 'Set by the agent half (capture_mode in its config, or AGENT_TRACE_CAPTURE). Read-only here.',
          settingsRetentionTitle: 'Retention',
          settingsRetentionHint: 'Traces and megabytes kept before oldest-first rotation.',
          settingsRetentionValue: (traces, mb) => traces + ' traces · ' + mb + ' MB',
          settingsSpans: 'spans recorded',
          settingsDropped: 'events dropped',
          settingsStoreBytes: 'store size',
          clearTraces: 'Clear traces',
          clearConfirm: 'Confirm clear',
          clearDone: n => 'Cleared ' + n + ' traces.',
          clearFailed: err => 'Clear failed: ' + err,
          cancel: 'Cancel',
          enabled: 'enabled',
          disabled: 'disabled',
          debugToggle: 'Reveal raw event buffer',
          debugToggleHint: 'Diagnostic only: the last 50 raw events for the focused session, verbatim JSON.',
          debugCount: (n, sid) => n + ' events · ' + sid,
          debugNoSession: 'no session',
          debugHidden: 'The raw buffer is hidden. Turn the switch on to inspect the exact event payloads this plugin consumes.'
        }
      })

      // ── live path 1: gateway events (always available) ──
      for (const type of LIVE_EVENTS) {
        ctx.onEvent(type, (event) => {
          try {
            dispatch(event && isObj(event) ? event : { type, payload: {} })
          } catch (e) {
            /* one malformed payload must never stop the stream */
          }
        })
      }

      // ── live path 2: backend records, incremental cursor poll ──
      // There is no websocket by design: with `plugins.isolation: host` the
      // plugin backend runs out of process, where a websocket upgrade cannot be
      // carried, and `ctx.socket` is a no-op on OAuth remotes anyway. `/live`
      // is the only live door — and still just an accelerator: the React Query
      // reads above remain the contract when this poll cannot run.
      let liveCursor = null
      ctx.setInterval(() => {
        if (!REST || !$backendOn.get()) return
        const path = liveCursor ? '/live?cursor=' + encodeURIComponent(liveCursor) : '/live'
        REST(path)
          .then((res) => {
            if (!isObj(res)) return
            if (typeof res.cursor === 'string') liveCursor = res.cursor
            for (const frame of pickList(res.records) || []) {
              try {
                dispatch(isObj(frame) ? frame : null)
              } catch (e) {
                /* one malformed record must not stop the poll */
              }
            }
          })
          .catch(() => {
            /* the poll is an accelerator; a rejection is swallowed, never an error state */
          })
      }, 1500)

      // ── render clock: running spans grow without polling data ──
      ctx.setInterval(() => {
        const now = Date.now()
        $nowMs.set(now)
        const next = reconcileStale($state.get(), now)
        if (next !== $state.get()) $state.set(next)
      }, 1000)

      // ── contributions ──
      ctx.registerMany([
        {
          id: 'page',
          area: ROUTES_AREA,
          data: { path: TRACE_PATH },
          render: () => jsx(TracePage, {})
        },
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 82,
          data: { path: TRACE_PATH, label: pluginT('navLabel'), codicon: 'graph' }
        },
        {
          id: 'palette',
          area: PALETTE_AREA,
          data: {
            id: 'agent-trace.open',
            label: pluginT('paletteLabel'),
            keywords: ['trace', 'span', 'waterfall', 'jaeger', 'telemetry'],
            action: 'agent-trace.toggle-pane',
            run: () => host.navigate(TRACE_PATH)
          }
        },
        {
          id: 'keybind',
          area: KEYBINDS_AREA,
          data: {
            id: 'agent-trace.toggle-pane',
            label: pluginT('keybindLabel'),
            category: 'view',
            defaults: ['mod+alt+t'],
            run: () => toggleDockedPane()
          }
        }
      ])

      // The docked pane is registered/unregistered so the keybind can toggle it.
      registerDockedPane()

      // Settings ▸ Plugins ▸ Agent Trace (▸ Backend, ▸ Debug).
      if (typeof ctx.registerSettingsPage === 'function') {
        ctx.registerSettingsPage({
          id: 'settings',
          title: pluginT('settingsTitle'),
          icon: 'graph',
          order: 40,
          render: () => jsx(GeneralSettings, {}),
          children: [
            { id: 'backend', title: pluginT('settingsBackendTitle'), render: () => jsx(BackendSettings, {}) },
            { id: 'debug', title: pluginT('settingsDebugTitle'), render: () => jsx(DebugSettings, {}) }
          ]
        })
      }

      // Capability probe: one GET /status, before anything asks for history.
      probeBackend()

      // Whatever the loader misses, the plugin cleans up itself.
      ctx.onDispose(() => {
        clearDockedPane()
        CTX = null
        REST = null
      })
    } catch (e) {
      // `register` must not throw: the loader would roll every contribution
      // back and show a load toast. Degrade to a no-op instead.
      try {
        host.notify({ kind: 'error', message: 'agent-trace: register failed — ' + messageOf(e) })
      } catch (inner) {
        /* nothing left to report with */
      }
    }
  }
}