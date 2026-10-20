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

- **No network access of any kind.** This plugin makes no HTTP requests, opens no sockets, and has
  no export, upload or telemetry feature. There is no endpoint to configure and no account to
  create. If you want traces in an external system, use the official `langfuse` plugin instead,
  which is built for exactly that.
- **No credentials.** It declares no `requires_env`, reads no `.env` file, reads no Hermes
  `auth.json`, and never touches the credential vault. Nothing here signs in to anything.
- **No retention outside your machine.** Nothing is copied anywhere.

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