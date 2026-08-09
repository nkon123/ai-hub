"""Integration tests for P06 버전 관리 / P07 내 자산
(01-portal-and-distribution.md §2 P06/P07).

Covers: 새 버전 만들기(SemVer 강제), 승인 버전 수정 금지, 자동검증
재실행(PASSED/FAILED persistence), 3축(Manifest/Dependency/Permission)
Diff, 검토 요청 취소(해피패스/본인 아님/이미 처리됨/사유 누락), `/my/assets`
6개 구분 분류, 그리고 소유자 범위 밖 접근 거부 + 감사 기록.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
from portal_api.models import Asset, AssetVersion

from tests.integration.portal_api.conftest import auth_header, make_draft_asset_version


def _valid_knowledge_manifest(asset_id: str, version: str = "1.0.0", **overrides: object) -> dict:
    manifest: dict = {
        "schema_version": "1.0",
        "id": asset_id,
        "type": "knowledge",
        "name": "P06 테스트 Knowledge",
        "version": version,
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "테스트용 지식 자산",
        "source": {
            "type": "portal_upload",
            "documents": [
                {"path": "policy.md", "mime_type": "text/markdown", "sha256": "a" * 64}
            ],
        },
        "indexing_profile_ref": {"name": "default-korean", "version": "1.0.0"},
    }
    manifest.update(overrides)
    return manifest


async def _make_approved_version(
    db,
    *,
    owner_creator_id: str = "dev-user@miracom.com",
    manifest: dict | None = None,
    version: str = "1.0.0",
) -> tuple[Asset, AssetVersion]:
    asset = Asset(
        type="knowledge",
        name="p06-approved-knowledge",
        owner_org="miracom",
        owner_creator_id=owner_creator_id,
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()

    m = manifest if manifest is not None else _valid_knowledge_manifest(asset.id, version)
    v = AssetVersion(
        asset_id=asset.id,
        version=version,
        status="APPROVED",
        manifest=m,
        manifest_hash="deadbeef",
        approved_at=datetime.now(UTC),
    )
    db.add(v)
    await db.commit()
    await db.refresh(v)
    return asset, v


# --- POST /assets/{asset_id}/versions — 새 버전 만들기 ---


async def test_create_version_rejects_non_greater_semver(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(db, version="1.0.0")

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "1.0.0"},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_create_version_rejects_lower_semver(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(db, version="1.5.0")

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "1.4.9"},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_create_version_rejects_malformed_semver(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(db)

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "not-a-version"},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_create_version_without_approved_source_rejected(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)  # DRAFT only, no APPROVED version exists

    resp = await client.post(
        f"/api/v1/assets/{version.asset_id}/versions",
        json={"version": "2.0.0"},
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_create_version_happy_path_copies_manifest(client: httpx.AsyncClient, db) -> None:
    asset, source = await _make_approved_version(db, version="1.0.0")

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "1.1.0", "changelog": "정책 문구 수정"},
        headers=auth_header(),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version"] == "1.1.0"
    assert body["status"] == "DRAFT"
    assert body["asset_id"] == asset.id
    assert body["manifest"]["version"] == "1.1.0"
    assert body["manifest"]["changelog"] == "정책 문구 수정"
    # Copied verbatim from the source manifest.
    assert body["manifest"]["indexing_profile_ref"] == source.manifest["indexing_profile_ref"]
    assert body["validation_status"] == "NOT_RUN"


async def test_create_version_duplicate_rejected(client: httpx.AsyncClient, db) -> None:
    asset, _ = await _make_approved_version(db, version="1.0.0")

    first = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "2.0.0"},
        headers=auth_header(),
    )
    assert first.status_code == 201

    second = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "2.0.0"},
        headers=auth_header(),
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "ASSET_VERSION_CONFLICT"


async def test_create_version_denies_non_owner_and_audits(client: httpx.AsyncClient, db) -> None:
    asset, _ = await _make_approved_version(db, owner_creator_id="someone-else@miracom.com")

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions",
        json={"version": "2.0.0"},
        headers=auth_header(),  # dev-user-token != owner
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": asset.id},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"] == "ASSET_VERSION_CREATE_DENIED"
        for e in events
    )


# --- PATCH /assets/{asset_id}/versions/{version_id} ---


async def test_update_version_rejected_when_approved(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(db)

    resp = await client.patch(
        f"/api/v1/assets/{asset.id}/versions/{version.id}",
        json={"changelog": "승인된 버전을 몰래 고쳐본다"},
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_update_version_edits_changelog_and_resets_validation(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    version.validation_status = "FAILED"
    version.validation_errors = ["이전 오류"]
    await db.commit()

    resp = await client.patch(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}",
        json={"changelog": "새 changelog", "manifest_patch": {"description": "새 설명"}},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["manifest"]["changelog"] == "새 changelog"
    assert body["manifest"]["description"] == "새 설명"
    # Edit invalidates the stale FAILED result.
    assert body["validation_status"] == "NOT_RUN"
    assert body["validation_errors"] is None


async def test_update_version_rejects_disallowed_manifest_field(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)

    resp = await client.patch(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}",
        json={"manifest_patch": {"classification": "RESTRICTED"}},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_update_version_denies_non_owner_and_audits(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db, owner_creator_id="someone-else@miracom.com")

    resp = await client.patch(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}",
        json={"changelog": "몰래 수정"},
        headers=auth_header(),
    )
    assert resp.status_code == 403

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": version.id},
        headers=auth_header("dev-auditor-token"),
    )
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"] == "ASSET_VERSION_EDIT_DENIED"
        for e in events
    )


# --- POST /assets/{asset_id}/versions/{version_id}/validate ---


async def test_validate_persists_passed(client: httpx.AsyncClient, db) -> None:
    asset = Asset(
        type="knowledge",
        name="validate-pass-knowledge",
        owner_org="miracom",
        owner_creator_id="dev-user@miracom.com",
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()
    version = AssetVersion(
        asset_id=asset.id,
        version="1.0.0",
        status="DRAFT",
        manifest=_valid_knowledge_manifest(asset.id),
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions/{version.id}/validate",
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["validation_status"] == "PASSED"
    assert body["validation_errors"] is None
    assert body["validated_at"] is not None


async def test_validate_persists_failed(client: httpx.AsyncClient, db) -> None:
    # make_draft_asset_version's manifest is minimal and fails the full
    # knowledge-manifest schema (missing id/owner/classification/source/...).
    version = await make_draft_asset_version(db)

    resp = await client.post(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/validate",
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["validation_status"] == "FAILED"
    assert body["validation_errors"]
    assert body["validated_at"] is not None


async def test_validate_rejected_when_approved(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(db)

    resp = await client.post(
        f"/api/v1/assets/{asset.id}/versions/{version.id}/validate",
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


# --- GET /assets/{asset_id}/versions/{version_id}/diff ---


async def test_diff_reports_three_axes(client: httpx.AsyncClient, db) -> None:
    base_manifest = _valid_knowledge_manifest("shared-id", "1.0.0")
    asset, base = await _make_approved_version(db, manifest=base_manifest, version="1.0.0")

    target_manifest = dict(base_manifest)
    target_manifest["version"] = "1.1.0"
    target_manifest["classification"] = "CONFIDENTIAL"  # permission axis
    target_manifest["indexing_profile_ref"] = {  # dependency axis
        "name": "other-profile",
        "version": "1.0.0",
    }
    target_manifest["description"] = "변경된 설명"  # manifest axis (changed)
    target_manifest["tags"] = ["new-tag"]  # manifest axis (added)

    target = AssetVersion(
        asset_id=asset.id, version="1.1.0", status="DRAFT", manifest=target_manifest
    )
    db.add(target)
    await db.commit()
    await db.refresh(target)

    resp = await client.get(
        f"/api/v1/assets/{asset.id}/versions/{target.id}/diff",
        params={"against": base.id},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version_id"] == target.id
    assert body["against_version_id"] == base.id

    permission_changed_keys = {c["key"] for c in body["permission"]["changed"]}
    assert "classification" in permission_changed_keys

    dependency_changed_keys = {c["key"] for c in body["dependency"]["changed"]}
    assert "indexing_profile_ref" in dependency_changed_keys

    manifest_changed_keys = {c["key"] for c in body["manifest"]["changed"]}
    assert "description" in manifest_changed_keys
    manifest_added_keys = {a["key"] for a in body["manifest"]["added"]}
    assert "tags" in manifest_added_keys

    # No leakage across axes.
    assert "classification" not in manifest_changed_keys
    assert "indexing_profile_ref" not in manifest_changed_keys


async def test_diff_rejects_cross_asset_comparison(client: httpx.AsyncClient, db) -> None:
    asset_a, version_a = await _make_approved_version(db)
    asset_b, version_b = await _make_approved_version(db)

    resp = await client.get(
        f"/api/v1/assets/{asset_a.id}/versions/{version_a.id}/diff",
        params={"against": version_b.id},
        headers=auth_header(),
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_diff_denies_non_owner_and_audits(client: httpx.AsyncClient, db) -> None:
    asset, version = await _make_approved_version(
        db, owner_creator_id="someone-else@miracom.com"
    )

    resp = await client.get(
        f"/api/v1/assets/{asset.id}/versions/{version.id}/diff",
        params={"against": version.id},
        headers=auth_header(),
    )
    assert resp.status_code == 403

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": version.id},
        headers=auth_header("dev-auditor-token"),
    )
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"] == "ASSET_VERSION_DIFF_DENIED"
        for e in events
    )


# --- POST /reviews/{review_id}/cancel ---


async def test_cancel_review_happy_path(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    submit_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/submit", headers=auth_header()
    )
    review_id = submit_resp.json()["review_id"]

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/cancel",
        json={"reason": "요구사항이 바뀌어 다시 작성합니다"},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["review"]["status"] == "CANCELLED"
    assert body["version_status"] == "CHANGES_REQUESTED"


async def test_cancel_review_requires_reason(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    submit_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/submit", headers=auth_header()
    )
    review_id = submit_resp.json()["review_id"]

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/cancel", json={}, headers=auth_header()
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_cancel_review_rejects_non_requester(client: httpx.AsyncClient, db) -> None:
    from portal_api.models.review import ReviewRequest
    from sqlalchemy import select

    version = await make_draft_asset_version(db)
    submit_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/submit", headers=auth_header()
    )
    review_id = submit_resp.json()["review_id"]

    # Simulate a different requester having submitted this review, while the
    # caller (dev-user-token) still holds ASSET_SUBMIT_REVIEW generally.
    review = (
        await db.execute(select(ReviewRequest).where(ReviewRequest.id == review_id))
    ).scalar_one()
    review.requested_by = "someone-else@miracom.com"
    await db.commit()

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/cancel",
        json={"reason": "취소해봅니다"},
        headers=auth_header(),
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"resource_id": review_id},
        headers=auth_header("dev-auditor-token"),
    )
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["event_type"] == "REVIEW_CANCEL_DENIED" for e in events
    )


async def test_cancel_review_rejects_already_decided(client: httpx.AsyncClient, db) -> None:
    version = await make_draft_asset_version(db)
    submit_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/submit", headers=auth_header()
    )
    review_id = submit_resp.json()["review_id"]

    decide_resp = await client.post(
        f"/api/v1/reviews/{review_id}/decisions",
        json={"decision": "APPROVE", "comments": "기술 검토 통과"},
        headers=auth_header("dev-reviewer-token"),
    )
    assert decide_resp.status_code == 200

    resp = await client.post(
        f"/api/v1/reviews/{review_id}/cancel",
        json={"reason": "이미 결정된 걸 취소해본다"},
        headers=auth_header(),
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "RESOURCE_REVISION_CONFLICT"


# --- GET /my/assets ---


async def test_my_assets_categorizes_six_buckets(client: httpx.AsyncClient, db) -> None:
    owner = "dev-user@miracom.com"

    in_progress = await make_draft_asset_version(db, owner_creator_id=owner, name="in-progress")

    failed = await make_draft_asset_version(db, owner_creator_id=owner, name="validation-failed")
    failed.validation_status = "FAILED"
    failed.validation_errors = ["필수 필드 누락"]
    await db.commit()

    pending = await make_draft_asset_version(db, owner_creator_id=owner, name="pending-review")
    pending.status = "IN_REVIEW"
    await db.commit()

    rejected = await make_draft_asset_version(db, owner_creator_id=owner, name="rejected")
    rejected.status = "REJECTED"
    await db.commit()

    _, approved = await _make_approved_version(db, owner_creator_id=owner)

    deprecated = await make_draft_asset_version(db, owner_creator_id=owner, name="deprecated")
    deprecated.status = "DEPRECATED"
    await db.commit()

    resp = await client.get("/api/v1/my/assets", headers=auth_header())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_code = {c["code"]: c for c in body["categories"]}
    assert set(by_code) == {
        "IN_PROGRESS",
        "VALIDATION_FAILED",
        "PENDING_REVIEW",
        "REJECTED",
        "APPROVED",
        "DEPRECATED",
    }

    def ids(code: str) -> set[str]:
        return {item["id"] for item in by_code[code]["items"]}

    assert in_progress.id in ids("IN_PROGRESS")
    assert failed.id in ids("VALIDATION_FAILED")
    assert pending.id in ids("PENDING_REVIEW")
    assert rejected.id in ids("REJECTED")
    assert approved.id in ids("APPROVED")
    assert deprecated.id in ids("DEPRECATED")

    failed_row = next(
        item for item in by_code["VALIDATION_FAILED"]["items"] if item["id"] == failed.id
    )
    assert failed_row["validation_errors"] == ["필수 필드 누락"]
    assert failed_row["can_edit"] is True

    approved_row = next(item for item in by_code["APPROVED"]["items"] if item["id"] == approved.id)
    assert approved_row["can_create_new_version"] is True


async def test_my_assets_excludes_other_owners_but_admin_sees_all(
    client: httpx.AsyncClient, db
) -> None:
    mine = await make_draft_asset_version(db, owner_creator_id="dev-user@miracom.com", name="mine")
    theirs = await make_draft_asset_version(
        db, owner_creator_id="someone-else@miracom.com", name="theirs"
    )

    mine_resp = await client.get("/api/v1/my/assets", headers=auth_header())
    mine_body = mine_resp.json()
    mine_ids = {item["id"] for cat in mine_body["categories"] for item in cat["items"]}
    assert mine.id in mine_ids
    assert theirs.id not in mine_ids

    admin_resp = await client.get("/api/v1/my/assets", headers=auth_header("dev-admin-token"))
    admin_body = admin_resp.json()
    admin_ids = {item["id"] for cat in admin_body["categories"] for item in cat["items"]}
    assert mine.id in admin_ids
    assert theirs.id in admin_ids


# --- GET /assets/{asset_id} pending_review_id (P06 검토 취소 진입점) ---


async def test_asset_detail_exposes_pending_review_id_for_in_review_version(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)
    submit_resp = await client.post(
        f"/api/v1/asset-versions/{version.id}/submit", headers=auth_header()
    )
    review_id = submit_resp.json()["review_id"]

    resp = await client.get(f"/api/v1/assets/{version.asset_id}", headers=auth_header())

    assert resp.status_code == 200, resp.text
    versions = resp.json()["versions"]
    row = next(v for v in versions if v["id"] == version.id)
    assert row["pending_review_id"] == review_id


async def test_asset_detail_omits_pending_review_id_for_draft_version(
    client: httpx.AsyncClient, db
) -> None:
    version = await make_draft_asset_version(db)

    resp = await client.get(f"/api/v1/assets/{version.asset_id}", headers=auth_header())

    versions = resp.json()["versions"]
    row = next(v for v in versions if v["id"] == version.id)
    assert row["pending_review_id"] is None
