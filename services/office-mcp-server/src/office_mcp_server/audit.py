"""MCP Audit Event — 05-mcp-security-governance.md §10.

"입력 Parameter와 결과 본문은 기본 Audit Event에 포함하지 않는다" — enforced
structurally: `AuditEvent` below has no `input`/`output`/`parameters` field
at all, so there is no attribute a caller could accidentally populate with
them. `AuditSink` implementations only ever receive an `AuditEvent`, never
the raw call/result dicts.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel


class AuditResult(StrEnum):
    SUCCEEDED = "SUCCEEDED"
    DENIED = "DENIED"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"


class AuditEvent(BaseModel):
    event_type: str
    trace_id: str
    run_id: str
    user_id: str
    organization_id: str
    service_id: str | None
    agent_id: str | None
    server_id: str = "office-mcp-server"
    tool_name: str
    tool_version: str | None
    started_at: str
    duration_ms: int
    result: AuditResult
    row_count: int | None = None
    truncated: bool | None = None
    policy_id: str


class AuditSink(ABC):
    @abstractmethod
    def record(self, event: AuditEvent) -> None: ...


class InMemoryAuditSink(AuditSink):
    """Used by tests and available for `/admin` introspection later; keeps
    events in-process only (§12.9 append-only is a storage-layer property
    out of scope for this in-memory PoC sink)."""

    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    def record(self, event: AuditEvent) -> None:
        self.events.append(event)


class LoggingAuditSink(AuditSink):
    """Writes each event as a single structured JSON log line. Never logs
    anything beyond `AuditEvent`'s own fields — see module docstring.

    The line already carries `trace_id`/`run_id` twice over: once inside the
    JSON payload (`AuditEvent.trace_id`/`run_id`, always present) and once
    more via `observability`'s `TraceContextFilter` (`service`/`trace_id`/
    `run_id=...` prefix), *if* the caller bound the same trace id into the
    ambient context before calling `record()` — see
    `office_mcp_server.pipeline.ToolCallPipeline.call`. Either one alone is
    enough to `grep` this event by trace id; having both means the id is
    grep-able even by an operator who only knows to look at the line prefix.
    """

    def __init__(self) -> None:
        import logging

        self._logger = logging.getLogger("office_mcp_server.audit")

    def record(self, event: AuditEvent) -> None:
        self._logger.info(
            "mcp.audit event_type=%s tool=%s result=%s duration_ms=%d %s",
            event.event_type,
            event.tool_name,
            event.result,
            event.duration_ms,
            event.model_dump_json(),
        )


class MultiAuditSink(AuditSink):
    """Fans one `AuditEvent` out to several sinks (e.g. keep events queryable
    in-process via `InMemoryAuditSink` *and* make them visible in the process
    log via `LoggingAuditSink`) without callers needing to know how many
    sinks are actually wired up."""

    def __init__(self, sinks: list[AuditSink]) -> None:
        self._sinks = sinks

    def record(self, event: AuditEvent) -> None:
        for sink in self._sinks:
            sink.record(event)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_event(
    *,
    event_type: str,
    trace_id: str,
    run_id: str,
    user_id: str,
    organization_id: str,
    service_id: str | None,
    agent_id: str | None,
    tool_name: str,
    tool_version: str | None,
    started_at: str,
    duration_ms: int,
    result: AuditResult,
    row_count: int | None = None,
    truncated: bool | None = None,
    policy_id: str = "poc-default",
) -> AuditEvent:
    return AuditEvent(
        event_type=event_type,
        trace_id=trace_id,
        run_id=run_id,
        user_id=user_id,
        organization_id=organization_id,
        service_id=service_id,
        agent_id=agent_id,
        tool_name=tool_name,
        tool_version=tool_version,
        started_at=started_at,
        duration_ms=duration_ms,
        result=result,
        row_count=row_count,
        truncated=truncated,
        policy_id=policy_id,
    )
