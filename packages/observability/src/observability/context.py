"""Trace Context — contextvars-based propagation of `trace_id`/`run_id`.

Binding once per inbound request/run (`bind_trace_id`, or the `trace_context`
context manager) makes every `logging` call made from that point onward, in
the same async task, automatically carry the id via
`observability.logging_config`'s `TraceContextFilter` — no need to thread
`trace_id` through every function signature or `extra={...}` call by hand.

`contextvars.ContextVar` is task-local: each `asyncio.create_task(...)` call
copies the *current* context at creation time, so binding a trace id in a
background task's own entrypoint (e.g. `agent_runtime.workflow
.run_knowledge_chat`) never leaks into other concurrent requests/tasks, and
never needs an explicit reset when the task simply runs to completion and is
garbage collected. `reset_trace_id`/`reset_run_id` (and the `trace_context`
context manager) exist for the cases that share a longer-lived context and
must restore the previous value — e.g. FastAPI middleware wrapping many
requests in one worker's event loop.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

_trace_id_var: ContextVar[str | None] = ContextVar("observability_trace_id", default=None)
_run_id_var: ContextVar[str | None] = ContextVar("observability_run_id", default=None)


def get_trace_id() -> str | None:
    """Trace id bound in the current async task's context, if any."""
    return _trace_id_var.get()


def get_run_id() -> str | None:
    """Run id bound in the current async task's context, if any."""
    return _run_id_var.get()


def bind_trace_id(trace_id: str | None) -> Token[str | None]:
    """Bind `trace_id` for the current context.

    Returns a token for `reset_trace_id`; safe to discard when the context
    dies with the task it was bound in (e.g. a one-shot background run)."""
    return _trace_id_var.set(trace_id)


def reset_trace_id(token: Token[str | None]) -> None:
    _trace_id_var.reset(token)


def bind_run_id(run_id: str | None) -> Token[str | None]:
    """Bind `run_id` for the current context. See `bind_trace_id`."""
    return _run_id_var.set(run_id)


def reset_run_id(token: Token[str | None]) -> None:
    _run_id_var.reset(token)


@contextmanager
def trace_context(trace_id: str | None = None, run_id: str | None = None) -> Iterator[None]:
    """Bind `trace_id`/`run_id` for the lifetime of the `with` block, then
    restore whatever was bound before (nesting-safe). A `None` argument
    leaves that particular id unbound/unchanged."""
    trace_token = bind_trace_id(trace_id) if trace_id is not None else None
    run_token = bind_run_id(run_id) if run_id is not None else None
    try:
        yield
    finally:
        if trace_token is not None:
            reset_trace_id(trace_token)
        if run_token is not None:
            reset_run_id(run_token)
