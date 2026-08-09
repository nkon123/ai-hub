"""Integration tests for the M02 review workflow (M11 security-policy backed).

Covers the sequential TECHNICAL → SECURITY → RELEASE approval chain, its
REJECT/REQUEST_CHANGES branches, RBAC + audit on review decisions, the
"승인 Version은 불변이다" chunk-tags mutability gate, the Knowledge-must-be-
APPROVED publish gate, and the audit-events endpoint's own access control.
"""

from __future__ import annotations

import httpx

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_draft_asset_version,
    make_indexed_knowledge,
)


async def _submit(
    client: httpx.AsyncClient, version_id: str, token: str = "dev-user-token"
) -> httpx.Response:
    return await client.post(
        f"/api/v1/asset-versions/{version_id}/submit", headers=auth_header(token)
    )


async def _decide(
    client: httpx.AsyncClient,
    review_id: str,
    *,
    decision: str,
    comments: str = "확인했습니다.",
    token: str,
) -> httpx.Response:
    return await client.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": decision, "comments": comments},
        headers=auth_header(token),
    )


async def test_submit_creates_pending_technical_review(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)

    resp = await _submit(client, version.id)

    assert resp.status_code == 200
    body = resp.json()
    assert body["version_id"] == version.id
    assert body["status"] == "IN_REVIEW"
    assert body["stage"] == "TECHNICAL"
    assert body["review_id"]


async def test_submit_requires_owner(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db, owner_creator_id="someone-else@miracom.com")

    resp = await _submit(client, version.id)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_full_happy_path_technical_security_release_approves_version(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    submit_resp = await _submit(client, version.id)
    review_id = submit_resp.json()["review_id"]

    tech_resp = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")
    assert tech_resp.status_code == 200
    tech_body = tech_resp.json()
    assert tech_body["version_status"] == "IN_REVIEW"
    assert tech_body["next_stage"] == "SECURITY"

    reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_type": "ASSET_VERSION", "stage": "SECURITY", "status": "PENDING"},
        headers=auth_header("dev-security-token"),
    )
    assert reviews_resp.status_code == 200
    security_reviews = [r for r in reviews_resp.json()["items"] if r["subject_id"] == version.id]
    assert len(security_reviews) == 1
    security_review_id = security_reviews[0]["id"]

    security_resp = await _decide(
        client, security_review_id, decision="APPROVE", token="dev-security-token"
    )
    assert security_resp.status_code == 200
    security_body = security_resp.json()
    assert security_body["version_status"] == "IN_REVIEW"
    assert security_body["next_stage"] == "RELEASE"

    release_reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_type": "ASSET_VERSION", "stage": "RELEASE", "status": "PENDING"},
        headers=auth_header("dev-release-token"),
    )
    release_review_id = next(
        r["id"] for r in release_reviews_resp.json()["items"] if r["subject_id"] == version.id
    )

    release_resp = await _decide(
        client, release_review_id, decision="APPROVE", token="dev-release-token"
    )
    assert release_resp.status_code == 200
    release_body = release_resp.json()
    assert release_body["version_status"] == "APPROVED"
    assert release_body["next_stage"] is None

    detail_resp = await client.get(
        f"/api/v1/reviews/{release_review_id}", headers=auth_header("dev-release-token")
    )
    assert detail_resp.status_code == 200
    history = detail_resp.json()["history"]
    assert [h["stage"] for h in history] == ["TECHNICAL", "SECURITY", "RELEASE"]
    assert all(h["decision"] == "APPROVE" for h in history)


async def test_reject_at_security_stage_rejects_version(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    review_id = (await _submit(client, version.id)).json()["review_id"]
    await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")

    reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_id_unused": "x", "stage": "SECURITY"},
        headers=auth_header("dev-security-token"),
    )
    security_review_id = next(
        r["id"] for r in reviews_resp.json()["items"] if r["subject_id"] == version.id
    )

    reject_resp = await _decide(
        client,
        security_review_id,
        decision="REJECT",
        comments="보안 취약점이 발견되었습니다.",
        token="dev-security-token",
    )

    assert reject_resp.status_code == 200
    assert reject_resp.json()["version_status"] == "REJECTED"
    assert reject_resp.json()["next_stage"] is None


