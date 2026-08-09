"""Integration tests for Deployment 수명주기 API (M02): suspend/resume/rollback
and the revisions list used to pick rollback targets.

Covers 10-hosted-chatbot-publication.md §8 게시 수명주기 rules:
  - Suspend requires a reason and blocks new Chat Session creation
    immediately (verified via by-slug 404ing right after suspend).
  - Resume re-runs the publish-gate validation before reactivating.
  - Rollback restores an earlier immutable Revision and marks the one it
    replaces SUPERSEDED.
  - Every action is RBAC-gated (RELEASE_MANAGER/ADMIN only) and audited,
    including permission denials.
"""

from __future__ import annotations

import httpx
from portal_api.models import AssetVersion
from sqlalchemy import select

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_indexed_knowledge,
)


async def _create_service(
    client: httpx.AsyncClient, db, *, indexed: bool = True
) -> tuple[str, str]:
    """Returns (service_version_id, knowledge_version_id)."""
    knowledge = await make_indexed_knowledge(db, indexed=indexed)
    definition = build_service_definition(knowledge)
    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"], knowledge.id


async def _create_deployment(client: httpx.AsyncClient, version_id: str, slug: str) -> str:
    resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": slug,
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _publish(client: httpx.AsyncClient, deployment_id: str) -> httpx.Response:
    return await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )


async def _create_active_deployment(client: httpx.AsyncClient, db, slug: str) -> str:
    version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, slug)
    publish_resp = await _publish(client, deployment_id)
    assert publish_resp.status_code == 202, publish_resp.text
    return deployment_id


# --- Suspend ---


async def test_suspend_requires_reason(client: httpx.AsyncClient, db) -> None:
    deployment_id = await _create_active_deployment(client, db, "suspend-needs-reason")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": ""},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_suspend_by_creator_returns_403_and_denied_audit(
    client: httpx.AsyncClient, db
) -> None:
    deployment_id = await _create_active_deployment(client, db, "suspend-rbac-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "테스트 중단"},
        headers=auth_header(),  # dev-user-token == CREATOR, lacks DEPLOYMENT_SUSPEND
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": deployment_id},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"].startswith("PERMISSION_DENIED")
        for e in events
    )


async def test_suspend_active_deployment_blocks_by_slug(client: httpx.AsyncClient, db) -> None:
    deployment_id = await _create_active_deployment(client, db, "suspend-then-404")

    # Sanity: reachable while ACTIVE.
    active_resp = await client.get("/api/v1/deployments/by-slug/suspend-then-404")
    assert active_resp.status_code == 200

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "긴급 점검"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUSPENDED"
    assert body["suspend_reason"] == "긴급 점검"
    assert body["suspended_by"]
    assert body["suspended_at"]

    # Key behavioral assertion: a suspended bot must become unreachable.
    by_slug_resp = await client.get("/api/v1/deployments/by-slug/suspend-then-404")
    assert by_slug_resp.status_code == 404
    assert by_slug_resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"


async def test_suspend_non_active_deployment_returns_409(client: httpx.AsyncClient, db) -> None:
    version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "pending-suspend-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "이유"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"


# --- Resume ---


async def test_resume_restores_active_and_by_slug_works_again(
    client: httpx.AsyncClient, db
) -> None:
    deployment_id = await _create_active_deployment(client, db, "resume-me-bot")
    suspend_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "점검"},
        headers=auth_header("dev-release-token"),
    )
    assert suspend_resp.status_code == 200

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/resume", headers=auth_header("dev-release-token")
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ACTIVE"
    assert body["suspended_by"] is None
    assert body["suspend_reason"] is None

    by_slug_resp = await client.get("/api/v1/deployments/by-slug/resume-me-bot")
    assert by_slug_resp.status_code == 200


async def test_resume_non_suspended_deployment_returns_409(client: httpx.AsyncClient, db) -> None:
    deployment_id = await _create_active_deployment(client, db, "already-active-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/resume", headers=auth_header("dev-release-token")
    )

    assert resp.status_code == 409


