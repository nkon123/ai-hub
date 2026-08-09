"""Integration tests for the ServiceVersion review chain (D-041 후속).

Mirrors `test_reviews.py`'s AssetVersion coverage exactly — same TECHNICAL →
SECURITY → RELEASE chain, same RBAC, same "사유 필수"/"재결정 차단" rules —
because `routers/reviews.py` reuses the identical `ReviewRequest`/
`ReviewDecision` machinery for both subject types (see
`_load_review_subject`). Also covers the `require_service_version_approval`
publish gate (default off — open-decisions.md D-063) and confirms the
existing ASSET_VERSION review/publish behavior is unaffected by this change.
"""

from __future__ import annotations

import httpx
from portal_api.models import Service, ServiceVersion
from sqlalchemy.ext.asyncio import AsyncSession

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_indexed_knowledge,
)


async def _create_service_version_direct_db(
    db: AsyncSession, *, owner_creator_id: str = "dev-user@miracom.com"
) -> str:
    """Insert a DRAFT Service + ServiceVersion straight into the DB (bypassing
    `POST /services`, which always defaults the owner to the calling token) so
    ownership-denial tests can use an owner other than any available token —
    mirrors `conftest.make_draft_asset_version`'s `owner_creator_id` param."""
    service = Service(
        name="다른 소유자 서비스", owner_org="miracom", owner_creator_id=owner_creator_id
    )
    db.add(service)
    await db.flush()

    version = ServiceVersion(
        service_id=service.id,
        version="1.0.0",
        status="DRAFT",
        service_definition={"name": "다른 소유자 서비스"},
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)
    return version.id


