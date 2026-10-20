# P0 observations — what the telemetry contract actually gives us

Answers captured directly from the Hermes source tree, not from inference. Version read:
Hermes Agent v0.22.2 (2026.9.24), install method git, checkout at `/home/phla7/.hermes/hermes-agent`.

The expected P0 output was a probe plugin capturing raw payloads. That turned out to be
unnecessary for the Python half: Hermes ships a **documented observer-hook contract** whose stated
purpose is exactly this class of integration, and it is the plugin-facing contract rather than an
implementation detail.

> "Hermes observer hooks are the read-only telemetry contract for plugins that need to reconstruct
> agent execution without changing runtime behavior. This contract supports trace, metrics, audit,
> replay, and export integrations such as Langfuse, OpenTelemetry-style collectors, and NeMo Relay."
>
> — `website/docs/developer-guide/observer-hooks.md:6`

Every observer payload is stamped by the plugin manager with:

```
telemetry_schema_version = "hermes.observer.v1"
```

That constant is the contract version this plugin should record against and assert on.

Because the contract is documented, the probe was replaced by reading the contract plus its fire
sites. A live smoke test is still required and is scheduled in P3 (see `docs/SPEC.md` §7).

## 1. The seven questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | What identifies a turn and joins a tool call to it? | `session_id`, `turn_id`, `tool_call_id`, `api_request_id`, `task_id`. All five are injected into **every** tool hook and middleware call. `turn_id` is documented as the "user-turn identity shared by API attempts and tool calls in a turn", so it is the turn-span key. | `agent/inline_tool_executors.py:20-28` (`tool_hook_ids`), `model_tools.py:642-653` (`_CallIds.hook_kwargs`), `observer-hooks.md:70-88` |
| 2 | Does `post_tool_call` get the arguments and the result? | Yes. `tool_name`, `args`, `result`, `duration_ms`, `status`, `error_type`, `error_message`, plus `middleware_trace`. `status ∈ {ok, error, blocked, cancelled}`, and the hook fires on blocked and cancelled paths too, so spans always close. | `model_tools.py:674-698`, `observer-hooks.md:183-196` |
| 3 | Do the gateway events carry args and results? | Yes, both. `tool.start` carries the **full** `args` dict (added deliberately so the desktop's expanded row is complete while the tool runs). `tool.complete` carries `result`, `duration_s`, `summary`, `result_text`, `inline_diff`, `todos`, `revision`. | `tui_gateway/contracts/events.py:285-318`, `tui_gateway/tool_progress.py:293-302` |
| 4 | What do the subagent hooks carry? | `subagent_start`: `parent_session_id`, `parent_turn_id`, `parent_subagent_id`, `child_session_id`, `child_subagent_id`, `child_role`, `child_goal`. `subagent_stop`: adds `child_summary`, `duration_ms`, and a metadata-only `tool_call_history`. The delegation tree is therefore derivable exactly. | `tools/delegate_tool.py:327-334`, `observer-hooks.md:229-250` |
| 5 | Is there a turn-start signal, or must the root span be synthesised? | There is a proper bracket: `pre_llm_call` fires "before the tool loop begins for a user turn" and `post_llm_call` "after the turn completes with final assistant output". Both carry `turn_id`. The root span does not have to be guessed from the first child. | `observer-hooks.md:110-128` |
| 6 | Do the API hooks expose per-call tokens and model? | Yes. `post_api_request` carries `usage`, `api_duration`, `started_at`, `ended_at`, `finish_reason`, `response_model`, `message_count`, plus the sanitized `response`. `api_request_error` closes failed attempts with `status_code`, `retry_count`, `retryable`, `reason` and a structured `error`. | `observer-hooks.md:130-168` |
| 7 | Are approval and human-input payloads pre-redacted? | Yes, and this is deliberate. `on_human_input_request` carries a **force-redacted** `prompt`; the typed password or answer is never included. Approval hooks carry `command`, `description`, `pattern_key(s)`, `session_key`, `surface`, and `post_approval_response` adds `choice`. Approval hooks are observer-only: a plugin cannot pre-answer or veto. | `observer-hooks.md:198-227` |

## 2. Additional findings that change the design

**The desktop half can build the full delegation tree on its own.** Core emits a six-event
`subagent.*` family whose payload carries `subagent_id`, `parent_id`, `child_session_id`,
`delegation_id`, `depth`, and a per-child rollup of `input_tokens`, `output_tokens`,
`reasoning_tokens`, `api_calls`, `files_read`, `files_written`, `output_tail`, `status`,
`summary`, `duration_seconds`. Identity fields are optional because older emitters omit them, and
the TUI spawn tree then falls back to flat rendering — so the plugin must handle both shapes.

Source: `tui_gateway/contracts/events.py:502-540`.

```
subagent.spawn_requested  delegate_task accepted a child goal (before the child starts)
subagent.start            a delegated child started running
subagent.progress         batched tool-name progress from a child
subagent.thinking         a child's reasoning chunk
subagent.tool             a child called a tool
subagent.complete         a child finished (status + observability rollup)
```

**Child tool rows are mirrored into the parent view with empty args.** `ToolStartPayload`'s own
docstring notes rows from `agent_callbacks._mirror_subagent_to_child` arrive with `preview` and
empty `args`. So the desktop half can show a child's tool call as a row but not its arguments;
those come from the Python half, where the child's own `pre_tool_call` fires with the child's
`session_id` and `task_id`.

**Hook callbacks must be fast and non-blocking.** The contract is explicit:

> "Keep hook callbacks fast and fail-open. Offload network export or batch writes when practical."
>
> — `observer-hooks.md:277-282`

Consequence for this plugin: hook callbacks do no file I/O and hold no locks. They push a
pre-serialised event onto a bounded queue; a background writer thread drains it to disk.
Event payload construction in core is gated behind `has_hook(...)`, so the plugin must **register
only the hooks it consumes** or it makes core build payloads it will never read.

**`subagent_stop.tool_call_history` is metadata-only by design**, and the contract says so
explicitly: each entry has the tool name, argument *names*, bounded side-effect targets, byte
counts and outcome. URL query strings and fragments are stripped. Raw arguments, prompts,
commands, contents, headers and results are intentionally excluded. This is the privacy posture to
keep, and it is worth citing in the README because it is core's own precedent.

**`post_compaction` exists** as an observer hook, so context compaction can be marked on the
timeline rather than silently changing what a trace means.

## 3. Backend mount contract (for the Python half)

- A plugin's Python backend is a `plugin_api.py` that exposes a FastAPI `router = APIRouter()`.
- It is mounted at `/api/plugins/<plugin-name>/`.
- It is discovered by scanning `<plugins root>/<name>/dashboard/manifest.json`, which declares
  `"api": "plugin_api.py"`.
- The `api` value must be a **relative** path resolving inside the plugin's own `dashboard/`
  directory; absolute paths and `../` are refused (GHSA-5qr3-c538-wm9j) and the routes are simply
  not mounted.
- The backend is imported **only when the plugin is in `plugins.enabled`** — a separate gate from
  the in-app Desktop toggle.
- `manifest.json` defaults: `entry` → `dist/index.js`, `tab.position` → `end`,
  `tab.path` → `/<name>`. A plugin with a backend but no web-dashboard UI should set
  `"tab": { "hidden": true }` so no unusable tab is added to the web dashboard.
- The desktop half reaches it with `ctx.rest('/path')` and `ctx.socket('/events')`, both scoped to
  `/api/plugins/<id>`. `ctx.socket` is a **no-op on OAuth remotes**, so a polling fallback is
  mandatory.

Sources: `hermes_cli/web_server_dashboard.py:449-555`, `:826-896`, `plugins/kanban/dashboard/plugin_api.py:43`.

## 4. Manifest schema observed in practice

Bundled plugins declare `name`, `version`, `description`, `author`, `provides_hooks`:

```yaml
name: disk-cleanup
version: 2.0.0
description: "..."
author: "..."
provides_hooks:
  - pre_tool_call
  - post_tool_call
  - on_session_end
```

Sources: `plugins/disk-cleanup/plugin.yaml`, `plugins/security-guidance/plugin.yaml`.

The catalog entry's `capabilities.hooks` list must match what `register()` actually wires, since
admission rule 6 fails the entry otherwise. This plugin therefore generates one list from the
other in CI rather than maintaining both by hand.

## 5. What this leaves unproven

Read from source, therefore **not** yet verified at runtime:

1. That the queue-and-drain recorder survives a real multi-tool turn without dropping spans.
2. That `turn_id` is non-empty on every tool call in practice. `tool_hook_ids` coerces missing
   values to `""`, so a turn with no id would silently correlate to the empty string.
   The recorder must group empty-`turn_id` calls by `session_id` and time window instead of
   collapsing them into one span.
3. That the desktop half receives `subagent.*` frames for children the user spawned from a
   non-desktop surface.
4. That a plugin backend mounted at `/api/plugins/agent-trace/` is reachable from `ctx.rest` in
   the desktop app with the plugin enabled.

Items 1-3 are covered by the P3 live smoke test. Item 4 is covered by the desktop half's own
first-run check.