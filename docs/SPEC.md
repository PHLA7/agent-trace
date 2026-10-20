# agent-trace — frozen interface contract

Both halves implement this. Nothing here is provisional: the Python recorder writes exactly this
shape, and the desktop renderer reads exactly this shape. Change it in one place and both halves
change together, or the tests fail.

Contract version recorded on every trace: `telemetry_schema_version = "hermes.observer.v1"`.

## 1. Span model

```jsonc
// Trace — one user turn
{
  "id": "tr_<turn_id>",              // stable within a session
  "session_id": "…",
  "turn_id": "…",
  "profile": "default",
  "platform": "cli|desktop|telegram|…",
  "model": "…",                      // from the first pre_api_request
  "provider": "…",
  "user_message": "…",               // sanitized, truncated
  "seq": 17,                         // monotonic creation counter, see below
  "started_at": 1750000000.123,      // epoch seconds, float
  "ended_at": 1750000012.456,
  "duration_ms": 12333,
  "status": "running|ok|error|interrupted|compacted",
  "totals": {
    "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
    "cache_write_tokens": 0, "reasoning_tokens": 0,
    "cost_usd": 0.0, "api_calls": 0, "tool_calls": 0, "subagents": 0
  },
  "capture_mode": "metadata|sanitized|full",
  "root": "sp_<turn_id>"
}

// Span — one unit of work
{
  "id": "sp_…",                      // stable; see §2 for the id scheme
  "parent_id": "sp_…|null",
  "trace_id": "tr_…",
  "kind": "turn|llm|tool|subagent|approval|human_input|compaction",
  "name": "…",                       // tool name, model name, child goal, command, …
  "started_at": 1750000000.123,
  "ended_at": 1750000012.456,
  "duration_ms": 12333,
  "status": "running|ok|error|blocked|cancelled",
  "depth": 0,                        // 0 = the turn, 1 = direct child of the turn, …
  "meta": { },                       // kind-specific, see §3
  "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0 },
  "cost_usd": null,
  "args_ref": "bl_…|null",           // id into the blob store
  "result_ref": "bl_…|null",
  "error": { "type": "…", "message": "…" }   // null unless status is error
}
```

Rules that hold everywhere:

- `started_at` / `ended_at` are epoch **seconds as floats**. Not milliseconds, not ISO strings.
- `duration_ms` is an integer. Where core supplies a duration (`duration_ms` on tool hooks,
  `api_duration`, `subagent_stop.duration_ms`) use it; otherwise derive from the timestamps.
- `status` starts `running` and is overwritten exactly once by the closing event. A span with no
  closing event stays `running` and is reconciled at write time by the stale pass (§5).
- `depth` is computed by the writer, never sent by the producer.
- `cost_usd` is `null` unless a pricing table resolves the model. Never invent `0.0` for an
  unknown model; a null is honest, a zero is a lie.
- `seq` is the recorder's monotonic creation counter. It exists because `started_at` alone cannot
  order traces: a platform whose clock ticks coarsely (Windows, ~15.6 ms) hands several traces the
  same timestamp, and "newest first" then falls back to whatever order the shard files were read
  in. Any newest-first listing orders by `(started_at, seq, id)` descending.

## 2. Span id scheme

| Span | id | Parent |
|---|---|---|
| turn | `sp_<turn_id>` | none |
| llm | `sp_api_<api_request_id>` | the turn |
| tool (top level) | `sp_tool_<tool_call_id>` | the turn |
| tool (inside a subagent) | `sp_tool_<tool_call_id>` | that subagent's span |
| subagent | `sp_sub_<child_subagent_id>` | the turn (`parent_subagent_id` if nested) |
| approval | `sp_appr_<session_key_hash>_<started_at>` | the turn active at that time |
| human input | `sp_hi_<request_id>` | the turn active at that time |
| compaction | `sp_compact_<started_at>` | the turn active at that time |

Parent resolution for tool and llm spans:

1. If `task_id` matches a child agent's `task_id` (recorded at `subagent_start`), the parent is that
   subagent span. This is how a child's own tool calls attach to the child.
2. Else if `session_id` matches a child `child_session_id`, same thing.
3. Else the parent is the turn span for `turn_id`.

Child agents run on their own `session_id`, so their own `pre_tool_call` / `post_tool_call` fire
with the child's identity. Rule 1 or 2 is what keeps a child's tools under the child rather than
under the root.

### Degenerate ids

`tool_hook_ids` coerces a missing value to `""`. If `turn_id` or `tool_call_id` is empty, do **not**
collapse every call into one span. Fall back to a synthetic id
`sp_tool_anon_<session_id>_<monotonic_counter>` and group by `session_id`. Record
`meta.correlation: "degraded"` so the UI can say so rather than quietly showing a wrong tree.

## 3. `meta` by kind

