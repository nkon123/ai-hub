"""Integration tests for the two Deployment 수명주기 transitions that
`test_deployment_lifecycle.py` predates (M02):

  POST /api/v1/deployments/{id}/revisions  — Update to a new Service Version
  POST /api/v1/deployments/{id}/retire     — terminal RETIRED

10-hosted-chatbot-publication.md §8 / HOST-022 / HOST-023. Two properties
carry most of the weight here and each has its own test:

  - HOST-022 "Update 실패 시 기존 Version을 유지한다". A failing update must
    leave the deployment byte-for-byte as it was — same active revision, same
    revision count, still serving. It is not enough that the endpoint returns
    400.
  - "RETIRED is terminal" is not a status string; it is the absence of every
    edge back out. Each of resume/suspend/rollback/publish/update is asserted
    to refuse a retired deployment, because any single one of them not
    refusing would silently make the state reversible.
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


async def _create_service(client: httpx.AsyncClient, db) -> tuple[str, str, str]:
    """Returns (service_id, service_version_id, knowledge_version_id)."""
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    version_id = resp.json()["id"]

    detail = await client.get(f"/api/v1/service-versions/{version_id}", headers=auth_header())
    assert detail.status_code == 200, detail.text
    return detail.json()["service_id"], version_id, knowledge.id


async def _add_version(
    client: httpx.AsyncClient,
    db,
    service_id: str,
    version: str,
    *,
    indexed: bool = True,
) -> str:
    """New ServiceVersion under an EXISTING Service — the only shape an
    update accepts."""
    knowledge = await make_indexed_knowledge(db, indexed=indexed)
    definition = build_service_definition(knowledge)
    definition["version"] = version
    resp = await client.post(
        "/api/v1/services",
        json={
            "name": "HR 챗봇",
            "service_definition": definition,
            "service_id": service_id,
        },
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


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


async def _active_deployment(client: httpx.AsyncClient, db, slug: str) -> tuple[str, str, str]:
    """Returns (deployment_id, service_id, first_service_version_id)."""
    service_id, version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, slug)
    assert (await _publish(client, deployment_id)).status_code == 202
    return deployment_id, service_id, version_id


async def _revisions(client: httpx.AsyncClient, deployment_id: str) -> list[dict]:
    resp = await client.get(
        f"/api/v1/deployments/{deployment_id}/revisions", headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


# --- Adding a version to an existing Service (prerequisite for update) ---


async def test_new_version_of_existing_service_reuses_the_service(
    client: httpx.AsyncClient, db
) -> None:
    service_id, first_version_id, _ = await _create_service(client, db)

    second_version_id = await _add_version(client, db, service_id, "1.1.0")

    assert second_version_id != first_version_id
    detail = await client.get(
        f"/api/v1/service-versions/{second_version_id}", headers=auth_header()
    )
    assert detail.json()["service_id"] == service_id


async def test_duplicate_version_number_is_refused(client: httpx.AsyncClient, db) -> None:
    """승인 Version을 제자리에서 고치는 경로를 만들지 않는다 — 같은 번호를
    다시 제출하면 기존 행을 갱신하는 대신 409."""
    service_id, _, _ = await _create_service(client, db)

    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)  # version defaults to 1.0.0
    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition, "service_id": service_id},
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SERVICE_VERSION_EXISTS"


async def test_unknown_service_id_is_404(client: httpx.AsyncClient, db) -> None:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    resp = await client.post(
        "/api/v1/services",
        json={
            "name": "HR 챗봇",
            "service_definition": definition,
            "service_id": "00000000-0000-0000-0000-000000000000",
        },
        headers=auth_header(),
    )

    assert resp.status_code == 404


# --- Update (new revision) ---


async def test_update_activates_new_revision_and_supersedes_previous(
    client: httpx.AsyncClient, db
) -> None:
    deployment_id, service_id, first_version_id = await _active_deployment(
        client, db, "update-happy-bot"
    )
    before = await _revisions(client, deployment_id)
    assert len(before) == 1
    first_revision_id = before[0]["id"]

    second_version_id = await _add_version(client, db, service_id, "1.1.0")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": second_version_id, "reason": "지식 자산 교체"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "ACTIVE"
    assert body["active_revision_id"] != first_revision_id
    # The deployment now points at the new version for any future publish too.
    assert body["service_version_id"] == second_version_id
    # The URL is unchanged — that is the whole point of updating rather than
    # deploying again.
    assert body["slug"] == "update-happy-bot"

    after = {r["id"]: r for r in await _revisions(client, deployment_id)}
    assert len(after) == 2
    assert after[first_revision_id]["status"] == "SUPERSEDED"
    assert after[body["active_revision_id"]]["status"] == "ACTIVE"
    assert after[body["active_revision_id"]]["revision_number"] == 2
    assert after[body["active_revision_id"]]["service_version_id"] == second_version_id


async def test_update_keeps_previous_revision_when_gate_fails(
    client: httpx.AsyncClient, db
) -> None:
    """HOST-022. The target version binds Knowledge that was never indexed,
    so the publish Gate refuses it — and nothing about the live deployment
    may change."""
    deployment_id, service_id, first_version_id = await _active_deployment(
        client, db, "update-gate-fail-bot"
    )
    before_body = (
        await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    ).json()
    before_revisions = await _revisions(client, deployment_id)

    bad_version_id = await _add_version(client, db, service_id, "1.1.0", indexed=False)

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": bad_version_id},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"
    assert resp.json()["error"]["details"]["checks"]

    after_body = (
        await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    ).json()
    assert after_body["status"] == "ACTIVE"
    assert after_body["active_revision_id"] == before_body["active_revision_id"]
    assert after_body["service_version_id"] == first_version_id
    after_revisions = await _revisions(client, deployment_id)
    assert len(after_revisions) == len(before_revisions)
    assert after_revisions[0]["status"] == "ACTIVE"


async def test_update_rejection_is_audited(client: httpx.AsyncClient, db) -> None:
    deployment_id, service_id, _ = await _active_deployment(client, db, "update-audit-bot")
    bad_version_id = await _add_version(client, db, service_id, "1.1.0", indexed=False)

    await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": bad_version_id},
        headers=auth_header("dev-release-token"),
    )

    events = (
        await client.get(
            "/api/v1/audit-events",
            params={"resource_id": deployment_id},
            headers=auth_header("dev-auditor-token"),
        )
    ).json()["items"]
    assert any(
        e["event_type"] == "DEPLOYMENT_UPDATE_REJECTED" and e["result"] == "FAILURE"
        for e in events
    )


async def test_update_to_the_same_version_is_refused(client: httpx.AsyncClient, db) -> None:
    deployment_id, _, first_version_id = await _active_deployment(client, db, "update-same-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": first_version_id},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DEPLOYMENT_VERSION_UNCHANGED"


async def test_update_to_another_services_version_is_refused(
    client: httpx.AsyncClient, db
) -> None:
    """The slug and audience were approved for THIS chatbot — repointing them
    at an unrelated Service would change what the URL is."""
    deployment_id, _, _ = await _active_deployment(client, db, "update-foreign-bot")
    _, other_version_id, _ = await _create_service(client, db)

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": other_version_id},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SERVICE_VERSION_MISMATCH"


async def test_update_of_never_published_deployment_points_at_publish(
    client: httpx.AsyncClient, db
) -> None:
    service_id, version_id, _ = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "update-pending-bot")
    second_version_id = await _add_version(client, db, service_id, "1.1.0")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": second_version_id},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"
    assert "/publish" in resp.json()["error"]["message"]


async def test_update_of_suspended_deployment_does_not_resume_it(
    client: httpx.AsyncClient, db
) -> None:
    """Updating is not an implicit resume — /resume has its own re-validation
    and its own audit event."""
    deployment_id, service_id, _ = await _active_deployment(client, db, "update-suspended-bot")
    assert (
        await client.post(
            f"/api/v1/deployments/{deployment_id}/suspend",
            json={"reason": "점검"},
            headers=auth_header("dev-release-token"),
        )
    ).status_code == 200
    second_version_id = await _add_version(client, db, service_id, "1.1.0")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": second_version_id},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "SUSPENDED"
    # Still blocked for new chat sessions.
    by_slug = await client.get("/api/v1/deployments/by-slug/update-suspended-bot")
    assert by_slug.status_code == 404


async def test_update_requires_publish_permission(client: httpx.AsyncClient, db) -> None:
    deployment_id, service_id, _ = await _active_deployment(client, db, "update-rbac-bot")
    second_version_id = await _add_version(client, db, service_id, "1.1.0")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": second_version_id},
        headers=auth_header(),  # CREATOR — may create a deployment, may not publish one
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_update_with_unknown_version_is_404(client: httpx.AsyncClient, db) -> None:
    deployment_id, _, _ = await _active_deployment(client, db, "update-404-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": "00000000-0000-0000-0000-000000000000"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 404


# --- Retire ---


async def test_retire_requires_reason(client: httpx.AsyncClient, db) -> None:
    deployment_id, _, _ = await _active_deployment(client, db, "retire-reason-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "   "},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_retire_requires_permission(client: httpx.AsyncClient, db) -> None:
    deployment_id, _, _ = await _active_deployment(client, db, "retire-rbac-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "서비스 종료"},
        headers=auth_header(),  # CREATOR
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_retire_records_who_when_and_why_and_stops_serving(
    client: httpx.AsyncClient, db
) -> None:
    deployment_id, _, _ = await _active_deployment(client, db, "retire-happy-bot")

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "부서 통합으로 서비스 종료"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "RETIRED"
    assert body["retire_reason"] == "부서 통합으로 서비스 종료"
    assert body["retired_by"]
    assert body["retired_at"]

    # The URL stops serving immediately, and the revision history survives.
    assert (await client.get("/api/v1/deployments/by-slug/retire-happy-bot")).status_code == 404
    revisions = await _revisions(client, deployment_id)
    assert len(revisions) == 1
    assert revisions[0]["status"] == "SUPERSEDED"

    events = (
        await client.get(
            "/api/v1/audit-events",
            params={"resource_id": deployment_id},
            headers=auth_header("dev-auditor-token"),
        )
    ).json()["items"]
    assert any(e["event_type"] == "DEPLOYMENT_RETIRED" for e in events)


async def test_retire_keeps_the_slug_reserved(client: httpx.AsyncClient, db) -> None:
    """A retired chatbot's URL must never be handed to a different one —
    anyone still holding the old link would silently land somewhere else."""
    deployment_id, _, _ = await _active_deployment(client, db, "retire-slug-bot")
    assert (
        await client.post(
            f"/api/v1/deployments/{deployment_id}/retire",
            json={"reason": "종료"},
            headers=auth_header("dev-release-token"),
        )
    ).status_code == 200

    _, other_version_id, _ = await _create_service(client, db)
    resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": other_version_id,
            "slug": "retire-slug-bot",
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )

    assert resp.status_code == 409


async def test_retire_is_terminal(client: httpx.AsyncClient, db) -> None:
    """Every edge out of RETIRED must be refused. Any one of these passing
    would make the terminal state reversible in practice."""
    deployment_id, service_id, _ = await _active_deployment(client, db, "retire-terminal-bot")
    second_version_id = await _add_version(client, db, service_id, "1.1.0")
    assert (
        await client.post(
            f"/api/v1/deployments/{deployment_id}/retire",
            json={"reason": "종료"},
            headers=auth_header("dev-release-token"),
        )
    ).status_code == 200

    release = auth_header("dev-release-token")
    resume = await client.post(f"/api/v1/deployments/{deployment_id}/resume", headers=release)
    assert resume.status_code == 409

    suspend = await client.post(
        f"/api/v1/deployments/{deployment_id}/suspend", json={"reason": "x"}, headers=release
    )
    assert suspend.status_code == 409

    rollback = await client.post(
        f"/api/v1/deployments/{deployment_id}/rollback", json={"reason": "x"}, headers=release
    )
    assert rollback.status_code == 409
    assert rollback.json()["error"]["code"] == "DEPLOYMENT_RETIRED"

    republish = await _publish(client, deployment_id)
    assert republish.status_code == 409
    assert republish.json()["error"]["code"] == "DEPLOYMENT_RETIRED"

    update = await client.post(
        f"/api/v1/deployments/{deployment_id}/revisions",
        json={"service_version_id": second_version_id},
        headers=release,
    )
    assert update.status_code == 409
    assert update.json()["error"]["code"] == "DEPLOYMENT_RETIRED"

    retire_again = await client.post(
        f"/api/v1/deployments/{deployment_id}/retire", json={"reason": "다시"}, headers=release
    )
    assert retire_again.status_code == 409

    still_retired = (
        await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    ).json()
    assert still_retired["status"] == "RETIRED"


async def test_retire_from_suspended_is_allowed(client: httpx.AsyncClient, db) -> None:
    deployment_id, _, _ = await _active_deployment(client, db, "retire-from-suspended-bot")
    assert (
        await client.post(
            f"/api/v1/deployments/{deployment_id}/suspend",
            json={"reason": "점검"},
            headers=auth_header("dev-release-token"),
        )
    ).status_code == 200

    resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "점검 결과 종료 결정"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "RETIRED"


async def test_retired_deployment_still_appears_in_the_list(
    client: httpx.AsyncClient, db
) -> None:
    """Retiring is not deleting — the row stays visible so an operator can
    still see it existed and why it ended."""
    deployment_id, _, _ = await _active_deployment(client, db, "retire-listed-bot")
    await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "종료"},
        headers=auth_header("dev-release-token"),
    )

    listing = (await client.get("/api/v1/deployments", headers=auth_header())).json()
    row = next(item for item in listing["items"] if item["id"] == deployment_id)
    assert row["status"] == "RETIRED"
    assert row["retire_reason"] == "종료"


async def test_knowledge_is_not_deleted_by_retiring(client: httpx.AsyncClient, db) -> None:
    """Sanity boundary: retiring a chatbot ends the deployment, not the
    Knowledge asset it served."""
    service_id, version_id, knowledge_id = await _create_service(client, db)
    deployment_id = await _create_deployment(client, version_id, "retire-knowledge-bot")
    assert (await _publish(client, deployment_id)).status_code == 202
    await client.post(
        f"/api/v1/deployments/{deployment_id}/retire",
        json={"reason": "종료"},
        headers=auth_header("dev-release-token"),
    )

    still_there = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == knowledge_id))
    ).scalar_one_or_none()
    assert still_there is not None
