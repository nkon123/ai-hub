"""Integration tests for Service Definition + Deployment publish API (M02).

Covers the "Knowledge 챗봇을 내부 URL로 게시" MVP flow end to end against an
isolated in-memory DB: service creation (valid/invalid), slug conflict,
publish blocked by the Knowledge-index gate, successful publish, by-slug
resolution (active/non-active/unknown), and the publish RBAC gate.
"""

from __future__ import annotations

import httpx

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_indexed_knowledge,
)


async def _create_service(client: httpx.AsyncClient, db, *, indexed: bool = True) -> str:
    knowledge = await make_indexed_knowledge(db, indexed=indexed)
    definition = build_service_definition(knowledge)
    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _create_deployment(
    client: httpx.AsyncClient, version_id: str, slug: str
) -> httpx.Response:
    return await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": slug,
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )


async def test_create_service_with_valid_definition_succeeds(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)

    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "DRAFT"
    assert body["service_definition"]["name"] == "HR 정책 챗봇"
    assert body["id"]
    assert body["service_id"]


async def test_create_service_with_invalid_definition_returns_400(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    del definition["model_policy"]  # required by service-definition.schema.json

    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["trace_id"]


async def test_create_service_requires_auth(client: httpx.AsyncClient, db) -> None:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)

    resp = await client.post(
        "/api/v1/services", json={"name": "HR 챗봇", "service_definition": definition}
    )

    assert resp.status_code == 401


