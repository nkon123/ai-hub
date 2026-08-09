"""Unit tests for `observability.context` — the contextvars-based Trace ID
propagation backing README §15 step 12 / NFR-04.

The property under test: a trace_id/run_id bound in one async task must
never leak into a sibling task's context (the whole point of using
`contextvars` instead of a module-level global), while still being visible
to everything running *inside* the task it was bound in — including nested
`asyncio.create_task(...)` children, which is exactly how
`agent_runtime.routers.runs.start_run` hands a Run off to
`agent_runtime.workflow.run_knowledge_chat`.
"""

from __future__ import annotations

import asyncio

from observability.context import (
    bind_run_id,
    bind_trace_id,
    get_run_id,
    get_trace_id,
    reset_run_id,
    reset_trace_id,
    trace_context,
)


def test_get_trace_id_defaults_to_none() -> None:
    assert get_trace_id() is None
    assert get_run_id() is None


def test_bind_then_reset_restores_previous_value() -> None:
    assert get_trace_id() is None
    token = bind_trace_id("trace-1")
    assert get_trace_id() == "trace-1"
    reset_trace_id(token)
    assert get_trace_id() is None


def test_bind_run_id_independent_of_trace_id() -> None:
    trace_token = bind_trace_id("trace-1")
    run_token = bind_run_id("run-1")
    try:
        assert get_trace_id() == "trace-1"
        assert get_run_id() == "run-1"
    finally:
        reset_trace_id(trace_token)
        reset_run_id(run_token)
    assert get_trace_id() is None
    assert get_run_id() is None


def test_trace_context_manager_binds_and_restores() -> None:
    with trace_context(trace_id="trace-2", run_id="run-2"):
        assert get_trace_id() == "trace-2"
        assert get_run_id() == "run-2"
    assert get_trace_id() is None
    assert get_run_id() is None


def test_trace_context_nesting_restores_outer_value() -> None:
    with trace_context(trace_id="outer"):
        assert get_trace_id() == "outer"
        with trace_context(trace_id="inner"):
            assert get_trace_id() == "inner"
        assert get_trace_id() == "outer"
    assert get_trace_id() is None


def test_trace_context_with_none_leaves_ambient_value_unchanged() -> None:
    with trace_context(trace_id="outer"):
        with trace_context(run_id="run-only"):
            # trace_id was not passed to the inner context manager — it must
            # keep reading the outer binding, not clear to None.
            assert get_trace_id() == "outer"
            assert get_run_id() == "run-only"
        assert get_run_id() is None


async def test_child_task_inherits_bound_trace_id() -> None:
    """`asyncio.create_task(...)` copies the *current* context at creation
    time — this is what makes it safe for `agent_runtime.routers.runs
    .start_run` to bind nothing itself and instead let `workflow
    .run_knowledge_chat` (running as its own task) bind its own trace_id."""
    with trace_context(trace_id="parent-trace"):

        async def child() -> str | None:
            return get_trace_id()

        result = await asyncio.create_task(child())
    assert result == "parent-trace"


async def test_sibling_tasks_do_not_leak_trace_id_into_each_other() -> None:
    """The core isolation guarantee: two concurrent Runs/requests binding
    different trace ids in their own tasks must never see each other's id —
    this is what makes it safe to bind without an explicit reset in a
    one-shot background task (agent_runtime.workflow.run_knowledge_chat)."""

    async def bind_and_read(trace_id: str, delay: float) -> str | None:
        bind_trace_id(trace_id)
        await asyncio.sleep(delay)
        return get_trace_id()

    results = await asyncio.gather(
        asyncio.create_task(bind_and_read("trace-A", 0.02)),
        asyncio.create_task(bind_and_read("trace-B", 0.01)),
    )

    assert results == ["trace-A", "trace-B"]
    # And the caller's own (unbound) context is still untouched.
    assert get_trace_id() is None
