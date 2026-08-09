"""Security property 7 — denials are audited, and the audit record itself
carries no request body / secret material.

`tests/integration/portal_api/test_reviews.py` already checks that a denied
review decision is recorded under Fake DI. This module adds two things that
require the real, running system: (1) the DENIED row is independently
*readable* through the real `AUDIT_READ`-gated endpoint by a real AUDITOR
token (not just present in a test's in-memory session), and (2) the
audit record's `metadata` never echoes back the sensitive-looking content of
the denied request itself -- proving `require_permission` (`rbac.py`)'s
fixed, small metadata shape (`{"required_permission", "role"}`) actually
reaches the wire, rather than some other code path re-logging the full
request body under a different key.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.security.conftest import assert_no_secret_leak, auth, mcp_audit_context

pytestmark = pytest.mark.security

_CANARY = "canary-super-secret-value-should-never-appear-in-audit-9f31"


async def test_denied_action_lands_as_denied_row_readable_by_auditor(
    portal: httpx.AsyncClient,
) -> None:
    trace_id = str(uuid.uuid4())
    resp = await portal.get(
        "/api/v1/audit-events", headers={**auth("CREATOR"), "X-Trace-Id": trace_id}
    )
    assert resp.status_code == 403, resp.text

    audit_resp = await portal.get(
        "/api/v1/audit-events",
        params={"actor_id": "dev-user@miracom.com"},
        headers=auth("AUDITOR"),
    )
    audit_resp.raise_for_status()
    matches = [e for e in audit_resp.json()["items"] if e["trace_id"] == trace_id]
    assert matches, "expected the denial itself to produce a readable DENIED audit row"
    assert matches[0]["result"] == "DENIED", matches[0]
    assert matches[0]["event_type"] == "PERMISSION_DENIED:AUDIT_READ", matches[0]


async def test_denial_audit_metadata_never_echoes_the_request_body(
    portal: httpx.AsyncClient,
) -> None:
    """A CREATOR attempts to suspend a Deployment, putting a canary value in
    the (never-reached) `reason` field -- `require_permission` denies before
    `body.reason` is ever read (`deployments.py`: permission check precedes
    the reason validation), so the resulting audit row's `metadata` must not
    contain the canary, or any part of the raw request, at all."""
    trace_id = str(uuid.uuid4())
    resp = await portal.post(
        f"/api/v1/deployments/{uuid.uuid4()}/suspend",
        json={"reason": _CANARY},
        headers={**auth("CREATOR"), "X-Trace-Id": trace_id},
    )
    assert resp.status_code == 403, resp.text

    audit_resp = await portal.get(
        "/api/v1/audit-events", params={"actor_id": "dev-user@miracom.com"}, headers=auth("AUDITOR")
    )
    audit_resp.raise_for_status()
    matches = [e for e in audit_resp.json()["items"] if e["trace_id"] == trace_id]
    assert matches, "expected a DENIED row for the suspend attempt"
    event = matches[0]
    assert event["result"] == "DENIED"
    assert _CANARY not in str(event), f"audit row leaked the request body's reason field: {event}"
    assert set(event["metadata"].keys()) <= {"required_permission", "role"}, event["metadata"]


async def test_mcp_denied_call_audit_event_has_no_input_or_output_fields(
    mcp: httpx.AsyncClient,
) -> None:
    """05-mcp-security-governance.md §10: "입력 Parameter와 결과 본문은 기본
    Audit Event에 포함하지 않는다." `AuditEvent` (audit.py) structurally has
    no `input`/`output`/`parameters` attribute at all -- this test confirms
    that guarantee holds for the actual JSON this suite can observe over
    HTTP, including for a DENIED call whose `input` contained a canary
    value."""
    trace_id = str(uuid.uuid4())
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_columns/call",
        json={
            "tool_name": "db_metadata.get_columns",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP", "table": "INTERFACE_LOG", "canary": _CANARY},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_columns", roles=["AUDITOR"], trace_id=trace_id
            ),
        },
    )
    assert resp.status_code == 403, resp.text  # AUDITOR is outside this tool's allowed_roles

    audit_resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    audit_resp.raise_for_status()
    events = audit_resp.json()["events"]
    assert events, "expected the denial to be audited"
    event = events[0]
    assert event["result"] == "DENIED", event
    assert "input" not in event and "output" not in event and "parameters" not in event
    assert _CANARY not in str(event), f"MCP audit event leaked tool input: {event}"
    assert_no_secret_leak(str(event), context="MCP DENIED audit event")