| kind | meta keys |
|---|---|
| `turn` | `is_first_turn`, `conversation_length` |
| `llm` | `api_call_count`, `retry_count`, `finish_reason`, `message_count`, `tool_count`, `approx_input_tokens`, `request_chars`, `assistant_content_chars`, `assistant_tool_call_count`, `base_url`, `api_mode`, `model`, `provider` |
| `tool` | `tool_name`, `middleware_trace_len`, `inline_diff` (bool: a diff was attached), `blocked_by` (when a `pre_tool_call` hook blocked it) |
| `subagent` | `role`, `goal`, `subagent_id`, `child_session_id`, `delegation_id`, `api_calls`, `toolsets`, `files_read`, `files_written`, `summary`, `tool_call_history` (metadata-only, passed through verbatim) |
| `approval` | `surface`, `pattern_keys`, `choice`, `description` |
| `human_input` | `kind` (`sudo`\|`clarify`\|`approval`), `outcome`, `platform` |
| `compaction` | `compression_count`, `in_place` |

`files_read` / `files_written` can be long. Cap at 50 entries at write time and set
`meta.files_truncated: true` when clipped.

## 4. Blob store

Arguments and results are stored out of band so a trace payload stays small.

```jsonc
// blob record, one JSON object per line in the same shard file
{ "id": "bl_…", "trace_id": "tr_…", "span_id": "sp_…", "field": "args|result",
  "encoding": "json|text", "chars": 1234, "truncated": false, "redactions": 3,
  "captured_at": 1750000000.123, "body": … }
```

Captured per `capture_mode`:

| mode | structure (ids, names, status, timings, tokens, costs) | content (args, results, prompts) |
|---|---|---|
| `metadata` | yes | replaced by `{"omitted": true, "type": "json\|text", "chars": N, "keys": [...]}` |
| `sanitized` **(default)** | yes | redacted, then truncated |
| `full` | yes | truncated only, explicit opt-in |

Redaction runs **before** truncation, always. Patterns: `sk-…`, `ghp_…`, `gho_…`, `xox[baprs]-…`,
`AKIA…`, JWTs (`eyJ….eyJ….…`), PEM private key blocks, `Authorization: Bearer …` header values,
and `password=` / `token=` / `api_key=` / `secret=` style assignments. Replacement is
`«redacted:<kind>»` so the count is visible in the UI.

Caps: 12000 chars per field, depth 4, 50 collection items, 50 `files_*` entries.

## 5. Storage layout

Everything under the plugin's own data directory, nothing outside it:

```
<plugin dir>/data/
├── traces/
│   └── YYYY-MM-DD/<session_id>.jsonl   # one shard per session per day, holding EVERY record
│                                       # kind, discriminated by a `record` field:
│                                       # "trace" | "span" | "blob"
└── status.json                         # the recorder's self-reported status, atomically swapped
```

One shard per session rather than per kind, because it makes a blob lookup a single-file read
instead of a store-wide scan: a blob is only ever fetched for a trace the caller already holds.

- Append-only JSONL, one record per line, fsync'd on a 1 s flush cadence rather than per event.
- The writer never blocks a hook: hooks push to a bounded `queue.Queue` (default 10000) and a
  daemon thread drains it. `put_nowait`; on `Full`, drop and increment a dropped counter that is
  reported in `GET /status`. Dropping is preferable to stalling a turn.
- **Retention** at write time, checked on the same 1 s tick: keep at most
  `retention.traces` (default 200) traces and `retention.mb` (default 50) megabytes, oldest first.
- Stale reconcile: a span still `running` whose trace ended more than 60 s ago is closed with
  `status: "cancelled"` and `meta.stale: true`. A trace that never received its closing hook at all
  (process death, killed session) is finished as `status: "cancelled"` with `stale: true` on the
  trace, so a crashed turn stays inspectable instead of existing only in memory. A stale span's
  `ended_at` stays `null` and its `duration_ms` is `null`: it ran, but for how long is unknown, and
  a duration derived from "when we gave up" would be invented.

## 6. Backend routes

