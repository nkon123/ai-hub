"""MCP Audit Event — 05-mcp-security-governance.md §10.

"입력 Parameter와 결과 본문은 기본 Audit Event에 포함하지 않는다." Proven
structurally (AuditEvent has no such field) and behaviorally (recorded
events never contain the actual filter value / comment text used in a
call)."""

from __future__ import annotations

from office_mcp_server.audit import AuditEvent, AuditResult, InMemoryAuditSink
from office_mcp_server.pipeline import ToolCallPipeline

from .conftest import make_call_body, make_context


def test_audit_event_has_no_input_or_output_field() -> None:
    field_names = set(AuditEvent.model_fields.keys())
    assert "input" not in field_names
    assert "output" not in field_names
    assert "parameters" not in field_names
    assert "result_body" not in field_names


async def test_successful_call_records_one_succeeded_event(
    pipeline: ToolCallPipeline, audit_sink: InMemoryAuditSink
) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", user_id="user-42")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)

    await pipeline.call("db_metadata.get_tables", body)

    assert len(audit_sink.events) == 1
    event = audit_sink.events[0]
    assert event.result == AuditResult.SUCCEEDED
    assert event.user_id == "user-42"
    assert event.tool_name == "db_metadata.get_tables"
    assert event.tool_version == "1.0.0"
    assert event.trace_id == ctx["trace_id"]
    assert event.row_count is not None


async def test_permission_denied_records_denied_event(
    pipeline: ToolCallPipeline, audit_sink: InMemoryAuditSink
) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=["AUDITOR"])
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)

    from office_mcp_server.errors import McpError

    try:
        await pipeline.call("db_metadata.get_tables", body)
    except McpError:
        pass

    assert len(audit_sink.events) == 1
    assert audit_sink.events[0].result == AuditResult.DENIED


async def test_no_audit_event_contains_the_actual_filter_value(
    pipeline: ToolCallPipeline, audit_sink: InMemoryAuditSink
) -> None:
    """A value a caller could consider sensitive (here a distinctive marker
    string used only as a filter value) must never surface anywhere in the
    recorded audit events — proving input parameters are not retained."""
    secret_marker = "SENSITIVE_MARKER_XYZ_998877"
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="table_count.query",
        input_={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": "STATUS", "operator": "eq", "value": secret_marker}],
        },
        context=ctx,
    )

    await pipeline.call("table_count.query", body)

    for event in audit_sink.events:
        serialized = event.model_dump_json()
        assert secret_marker not in serialized


def test_audit_event_is_a_flat_summary_not_a_wrapper_around_call_data() -> None:
    """Every field on AuditEvent must be a scalar / small enum, never a
    dict/list that could become a smuggling vector for input or output."""
    for name, field in AuditEvent.model_fields.items():
        annotation = field.annotation
        assert annotation is not None
        # Every declared field type must resolve to a primitive or Optional
        # primitive/enum — never dict/list.
        origin_str = str(annotation)
        assert "dict" not in origin_str.lower(), f"{name} looks like a container: {origin_str}"
        assert "list" not in origin_str.lower(), f"{name} looks like a container: {origin_str}"
