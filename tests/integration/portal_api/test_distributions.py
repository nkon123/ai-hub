"""Integration tests for the M02 Distribution/Offline Bundle API.

Covers: non-APPROVED/non-published root rejection, RBAC denial + audit,
download-before-completion rejection, and the happy path for both root
types with distribution-service faked via a `get_distribution_caller`
dependency override (no real distribution-service process required).

Every test that reaches `_run_bundle_job` (i.e. successfully creates a
distribution) installs a `get_distribution_caller` override — either
`override_distribution_caller` (fakes a SUCCEEDED result) or
`override_distribution_caller_unreachable` (fakes a connection failure) —
so results never depend on whether a real distribution-service process is
listening on :8400.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from portal_api.main import app
from portal_api.models import DistributionRequest
from portal_api.routers.distributions import get_distribution_caller, get_session_factory

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_draft_asset_version,
    make_indexed_knowledge,
)


async def _insert_distribution(
    db, *, requested_by: str, created_at: datetime, root_id: str | None = None
) -> str:
    """Insert a DistributionRequest row directly (bypassing the create API)
    so list-endpoint tests control `requested_by`/`created_at` precisely —
    the create API always derives `requested_by` from the caller and
    `created_at` from `_now()`, neither of which a test can pin down."""
    row = DistributionRequest(
        root_type="ASSET_VERSION",
        root_id=root_id or "00000000-0000-0000-0000-000000000000",
        mode="OFFLINE_BUNDLE",
        requested_by=requested_by,
        status="SUCCEEDED",
        stage="SUCCEEDED",
        created_at=created_at,
        updated_at=created_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row.id


@pytest.fixture(autouse=True)
def override_session_factory(session_factory):
    """`_run_bundle_job` opens its own DB session (it runs after the
    request's `Depends(get_db)` session has already closed) — point it at
    this test's isolated in-memory engine, never the real
    `settings.database_url`/`portal.db`."""
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    yield
    app.dependency_overrides.pop(get_session_factory, None)


@pytest.fixture
def fake_bundle_result():
    """Mutable holder so individual tests can swap in a FAILED result."""
    return {
        "status": "SUCCEEDED",
        "stage": "SUCCEEDED",
        "bundle_object_id": "11111111-1111-1111-1111-111111111111",
        "bundle_path": "/tmp/fake-bundle.zip",
        "bundle_size_bytes": 12345,
        "checksum": "deadbeef",
        "manifest_summary": {"bundle_id": "b1", "included": [], "install_order": ["knowledge"]},
    }


@pytest.fixture
def override_distribution_caller(fake_bundle_result):
    calls: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return fake_bundle_result

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    yield calls
    app.dependency_overrides.pop(get_distribution_caller, None)


@pytest.fixture
def override_distribution_caller_unreachable():
    """Deterministically exercises `_run_bundle_job`'s `except Exception`
    branch (mark FAILED / DEPENDENCY_UNAVAILABLE) — the same code path a real
    connection failure to distribution-service would hit — without depending
    on whether anything is actually listening on :8400. Using a real
    dependency override (rather than pointing the URL at a dead/free port)
    keeps the test's result independent of ambient machine/network state."""

    async def _fake_caller(payload: dict) -> dict:
        raise httpx.ConnectError("simulated distribution-service unavailable")

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_distribution_caller, None)


async def _create_service_version(client: httpx.AsyncClient, db) -> tuple[str, str]:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(
        knowledge,
        prompt_bindings=[
            {"role_id": "answerer", "prompt_id": "std-prompt-id", "prompt_version": "1.0.0"}
        ],
    )
    resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"], knowledge.id


async def _create_and_publish_deployment(
    client: httpx.AsyncClient, version_id: str, slug: str
) -> None:
    create_resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": slug,
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert create_resp.status_code == 201, create_resp.text
    deployment_id = create_resp.json()["id"]
    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert publish_resp.status_code == 202, publish_resp.text


# --- RBAC ---


async def test_create_distribution_denied_for_role_without_permission(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)

    resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header("dev-reviewer-token"),  # TECH_REVIEWER lacks DISTRIBUTION_CREATE
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": "-"},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"].startswith("PERMISSION_DENIED")
        for e in events
    )


# --- Validation / approval gates ---


