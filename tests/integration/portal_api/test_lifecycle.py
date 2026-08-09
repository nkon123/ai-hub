"""Integration tests for P16 수명주기/회수
(01-portal-and-distribution.md §2 P16) — Retired, 대체 버전 설정, 긴급
Revocation, 영향받는 Service/Bundle 조회, and the lifecycle list.

Suspend/Deprecate already have their own tests in `test_reviews.py`; this
file only covers what's new: `retire`, `replacement`, `revocations`,
`lifecycle` (list), and `impact`, plus the end-to-end wiring that flags a
revoked item in the bundle payload portal-api sends to distribution-service
(the actual *enforcement* of that flag is a distribution-service unit test —
see `tests/unit/distribution_service/test_revocation_enforcement.py`).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from portal_api.main import app
from portal_api.models import AssetVersion
from portal_api.routers.distributions import get_distribution_caller, get_session_factory

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_draft_asset_version,
    make_indexed_knowledge,
)


async def _deprecate_in_place(db, version: AssetVersion) -> None:
    """Force a version straight to DEPRECATED for test setup — mirrors
    `test_reviews.py`'s `knowledge.status = "IN_REVIEW"` pattern rather than
    walking the full submit/decide chain, which is already covered
    elsewhere."""
    version.status = "DEPRECATED"
    version.deprecated_at = datetime.now(UTC)
    await db.commit()


# --- Retired ---


async def test_retire_rejects_non_deprecated_status(client: httpx.AsyncClient, db) -> None:
    approved = await make_indexed_knowledge(db)  # APPROVED, not DEPRECATED

    resp = await client.post(
        f"/api/v1/asset-versions/{approved.id}/retire",
        json={"reason": "후속 조치"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_retire_requires_reason(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/retire",
        json={"reason": "  "},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_retire_requires_release_manager_role_and_audits_denial(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    denied = await client.post(
        f"/api/v1/asset-versions/{version.id}/retire",
        json={"reason": "지원 종료 기간 만료"},
        headers=auth_header(),  # CREATOR lacks ASSET_RETIRE
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": version.id},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and "ASSET_RETIRE" in e["event_type"] for e in events
    )


async def test_retire_happy_path(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/retire",
        json={"reason": "지원 종료 기간 만료"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "RETIRED"
    assert body["retired_at"] is not None

    # RETIRED is terminal — a second retire attempt must be rejected, not
    # silently re-applied.
    again = await client.post(
        f"/api/v1/asset-versions/{version.id}/retire",
        json={"reason": "중복 시도"},
        headers=auth_header("dev-release-token"),
    )
    assert again.status_code == 409


# --- 대체 버전 설정 (Replacement) ---


async def test_set_replacement_rejects_non_deprecated_or_retired_source(
    client: httpx.AsyncClient, db
) -> None:
    approved = await make_indexed_knowledge(db)
    successor = await make_indexed_knowledge(db, indexed=False)
    # Give the successor the same asset_id so the "same asset" rule doesn't
    # mask the status check this test targets.
    successor.asset_id = approved.asset_id
    await db.commit()

    resp = await client.post(
        f"/api/v1/asset-versions/{approved.id}/replacement",
        json={"replacement_version_id": successor.id, "reason": "후속 버전 안내"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_set_replacement_rejects_self_reference(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/replacement",
        json={"replacement_version_id": version.id, "reason": "자기 참조 시도"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "자기 자신" in resp.json()["error"]["message"]


async def test_set_replacement_rejects_non_approved_target(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    draft_successor = await make_draft_asset_version(db, name="successor-draft")
    draft_successor.asset_id = version.asset_id
    await db.commit()

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/replacement",
        json={"replacement_version_id": draft_successor.id, "reason": "후속 버전 안내"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "APPROVED" in resp.json()["error"]["message"]


async def test_set_replacement_rejects_cross_asset_target(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    other_asset_version = await make_indexed_knowledge(db)  # different Asset entirely

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/replacement",
        json={"replacement_version_id": other_asset_version.id, "reason": "후속 버전 안내"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "다른 자산" in resp.json()["error"]["message"]


async def test_set_replacement_happy_path(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    await _deprecate_in_place(db, version)

    successor = await make_indexed_knowledge(db, indexed=False)
    successor.asset_id = version.asset_id
    await db.commit()

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/replacement",
        json={"replacement_version_id": successor.id, "reason": "후속 버전 안내"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["replacement_version_id"] == successor.id
    assert body["replacement_version_label"] == successor.version


# --- 긴급 Revocation ---


async def test_create_revocation_requires_reason(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={"approver_id": "release-manager@miracom.com", "effective_at": _iso_now()},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "사유" in resp.json()["error"]["message"]


async def test_create_revocation_requires_approver_id(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={"reason": "보안 취약점 발견", "effective_at": _iso_now()},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "승인자" in resp.json()["error"]["message"]


async def test_create_revocation_requires_effective_at(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={"reason": "보안 취약점 발견", "approver_id": "release-manager@miracom.com"},
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "효력 시각" in resp.json()["error"]["message"]


async def test_create_revocation_rejects_never_approved_version(
    client: httpx.AsyncClient, db
) -> None:
    draft = await make_draft_asset_version(db)

    resp = await client.post(
        f"/api/v1/asset-versions/{draft.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": _iso_now(),
        },
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_create_revocation_requires_release_manager_role(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": _iso_now(),
        },
        headers=auth_header(),  # CREATOR lacks ASSET_REVOKE
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_create_revocation_happy_path_and_effective_flag(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version_id"] == version.id
    assert body["effective"] is True

    lifecycle_resp = await client.get(
        "/api/v1/asset-versions/lifecycle",
        params={"page_size": 100},
        headers=auth_header("dev-release-token"),
    )
    assert lifecycle_resp.status_code == 200
    row = next(i for i in lifecycle_resp.json()["items"] if i["id"] == version.id)
    assert row["active_revocation"] is not None
    assert row["active_revocation"]["effective"] is True


async def test_future_dated_revocation_is_not_effective(client: httpx.AsyncClient, db) -> None:
    version = await make_indexed_knowledge(db)
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()

    resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "예정된 회수",
            "approver_id": "release-manager@miracom.com",
            "effective_at": future,
        },
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 201
    assert resp.json()["effective"] is False


# --- D-072: catalog (GET /api/v1/assets, GET /assets/{id}) exposes
# effective revocation. `GET /api/v1/assets` is the only endpoint Desktop's
# 자산 스토어(`storeTypes.ts`) uses to decide 설치 가능/불가 — before this,
# revoked APPROVED versions looked installable until the actual install
# request hit `ASSET_VERSION_REVOKED`. ---


async def test_catalog_shows_effective_revocation_without_reason_for_asset_read_only(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

    revoke_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )
    assert revoke_resp.status_code == 201, revoke_resp.text

    # CREATOR (dev-user-token) only holds ASSET_READ, not LIFECYCLE_READ —
    # must see that the version is revoked (the visibility gap D-072
    # closes) but not the free-text reason, which is RELEASE_MANAGER/
    # AUDITOR/ADMIN-only on the P16 lifecycle screen and must not be
    # silently widened here.
    catalog_resp = await client.get(
        "/api/v1/assets", params={"page_size": 100}, headers=auth_header("dev-user-token")
    )
    assert catalog_resp.status_code == 200
    asset = next(a for a in catalog_resp.json()["items"] if a["id"] == version.asset_id)
    version_out = next(v for v in asset["versions"] if v["id"] == version.id)
    assert version_out["status"] == "APPROVED"  # status alone would say "installable"
    assert version_out["active_revocation"] is not None
    assert version_out["active_revocation"]["reason"] is None


async def test_catalog_shows_revocation_reason_for_lifecycle_read_role(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

    await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )

    # RELEASE_MANAGER holds LIFECYCLE_READ — sees the reason too.
    catalog_resp = await client.get(
        "/api/v1/assets", params={"page_size": 100}, headers=auth_header("dev-release-token")
    )
    assert catalog_resp.status_code == 200
    asset = next(a for a in catalog_resp.json()["items"] if a["id"] == version.asset_id)
    version_out = next(v for v in asset["versions"] if v["id"] == version.id)
    assert version_out["active_revocation"]["reason"] == "보안 취약점 발견"


async def test_catalog_does_not_show_future_dated_revocation(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()

    revoke_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "예정된 회수",
            "approver_id": "release-manager@miracom.com",
            "effective_at": future,
        },
        headers=auth_header("dev-release-token"),
    )
    assert revoke_resp.status_code == 201

    catalog_resp = await client.get(
        "/api/v1/assets", params={"page_size": 100}, headers=auth_header("dev-release-token")
    )
    assert catalog_resp.status_code == 200
    asset = next(a for a in catalog_resp.json()["items"] if a["id"] == version.asset_id)
    version_out = next(v for v in asset["versions"] if v["id"] == version.id)
    # A future-dated revocation must not mark the version unavailable yet
    # (that's the install-time gate's own semantics — kept consistent, not
    # duplicated, via the shared `effective_filter` predicate).
    assert version_out["active_revocation"] is None


async def test_get_asset_detail_also_shows_effective_revocation(
    client: httpx.AsyncClient, db
) -> None:
    """`GET /assets/{asset_id}` must not contradict the catalog list."""
    version = await make_indexed_knowledge(db)
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

    await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )

    detail_resp = await client.get(
        f"/api/v1/assets/{version.asset_id}", headers=auth_header("dev-user-token")
    )
    assert detail_resp.status_code == 200
    version_out = next(v for v in detail_resp.json()["versions"] if v["id"] == version.id)
    assert version_out["active_revocation"] is not None
    assert version_out["active_revocation"]["reason"] is None


# --- Lifecycle list ---


async def test_lifecycle_list_requires_release_manager_admin_or_auditor(
    client: httpx.AsyncClient, db
) -> None:
    await make_indexed_knowledge(db)

    denied = await client.get(
        "/api/v1/asset-versions/lifecycle", headers=auth_header()
    )  # CREATOR
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "PERMISSION_DENIED"

    for token in ("dev-release-token", "dev-admin-token", "dev-auditor-token"):
        allowed = await client.get(
            "/api/v1/asset-versions/lifecycle", headers=auth_header(token)
        )
        assert allowed.status_code == 200, f"{token} should be allowed"
        assert allowed.json()["total"] >= 1


# --- 영향받는 Service/Bundle 조회 (Impact) ---


async def test_impact_query_requires_release_manager_admin_or_auditor(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)

    denied = await client.get(
        f"/api/v1/asset-versions/{version.id}/impact", headers=auth_header()
    )  # CREATOR
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_impact_query_finds_referencing_service_and_deployment(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    service_resp = await client.post(
        "/api/v1/services",
        json={"name": "HR 챗봇", "service_definition": definition},
        headers=auth_header(),
    )
    assert service_resp.status_code == 201, service_resp.text
    service_version_id = service_resp.json()["id"]

    deploy_resp = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": service_version_id,
            "slug": "impact-query-test",
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert deploy_resp.status_code == 201, deploy_resp.text
    deployment_id = deploy_resp.json()["id"]

    publish_resp = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert publish_resp.status_code == 202, publish_resp.text

    resp = await client.get(
        f"/api/v1/asset-versions/{knowledge.id}/impact",
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert any(s["service_version_id"] == service_version_id for s in body["services"])
    assert any(d["deployment_id"] == deployment_id for d in body["service_deployments"])


async def test_impact_query_for_unreferenced_version_is_empty(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)

    resp = await client.get(
        f"/api/v1/asset-versions/{version.id}/impact",
        headers=auth_header("dev-release-token"),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["services"] == []
    assert body["service_deployments"] == []
    assert body["distribution_requests"] == []


# --- Enforcement wiring: revoked items are flagged for distribution-service ---


@pytest.fixture(autouse=True)
def _override_session_factory_for_bundle_tests(session_factory):
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    yield
    app.dependency_overrides.pop(get_session_factory, None)


async def test_revoked_version_is_flagged_in_bundle_payload(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_indexed_knowledge(db)
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    revoke_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )
    assert revoke_resp.status_code == 201

    calls: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return {"status": "SUCCEEDED", "stage": "SUCCEEDED"}

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    try:
        create_resp = await client.post(
            "/api/v1/distributions",
            json={"root_type": "ASSET_VERSION", "root_id": version.id, "mode": "OFFLINE_BUNDLE"},
            headers=auth_header(),
        )
        assert create_resp.status_code == 202, create_resp.text
    finally:
        app.dependency_overrides.pop(get_distribution_caller, None)

    assert len(calls) == 1
    root_items = [i for i in calls[0]["items"] if i["asset_version_id"] == version.id]
    assert root_items and root_items[0]["revoked"] is True


async def test_download_blocked_for_effectively_revoked_asset_version(
    client: httpx.AsyncClient, db, tmp_path
) -> None:
    version = await make_indexed_knowledge(db)

    bundle_file = tmp_path / "bundle.zip"
    bundle_file.write_bytes(b"PK\x03\x04fake-zip")

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

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    try:
        create_resp = await client.post(
            "/api/v1/distributions",
            json={"root_type": "ASSET_VERSION", "root_id": version.id, "mode": "OFFLINE_BUNDLE"},
            headers=auth_header(),
        )
        assert create_resp.status_code == 202
        distribution_id = create_resp.json()["id"]
    finally:
        app.dependency_overrides.pop(get_distribution_caller, None)

    # The bundle was built successfully *before* the revocation existed —
    # download must still succeed at this point.
    ok_download = await client.get(
        f"/api/v1/distributions/{distribution_id}/download", headers=auth_header()
    )
    assert ok_download.status_code == 200

    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    revoke_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/revocations",
        json={
            "reason": "보안 취약점 발견",
            "approver_id": "release-manager@miracom.com",
            "effective_at": past,
        },
        headers=auth_header("dev-release-token"),
    )
    assert revoke_resp.status_code == 201

    blocked_download = await client.get(
        f"/api/v1/distributions/{distribution_id}/download", headers=auth_header()
    )
    assert blocked_download.status_code == 409
    assert blocked_download.json()["error"]["code"] == "ASSET_VERSION_REVOKED"


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()
