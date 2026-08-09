"""In-memory Run store (PoC — no persistence)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "CANCELLED", "INSUFFICIENT_EVIDENCE"}

# Deliberately NOT in TERMINAL_STATUSES — WAITING_FOR_USER always resolves
# into either RUNNING (approve/deny, workflow.py `_await_confirmation`) or a
# genuine terminal status (CANCELLED via /cancel, FAILED via expiry).


@dataclass
class PendingConfirmation:
    """One outstanding Tool-confirmation request (02-...md §5.3
    WAITING_FOR_USER). `summary` is the only tool-specific text exposed to
    the caller/UI — never the raw tool input (D-052 후속 property, same as
    `mcp.call.*` events)."""

    tool_name: str
    summary: str
    deadline: datetime
    event: asyncio.Event = field(default_factory=asyncio.Event)
    # Set by POST /runs/{id}/confirm just before `event.set()`; read by the
    # awaiting workflow coroutine once it wakes.
    decision: str | None = None  # "approve" | "deny"


@dataclass
class RunRecord:
    id: str
    service_id: str
    status: str
    trace_id: str
    created_at: datetime
    completed_at: datetime | None = None
    output: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    event_log: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    # Non-None exactly while status == "WAITING_FOR_USER".
    confirmation: PendingConfirmation | None = None
    _next_event_id: int = field(default=0, repr=False)


class RunStore:
    """In-memory registry of runs, their event logs, and SSE subscribers."""

    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}

    def create(self, service_id: str, trace_id: str) -> RunRecord:
        run_id = _new_run_id()
        record = RunRecord(
            id=run_id,
            service_id=service_id,
            status="CREATED",
            trace_id=trace_id,
            created_at=datetime.now(UTC),
        )
        self._runs[run_id] = record
        return record

    def get(self, run_id: str) -> RunRecord | None:
        return self._runs.get(run_id)

    def append_event(self, run_id: str, event: str, data: dict[str, Any]) -> None:
        record = self._runs.get(run_id)
        if record is None:
            return
        event_id = record._next_event_id
        record._next_event_id += 1
        item = {"id": str(event_id), "event": event, "data": data}
        record.event_log.append(item)
        for queue in list(record.subscribers):
            queue.put_nowait(item)

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        record = self._runs.get(run_id)
        if record is not None:
            record.subscribers.append(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        record = self._runs.get(run_id)
        if record is not None and queue in record.subscribers:
            record.subscribers.remove(queue)

    def replay_since(self, run_id: str, last_event_id: str | None) -> list[dict[str, Any]]:
        record = self._runs.get(run_id)
        if record is None:
            return []
        if last_event_id is None:
            return list(record.event_log)
        try:
            threshold = int(last_event_id)
        except ValueError:
            return list(record.event_log)
        return [item for item in record.event_log if int(item["id"]) > threshold]

    def set_status(
        self,
        run_id: str,
        status: str,
        output: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        record = self._runs.get(run_id)
        if record is None:
            return
        record.status = status
        if output is not None:
            record.output = output
        if error is not None:
            record.error = error
        if status in TERMINAL_STATUSES:
            record.completed_at = datetime.now(UTC)


def _new_run_id() -> str:
    return str(uuid4())


run_store = RunStore()
