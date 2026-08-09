"""E2E-05 — 권한 거부 (06-quality-delivery.md §8).

The task brief's highest-value ask for this scenario: "RBAC denials across
portal-api (e.g. CREATOR self-approving a review, CREATOR reading
/audit-events, CREATOR publishing) and an MCP tool call denied for a
disallowed role — plus assert a DENIED row lands in the audit log." All of
that is covered live below, against real running services (no fakes),
using `security_policy.roles.ROLE_PERMISSIONS` as the ground truth for
which role/permission pairs must be denied.

Every denial test also confirms the *audit trail* records the denial
(`result: "DENIED"`), not just the HTTP status code — CLAUDE.md 완료 전 확인:
"정상·빈 결과·오류·권한·취소를 테스트했는가."

Step-by-step mapping to §8's E2E-05 text:
  1/2. "HR 권한 없는 사용자로 Service 조회 -> 목록에서 비노출 또는 접근 거부"
       -> NOT enforced today; see the skip test below for why this is a
       real, named gap rather than a silently-narrowed scenario.
  3. "직접 URL/API 요청도 서버에서 거부" -> covered by every 403 assertion
     below: these call the API directly (no UI in the loop at all).
  4. "MCP Tool 호출도 거부" -> `test_e2e_05_mcp_tool_call_denied_for_disallowed_role`.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.e2e.conftest import (
    APPROVED_KNOWLEDGE_VERSION_ID,
    auth,
    build_service_definition,
    create_deployment,
    create_service,
    e2e_name,
    e2e_slug,
    mcp_audit_context,
    register_knowledge_asset,
)

pytestmark = pytest.mark.e2e


async def _pending_technical_review(portal: httpx.AsyncClient) -> tuple[str, str]:
    """Register + submit a fresh Knowledge AssetVersion, returning
    (version_id, review_id) with a PENDING TECHNICAL review — a target
    CREATOR has no permission to decide, regardless of ownership."""
    version = await register_knowledge_asset(
        portal, name=e2e_name("perm-denied-fixture"), markdown_content="# 문서\n\n내용\n"
    )
    version_id = version["id"]
    resp = await portal.post(f"/api/v1/asset-versions/{version_id}/submit", headers=auth("CREATOR"))
    resp.raise_for_status()
    return version_id, resp.json()["review_id"]


async def test_e2e_05_creator_cannot_decide_own_review(portal: httpx.AsyncClient) -> None:
    """CREATOR lacks REVIEW_DECIDE_TECHNICAL entirely (ROLE_PERMISSIONS) —
    denied even on their own submitted version."""
    trace_id = str(uuid.uuid4())
    _, review_id = await _pending_technical_review(portal)

    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "제가 승인합니다"},
        headers={**auth("CREATOR"), "X-Trace-Id": trace_id},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    resp = await portal.get(
        "/api/v1/audit-events", params={"resource_id": review_id}, headers=auth("AUDITOR")
    )
    resp.raise_for_status()
    denied = [
        e
        for e in resp.json()["items"]
        if e["trace_id"] == trace_id and e["result"] == "DENIED"
    ]
    assert denied, "expected a DENIED audit row for the self-approval attempt"
    assert "REVIEW_DECIDE_TECHNICAL" in denied[0]["event_type"]


async def test_e2e_05_creator_cannot_read_audit_events(portal: httpx.AsyncClient) -> None:
    """CREATOR lacks AUDIT_READ (only AUDITOR/ADMIN hold it)."""
    trace_id = str(uuid.uuid4())
    resp = await portal.get(
        "/api/v1/audit-events", headers={**auth("CREATOR"), "X-Trace-Id": trace_id}
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    resp = await portal.get(
        "/api/v1/audit-events", params={"actor_id": "dev-user@miracom.com"}, headers=auth("AUDITOR")
    )
    resp.raise_for_status()
    denied = [e for e in resp.json()["items"] if e["trace_id"] == trace_id]
    assert denied and denied[0]["result"] == "DENIED"
    assert "AUDIT_READ" in denied[0]["event_type"]


async def test_e2e_05_creator_cannot_publish_deployment(portal: httpx.AsyncClient) -> None:
    """DEPLOYMENT_PUBLISH is RELEASE_MANAGER/ADMIN-only (D-040) — CREATOR
    cannot self-publish even a deployment it created itself."""
    trace_id = str(uuid.uuid4())
    definition = build_service_definition(
        name=e2e_name("perm-denied-service"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version = await create_service(portal, definition)
    resp = await create_deployment(
        portal, service_version_id=service_version["id"], slug=e2e_slug("perm-denied")
    )
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/publish",
        headers={**auth("CREATOR"), "X-Trace-Id": trace_id},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    resp = await portal.get(
        "/api/v1/audit-events", params={"resource_id": deployment_id}, headers=auth("AUDITOR")
    )
    resp.raise_for_status()
    denied = [e for e in resp.json()["items"] if e["trace_id"] == trace_id]
    assert denied and denied[0]["result"] == "DENIED"
    assert "DEPLOYMENT_PUBLISH" in denied[0]["event_type"]


async def test_e2e_05_mcp_tool_call_denied_for_disallowed_role(mcp: httpx.AsyncClient) -> None:
    """office-mcp-server's own allowlist (`USER, CREATOR, TECH_REVIEWER,
    ADMIN`) denies roles outside it -- SECURITY_REVIEWER here, a role that
    legitimately holds review permissions on Portal but has no business
    calling a read-only DB metadata Tool directly."""
    trace_id = str(uuid.uuid4())
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_columns/call",
        json={
            "tool_name": "db_metadata.get_columns",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP", "table": "INTERFACE_LOG"},
            "confirmed": False,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_columns",
                roles=["SECURITY_REVIEWER"],
                trace_id=trace_id,
            ),
        },
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "MCP_PERMISSION_DENIED"

    resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    resp.raise_for_status()
    events = resp.json()["events"]
    assert events and events[0]["result"] == "DENIED"


def test_e2e_05_step1_service_visibility_acl_not_enforced() -> None:
    pytest.skip(
        "E2E-05 steps 1-2 (HR 권한 없는 사용자에게 Service가 목록에서 비노출되거나 "
        "접근 거부됨) are NOT implemented today: GET /api/v1/services, "
        "GET /api/v1/service-versions/{id}, and GET /api/v1/deployments/{id} on "
        "apps/portal-api/src/portal_api/routers/services.py only require a valid "
        "Test Identity token (SERVICE_READ, granted to every role) — there is no "
        "target_orgs/target_roles ACL check narrowing what a given caller can see, "
        "even though ServiceDeployment already stores target_orgs/target_roles "
        "columns. This is a real gap, not a narrowed assertion — see "
        "open-decisions.md D-022 (조직·사업장 권한, still PoC-assumption Role+Org+Site "
        "without a target-audience read filter)."
    )
