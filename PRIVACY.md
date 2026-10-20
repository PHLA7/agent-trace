# Privacy

This plugin records agent telemetry to your own disk. That is the whole point of it, and it is also
the reason to read this file before installing it.

## What is recorded

For every agent turn:

- the tool calls it made, with their arguments and their results
- the provider API attempts, with the request and response payloads and token counts
- the goals, summaries and metadata-only tool history of any delegated subagents
- approval prompts and their outcome, and human-input prompts (already redacted by Hermes)
- timings, token counts, model identifiers and estimated cost

## Where it is stored

Inside the plugin's own directory, on the machine running Hermes, and nowhere else:

```
<plugin dir>/data/traces/YYYY-MM-DD/<session_id>.jsonl
<plugin dir>/data/status.json
```

That is the only path the plugin writes. It does not write to your home directory, to
`~/.hermes/status.db`, to any other plugin's storage, or to any system temp directory.

## What does NOT happen

- **The plugin makes no requests of its own.** No HTTP call, no socket, no export, upload or
  telemetry feature. There is no endpoint to configure and no account to create. If you want traces
  in an external system, use the official `langfuse` plugin instead, which is built for exactly that.
- **No credentials.** It declares no `requires_env`, reads no `.env` file, reads no Hermes
  `auth.json`, and never touches the credential vault. Nothing here signs in to anything.
- **No retention outside your machine.** Nothing is copied anywhere.

## The one indirect path to the network

Cost estimation calls Hermes' own pricing code (`agent.usage_pricing.estimate_usage_cost`), the same
path `hermes logs` uses to print a cost. That code, not this plugin, can issue an HTTPS request: it
refreshes a model-pricing cache from the model provider when its on-disk cache is more than an hour
old (for an OpenRouter route, a `GET` to `openrouter.ai/models`; Hermes stores the result under its
own cache directory). Nothing about your conversation is sent. The request is for a public price
list.

Order of events, so the bound is clear:

1. Hermes' provider profile reports a cost already present in the response. Then no request happens
   at all, for any provider that returns cost per call.
2. Otherwise Hermes looks up a bundled price snapshot.
3. Only if that also misses does the cache refresh logic run, and only when its cache is over an
   hour old.

**Set `AGENT_TRACE_PRICING=off` and the plugin touches no network path whatsoever.** `cost_usd` then
reports as `null`, which is the same value it reports for any model Hermes has no price for.

## Capture modes

`capture_mode` decides how much *content* is stored. Structural metadata (ids, names, statuses,
timings, token counts, cost) is always recorded, in every mode.

| mode | what is stored |
|---|---|
| `metadata` | no content at all. Prompts, arguments and results are replaced by a shape and a size, e.g. `{"omitted": true, "type": "json", "keys": ["command"]}`. Use this on a shared machine or if you would rather the plugin stored only structure and counts. |
| `sanitized` **(default)** | content is redacted, then truncated. Redaction is pattern-based: API keys, GitHub and Slack tokens, AWS access key ids, JWTs, PEM private keys, `Bearer <token>` values, and `key=value` assignments whose key name looks like a secret. |
| `full` | raw content, truncated only. Explicit opt-in. Traces will contain whatever passed through the conversation, including injected memory and the contents of the files the agent read. |

Set it with `AGENT_TRACE_CAPTURE=metadata|sanitized|full`, or from the plugin's settings page.

### Redaction is defence in depth, not a guarantee

`sanitized` mode is pattern matching. It catches the shapes above. It will not catch a secret that
does not look like one, a token split across two arguments, or a credential typed in an unusual
form. If you pasted something into a session that you would not want written to a file, use
`metadata` mode, or clear the store afterwards.

## Bounds and retention

- 12000 characters per field, nesting depth 4, 50 items per collection, 50 file paths per list.
- At most 200 traces and 50 MB by default, rotated oldest-first.
- A 10000-event queue; if it fills, records are dropped and counted rather than stalling your turn.
- `hermes plugins disable agent-trace` stops all recording immediately. The Settings page has a
  clear action that deletes every stored trace.

## Blob bodies are stored separately

Arguments and results go into `blob` records keyed by id, so the span tree stays small enough to
render. A blob body is never inlined into a trace payload.

## Hermes' own precedent

Hermes' observer-hook contract is written to support exactly this kind of consumer, and it already
redacts the things it can. `on_human_input_request` carries a force-redacted prompt and never the
typed password or answer. `subagent_stop.tool_call_history` is metadata-only by design: tool name,
argument *names*, bounded side-effect targets, byte counts and outcome, with URL query strings and
fragments removed, and raw arguments, prompts, commands, contents and headers deliberately excluded.
This plugin passes those through rather than trying to re-derive them.