async def test_resume_fails_when_knowledge_no_longer_approved(
    client: httpx.AsyncClient, db
) -> None:
    version_id, knowledge_version_id = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "knowledge-revoked-bot")
    assert (await _publish(client, deployment_id)).status_code == 202

    suspend_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "점검"},
        headers=auth_header("dev-release-token"),
    )
    assert suspend_resp.status_code == 200

    # Knowledge is revoked/suspended while the deployment sits suspended.
    knowledge_version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == knowledge_version_id))
    ).scalar_one()
    knowledge_version.status = "SUSPENDED"
    await db.commit()

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/resume", headers=auth_header("dev-release-token")
    )

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"
    failed_codes = {c["code"] for c in body["error"]["details"]["checks"] if not c["passed"]}
    assert "CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE" in failed_codes

    # Deployment must remain SUSPENDED — a failed re-validation must not
    # silently reactivate it.
    detail = await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    assert detail.json()["status"] == "SUSPENDED"


async def test_resume_requires_allowed_role(client: httpx.AsyncClient, db) -> None:
    deployment_id = await _create_active_deployment(client, db, "resume-rbac-bot")
    assert (
        await client.post(
            f"/api/v1/deployments/{deployment_id}/suspend",
            json={"reason": "점검"},
            headers=auth_header("dev-release-token"),
        )
    ).status_code == 200

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/resume", headers=auth_header()  # CREATOR
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


# --- Rollback ---


async def test_rollback_with_no_earlier_revision_returns_409(
    client: httpx.AsyncClient, db
) -> None:
    deployment_id = await _create_active_deployment(client, db, "rollback-none-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/rollback",
        json={"reason": "복구 시도"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DEPLOYMENT_REVISION_UNAVAILABLE"


async def test_rollback_requires_reason(client: httpx.AsyncClient, db) -> None:
    deployment_id = await _create_active_deployment(client, db, "rollback-needs-reason")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/rollback",
        json={"reason": ""},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_publish_twice_then_rollback_restores_revision_one(
    client: httpx.AsyncClient, db
) -> None:
    version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "rollback-two-rev-bot")

    first_publish = await _publish(client, deployment_id)
    assert first_publish.status_code == 202
    revision_1_id = first_publish.json()["job_id"]

    second_publish = await _publish(client, deployment_id)
    assert second_publish.status_code == 202
    revision_2_id = second_publish.json()["job_id"]
    assert revision_2_id != revision_1_id

    # Publishing again must supersede the first revision.
    revisions_resp = await client.get(
        f"/api/v1/deployments/{deployment_id}/revisions", headers=auth_header()
    )
    assert revisions_resp.status_code == 200
    revisions = revisions_resp.json()["items"]
    by_id = {r["id"]: r for r in revisions}
    assert by_id[revision_1_id]["status"] == "SUPERSEDED"
    assert by_id[revision_2_id]["status"] == "ACTIVE"

    rollback_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/rollback",
        json={"reason": "새 Revision에 문제 발견"},
        headers=auth_header("dev-release-token"),
    )

    assert rollback_resp.status_code == 200
    body = rollback_resp.json()
    assert body["active_revision_id"] == revision_1_id
    assert body["status"] == "ACTIVE"

    revisions_after = (
        await client.get(
            f"/api/v1/deployments/{deployment_id}/revisions", headers=auth_header()
        )
    ).json()["items"]
    by_id_after = {r["id"]: r for r in revisions_after}
    assert by_id_after[revision_1_id]["status"] == "ACTIVE"
    assert by_id_after[revision_2_id]["status"] == "SUPERSEDED"


async def test_rollback_requires_allowed_role(client: httpx.AsyncClient, db) -> None:
    version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "rollback-rbac-bot")
    assert (await _publish(client, deployment_id)).status_code == 202
    assert (await _publish(client, deployment_id)).status_code == 202

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/rollback",
        json={"reason": "복구"},
        headers=auth_header(),  # CREATOR
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


# --- Revisions listing ---


async def test_list_revisions_orders_by_revision_number_desc(
    client: httpx.AsyncClient, db
) -> None:
    version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "revisions-order-bot")
    assert (await _publish(client, deployment_id)).status_code == 202
    assert (await _publish(client, deployment_id)).status_code == 202
    assert (await _publish(client, deployment_id)).status_code == 202

    resp = await client.get(
        f"/api/v1/deployments/{deployment_id}/revisions", headers=auth_header()
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    numbers = [item["revision_number"] for item in body["items"]]
    assert numbers == [3, 2, 1]
    # Compact summary only — no full resolved_dependency_snapshot leaked.
    assert "resolved_dependency_snapshot" not in body["items"][0]
    assert body["items"][0]["model_alias"] == "default-chat"
    assert body["items"][0]["knowledge"][0]["asset_name"]
