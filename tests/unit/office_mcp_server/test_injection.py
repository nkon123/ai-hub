"""Injection defenses — 05-mcp-security-governance.md §5.3, §13 SEC-06/SEC-07.

The Mock Connector's `execute_named_query(query_id, parameters, context)`
signature has no `sql: str` parameter anywhere — there is no code path
through which a string could become SQL syntax. This file proves two
things per malicious input:

1. Schema/Table/Field/Operator identifiers outside the allowlist are
   rejected as `MCP_INPUT_INVALID` *before* the Connector is ever called
   (`SpyConnector.calls` stays empty) — allowlist membership, not string
   sanitization.
2. A value containing injection-shaped text (`' OR '1'='1`, `; DROP TABLE
   ...`, `--`) is accepted as ordinary *data* — the call succeeds, the
   Connector receives it verbatim inside `filters[].value` (never woven
   into anything resembling a query string), and it behaves as an inert
   equality comparison (typically matching zero rows).
"""

from __future__ import annotations

from typing import Any

import pytest
from office_mcp_server.audit import InMemoryAuditSink
from office_mcp_server.connector import Connector, ConnectorStatus, MockOracleConnector, QueryId
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.execution import RateLimiter
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.request_context import RequestContext
from office_mcp_server.tool_registry import ToolRegistry
from office_mcp_server.tools_setup import register_poc_tools

from .conftest import make_call_body, make_context


class SpyConnector(Connector):
    """Wraps the real Mock connector but records every call so tests can
    assert the connector layer was never reached with a malicious
    identifier, and inspect exactly what it *did* receive."""

    def __init__(self) -> None:
        self._inner = MockOracleConnector()
        self.calls: list[tuple[QueryId, dict]] = []

    async def health(self) -> ConnectorStatus:
        return await self._inner.health()

    async def execute_named_query(
        self, query_id: QueryId, parameters: dict, context: RequestContext
    ) -> Any:
        self.calls.append((query_id, parameters))
        return await self._inner.execute_named_query(query_id, parameters, context)

    async def close(self) -> None:
        return await self._inner.close()


@pytest.fixture
def spy_connector() -> SpyConnector:
    return SpyConnector()


@pytest.fixture
def spy_pipeline(spy_connector: SpyConnector) -> ToolCallPipeline:
    reg = ToolRegistry()
    register_poc_tools(reg)
    return ToolCallPipeline(
        registry=reg,
        connector=spy_connector,
        audit_sink=InMemoryAuditSink(),
        rate_limiter=RateLimiter(),
    )


MALICIOUS_IDENTIFIERS = [
    "APP; DROP TABLE INTERFACE_LOG",
    "APP--",
    "APP' OR '1'='1",
    "APP/*comment*/",
    "../../etc/passwd",
    "APP\x00NUL",
    "APP​ZW",  # zero-width space smuggled in
    "АPP",  # Cyrillic А look-alike for 'A'
    "ＡＰＰ",  # full-width lookalike
    "APP OR 1=1",
    "",
]


@pytest.mark.parametrize("malicious_schema", MALICIOUS_IDENTIFIERS)
async def test_malicious_schema_rejected_before_connector(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector, malicious_schema: str
) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": malicious_schema}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await spy_pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
    assert spy_connector.calls == []


@pytest.mark.parametrize("malicious_table", MALICIOUS_IDENTIFIERS + ["interface_log"])
async def test_malicious_table_rejected_before_connector(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector, malicious_table: str
) -> None:
    ctx = make_context(requested_tool="db_metadata.get_columns")
    body = make_call_body(
        tool_name="db_metadata.get_columns",
        input_={"schema": "APP", "table": malicious_table},
        context=ctx,
    )
    with pytest.raises(McpError) as exc_info:
        await spy_pipeline.call("db_metadata.get_columns", body)
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
    assert spy_connector.calls == []


@pytest.mark.parametrize("malicious_field", MALICIOUS_IDENTIFIERS + ["STATUS = 'ERROR' OR 1=1"])
async def test_malicious_filter_field_rejected_before_connector(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector, malicious_field: str
) -> None:
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="table_count.query",
        input_={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": malicious_field, "operator": "eq", "value": "ERROR"}],
        },
        context=ctx,
    )
    with pytest.raises(McpError) as exc_info:
        await spy_pipeline.call("table_count.query", body)
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
    assert spy_connector.calls == []


@pytest.mark.parametrize(
    "malicious_operator",
    ["=", "OR", "1=1", "; DROP", "eq; DROP TABLE INTERFACE_LOG;", "LIKE", "eq OR 1=1"],
)
async def test_malicious_filter_operator_rejected_before_connector(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector, malicious_operator: str
) -> None:
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="table_count.query",
        input_={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": "STATUS", "operator": malicious_operator, "value": "ERROR"}],
        },
        context=ctx,
    )
    with pytest.raises(McpError) as exc_info:
        await spy_pipeline.call("table_count.query", body)
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
    assert spy_connector.calls == []


INJECTION_VALUES = [
    "' OR '1'='1",
    "'; DROP TABLE INTERFACE_LOG; --",
    "ERROR' --",
    "\x00\x01",
    "𝐀𝐃𝐌𝐈𝐍",  # mathematical bold unicode lookalike
]


@pytest.mark.parametrize("injection_value", INJECTION_VALUES)
async def test_injection_shaped_value_is_treated_as_inert_data(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector, injection_value: str
) -> None:
    """`value` is data, not an identifier — the call must succeed (no crash,
    no special interpretation), the connector must receive it verbatim
    inside `filters[].value`, and since no dataset row equals this literal
    string, it behaves as an ordinary (typically zero-match) filter."""
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="table_count.query",
        input_={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": "STATUS", "operator": "eq", "value": injection_value}],
        },
        context=ctx,
    )
    result = await spy_pipeline.call("table_count.query", body)

    assert result["success"] is True
    assert result["output"]["count"] == 0  # no row's STATUS equals the injection string

    assert len(spy_connector.calls) == 1
    query_id, parameters = spy_connector.calls[0]
    assert query_id == QueryId.COUNT_WITH_FILTERS
    expected_filter = {"field": "STATUS", "operator": "eq", "value": injection_value}
    assert parameters["filters"] == [expected_filter]
    # The connector received exactly one parameters dict — never a raw SQL
    # string anywhere in its call args.
    assert "SELECT" not in str(parameters).upper()


async def test_too_many_filters_rejected(
    spy_pipeline: ToolCallPipeline, spy_connector: SpyConnector
) -> None:
    ctx = make_context(requested_tool="table_count.query")
    filters = [{"field": "STATUS", "operator": "eq", "value": "ERROR"} for _ in range(50)]
    body = make_call_body(
        tool_name="table_count.query",
        input_={"schema": "APP", "table": "INTERFACE_LOG", "filters": filters},
        context=ctx,
    )
    with pytest.raises(McpError) as exc_info:
        await spy_pipeline.call("table_count.query", body)
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
    assert spy_connector.calls == []


async def test_connector_interface_has_no_sql_string_parameter() -> None:
    """Structural guarantee, not a runtime check: `execute_named_query`'s
    signature only accepts a `QueryId` enum member + a `parameters` dict —
    there is no `sql`/`query`/`statement` string parameter to smuggle
    anything through, for the Mock or any future real connector."""
    import inspect

    sig = inspect.signature(Connector.execute_named_query)
    param_names = list(sig.parameters.keys())
    assert param_names == ["self", "query_id", "parameters", "context"]
