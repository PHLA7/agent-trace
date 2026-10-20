"""agent-trace — records a Hermes turn as a span tree for the desktop execution-graph pane.

The agent half of the plugin. It wires observer hooks into a recorder
(:mod:`recorder`) and writes a local, redacted, retained store that the desktop half reads
through the backend routes in ``dashboard/plugin_api.py``.

Observer-only by design. Nothing here changes agent behaviour, and no hook return value is used.

Recording is local-only: this plugin makes no requests of its own, has no credentials, and writes
nothing outside its own data directory. Its one indirect network path is cost estimation, which goes
through Hermes' own pricing lookup (see PRIVACY.md); ``AGENT_TRACE_PRICING=off`` removes it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from .recorder import (
    CAPTURE_MODES,
    DEFAULT_CAPTURE_MODE,
    DEFAULT_QUEUE_MAX,
    DEFAULT_RETENTION_MB,
    DEFAULT_RETENTION_TRACES,
    Recorder,
    capture_mode_from_env,
    enabled_from_env,
    register_hooks,
)

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent
_DATA_DIR = _PLUGIN_DIR / "data"

_recorder: Optional[Recorder] = None
_registered_hooks: list[str] = []


def _int_env(name: str, default: int) -> int:
    """Read a positive int from the environment, falling back on anything unusable."""
    try:
        import os

        raw = (os.environ.get(name) or "").strip()
        value = int(raw) if raw else default
        return value if value > 0 else default
    except Exception:
        return default


def register(ctx: Any) -> None:
    """Wire the recorder into the agent. Never raises: a failed recorder must not break a turn."""
    global _recorder, _registered_hooks

    if not enabled_from_env():
        logger.info("agent-trace: AGENT_TRACE_DISABLED is set, recording nothing")
        return

    try:
        _recorder = Recorder(
            _DATA_DIR,
            capture_mode=capture_mode_from_env(),
            queue_max=_int_env("AGENT_TRACE_QUEUE_MAX", DEFAULT_QUEUE_MAX),
            retention_traces=_int_env("AGENT_TRACE_RETENTION_TRACES", DEFAULT_RETENTION_TRACES),
            retention_mb=_int_env("AGENT_TRACE_RETENTION_MB", DEFAULT_RETENTION_MB),
        )
    except Exception as exc:
        logger.warning("agent-trace: recorder did not start, recording nothing: %s", exc)
        _recorder = None
        return

    try:
        _registered_hooks = register_hooks(ctx, _recorder)
    except Exception as exc:
        logger.warning("agent-trace: hook registration failed: %s", exc)
        return

    logger.info(
        "agent-trace: recording %d hooks, capture_mode=%s, data=%s",
        len(_registered_hooks), _recorder.capture_mode, _DATA_DIR,
    )
    try:
        _recorder._write_status()
    except Exception:
        pass


def status(ctx: Any = None) -> dict[str, Any]:
    """Introspection helper for tests and the ``hermes plugins`` surfaces."""
    del ctx
    return {
        "schema_version": "hermes.observer.v1",
        "capture_modes": list(CAPTURE_MODES),
        "default_capture_mode": DEFAULT_CAPTURE_MODE,
        "registered_hooks": list(_registered_hooks),
        "recorder": _recorder.status() if _recorder is not None else None,
    }