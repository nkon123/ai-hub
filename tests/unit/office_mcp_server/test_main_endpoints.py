"""HTTP-layer tests against the FastAPI app — 05-mcp-security-governance.md
§11 operational API, plus end-to-end tool-call flows and the Kill Switch at
the HTTP boundary.

These tests share `office_mcp_server.main`'s module-level registry/pipeline
singletons (that's what `TestClient(app)` exercises), so any test that
disables a tool re-enables it in a `finally` block to avoid leaking state
into other tests in this file.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from office_mcp_server.main import app

from .conftest import make_call_body, make_context

client = TestClient(app)


def test_health_live() -> None:
    resp = client.get("/health/live")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_health_ready() -> None:
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_version() -> None:
    resp = client.get("/version")
    body = resp.json()
    assert body["schema_version"] == "1.0"
    tool_names = {t["name"] for t in body["tools"]}
    assert tool_names == {
        "calculator.add",
        "db_metadata.get_tables",
        "db_metadata.get_columns",
        "table_count.query",
    }


def test_list_tools_returns_registered_tools() -> None:
    resp = client.get("/mcp/v1/tools")
    body = resp.json()
    assert body["count"] == 4
    names = {t["name"] for t in body["tools"]}
    assert names == {
        "calculator.add",
        "db_metadata.get_tables",
        "db_metadata.get_columns",
        "table_count.query",
    }
    for t in body["tools"]:
        assert t["status"] == "ACTIVE"
        assert t["risk_level"] == "READ_ONLY"


def test_get_tables_end_to_end() -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)
    resp = client.post("/mcp/v1/tools/db_metadata.get_tables/call", json=body)
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["success"] is True
    expected_item = {"table": "INTERFACE_LOG", "schema": "APP", "comment": "인터페이스 처리 이력"}
    assert expected_item in payload["output"]["items"]


def test_calculator_add_end_to_end() -> None:
    ctx = make_context(requested_tool="calculator.add")
    body = make_call_body(
        tool_name="calculator.add", input_={"a": 12.5, "b": 7.5}, context=ctx
    )
    resp = client.post("/mcp/v1/tools/calculator.add/call", json=body)
    assert resp.status_code == 200
    assert resp.json()["output"] == {"result": 20.0, "classification": "PUBLIC_INTERNAL"}


def test_calculator_add_rejects_non_numeric_input() -> None:
    ctx = make_context(requested_tool="calculator.add")
    body = make_call_body(
        tool_name="calculator.add", input_={"a": "12", "b": 7.5}, context=ctx
    )
    resp = client.post("/mcp/v1/tools/calculator.add/call", json=body)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID"


def test_table_count_query_end_to_end() -> None:
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="table_count.query",
        input_={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": "STATUS", "operator": "eq", "value": "ERROR"}],
        },
        context=ctx,
    )
    resp = client.post("/mcp/v1/tools/table_count.query/call", json=body)
    assert resp.status_code == 200
    assert resp.json()["output"]["count"] == 4


def test_table_count_without_filters_requires_confirmation_then_succeeds() -> None:
    ctx = make_context(requested_tool="table_count.query")

    unconfirmed = make_call_body(
        tool_name="table_count.query",
        input_={"schema": "APP", "table": "INTERFACE_LOG"},
        context=ctx,
        confirmed=False,
    )
    resp1 = client.post("/mcp/v1/tools/table_count.query/call", json=unconfirmed)
    assert resp1.status_code == 400
    assert resp1.json()["error"]["code"] == "VALIDATION_ERROR"
    assert resp1.json()["error"]["details"]["requires_confirmation"] is True

    confirmed = {**unconfirmed, "confirmed": True}
    resp2 = client.post("/mcp/v1/tools/table_count.query/call", json=confirmed)
    assert resp2.status_code == 200
    assert resp2.json()["output"]["count"] == 12


def test_wrong_server_alias_rejected() -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(
        tool_name="db_metadata.get_tables",
        input_={"schema": "APP"},
        context=ctx,
        server_alias="some-other-server",
    )
    resp = client.post("/mcp/v1/tools/db_metadata.get_tables/call", json=body)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MCP_TOOL_NOT_FOUND"


def test_unknown_tool_name_rejected() -> None:
    ctx = make_context(requested_tool="db_metadata.delete_everything")
    body = make_call_body(
        tool_name="db_metadata.delete_everything", input_={}, context=ctx
    )
    resp = client.post("/mcp/v1/tools/db_metadata.delete_everything/call", json=body)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MCP_TOOL_NOT_FOUND"


def test_error_envelope_shape() -> None:
    """07-data-api-contracts.md §10.2 Error Envelope."""
    body = {
        "tool_name": "db_metadata.get_tables",
        "server_alias": "oracle-connector",
        "input": {"schema": "APP"},
        # no audit_context
    }
    resp = client.post("/mcp/v1/tools/db_metadata.get_tables/call", json=body)
    assert resp.status_code == 400
    error = resp.json()["error"]
    assert set(["code", "message", "trace_id"]).issubset(error.keys())
    assert error["code"] == "VALIDATION_ERROR"


def test_x_trace_id_header_used_for_error_envelope_when_context_missing() -> None:
    body = {
        "tool_name": "db_metadata.get_tables",
        "server_alias": "oracle-connector",
        "input": {"schema": "APP"},
    }
    resp = client.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json=body,
        headers={"X-Trace-ID": "caller-supplied-trace-id"},
    )
    assert resp.json()["error"]["trace_id"] == "caller-supplied-trace-id"


def test_admin_endpoints_require_admin_role() -> None:
    assert client.get("/admin/tools").status_code == 403
    assert (
        client.post("/admin/tools/db_metadata.get_tables/disable").status_code == 403
    )


def test_admin_endpoints_accept_admin_role() -> None:
    resp = client.get("/admin/tools", headers={"X-Actor-Role": "ADMIN"})
    assert resp.status_code == 200
    names = {t["name"] for t in resp.json()["tools"]}
    assert "table_count.query" in names


def test_kill_switch_disable_then_enable_over_http() -> None:
    admin_headers = {"X-Actor-Role": "ADMIN"}
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)

    try:
        disable_resp = client.post(
            "/admin/tools/db_metadata.get_tables/disable", headers=admin_headers
        )
        assert disable_resp.status_code == 200
        assert disable_resp.json()["status"] == "DISABLED"

        call_resp = client.post("/mcp/v1/tools/db_metadata.get_tables/call", json=body)
        assert call_resp.status_code == 409
        assert call_resp.json()["error"]["code"] == "MCP_TOOL_DISABLED"
    finally:
        enable_resp = client.post(
            "/admin/tools/db_metadata.get_tables/enable", headers=admin_headers
        )
        assert enable_resp.status_code == 200
        assert enable_resp.json()["status"] == "ACTIVE"

    # Reappears and works again after enable.
    call_resp_2 = client.post("/mcp/v1/tools/db_metadata.get_tables/call", json=body)
    assert call_resp_2.status_code == 200


def test_disabling_unknown_tool_returns_not_found() -> None:
    resp = client.post(
        "/admin/tools/does_not_exist/disable", headers={"X-Actor-Role": "ADMIN"}
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MCP_TOOL_NOT_FOUND"
