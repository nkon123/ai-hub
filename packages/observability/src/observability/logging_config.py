"""Structured, greppable logging — `configure_logging(service_name, level)`.

Every emitted line includes `service`, `trace_id`, `run_id` (bound via
`observability.context`, defaulting to `-` when unset), the stdlib logger
name, level, and message — enough to `grep <trace_id>` a single request/run
across every service's log file and see the steps line up (README §15 step
12 / NFR-04: "Portal·Desktop·Runtime·MCP 로그가 동일 Trace ID로 연결된다").

Why this is needed at all: `uvicorn`'s own `Config.configure_logging()` (see
`uvicorn/config.py`, `LOGGING_CONFIG`) only ever attaches handlers to the
`uvicorn`/`uvicorn.error`/`uvicorn.access` loggers — never to the root
logger. An app's own `logging.getLogger(__name__).info(...)` calls (e.g.
`agent_runtime/workflow.py`) propagate up to the root logger, which by
default has *no* handler at all, so Python's logging module silently drops
anything below WARNING (the `lastResort` handler's level) — the app's INFO
logs vanish even though uvicorn's own startup banner prints fine. Calling
`configure_logging()` fixes that by giving the root logger an explicit
handler and level.

Deliberately clears any pre-existing root handlers before installing its own
(idempotent — safe to call more than once, e.g. once at module import and
again in a lifespan hook) and only ever touches the *root* logger, never
`uvicorn`/`uvicorn.error`/`uvicorn.access` themselves — so it is safe to call
regardless of whether it runs before or after uvicorn's own
`configure_logging()`, and it never disturbs uvicorn's own colored
access-log formatting.

Log hygiene (CLAUDE.md: "Log에 Prompt 원문, 문서 전체, DB 결과, Secret을
기본 저장하지 않는다") is structural here, not a promise: this module's
public surface is exactly stdlib `logging`'s own `msg`/`extra` shape — there
is no "attach a payload" parameter anywhere, so there is no API shortcut
that makes logging a full prompt or document body easier than logging an id
or a count.
"""

from __future__ import annotations

import logging
import sys

from observability.context import get_run_id, get_trace_id

_LOG_FORMAT = (
    "%(asctime)s %(levelname)s service=%(service)s trace_id=%(trace_id)s "
    "run_id=%(run_id)s logger=%(name)s %(message)s"
)
_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S%z"


class TraceContextFilter(logging.Filter):
    """Attaches `service`/`trace_id`/`run_id` to every `LogRecord` that does
    not already declare them explicitly.

    An explicit `logger.info(..., extra={"trace_id": "..."})` always wins
    over the ambient contextvar — useful for the rare call site that must
    log about a *different* run than the one currently bound (e.g. a
    supervisory/cleanup loop iterating over multiple runs)."""

    def __init__(self, service_name: str) -> None:
        super().__init__()
        self._service_name = service_name

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "service"):
            record.service = self._service_name
        if not hasattr(record, "trace_id"):
            record.trace_id = get_trace_id() or "-"
        if not hasattr(record, "run_id"):
            record.run_id = get_run_id() or "-"
        return True


def configure_logging(service_name: str, level: str = "INFO") -> None:
    """Install the structured formatter + `TraceContextFilter` on the root
    logger, writing to stdout.

    Call once at service startup — the established pattern in this repo is
    a top-level call near the top of `<service>/main.py`, before the `app =
    FastAPI(...)` line, so it takes effect for every request/background task
    from the very first log line. Safe to call again later (e.g. in a
    lifespan hook) without accumulating duplicate handlers.
    """
    resolved_level = logging.getLevelName(level.upper())
    if not isinstance(resolved_level, int):
        # Unknown level name — logging.getLevelName() returns a "Level X"
        # string in that case. Fail safe to INFO rather than raise, since a
        # bad LOG_LEVEL env var must never crash service startup.
        resolved_level = logging.INFO

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    handler.addFilter(TraceContextFilter(service_name))

    root = logging.getLogger()
    root.setLevel(resolved_level)
    root.handlers = [handler]