Mounted at `/api/plugins/agent-trace/`. Read-only by design except the clear action.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/status` | `{ enabled, capture_mode, telemetry_schema_version, spans_recorded, dropped, store_bytes, retention, status_age_s }` — read from the recorder's `status.json` |
| `GET` | `/traces` | `[{ id, session_id, platform, model, started_at, duration_ms, status, totals }]`, newest first. Query: `session_id`, `limit` (default 50), `since` |
| `GET` | `/traces/{trace_id}` | the full `Trace` plus its flat `spans` array (no blob bodies) |
| `GET` | `/blobs/{blob_id}` | one blob record including `body`, redacted per its capture mode. Query: `trace_id` narrows the read to one shard |
| `GET` | `/live` | records written since a cursor. Query: `cursor` (opaque, from the previous response), `session_id`. Returns `{ cursor, records: [{ type, trace?, span?, blob_id? }] }` |
| `DELETE` | `/traces` | clears the store. Requires `?confirm=true`. Returns `{ files, bytes }` |

**There is no WebSocket in v1.** `plugins.isolation: host` runs the plugin backend out of process
and cannot carry a websocket upgrade ("streaming and websockets need in-process" —
`web_server_dashboard.py:829`), and `ctx.socket` is additionally a no-op on OAuth remotes. `/live`
is an incremental poll that works identically in every deployment, so it is the only live channel
and the desktop half needs no special case. A websocket can be added later where in-process
isolation is detected, without changing the desktop half.

`/live` frames use the same vocabulary the desktop half's frame reducer already routes on
(anything carrying `span` or `trace`), so no client-side translation is needed:

```jsonc
{ "cursor": "…", "records": [
  { "type": "trace.start" | "trace.end", "trace": { … } },
  { "type": "span.start"  | "span.end",  "trace_id": "tr_…", "span": { … } },
  { "type": "blob", "trace_id": "tr_…", "span_id": "sp_…", "blob_id": "bl_…" }   // body omitted
] }
```

`span.start` is used while the span is still running, `span.end` once it is closed.

## 7. Hooks consumed

Registered only when the plugin is enabled. The list is the source of truth for
`plugin.yaml`'s `provides_hooks` and for the catalog entry's `capabilities.hooks`.

| Hook | Span effect |
|---|---|
| `pre_llm_call` | opens the turn span |
| `post_llm_call` | closes the turn span, final assistant text |
| `pre_tool_call` | opens a tool span |
| `post_tool_call` | closes a tool span; `status`, `result`, `duration_ms` |
| `pre_api_request` | opens an llm span |
| `post_api_request` | closes an llm span; `usage`, `api_duration`, `finish_reason` |
| `api_request_error` | closes an llm span as `error` |
| `subagent_start` | opens a subagent span |
| `subagent_stop` | closes a subagent span; `child_summary`, `duration_ms`, `tool_call_history` |
| `pre_approval_request` | opens an approval span |
| `post_approval_response` | closes an approval span; `choice` |
| `on_human_input_request` | opens a human-input span |
| `on_human_input_resolved` | closes a human-input span; `outcome` |
| `post_compaction` | emits a compaction span |
| `on_session_end` | flushes and closes any open turn |

Not registered, deliberately: `pre_auxiliary_call`, `post_auxiliary_call` (aux calls are not part of
a turn's trajectory and would pollute the graph), and every directive/control hook. Observer-only,
per the contract's own guidance, and registering fewer hooks keeps core from building payloads
nobody reads.

## 8. Desktop contributions

| Surface | Area | Detail |
|---|---|---|
| Live pane | `panes` | `dock: { pane: 'workspace', pos: 'bottom' }`, `height: '260px'`, renders the focused session's live waterfall |
| Full page | `ROUTES_AREA` at `/trace` | history browser plus trace detail |
| Sidebar nav | `SIDEBAR_NAV_AREA` | path `/trace`, label "Trace", codicon `graph` |
| ⌘K command | `PALETTE_AREA` | "Show agent trace" → `host.navigate('/trace')` |
| Keybind | `KEYBINDS_AREA` | toggles the docked pane |
| Settings | `ctx.registerSettingsPage` | capture mode, retention, clear traces, show `/status` |

Hard constraints inherited from admission rule 8 and the SDK:

- Imports are `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`. Nothing else. No `eval`, no
  dynamic `import()`, no script tags, no prototype patching.
- No reading or styling core markup. No `data-slot` / `data-tour` / `data-sidebar` / `data-testid`
  queries, no `document.body` MutationObserver.
- No third-party layout library. The waterfall and tree layouts are hand-rolled from the flat span
  array.
- Theme variables only, never a literal colour. The app UI kit (`ScrollArea`, `Badge`,
  `SegmentedControl`, `SearchField`, `CopyButton`, `StatusDot`, `Tooltip`, `GlyphSpinner`,
  `EmptyState`, `ErrorState`, `LogView`, `DecodeText`, `cn`, `icons.*`) over hand-rolled elements.
- `ctx.storage` for pane/tree/waterfall preferences. No storage of trace content in the renderer.
- The app's shared React Query client (`useQuery`) for reads. Never a hand-rolled poll loop.

## 9. Configuration

| Key | Default | Meaning |
|---|---|---|
| `capture_mode` | `sanitized` | `metadata` / `sanitized` / `full` |
| `retention.traces` | 200 | traces kept before oldest-first rotation |
| `retention.mb` | 50 | store size cap |
| `queue.max` | 10000 | pending events before dropping (never blocks a turn) |
| `ENV AGENT_TRACE_CAPTURE` | — | overrides `capture_mode` |
| `ENV AGENT_TRACE_DISABLED` | — | kill switch: plugin loads, records nothing |

`full` mode must be described in the README as capturing whatever passed through the conversation,
including injected memory and file contents, and must not be the default.