async def test_validate_service_version_passes_when_knowledge_indexed(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service(client, db)

    resp = await client.post(
        f"/api/v1/service-versions/{version_id}/validate", headers=auth_header()
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["passed"] is True
    assert all(c["passed"] for c in body["checks"])


async def test_validate_service_version_fails_when_knowledge_not_indexed(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service(client, db, indexed=False)

    resp = await client.post(
        f"/api/v1/service-versions/{version_id}/validate", headers=auth_header()
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["passed"] is False
    failed_codes = {c["code"] for c in body["checks"] if not c["passed"]}
    assert "CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE" in failed_codes


async def test_deployment_slug_conflict_returns_409(client: httpx.AsyncClient, db) -> None:
    version_id_1 = await _create_service(client, db)
    first = await _create_deployment(client, version_id_1, "hr-policy-guide")
    assert first.status_code == 201

    version_id_2 = await _create_service(client, db)
    second = await _create_deployment(client, version_id_2, "hr-policy-guide")

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "DEPLOYMENT_SLUG_CONFLICT"


async def test_deployment_rejects_reserved_slug(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    resp = await _create_deployment(client, version_id, "admin")

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DEPLOYMENT_SLUG_CONFLICT"


async def test_publish_blocked_when_knowledge_not_indexed(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db, indexed=False)
    deploy_resp = await _create_deployment(client, version_id, "unindexed-bot")
    assert deploy_resp.status_code == 201
    deployment_id = deploy_resp.json()["id"]

    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )

    assert publish_resp.status_code == 400
    assert publish_resp.json()["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"

    # Deployment must remain PENDING — a failed gate must not activate it.
    detail = await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    assert detail.json()["status"] == "PENDING"


async def test_publish_succeeds_and_activates_deployment(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    deploy_resp = await _create_deployment(client, version_id, "hr-policy-live")
    deployment_id = deploy_resp.json()["id"]

    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )

    assert publish_resp.status_code == 202
    body = publish_resp.json()
    assert body["deployment_url"] == "https://ai.company.local/chat/hr-policy-live"
    assert body["job_id"]

    detail_resp = await client.get(f"/api/v1/deployments/{deployment_id}", headers=auth_header())
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["status"] == "ACTIVE"
    assert detail["active_revision_id"] == body["job_id"]
    assert detail["active_revision"]["status"] == "ACTIVE"


async def test_publish_requires_allowed_role(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    deploy_resp = await _create_deployment(client, version_id, "rbac-test-bot")
    deployment_id = deploy_resp.json()["id"]

    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish",
        headers=auth_header("dev-reviewer-token"),  # TECH_REVIEWER — not allowed to publish
    )

    assert publish_resp.status_code == 403
    assert publish_resp.json()["error"]["code"] == "PERMISSION_DENIED"

    # CREATOR (the service's own owner) is no longer allowed to self-publish
    # either — §3.2 assigns DEPLOYMENT_PUBLISH to RELEASE_MANAGER/ADMIN only.
    creator_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish",
        headers=auth_header(),  # dev-user-token == CREATOR
    )
    assert creator_resp.status_code == 403
    assert creator_resp.json()["error"]["code"] == "PERMISSION_DENIED"

    # Confirm the role actually allowed to publish (RELEASE_MANAGER) succeeds.
    ok_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish",
        headers=auth_header("dev-release-token"),
    )
    assert ok_resp.status_code == 202


async def test_by_slug_returns_404_for_pending_deployment(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    deploy_resp = await _create_deployment(client, version_id, "not-yet-live")
    assert deploy_resp.status_code == 201

    resp = await client.get("/api/v1/deployments/by-slug/not-yet-live")

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"


async def test_by_slug_returns_same_shape_for_unknown_slug(
    client: httpx.AsyncClient, db
) -> None:
    """A slug that never existed must be indistinguishable from a non-active one."""
    version_id = await _create_service(client, db)
    await _create_deployment(client, version_id, "not-yet-live-2")
    pending_resp = await client.get("/api/v1/deployments/by-slug/not-yet-live-2")
    unknown_resp = await client.get("/api/v1/deployments/by-slug/totally-unknown-slug")

    assert pending_resp.status_code == unknown_resp.status_code == 404
    pending_error = pending_resp.json()["error"]
    unknown_error = unknown_resp.json()["error"]
    assert pending_error["code"] == unknown_error["code"] == "DEPLOYMENT_NOT_ACTIVE"
    assert pending_error["message"] == unknown_error["message"]


async def test_by_slug_requires_no_auth(client: httpx.AsyncClient, db) -> None:
    """The Hosted Runtime calls this server-to-server — no Authorization header needed."""
    resp = await client.get("/api/v1/deployments/by-slug/anything")
    assert resp.status_code == 404  # not 401


async def test_by_slug_returns_chatbot_config_when_active(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    deploy_resp = await _create_deployment(client, version_id, "hr-policy-active")
    deployment_id = deploy_resp.json()["id"]
    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert publish_resp.status_code == 202

    resp = await client.get("/api/v1/deployments/by-slug/hr-policy-active")

    assert resp.status_code == 200
    body = resp.json()
    assert body["slug"] == "hr-policy-active"
    assert body["status"] == "ACTIVE"
    assert body["chatbot_config"]["welcome_message"]
    assert body["model_alias"] == "default-chat"
    assert body["knowledge_id"]


async def test_list_deployments(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    await _create_deployment(client, version_id, "list-me-bot")

    resp = await client.get("/api/v1/deployments", headers=auth_header())

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] >= 1
    assert any(item["slug"] == "list-me-bot" for item in body["items"])


# --- GET /services, GET /services/{id}, GET /service-versions/{id} ---
# Without these, everything the Composer/Chatbot-wizard writes was invisible
# after the fact: POST /services returned 201 but there was no way to read a
# Service back (405/404). These three read endpoints close that gap.


async def test_list_services_returns_newest_first_with_latest_version(
    client: httpx.AsyncClient, db
) -> None:
    version_id_1 = await _create_service(client, db)
    version_id_2 = await _create_service(client, db)

    resp = await client.get("/api/v1/services", headers=auth_header())

    assert resp.status_code == 200
    body = resp.json()
    assert body["page"] == 1
    assert body["page_size"] == 20
    assert body["total"] >= 2
    ids = [item["id"] for item in body["items"]]
    # Newest (version_id_2's service) must sort before the older one.
    assert ids.index(_service_id_for(body, version_id_2)) < ids.index(
        _service_id_for(body, version_id_1)
    )
    item = next(i for i in body["items"] if i["id"] == _service_id_for(body, version_id_2))
    assert item["version_count"] == 1
    assert item["latest_version"]["id"] == version_id_2
    assert item["latest_version"]["status"] == "DRAFT"
    assert item["owner_org"]
    assert item["owner_creator_id"]


def _service_id_for(list_body: dict, version_id: str) -> str:
    for item in list_body["items"]:
        if item["latest_version"] and item["latest_version"]["id"] == version_id:
            return item["id"]
    raise AssertionError(f"version_id {version_id} not found in list response")


async def test_list_services_requires_auth(client: httpx.AsyncClient, db) -> None:
    resp = await client.get("/api/v1/services")
    assert resp.status_code == 401


async def test_list_services_paginates(client: httpx.AsyncClient, db) -> None:
    await _create_service(client, db)
    await _create_service(client, db)

    resp = await client.get("/api/v1/services?page=1&page_size=1", headers=auth_header())

    assert resp.status_code == 200
    body = resp.json()
    assert body["page_size"] == 1
    assert len(body["items"]) == 1
    assert body["total"] >= 2


async def test_get_service_returns_version_history(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    version_resp = await client.get(
        f"/api/v1/service-versions/{version_id}", headers=auth_header()
    )
    service_id = version_resp.json()["service_id"]

    resp = await client.get(f"/api/v1/services/{service_id}", headers=auth_header())

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == service_id
    assert len(body["versions"]) == 1
    assert body["versions"][0]["id"] == version_id


async def test_get_service_returns_404_for_unknown_id(client: httpx.AsyncClient, db) -> None:
    resp = await client.get(
        "/api/v1/services/00000000-0000-0000-0000-000000000000", headers=auth_header()
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    assert resp.json()["error"]["trace_id"]


async def test_get_service_version_returns_full_detail_with_service_identity(
    client: httpx.AsyncClient, db
) -> None:
    version_id = await _create_service(client, db)

    resp = await client.get(f"/api/v1/service-versions/{version_id}", headers=auth_header())

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == version_id
    assert body["status"] == "DRAFT"
    assert body["service_definition"]["name"] == "HR 정책 챗봇"
    assert body["service"]["id"] == body["service_id"]
    assert body["service"]["name"] == "HR 챗봇"
    assert body["service"]["owner_org"]


async def test_get_service_version_returns_404_for_unknown_id(
    client: httpx.AsyncClient, db
) -> None:
    resp = await client.get(
        "/api/v1/service-versions/00000000-0000-0000-0000-000000000000", headers=auth_header()
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


async def test_get_service_version_requires_auth(client: httpx.AsyncClient, db) -> None:
    version_id = await _create_service(client, db)
    resp = await client.get(f"/api/v1/service-versions/{version_id}")
    assert resp.status_code == 401
