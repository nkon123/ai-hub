"""Shared fixtures for office_mcp_server unit tests.

Everything here builds a fresh, in-process `ToolRegistry` +
`MockOracleConnector` + `InMemoryAuditSink` + `ToolCallPipeline` per test (no
live services, no network — task requirement). Tests that exercise the HTTP
layer use `fastapi.testclient.TestClient(office_mcp_server.main.app)`
directly against the module-level singletons in `main.py`; those tests are
responsible for restoring any Kill Switch state they change.
"""

from __future__ import annotations

from typing import Any

import pytest
from office_mcp_server.audit import InMemoryAuditSink
from office_mcp_server.connector import MockOracleConnector
from office_mcp_server.execution import RateLimiter
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import ToolRegistry
from office_mcp_server.tools_setup import register_poc_tools

VALID_ORG = "miracom"
VALID_SITE = "headquarters"


def make_context(
    *,
    requested_tool: str,
    user_id: str = "user-1",
    roles: list[str] | None = None,
    organization_id: str = VALID_ORG,
    site_id: str = VALID_SITE,
    trace_id: str = "trace-1",
    run_id: str = "run-1",
) -> dict[str, Any]:
    return {
        "request_id": "req-1",
        "trace_id": trace_id,
        "run_id": run_id,
        "service_id": "svc-1",
        "service_version": "1.0.0",
        "agent_id": "agent-1",
        "agent_version": "1.0.0",
        "user": {
            "id": user_id,
            "organization_id": organization_id,
            "site_id": site_id,
            "roles": roles if roles is not None else ["USER"],
        },
        "requested_tool": requested_tool,
    }


def make_call_body(
    *,
    tool_name: str,
    input_: dict,
    context: dict | None = None,
    server_alias: str = "oracle-connector",
    confirmed: bool = False,
    **context_overrides: Any,
) -> dict:
    return {
        "tool_name": tool_name,
        "server_alias": server_alias,
        "input": input_,
        "audit_context": context or make_context(requested_tool=tool_name, **context_overrides),
        "confirmed": confirmed,
    }


@pytest.fixture
def registry() -> ToolRegistry:
    reg = ToolRegistry()
    register_poc_tools(reg)
    return reg


@pytest.fixture
def connector() -> MockOracleConnector:
    return MockOracleConnector()


@pytest.fixture
def audit_sink() -> InMemoryAuditSink:
    return InMemoryAuditSink()


@pytest.fixture
def pipeline(
    registry: ToolRegistry, connector: MockOracleConnector, audit_sink: InMemoryAuditSink
) -> ToolCallPipeline:
    return ToolCallPipeline(
        registry=registry,
        connector=connector,
        audit_sink=audit_sink,
        rate_limiter=RateLimiter(),
    )
