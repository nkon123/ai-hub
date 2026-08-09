"""Security property 5 — injection is rejected at the boundary.

`tests/unit/office_mcp_server/test_injection.py` already unit-tests the
individual validator functions in `tools/db_metadata.py`/`tools/table_count.py`
directly. This module instead sends the same class of payloads over real
HTTP to the live, running office-mcp-server (:8500) -- proving the allowlist
design is actually wired into the FastAPI route, the Pydantic models, and
the error envelope end to end, not just correct as a unit.

Design point this file exists to demonstrate, not just assert: identifiers
(`schema`/`table`/`field`) are validated against a closed allowlist and
rejected outright if they don't match (SQL metacharacters, `--`, `;`, or a
Unicode look-alike all fail the same way, MCP_INPUT_INVALID) -- whereas a
`value` in a `table_count.query` filter is never structurally interpreted at
all, so the *same* injection strings are accepted there as inert, opaque
data (§5.3: "Value만 Prepared Parameter 사용"). Both outcomes are the
correct, secure behavior; asserting only "injection strings always get
rejected" would be testing the wrong property for `value`.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.security.conftest import assert_no_secret_leak, mcp_audit_context

pytestmark = pytest.mark.security

_INJECTION_IDENTIFIER_PAYLOADS = [
    "APP; DROP TABLE INTERFACE_LOG;--",
    "APP' OR '1'='1",
    "APP--",
    "APP/*",
    "APP UNION SELECT * FROM USERS",
    "АPP",  # Cyrillic А (U+0410) look-alike for ASCII "APP"
    "аpp",  # Cyrillic а (U+0430) look-alike, lowercase
]


def _call_body(tool_name: str, raw_input: dict, *, roles: list[str] | None = None) -> dict:
    return {
        "tool_name": tool_name,
        "server_alias": "oracle-connector",
        "input": raw_input,
        "confirmed": True,
        "audit_context": mcp_audit_context(
            requested_tool=tool_name, roles=roles or ["USER"], trace_id=str(uuid.uuid4())
        ),
    }


@pytest.mark.parametrize("payload", _INJECTION_IDENTIFIER_PAYLOADS)
async def test_db_metadata_get_tables_rejects_injection_and_lookalike_schema(
    mcp: httpx.AsyncClient, payload: str
) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json=_call_body("db_metadata.get_tables", {"schema": payload}),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text
    assert_no_secret_leak(resp.text, context=f"get_tables schema={payload!r}")
    assert "SELECT" not in resp.text and "DROP TABLE" not in resp.text


@pytest.mark.parametrize("payload", _INJECTION_IDENTIFIER_PAYLOADS)
async def test_db_metadata_get_columns_rejects_injection_and_lookalike_table(
    mcp: httpx.AsyncClient, payload: str
) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_columns/call",
        json=_call_body("db_metadata.get_columns", {"schema": "APP", "table": payload}),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text
    assert_no_secret_leak(resp.text, context=f"get_columns table={payload!r}")


async def test_table_count_rejects_injection_in_field_and_operator_identifiers(
    mcp: httpx.AsyncClient,
) -> None:
    """`field`/`operator` are identifiers too (§5.3) -- resolved from an
    allowlist, never passed through -- so an injection string there must be
    rejected exactly like a bad `schema`/`table`, not silently coerced."""
    resp = await mcp.post(
        "/mcp/v1/tools/table_count.query/call",
        json=_call_body(
            "table_count.query",
            {
                "schema": "APP",
                "table": "INTERFACE_LOG",
                "filters": [
                    {
                        "field": "STATUS; DROP TABLE INTERFACE_LOG;--",
                        "operator": "eq",
                        "value": "ERROR",
                    }
                ],
            },
        ),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text


async def test_table_count_rejects_injection_operator(mcp: httpx.AsyncClient) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/table_count.query/call",
        json=_call_body(
            "table_count.query",
            {
                "schema": "APP",
                "table": "INTERFACE_LOG",
                "filters": [{"field": "STATUS", "operator": "1=1; --", "value": "ERROR"}],
            },
        ),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text


@pytest.mark.parametrize(
    "value",
    [
        "' OR '1'='1",
        "'; DROP TABLE INTERFACE_LOG; --",
        "ERROR' UNION SELECT password FROM users--",
    ],
)
async def test_table_count_treats_injection_strings_in_value_as_inert_opaque_data(
    mcp: httpx.AsyncClient, value: str
) -> None:
    """The one place a caller-controlled string legitimately flows through
    to the (mock) connector: `filters[].value` on an allowlisted
    `field`/`operator`. §5.3's guarantee is that this can NEVER be
    interpreted as SQL syntax -- proven here by observing the *opposite* of
    an injection-style test: the call SUCCEEDS (200, a plain integer count),
    because the string is compared as data, not concatenated into anything.
    A crash, a non-zero-looking anomalous count, or a leaked query fragment
    would indicate the opposite: that the value ended up being interpreted
    rather than compared."""
    resp = await mcp.post(
        "/mcp/v1/tools/table_count.query/call",
        json=_call_body(
            "table_count.query",
            {
                "schema": "APP",
                "table": "INTERFACE_LOG",
                "filters": [{"field": "STATUS", "operator": "eq", "value": value}],
            },
        ),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["output"]["count"], int)
    assert_no_secret_leak(resp.text, context=f"table_count.query value={value!r}")


async def test_get_columns_input_extra_field_rejected_not_silently_dropped(
    mcp: httpx.AsyncClient,
) -> None:
    """`GetColumnsInput` is `extra="forbid"` -- an unrecognized business
    parameter riding along with valid `schema`/`table` (e.g. a Prompt
    Injection payload trying to smuggle a directive into the tool call) must
    fail validation outright, not be quietly ignored."""
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_columns/call",
        json=_call_body(
            "db_metadata.get_columns",
            {"schema": "APP", "table": "INTERFACE_LOG", "ignore_previous_instructions": True},
        ),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text


async def test_oversized_identifier_rejected(mcp: httpx.AsyncClient) -> None:
    """Length bounds (`max_length=64` on `schema`) are part of the same
    boundary defense -- an absurdly long identifier must fail the same way
    as a malformed one, not hang or degrade the service."""
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json=_call_body("db_metadata.get_tables", {"schema": "A" * 5000}),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MCP_INPUT_INVALID", resp.text