async def _create_service_version(
    client: httpx.AsyncClient, db, *, token: str = "dev-user-token"
) -> str:
    """POST /services with a fresh, throwaway HR-chatbot-style definition
    bound to a freshly indexed+approved Knowledge version — never touches the
    real demo assets/services. Returns the new ServiceVersion id."""
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    resp = await client.post(
        "/api/v1/services",
        json={"name": "리뷰 체인 테스트 서비스", "service_definition": definition},
        headers=auth_header(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _submit_service(
    client: httpx.AsyncClient, version_id: str, token: str = "dev-user-token"
) -> httpx.Response:
    return await client.post(
        f"/api/v1/service-versions/{version_id}/submit", headers=auth_header(token)
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


async def test_submit_service_version_creates_pending_technical_review(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)

    resp = await _submit_service(client, version_id)

    assert resp.status_code == 200
    body = resp.json()
    assert body["version_id"] == version_id
    assert body["status"] == "IN_REVIEW"
    assert body["stage"] == "TECHNICAL"
    assert body["review_id"]


async def test_submit_service_version_requires_owner(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service_version_direct_db(
        db, owner_creator_id="someone-else@miracom.com"
    )

    # dev-user-token (CREATOR) holds SERVICE_SUBMIT_REVIEW but is not the
    # owner of this Service — mirrors `test_reviews.py::test_submit_requires_owner`.
    resp = await _submit_service(client, version_id)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_wrong_role_cannot_submit_service_version(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service_version(client, db)

    resp = await _submit_service(client, version_id, token="dev-reviewer-token")

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_full_happy_path_technical_security_release_approves_service_version(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)
    submit_resp = await _submit_service(client, version_id)
    review_id = submit_resp.json()["review_id"]

    tech_resp = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")
    assert tech_resp.status_code == 200
    assert tech_resp.json()["version_status"] == "IN_REVIEW"
    assert tech_resp.json()["next_stage"] == "SECURITY"

    reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_type": "SERVICE_VERSION", "stage": "SECURITY", "status": "PENDING"},
        headers=auth_header("dev-security-token"),
    )
    assert reviews_resp.status_code == 200
    security_reviews = [
        r for r in reviews_resp.json()["items"] if r["subject_id"] == version_id
    ]
    assert len(security_reviews) == 1
    security_review_id = security_reviews[0]["id"]
    # D-041 후속: the joined display fields (reused from the ASSET_VERSION
    # shape) carry the Service's own name/type for a SERVICE_VERSION subject.
    assert security_reviews[0]["asset_type"] == "service"
    assert security_reviews[0]["asset_name"] == "리뷰 체인 테스트 서비스"

    # Cannot skip straight to RELEASE while still at SECURITY.
    skip_resp = await _decide(
        client, security_review_id, decision="APPROVE", token="dev-release-token"
    )
    assert skip_resp.status_code == 403

    security_resp = await _decide(
        client, security_review_id, decision="APPROVE", token="dev-security-token"
    )
    assert security_resp.status_code == 200
    assert security_resp.json()["next_stage"] == "RELEASE"

    release_reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_type": "SERVICE_VERSION", "stage": "RELEASE", "status": "PENDING"},
        headers=auth_header("dev-release-token"),
    )
    release_review_id = next(
        r["id"] for r in release_reviews_resp.json()["items"] if r["subject_id"] == version_id
    )

    release_resp = await _decide(
        client, release_review_id, decision="APPROVE", token="dev-release-token"
    )
    assert release_resp.status_code == 200
    assert release_resp.json()["version_status"] == "APPROVED"
    assert release_resp.json()["next_stage"] is None

    detail_resp = await client.get(
        f"/api/v1/reviews/{release_review_id}", headers=auth_header("dev-release-token")
    )
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert [h["stage"] for h in detail["history"]] == ["TECHNICAL", "SECURITY", "RELEASE"]
    assert all(h["decision"] == "APPROVE" for h in detail["history"])
    assert detail["subject_summary"]["manifest_type"] == "service"
    assert detail["subject_summary"]["manifest_name"] == "리뷰 체인 테스트 서비스"

    version_resp = await client.get(
        f"/api/v1/service-versions/{version_id}", headers=auth_header("dev-release-token")
    )
    assert version_resp.status_code == 200
    assert version_resp.json()["status"] == "APPROVED"
    assert version_resp.json()["approved_at"] is not None


async def test_reject_at_security_stage_rejects_service_version(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)
    review_id = (await _submit_service(client, version_id)).json()["review_id"]
    await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")

    reviews_resp = await client.get(
        "/api/v1/reviews",
        params={"subject_type": "SERVICE_VERSION", "stage": "SECURITY"},
        headers=auth_header("dev-security-token"),
    )
    security_review_id = next(
        r["id"] for r in reviews_resp.json()["items"] if r["subject_id"] == version_id
    )

    reject_resp = await _decide(
        client,
        security_review_id,
        decision="REJECT",
        comments="정책 위반 소지가 있습니다.",
        token="dev-security-token",
    )

    assert reject_resp.status_code == 200
    assert reject_resp.json()["version_status"] == "REJECTED"
    assert reject_resp.json()["next_stage"] is None


async def test_decision_without_comments_returns_400_for_service_version(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)
    review_id = (await _submit_service(client, version_id)).json()["review_id"]

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "  "},
        headers=auth_header("dev-reviewer-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_deciding_an_already_decided_service_review_returns_409(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)
    review_id = (await _submit_service(client, version_id)).json()["review_id"]
    first = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")
    assert first.status_code == 200

    second = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "RESOURCE_REVISION_CONFLICT"


async def test_cancel_pending_service_review_returns_version_to_changes_requested(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service_version(client, db)
    review_id = (await _submit_service(client, version_id)).json()["review_id"]

    cancel_resp = await client.post(
        f"/api/v1/reviews/{review_id}/cancel",
        json={"reason": "요구사항이 바뀌어 다시 준비합니다."},
        headers=auth_header("dev-user-token"),
    )

    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["version_status"] == "CHANGES_REQUESTED"

    # Re-submit works from CHANGES_REQUESTED.
    resubmit = await _submit_service(client, version_id)
    assert resubmit.status_code == 200
    assert resubmit.json()["review_id"] != review_id


async def test_reviews_inbox_lists_both_subject_types_together(
    client: httpx.AsyncClient, db
) -> None:
    from tests.integration.portal_api.conftest import make_draft_asset_version

    asset_version = await make_draft_asset_version(db)
    asset_review_id = (
        await client.post(
            f"/api/v1/asset-versions/{asset_version.id}/submit", headers=auth_header()
        )
    ).json()["review_id"]

    service_version_id = await _create_service_version(client, db)
    service_review_id = (await _submit_service(client, service_version_id)).json()["review_id"]

    resp = await client.get(
        "/api/v1/reviews",
        params={"stage": "TECHNICAL", "status": "PENDING", "page_size": 100},
        headers=auth_header("dev-reviewer-token"),
    )
    assert resp.status_code == 200
    ids = {item["id"] for item in resp.json()["items"]}
    assert asset_review_id in ids
    assert service_review_id in ids
    subject_types = {item["id"]: item["subject_type"] for item in resp.json()["items"]}
    assert subject_types[asset_review_id] == "ASSET_VERSION"
    assert subject_types[service_review_id] == "SERVICE_VERSION"


# --- Publish gate (require_service_version_approval, open-decisions.md D-063) ---


async def _publish_deployment_for(
    client: httpx.AsyncClient, version_id: str, *, slug: str
) -> httpx.Response:
    deploy_resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": slug,
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert deploy_resp.status_code == 201, deploy_resp.text
    deployment_id = deploy_resp.json()["id"]
    return await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )


async def test_publish_allowed_when_flag_off_even_though_unreviewed(
    client: httpx.AsyncClient, db
) -> None:
    """Default PoC setting (open-decisions.md D-063): an unreviewed (DRAFT)
    ServiceVersion may still be published, but the validate/publish response
    must still surface its true (unreviewed) status rather than hiding it."""
    version_id = await _create_service_version(client, db)

    validate_resp = await client.post(
        f"/api/v1/service-versions/{version_id}/validate", headers=auth_header()
    )
    assert validate_resp.status_code == 200
    checks = {c["name"]: c for c in validate_resp.json()["checks"]}
    assert checks["service_version_review_status"]["passed"] is True
    assert "검토·승인되지 않았습니다" in checks["service_version_review_status"]["message"]

    publish_resp = await _publish_deployment_for(client, version_id, slug="review-flag-off-test")
    assert publish_resp.status_code == 202


async def test_publish_refused_when_flag_on_and_not_approved(
    client: httpx.AsyncClient, db, monkeypatch
) -> None:
    from portal_api.config import settings
    from portal_api.routers import services as services_module

    monkeypatch.setattr(settings, "require_service_version_approval", True)
    assert services_module.settings is settings

    version_id = await _create_service_version(client, db)

    blocked = await _publish_deployment_for(client, version_id, slug="review-flag-on-blocked")
    assert blocked.status_code == 400
    assert blocked.json()["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"
    checks = blocked.json()["error"]["details"]["checks"]
    failed = {c["name"]: c for c in checks if not c["passed"]}
    assert "service_version_review_status" in failed
    assert failed["service_version_review_status"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"


async def test_publish_succeeds_when_flag_on_and_approved(
    client: httpx.AsyncClient, db, monkeypatch
) -> None:
    from portal_api.config import settings
    from portal_api.routers import services as services_module

    version_id = await _create_service_version(client, db)
    review_id = (await _submit_service(client, version_id)).json()["review_id"]
    tech = await _decide(client, review_id, decision="APPROVE", token="dev-reviewer-token")
    security_review_id = next(
        r["id"]
        for r in (
            await client.get(
                "/api/v1/reviews",
                params={"subject_type": "SERVICE_VERSION", "stage": "SECURITY"},
                headers=auth_header("dev-security-token"),
            )
        ).json()["items"]
        if r["subject_id"] == version_id
    )
    await _decide(client, security_review_id, decision="APPROVE", token="dev-security-token")
    release_review_id = next(
        r["id"]
        for r in (
            await client.get(
                "/api/v1/reviews",
                params={"subject_type": "SERVICE_VERSION", "stage": "RELEASE"},
                headers=auth_header("dev-release-token"),
            )
        ).json()["items"]
        if r["subject_id"] == version_id
    )
    final = await _decide(client, release_review_id, decision="APPROVE", token="dev-release-token")
    assert final.json()["version_status"] == "APPROVED"
    assert tech.status_code == 200

    monkeypatch.setattr(settings, "require_service_version_approval", True)
    assert services_module.settings is settings

    ok = await _publish_deployment_for(client, version_id, slug="review-flag-on-approved")
    assert ok.status_code == 202
