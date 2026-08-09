"""Security property 2 — server-side authorization cannot be bypassed by
the client.

CLAUDE.md UI 구현 규칙: "모든 권한 검사는 서버에서 수행하며 화면 숨김만으로
권한을 통제하지 않는다." `tests/unit/security_policy/` already proves
`has_permission`/`ROLE_PERMISSIONS` are correct in isolation as pure
functions; `tests/integration/portal_api/` proves the FastAPI routers call
`require_permission` under Fake-DI. What neither can prove is that hitting
the real, running process directly -- no browser, no hidden UI element, just
a bearer token and an HTTP client -- actually gets denied through the real
dependency-injection wiring, the real database, the real middleware stack.

Every denial below is asserted three ways: (1) the exact HTTP status the
task brief specifies, (2) the *envelope shape*
`{"error": {"code": "PERMISSION_DENIED", "message", "trace_id"}}` --
specifically not a 500, not a bare FastAPI `{"detail": ...}`, not a stack
trace, and (3) that the body carries no leaked internals. `rbac.py`'s
`require_permission` is the single choke point that produces this envelope
for every router in this file (see its docstring) -- these tests confirm
that choke point is actually reached over the wire for all five endpoint
categories the task brief names: review decisions, publish, suspend,
audit-events read, asset creation.
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
    register_knowledge_asset,
)

pytestmark = pytest.mark.security


def _assert_permission_denied_envelope(resp: httpx.Response, *, expected_status: int = 403) -> None:
    assert resp.status_code == expected_status, resp.text
    body = resp.json()
    assert "error" in body, f"not an error envelope: {body}"
    assert body["error"]["code"] == "PERMISSION_DENIED", body
    assert body["error"].get("message"), "PERMISSION_DENIED must carry a human-readable message"
    assert body["error"].get("trace_id"), "PERMISSION_DENIED must carry a trace_id"
    assert_no_secret_leak(resp.text, context=f"PERMISSION_DENIED envelope ({resp.request.url})")


async def _pending_technical_review(portal: httpx.AsyncClient) -> str:
    version = await register_knowledge_asset(
        portal, name=e2e_name("authz-bypass-fixture"), markdown_content="# 문서\n\n내용\n"
    )
    resp = await portal.post(
        f"/api/v1/asset-versions/{version['id']}/submit", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    return resp.json()["review_id"]


async def test_review_decision_denied_for_creator_direct_api_call(
    portal: httpx.AsyncClient,
) -> None:
    """CREATOR lacks REVIEW_DECIDE_TECHNICAL entirely -- hitting the decision
    endpoint directly (no reviewer UI ever renders this action for a
    CREATOR) must still be refused server-side."""
    review_id = await _pending_technical_review(portal)
    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "직접 API 호출로 승인 시도"},
        headers=auth("CREATOR"),
    )
    _assert_permission_denied_envelope(resp)


async def test_publish_denied_for_creator_direct_api_call(portal: httpx.AsyncClient) -> None:
    """DEPLOYMENT_PUBLISH is RELEASE_MANAGER/ADMIN-only (D-040) -- a CREATOR
    who created the Service/Deployment themselves still cannot self-publish
    by calling the publish endpoint directly."""
    definition = build_service_definition(
        name=e2e_name("authz-bypass-svc"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version = await create_service(portal, definition)
    resp = await create_deployment(
        portal, service_version_id=service_version["id"], slug=e2e_slug("authz-bypass")
    )
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth("CREATOR")
    )
    _assert_permission_denied_envelope(resp, expected_status=403)


async def test_suspend_denied_for_creator_direct_api_call(portal: httpx.AsyncClient) -> None:
    """DEPLOYMENT_SUSPEND is RELEASE_MANAGER/ADMIN-only. The permission gate
    runs before any state check in `suspend_deployment` (see
    `deployments.py`), so this must be denied even for a Deployment that was
    never published -- a client cannot bypass the check by attacking an
    endpoint whose business-state precondition it also fails."""
    definition = build_service_definition(
        name=e2e_name("authz-bypass-suspend"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version = await create_service(portal, definition)
    resp = await create_deployment(
        portal, service_version_id=service_version["id"], slug=e2e_slug("authz-suspend")
    )
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "직접 API 호출로 중단 시도"},
        headers=auth("CREATOR"),
    )
    _assert_permission_denied_envelope(resp)


async def test_audit_events_read_denied_for_creator_direct_api_call(
    portal: httpx.AsyncClient,
) -> None:
    """AUDIT_READ is AUDITOR/ADMIN-only -- a CREATOR cannot read the audit
    trail (including entries about their own actions) by calling the
    endpoint directly."""
    resp = await portal.get("/api/v1/audit-events", headers=auth("CREATOR"))
    _assert_permission_denied_envelope(resp)


async def test_asset_creation_denied_for_role_without_asset_create(
    portal: httpx.AsyncClient,
) -> None:
    """ASSET_CREATE is held only by CREATOR/ADMIN (`ROLE_PERMISSIONS`).
    AUDITOR is a legitimate, high-trust role elsewhere in this system (it can
    read the audit trail) but must still be denied here -- authorization is
    per-permission, not "any authenticated staff role can do anything.\""""
    resp = await portal.post(
        "/api/v1/assets",
        data={
            "manifest": (
                '{"schema_version":"1.0","id":"' + str(uuid.uuid4()) + '",'
                '"type":"knowledge","name":"authz-bypass-should-never-exist",'
                '"version":"1.0.0","owner":{"org":"miracom","creator_id":"x"},'
                '"classification":"INTERNAL"}'
            )
        },
        headers=auth("AUDITOR"),
    )
    _assert_permission_denied_envelope(resp, expected_status=403)


async def test_review_decision_on_nonexistent_review_never_surfaces_as_server_error(
    portal: httpx.AsyncClient,
) -> None:
    """Explicit negative check called out by the task brief: a rejected
    request must never surface as a bare 500 or an unhandled-exception body.
    `decide_review` looks up the review before checking permission (so it
    can resolve which stage-specific permission applies), so a made-up
    review_id comes back as a clean RESOURCE_NOT_FOUND envelope here rather
    than PERMISSION_DENIED -- still an ordinary, well-formed error, not a
    crash, which is the property under test."""
    resp = await portal.post(
        f"/api/v1/reviews/{uuid.uuid4()}/decisions",
        json={"decision": "APPROVE", "comments": "존재하지 않는 검토 대상"},
        headers=auth("CREATOR"),
    )
    assert resp.status_code < 500, f"must not surface as a server error: {resp.text}"
    assert resp.status_code == 404, resp.text
    body = resp.json()
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND", body
    assert_no_secret_leak(resp.text, context="nonexistent review_id decision attempt")
