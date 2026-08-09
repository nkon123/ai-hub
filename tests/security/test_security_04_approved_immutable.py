"""Security property 4 — approved artifacts are immutable, and unapproved
Knowledge cannot be published or bundled.

`tests/unit/security_policy/test_transitions.py` already proves
`is_mutable(VersionStatus.APPROVED) is False` as a pure function.
`tests/integration/portal_api/` proves the same thing against a Fake-DI
FastAPI app. What's missing is the same check against the real, running
process and its real sqlite-backed `portal.db` -- including against the
live, already-APPROVED seeded Knowledge (`APPROVED_KNOWLEDGE_VERSION_ID`)
rather than a version this suite approves itself, which is the version most
likely to be targeted by an actual client bug or attack since it is the one
real, working, citable Knowledge already live in this environment.

Read-only-safe by construction: `PATCH .../chunk-tags` on an APPROVED
version is rejected (409) *before* any write -- `is_mutable` is checked
before the manifest is touched (`assets.py`) -- so hitting this endpoint
against the protected seeded Knowledge never actually mutates it.
"""

from __future__ import annotations

import httpx
import pytest

from tests.security.conftest import (
    APPROVED_KNOWLEDGE_ASSET_ID,
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


async def test_approved_knowledge_version_rejects_chunk_tag_mutation(
    portal: httpx.AsyncClient,
) -> None:
    """`PATCH /assets/{asset_id}/versions/{version_id}/chunk-tags` against
    the live, already-APPROVED, already-published seeded Knowledge must be
    refused with 409 ASSET_STATE_TRANSITION_INVALID -- never silently
    accepted, never a 500. CREATOR holds ASSET_EDIT_DRAFT (the permission
    gate this endpoint checks first), so a bare permission denial cannot be
    the reason this fails -- state immutability itself must be what blocks
    it."""
    resp = await portal.patch(
        f"/api/v1/assets/{APPROVED_KNOWLEDGE_ASSET_ID}/versions/{APPROVED_KNOWLEDGE_VERSION_ID}/chunk-tags",
        json={"chunk_id": "does-not-matter-rejected-before-lookup", "tags": ["security-probe"]},
        headers=auth("CREATOR"),
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID", body
    assert_no_secret_leak(resp.text, context="approved-version mutation attempt")


async def test_unapproved_knowledge_cannot_be_bundled(portal: httpx.AsyncClient) -> None:
    """`POST /api/v1/distributions` (Offline Bundle) with an ASSET_VERSION
    root that is still DRAFT must be refused -- "승인되지 않은 버전은
    다운로드에 노출하지 않는다" (01-portal-and-distribution.md §3.3)."""
    version = await register_knowledge_asset(
        portal, name=e2e_name("immutable-gate-bundle"), markdown_content="# 문서\n\n내용\n"
    )
    assert version["status"] == "DRAFT", version  # never submitted/approved

    resp = await portal.post(
        "/api/v1/distributions",
        json={
            "mode": "OFFLINE_BUNDLE",
            "root_type": "ASSET_VERSION",
            "root_id": version["id"],
        },
        headers=auth("CREATOR"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID", body


async def test_unapproved_knowledge_cannot_be_published(portal: httpx.AsyncClient) -> None:
    """A Service/Deployment whose only Knowledge binding points at a DRAFT
    (never-reviewed) Knowledge version must fail the publish-gate --
    "게시 가능: APPROVED Knowledge Version만 허용" (10-hosted-chatbot-
    publication.md §5) -- even though the Deployment itself was created
    successfully (creation and publish are deliberately two separate gates)."""
    version = await register_knowledge_asset(
        portal, name=e2e_name("immutable-gate-publish"), markdown_content="# 문서\n\n내용\n"
    )
    assert version["status"] == "DRAFT", version

    definition = build_service_definition(
        name=e2e_name("immutable-gate-service"), knowledge_version_id=version["id"]
    )
    service_version = await create_service(portal, definition)
    resp = await create_deployment(
        portal, service_version_id=service_version["id"], slug=e2e_slug("immutable-gate")
    )
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth("RELEASE_MANAGER")
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED", body
    checks = body["error"].get("details", {}).get("checks") or []
    codes = {c.get("code") for c in checks if isinstance(c, dict)}
    assert "CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE" in codes, body


async def test_review_decision_cannot_reopen_an_already_decided_review(
    portal: httpx.AsyncClient,
) -> None:
    """A second decision on an already-APPROVED review must be refused
    (409) -- immutability applies to the review record itself, not only to
    the AssetVersion it targets."""
    version = await register_knowledge_asset(
        portal, name=e2e_name("immutable-gate-review"), markdown_content="# 문서\n\n내용\n"
    )
    resp = await portal.post(
        f"/api/v1/asset-versions/{version['id']}/submit", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    review_id = resp.json()["review_id"]

    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "1차 승인"},
        headers=auth("TECH_REVIEWER"),
    )
    assert resp.status_code == 200, resp.text

    resp = await portal.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "재승인 시도"},
        headers=auth("TECH_REVIEWER"),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "RESOURCE_REVISION_CONFLICT", resp.text
