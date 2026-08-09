"""Security property 6 — secrets and internals don't leak, and the Hosted
Chat "safe 404" (no existence oracle) property holds.

Sweeps the bodies of a deliberately broad set of failing requests
(401/403/404/409/400/422) across portal-api and office-mcp-server, and
separately proves an unknown Hosted Chat slug and a suspended one are
observationally indistinguishable from outside -- CLAUDE.md 로그 규칙 ("내부
오류·Stack Trace 제거") and 05-mcp-security-governance.md §9 ("내부 오류·
Stack Trace 제거") applied end to end, not just at the one layer
(`office_mcp_server.output_filter`) that already has a unit test for it.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.security.conftest import (
    APPROVED_KNOWLEDGE_VERSION_ID,
    assert_no_secret_leak,
    auth,
    build_service_definition,
    create_deployment,
    create_service,
    e2e_name,
    e2e_slug,
    mcp_audit_context,
    publish_deployment,
    strip_trace_id,
)

pytestmark = pytest.mark.security


# --- Sweep: a deliberately-failing request per status code, per service ----


async def test_leak_sweep_portal_api_401_missing_auth(portal: httpx.AsyncClient) -> None:
    resp = await portal.get("/api/v1/assets")
    assert resp.status_code == 401
    assert_no_secret_leak(resp.text, context="portal-api 401")


async def test_leak_sweep_portal_api_403_permission_denied(portal: httpx.AsyncClient) -> None:
    resp = await portal.get("/api/v1/audit-events", headers=auth("CREATOR"))
    assert resp.status_code == 403
    assert_no_secret_leak(resp.text, context="portal-api 403")


async def test_leak_sweep_portal_api_404_unknown_asset(portal: httpx.AsyncClient) -> None:
    resp = await portal.get(f"/api/v1/assets/{uuid.uuid4()}", headers=auth("CREATOR"))
    assert resp.status_code == 404
    assert_no_secret_leak(resp.text, context="portal-api 404")


async def test_leak_sweep_portal_api_409_double_decision(portal: httpx.AsyncClient) -> None:
    from tests.security.conftest import register_knowledge_asset

    version = await register_knowledge_asset(
        portal, name=e2e_name("leak-sweep-409"), markdown_content="# 문서\n\n내용\n"
    )
    resp = await portal.post(
        f"/api/v1/asset-versions/{version['id']}/submit", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    review_id = resp.json()["review_id"]
    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "1차"},
        headers=auth("TECH_REVIEWER"),
    )
    resp.raise_for_status()
    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "2차 (충돌 유발)"},
        headers=auth("TECH_REVIEWER"),
    )
    assert resp.status_code == 409
    assert_no_secret_leak(resp.text, context="portal-api 409")


async def test_leak_sweep_portal_api_400_invalid_manifest_json(portal: httpx.AsyncClient) -> None:
    resp = await portal.post(
        "/api/v1/assets",
        data={"manifest": "{not valid json"},
        headers=auth("CREATOR"),
    )
    assert resp.status_code == 400
    assert_no_secret_leak(resp.text, context="portal-api 400 invalid manifest JSON")
    # This one path uses FastAPI's raw HTTPException (`detail`), not the
    # `{error: {...}}` envelope -- still must not echo a Python exception
    # object or parser internals beyond a plain message.
    assert "json.decoder" not in resp.text.lower()


async def test_leak_sweep_portal_api_422_malformed_request_body(portal: httpx.AsyncClient) -> None:
    resp = await portal.post(
        "/api/v1/reviews/some-id/decisions",
        json={"decision": 12345},  # wrong type -- FastAPI/Pydantic 422
        headers=auth("TECH_REVIEWER"),
    )
    assert resp.status_code == 422
    assert_no_secret_leak(resp.text, context="portal-api 422")


async def test_leak_sweep_mcp_400_input_invalid(mcp: httpx.AsyncClient) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "NOT_ALLOWED"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_tables", roles=["USER"]
            ),
        },
    )
    assert resp.status_code == 400
    assert_no_secret_leak(resp.text, context="office-mcp-server 400")


async def test_leak_sweep_mcp_403_permission_denied(mcp: httpx.AsyncClient) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_columns/call",
        json={
            "tool_name": "db_metadata.get_columns",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP", "table": "INTERFACE_LOG"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_columns", roles=["AUDITOR"]
            ),
        },
    )
    assert resp.status_code == 403
    assert_no_secret_leak(resp.text, context="office-mcp-server 403")


async def test_leak_sweep_mcp_404_unknown_tool(mcp: httpx.AsyncClient) -> None:
    resp = await mcp.post(
        "/mcp/v1/tools/does_not_exist.query/call",
        json={
            "tool_name": "does_not_exist.query",
            "server_alias": "oracle-connector",
            "input": {},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="does_not_exist.query", roles=["USER"]
            ),
        },
    )
    assert resp.status_code == 404
    assert_no_secret_leak(resp.text, context="office-mcp-server 404")


async def test_leak_sweep_mcp_admin_403_missing_actor_role(mcp: httpx.AsyncClient) -> None:
    resp = await mcp.get("/admin/audit/events")  # no X-Actor-Role header at all
    assert resp.status_code == 403
    assert_no_secret_leak(resp.text, context="office-mcp-server admin 403")


# --- Hosted Chat safe-404: no existence oracle -----------------------------


async def test_hosted_chat_unknown_and_suspended_slug_return_identical_error(
    portal: httpx.AsyncClient, agent: httpx.AsyncClient
) -> None:
    """05-mcp-security-governance.md / `chat.py` module docstring §9: a
    truly-never-existed slug and a slug that exists but is SUSPENDED must be
    indistinguishable to an outside caller -- same status code, same error
    code, same message. Only `trace_id` (a fresh uuid4 minted per request,
    `chat.py`'s `_deployment_not_active_error`) is allowed to differ, so the
    comparison below normalizes that one field before asserting equality."""
    definition = build_service_definition(
        name=e2e_name("safe-404-service"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version = await create_service(portal, definition)
    slug = e2e_slug("safe-404")
    resp = await create_deployment(portal, service_version_id=service_version["id"], slug=slug)
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]
    resp = await publish_deployment(portal, deployment_id)
    assert resp.status_code == 202, resp.text

    # Confirm it is genuinely reachable before suspending it (otherwise a
    # "same 404 either way" result could just mean the deployment was never
    # live in the first place).
    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text

    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "tests/security safe-404 시나리오 검증"},
        headers=auth("RELEASE_MANAGER"),
    )
    assert resp.status_code == 200, resp.text

    never_existed_slug = e2e_slug("never-existed")
    resp_unknown = await agent.get(f"/chat-api/v1/chatbots/{never_existed_slug}")
    resp_suspended = await agent.get(f"/chat-api/v1/chatbots/{slug}")

    assert resp_unknown.status_code == resp_suspended.status_code == 404
    normalized_unknown = strip_trace_id(resp_unknown.json())
    normalized_suspended = strip_trace_id(resp_suspended.json())
    assert normalized_unknown == normalized_suspended, (
        normalized_unknown,
        normalized_suspended,
    )
    assert normalized_unknown["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"

    # Same property for session creation (POST, 403 rather than 404 -- see
    # chat.py's own comment on why: "세션 요청은 슬러그가 존재했는지도 드러내면
    # 안 된다").
    resp_unknown_session = await agent.post(
        "/chat-api/v1/sessions", json={"slug": never_existed_slug}
    )
    resp_suspended_session = await agent.post("/chat-api/v1/sessions", json={"slug": slug})
    assert resp_unknown_session.status_code == resp_suspended_session.status_code == 403
    assert strip_trace_id(resp_unknown_session.json()) == strip_trace_id(
        resp_suspended_session.json()
    )