async def test_request_changes_sends_version_back_to_draft_editable_state_and_resubmit_works(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    review_id = (await _submit(client, version.id)).json()["review_id"]

    changes_resp = await _decide(
        client,
        review_id,
        decision="REQUEST_CHANGES",
        comments="문서 출처를 보강해 주세요.",
        token="dev-reviewer-token",
    )
    assert changes_resp.status_code == 200
    assert changes_resp.json()["version_status"] == "CHANGES_REQUESTED"

    # Re-submit from CHANGES_REQUESTED must succeed and open a fresh TECHNICAL review.
    resubmit_resp = await _submit(client, version.id)
    assert resubmit_resp.status_code == 200
    assert resubmit_resp.json()["status"] == "IN_REVIEW"
    assert resubmit_resp.json()["stage"] == "TECHNICAL"
    assert resubmit_resp.json()["review_id"] != review_id


async def test_wrong_role_decision_returns_403_and_denied_audit_row(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    review_id = (await _submit(client, version.id)).json()["review_id"]

    # SECURITY_REVIEWER cannot decide a TECHNICAL-stage review.
    resp = await _decide(client, review_id, decision="APPROVE", token="dev-security-token")

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": review_id},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    denied_events = [e for e in audit_resp.json()["items"] if e["result"] == "DENIED"]
    assert any(
        e["event_type"].startswith("PERMISSION_DENIED:REVIEW_DECIDE_TECHNICAL")
        for e in denied_events
    )


async def test_decision_without_comments_returns_400(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    review_id = (await _submit(client, version.id)).json()["review_id"]

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "   "},
        headers=auth_header("dev-reviewer-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_deciding_an_already_decided_review_returns_409(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    review_id = (await _submit(client, version.id)).json()["review_id"]
    first = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")
    assert first.status_code == 200

    second = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "RESOURCE_REVISION_CONFLICT"


async def test_chunk_tags_patch_rejected_on_approved_version(client: httpx.AsyncClient, db) -> None:
    approved = await make_indexed_knowledge(db)  # status == APPROVED

    resp = await client.patch(
        f"/api/v1/assets/{approved.asset_id}/versions/{approved.id}/chunk-tags",
        json={"chunk_id": "chunk-1", "tags": ["hr"]},
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_chunk_tags_patch_allowed_on_draft_version(client: httpx.AsyncClient, db) -> None:
    draft = await make_draft_asset_version(db)

    resp = await client.patch(
        f"/api/v1/assets/{draft.asset_id}/versions/{draft.id}/chunk-tags",
        json={"chunk_id": "chunk-1", "tags": ["hr"]},
        headers=auth_header(),
    )

    assert resp.status_code == 200
    assert resp.json() == {"chunk_id": "chunk-1", "tags": ["hr"]}


async def test_suspend_requires_reason_and_release_manager_role(
    client: httpx.AsyncClient, db
) -> None:
    approved = await make_indexed_knowledge(db)

    no_reason = await client.post(
        f"/api/v1/asset-versions/{approved.id}/suspend",
        json={"reason": ""},
        headers=auth_header("dev-release-token"),
    )
    assert no_reason.status_code == 400

    wrong_role = await client.post(
        f"/api/v1/asset-versions/{approved.id}/suspend",
        json={"reason": "긴급 보안 이슈"},
        headers=auth_header(),  # CREATOR
    )
    assert wrong_role.status_code == 403

    ok = await client.post(
        f"/api/v1/asset-versions/{approved.id}/suspend",
        json={"reason": "긴급 보안 이슈"},
        headers=auth_header("dev-release-token"),
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "SUSPENDED"


async def test_deprecate_targets_latest_approved_version(client: httpx.AsyncClient, db) -> None:
    approved = await make_indexed_knowledge(db)

    resp = await client.post(
        f"/api/v1/assets/{approved.asset_id}/deprecate",
        json={"reason": "후속 버전으로 대체"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == approved.id
    assert body["status"] == "DEPRECATED"


# --- Publish requires APPROVED Knowledge (10-hosted-chatbot-publication.md §5) ---


async def test_publish_blocked_when_knowledge_not_approved_then_succeeds_after_approval(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    # Force it back to a non-approved state to simulate "not yet approved".
    knowledge.status = "IN_REVIEW"
    await db.commit()

    definition = build_service_definition(knowledge)
    service_resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert service_resp.status_code == 201
    version_id = service_resp.json()["id"]

    deploy_resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": "gate-on-approval",
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert deploy_resp.status_code == 201
    deployment_id = deploy_resp.json()["id"]

    blocked = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert blocked.status_code == 400
    assert blocked.json()["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"
    checks = blocked.json()["error"]["details"]["checks"]
    failed_codes = {c["code"] for c in checks if not c["passed"]}
    assert "CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE" in failed_codes

    # Now approve the Knowledge version and retry — publish should succeed.
    knowledge.status = "APPROVED"
    await db.commit()

    ok = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert ok.status_code == 202


# --- Audit events endpoint access control ---


async def test_audit_events_requires_auditor_or_admin(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    await _submit(client, version.id)

    denied = await client.get("/api/v1/audit-events", headers=auth_header())  # CREATOR
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "PERMISSION_DENIED"

    allowed = await client.get("/api/v1/audit-events", headers=auth_header("dev-auditor-token"))
    assert allowed.status_code == 200
    body = allowed.json()
    assert body["total"] >= 1
    assert any(e["event_type"] == "ASSET_VERSION_SUBMITTED" for e in body["items"])

    admin_allowed = await client.get("/api/v1/audit-events", headers=auth_header("dev-admin-token"))
    assert admin_allowed.status_code == 200