async def test_online_mode_is_rejected_as_unimplemented(client: httpx.AsyncClient, db) -> None:
    knowledge = await make_indexed_knowledge(db)

    resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "ONLINE"},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_unapproved_asset_version_root_is_rejected(client: httpx.AsyncClient, db) -> None:
    draft = await make_draft_asset_version(db)

    resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": draft.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_nonexistent_asset_version_root_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "ASSET_VERSION",
            "root_id": "00000000-0000-0000-0000-000000000000",
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )

    assert resp.status_code == 404


async def test_unpublished_service_version_root_is_rejected(client: httpx.AsyncClient, db) -> None:
    service_version_id, _ = await _create_service_version(client, db)

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "게시" in resp.json()["error"]["message"]


# --- Download state gate ---


async def test_download_before_completion_returns_409(
    client: httpx.AsyncClient, db, override_distribution_caller_unreachable
) -> None:
    knowledge = await make_indexed_knowledge(db)
    create_resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header(),
    )
    assert create_resp.status_code == 202
    distribution_id = create_resp.json()["id"]

    # `override_distribution_caller_unreachable` makes the background task's
    # call to distribution-service fail deterministically, so the request is
    # persisted as FAILED — still "not SUCCEEDED", which is exactly the state
    # this test wants to exercise — regardless of whether a real
    # distribution-service happens to be listening on :8400.
    download_resp = await client.get(
        f"/api/v1/distributions/{distribution_id}/download", headers=auth_header()
    )

    assert download_resp.status_code == 409
    assert download_resp.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"


async def test_download_denied_for_non_requester(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    knowledge = await make_indexed_knowledge(db)
    create_resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header(),  # dev-user@miracom.com
    )
    distribution_id = create_resp.json()["id"]

    resp = await client.get(
        f"/api/v1/distributions/{distribution_id}",
        headers=auth_header("dev-security-token"),  # different user, not ADMIN/AUDITOR
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


# --- Happy path ---


async def test_asset_version_happy_path_reaches_succeeded(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    knowledge = await make_indexed_knowledge(db)

    create_resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "ASSET_VERSION",
            "root_id": knowledge.id,
            "mode": "OFFLINE_BUNDLE",
            "target_site_id": "site-hq",
        },
        headers=auth_header(),
    )
    assert create_resp.status_code == 202, create_resp.text
    distribution_id = create_resp.json()["id"]
    assert create_resp.json()["status"] == "QUEUED"

    detail_resp = await client.get(
        f"/api/v1/distributions/{distribution_id}", headers=auth_header()
    )
    assert detail_resp.status_code == 200
    body = detail_resp.json()
    assert body["status"] == "SUCCEEDED"
    assert body["stage"] == "SUCCEEDED"
    assert body["bundle_size_bytes"] == 12345
    assert body["bundle_checksum"] == "deadbeef"

    # The payload portal-api built and sent to distribution-service resolved
    # the real Knowledge asset from the DB — not a stub.
    sent_payload = override_distribution_caller[0]
    assert sent_payload["root_type"] == "ASSET_VERSION"
    knowledge_items = [i for i in sent_payload["items"] if i["asset_type"] == "knowledge"]
    assert knowledge_items[0]["asset_version_id"] == knowledge.id
    assert knowledge_items[0]["status"] == "APPROVED"


async def test_asset_version_download_succeeds_after_completion(
    client: httpx.AsyncClient, db, override_distribution_caller, tmp_path
) -> None:
    # Point the fake bundle at a real file so FileResponse can stream it.
    bundle_file = tmp_path / "bundle.zip"
    bundle_file.write_bytes(b"PK\x03\x04fake-zip-content")
    override_distribution_caller  # noqa: B018 — ensure fixture applied before mutating result
    from portal_api.routers import distributions as distributions_module

    async def _fake_caller(payload: dict) -> dict:
        return {
            "status": "SUCCEEDED",
            "stage": "SUCCEEDED",
            "bundle_object_id": "obj-1",
            "bundle_path": str(bundle_file),
            "bundle_size_bytes": bundle_file.stat().st_size,
            "checksum": "abc123",
            "manifest_summary": {"bundle_id": "b1", "included": [], "install_order": []},
        }

    app.dependency_overrides[distributions_module.get_distribution_caller] = lambda: _fake_caller

    knowledge = await make_indexed_knowledge(db)
    create_resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header(),
    )
    distribution_id = create_resp.json()["id"]

    download_resp = await client.get(
        f"/api/v1/distributions/{distribution_id}/download", headers=auth_header()
    )

    assert download_resp.status_code == 200
    assert download_resp.content == b"PK\x03\x04fake-zip-content"
    assert download_resp.headers["content-type"] == "application/zip"
    assert "bundle-" in download_resp.headers["content-disposition"]


