"""Observability — structured logging + Trace ID propagation.

Cross-cutting shared package (not owned by a single module in the M01-M12
table; consumed by M02 `apps/portal-api`, M05 `services/agent-runtime`, M07
`services/indexing-runtime`, M08 `services/search-runtime`, M10
`services/office-mcp-server`) backing README §15 step 12 and NFR-04:
"Portal·Desktop·Runtime·MCP 로그가 동일 Trace ID로 연결된다" /
"요청·Job·Agent Run·MCP Tool을 Trace ID로 연결".

Framework-light by design: `context` and `logging_config` depend only on the
stdlib (`contextvars`, `logging`); only `middleware` depends on `starlette`
(see its module docstring for when to use it vs. binding a body-supplied
trace id directly).
"""

from observability.context import (
    bind_run_id,
    bind_trace_id,
    get_run_id,
    get_trace_id,
    reset_run_id,
    reset_trace_id,
    trace_context,
)
from observability.logging_config import TraceContextFilter, configure_logging

__all__ = [
    "bind_run_id",
    "bind_trace_id",
    "get_run_id",
    "get_trace_id",
    "reset_run_id",
    "reset_trace_id",
    "trace_context",
    "TraceContextFilter",
    "configure_logging",
]
