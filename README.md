# agent-trace

Execution graph for Hermes turns: every LLM attempt, every tool call, every delegated subagent,
approval prompts and context compaction, rendered as a span tree with timings, token counts and
per-branch cost.

## Why

The desktop app already streams tool output inline while a turn runs. That tells you *what* ran. It
does not tell you:

- which subagent made a call, or which of two parallel children spent the time
- where the turn's wall clock actually went
- what a turn cost, attributed down to a branch
- anything at all about a turn that ran somewhere else, on Telegram or on cron, before you opened
  the app

This plugin answers those, and it does it from Hermes' own observer-hook contract, so it needs no
changes to Hermes itself.

## What you get

- **Live pane** docked under the conversation: the focused session's current turn as a waterfall,
  filling in as it runs.
- **Full page** at `/trace`: history browser over every recorded turn, filters, and a detail
  inspector for any span.
- **Detail inspector:** name, kind, status, duration, tokens, cost, error, and the tool's arguments
  and result rendered readably, with a copy button.
- **Two views** over the same data: a Jaeger-style waterfall for "where did the time go", and an
  indented tree for "which subagent did this".
- **Per-branch rollups** on subagent spans: API calls, input/output/reasoning tokens, and the files
  each child read and wrote.

## Install

```bash
hermes plugins install agent-trace
hermes plugins enable agent-trace
```

Then turn on the Desktop half in **Settings → Plugins** — a unified package's desktop half is
opt-in and off until you flip it. Finally run ⌘K → **Reload desktop plugins**.

## Privacy

**The plugin opens no sockets and makes no requests of its own.** No export, no upload, no account,
no endpoint to configure. Everything is written to the plugin's own directory on your machine and
nowhere else.

One indirect path can cause outbound traffic, and it is worth knowing about rather than discovering:
cost estimation calls Hermes' **own** pricing code (`agent.usage_pricing`), the same path
`hermes logs` uses. That code refreshes a model-pricing cache from the model provider over HTTPS
(for an OpenRouter route, a `GET` to `openrouter.ai/models`) when its on-disk cache is more than an
hour old, and caches the result. So at most roughly one request per hour, from Hermes, not from this
plugin, and only when the provider does not already report the cost. `AGENT_TRACE_PRICING=off`
removes the path entirely; `cost_usd` then reports as `null`.

`sanitized` capture is the default: content is redacted then truncated. `metadata` mode stores no
content at all, only structure and counts. Read [PRIVACY.md](PRIVACY.md) before installing if you
paste secrets into sessions.

## Capture modes

| mode | content |
|---|---|
| `metadata` | none. Prompts, arguments and results become a shape and a size. |
| `sanitized` **(default)** | redacted then truncated. |
| `full` | raw, truncated only. Explicit opt-in. |

Set with `AGENT_TRACE_CAPTURE=metadata|sanitized|full`, or from the Settings page.

| env var | meaning |
|---|---|
| `AGENT_TRACE_CAPTURE` | `metadata` / `sanitized` / `full` |
| `AGENT_TRACE_DISABLED` | set it and the plugin loads but records nothing |
| `AGENT_TRACE_RETENTION_TRACES` | traces kept before oldest-first rotation (default 200) |
| `AGENT_TRACE_RETENTION_MB` | store size cap in MB (default 50) |
| `AGENT_TRACE_QUEUE_MAX` | pending events before dropping (default 10000) |

If the queue fills, records are **dropped and counted**, never queued at the cost of stalling your
turn. The Settings page shows the dropped count.

## How it is built

Two halves in one package.

**Agent half** (`__init__.py`, `recorder.py`) registers 15 observer hooks and turns them into spans.
Hooks do no file I/O and take no locks: they serialise an event onto a bounded queue, and a daemon
writer thread drains it. Every callback is fail-open — recording can never break a turn.

**Desktop half** (`desktop/plugin.js`) is one plain-ESM file loaded uncompiled, with no build step.
It renders the graph and reads from the backend.

**Backend** (`dashboard/plugin_api.py`) is read-only and mounted at `/api/plugins/agent-trace/`:

| route | returns |
|---|---|
| `GET /status` | recorder health: capture mode, spans recorded, dropped, store size |
| `GET /traces` | newest-first trace summaries (`session_id`, `limit`, `since`) |
| `GET /traces/{id}` | one trace with its flat span array |
| `GET /blobs/{id}` | one argument/result payload, redacted per its capture mode |
| `GET /live` | records written since a cursor — the live channel |
| `DELETE /traces` | clears the store (requires `confirm=true`) |

`/live` is an incremental poll rather than a websocket, deliberately: `plugins.isolation: host` runs
a plugin backend out of process where a websocket upgrade cannot be served, and `ctx.socket` is a
no-op on OAuth remotes. Polling behaves identically in every deployment.

## Design notes

[`docs/SPEC.md`](docs/SPEC.md) is the frozen interface both halves implement: span model, id scheme,
blob store, storage layout, routes, hooks consumed. [`docs/observations.md`](docs/observations.md)
records what the telemetry contract actually gives us, with file-and-line evidence from the Hermes
source, and states plainly which conclusions are read-from-source rather than verified at runtime.

Two decisions worth calling out:

- **Span correlation** uses `session_id`, `turn_id`, `tool_call_id` and `api_request_id`, all of
  which Hermes injects into every tool hook and middleware call. A subagent runs as its own agent on
  its own session, so its events carry the child's ids; they are attached to the subagent's span via
  the child session registered at `subagent_start`, which is what makes the delegation tree correct
  instead of flattened.
- **Cost comes from Hermes' own pricing tables** (`agent.usage_pricing`), imported lazily inside a
  try/except. If pricing is unavailable for a model, `cost_usd` is `null`. It is never `0.0`: a null
  is honest, a zero is a lie. This is an import of a core module, which admission rule 9 warns
  about without failing — the same trade the official `langfuse` plugin makes, and the alternative
  is inventing numbers.

## Limitations, stated plainly

- The desktop half shows a subagent's tool calls as rows with a preview and no arguments, because
  that is what the mirrored child events carry. Full arguments come from the agent half.
- `subagent_stop.tool_call_history` is metadata-only **by Hermes' own design** — tool name, argument
  *names*, byte counts and outcome, no raw arguments or results. This plugin passes it through
  rather than trying to reconstruct what core deliberately withheld.
- Context compaction is marked as a point event, not bracketed, so the timeline shows where it
  happened without knowing how long it took.
- Nothing is recorded for a turn that ran while the plugin was disabled. There is no backfill.

## Development

```bash
pytest tests                              # 32 tests, no fixtures mocked
python tests/check_declared_hooks.py      # admission rule 6: manifest matches register()
python tests/check_desktop_surface.py     # admission rule 8: the SDK surface lint
node tests/desktop_smoke.mjs              # loads the desktop half the way the app does, registers it
hermes plugins install ./agent-trace --force
```

`pytest` must run with `tests/` as its rootdir (the config in `tests/pytest.ini` arranges that).
The plugin root has to keep its `__init__.py` for Hermes' loader, and a rootdir containing
`__init__.py` makes pytest try to import that file as a package.

`desktop_smoke.mjs` is the closest thing to running the plugin without the app: it rewrites the
three allowed specifiers to local stubs, exactly as `src/contrib/runtime-loader.ts` does, imports
the module, and calls `register(ctx)` with a recording context. It catches what `node --check`
cannot — a named import the SDK does not export, a `register()` that throws, and a contribution set
or i18n ordering that does not match the spec.

## License

MIT. See [LICENSE](LICENSE).