async def test_service_version_happy_path_uses_published_snapshot(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    service_version_id, knowledge_version_id = await _create_service_version(client, db)
    await _create_and_publish_deployment(client, service_version_id, "svc-bundle-test")

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )

    assert resp.status_code == 202, resp.text
    sent_payload = override_distribution_caller[0]
    assert sent_payload["root_type"] == "SERVICE_VERSION"
    assert sent_payload["service_definition"] is not None
    roles = {i["role"] for i in sent_payload["items"]}
    assert "root" in roles
    assert "knowledge" in roles
    assert "agent" in roles
    assert "prompt" in roles
    knowledge_item = next(i for i in sent_payload["items"] if i["role"] == "knowledge")
    assert knowledge_item["asset_version_id"] == knowledge_version_id
    agent_item = next(i for i in sent_payload["items"] if i["role"] == "agent")
    assert agent_item["status"] == "STANDARD_LOCAL_COPY"


# --- List (GET /api/v1/distributions) ---


async def test_list_distributions_denied_for_role_without_download_read(
    client: httpx.AsyncClient,
) -> None:
    # TECH_REVIEWER lacks DOWNLOAD_READ (security_policy.roles.ROLE_PERMISSIONS).
    resp = await client.get("/api/v1/distributions", headers=auth_header("dev-reviewer-token"))

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_list_distributions_scopes_to_own_requests_for_regular_user(
    client: httpx.AsyncClient, db
) -> None:
    now = datetime.now(UTC)
    own_id = await _insert_distribution(db, requested_by="dev-user@miracom.com", created_at=now)
    await _insert_distribution(db, requested_by="admin@miracom.com", created_at=now)

    resp = await client.get("/api/v1/distributions", headers=auth_header())  # dev-user-token
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == [own_id]


async def test_list_distributions_admin_and_auditor_see_all_requests(
    client: httpx.AsyncClient, db
) -> None:
    now = datetime.now(UTC)
    await _insert_distribution(db, requested_by="dev-user@miracom.com", created_at=now)
    await _insert_distribution(db, requested_by="admin@miracom.com", created_at=now)

    admin_resp = await client.get("/api/v1/distributions", headers=auth_header("dev-admin-token"))
    assert admin_resp.status_code == 200
    assert admin_resp.json()["total"] == 2

    # AUDITOR never created a distribution itself but P13's rule still
    # grants it every request, not just its own.
    auditor_resp = await client.get(
        "/api/v1/distributions", headers=auth_header("dev-auditor-token")
    )
    assert auditor_resp.status_code == 200
    assert auditor_resp.json()["total"] == 2


async def test_list_distributions_orders_newest_first_and_paginates(
    client: httpx.AsyncClient, db
) -> None:
    base = datetime.now(UTC)
    ids = [
        await _insert_distribution(
            db, requested_by="admin@miracom.com", created_at=base + timedelta(minutes=i)
        )
        for i in range(3)
    ]
    # ids[2] was created last (newest), ids[0] first (oldest).

    page1 = await client.get(
        "/api/v1/distributions",
        params={"page": 1, "page_size": 2},
        headers=auth_header("dev-admin-token"),
    )
    assert page1.status_code == 200
    body1 = page1.json()
    assert body1["total"] == 3
    assert body1["page"] == 1
    assert body1["page_size"] == 2
    assert [item["id"] for item in body1["items"]] == [ids[2], ids[1]]

    page2 = await client.get(
        "/api/v1/distributions",
        params={"page": 2, "page_size": 2},
        headers=auth_header("dev-admin-token"),
    )
    assert page2.status_code == 200
    body2 = page2.json()
    assert body2["total"] == 3
    assert [item["id"] for item in body2["items"]] == [ids[0]]
