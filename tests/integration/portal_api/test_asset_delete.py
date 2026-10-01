"""자산 영구 삭제 — 되돌릴 수 없으므로 **거부 경로가 본체**다.

행복한 경로(초안 하나 지우기)는 쉽다. 위험한 것은 지우면 안 되는 것을 지우는
쪽이다:

* 승인된 적이 있는 자산 — 승인 이력은 감사 대상이고, 명세 §4.1 이 삭제를
  허용하는 상태는 DRAFT/CHANGES_REQUESTED 뿐이다.
* 다른 곳이 참조 중인 자산 — 서비스 정의의 `knowledge_bindings` 와 배포 요청의
  `root_id` 는 **FK 가 아니다**. 데이터베이스가 막아 주지 않으므로 코드가
  확인해야 하고, 확인하지 않고 지우면 게시된 챗봇이 질의 시점에 조용히 빈
  결과를 내기 시작한다.
* 남의 자산 — 권한이 있다고 소유권이 생기지는 않는다.

파일 삭제는 저장소 루트 밖으로 나가지 않아야 한다.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from portal_api.config import settings
from portal_api.models import AssetVersion, DistributionRequest, IndexingJob
from portal_api.models.revocation import AssetVersionRevocation
from portal_api.models.review import AuditEvent, ReviewDecision, ReviewRequest
from portal_api.models.service import Service, ServiceVersion
from sqlalchemy import func, select

from .conftest import auth_header, make_draft_asset_version

CREATOR = auth_header("dev-user-token")
ADMIN = auth_header("dev-admin-token")
REASON = {"reason": "테스트 중 잘못 올린 문서"}


async def _draft(db, name: str = "지울 초안"):
    return await make_draft_asset_version(db, name=name)


@pytest.mark.asyncio
async def test_owner_can_delete_their_draft(client: AsyncClient, db) -> None:
    version = await _draft(db)

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] is True

    gone = await client.get(f"/api/v1/assets/{version.asset_id}", headers=CREATOR)
    assert gone.status_code == 404


@pytest.mark.asyncio
async def test_reason_is_required(client: AsyncClient, db) -> None:
    """되돌릴 수 없는 행동이라 감사에 '누가 왜' 가 남아야 한다."""
    version = await _draft(db)
    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json={"reason": "   "}, headers=CREATOR
    )
    assert res.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("status_value", ["APPROVED", "IN_REVIEW", "DEPRECATED", "SUSPENDED", "RETIRED"])
async def test_an_owner_cannot_delete_a_version_past_draft(
    client: AsyncClient, db, status_value: str
) -> None:
    """명세 §4.1: 제작자가 지울 수 있는 상태는 DRAFT/CHANGES_REQUESTED 뿐이다.
    승인 절차에 들어간 자산을 내리는 수단은 따로 있다(중단/지원 종료). 지우는 것은 관리자의 일이다."""
    version = await _draft(db)
    version.status = status_value
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_NOT_DELETABLE"
    assert "관리자" in res.json()["error"]["message"]
    assert (await client.get(f"/api/v1/assets/{version.asset_id}", headers=CREATOR)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("status_value", ["APPROVED", "IN_REVIEW", "DEPRECATED", "SUSPENDED", "RETIRED"])
async def test_an_admin_can_delete_an_unreferenced_asset_in_any_status(
    client: AsyncClient, db, status_value: str
) -> None:
    version = await _draft(db)
    version.status = status_value
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN
    )
    assert res.status_code == 200, res.text
    assert (await client.get(f"/api/v1/assets/{version.asset_id}", headers=ADMIN)).status_code == 404


@pytest.mark.asyncio
async def test_an_admin_delete_removes_review_history_but_keeps_the_audit_trail(
    client: AsyncClient, db
) -> None:
    version = await _draft(db)
    version.status = "APPROVED"
    review = ReviewRequest(
        subject_type="ASSET_VERSION", subject_id=version.id, stage="TECHNICAL",
        status="APPROVED", requested_by="dev-user@miracom.com",
    )
    db.add(review)
    await db.flush()
    db.add(ReviewDecision(
        review_id=review.id, decision="APPROVE", reviewer_id="reviewer@miracom.com", comments="ok",
    ))
    db.add(AuditEvent(
        event_type="REVIEW_DECIDED", actor_id="reviewer@miracom.com", resource_type="ASSET_VERSION",
        resource_id=version.id, result="SUCCESS",
    ))
    await db.commit()
    # 지운 뒤에는 ORM 객체를 읽을 수 없으니 값을 먼저 잡아 둔다.
    version_id, asset_id = version.id, version.asset_id

    res = await client.request("DELETE", f"/api/v1/assets/{asset_id}", json=REASON, headers=ADMIN)
    assert res.status_code == 200, res.text

    db.expire_all()
    assert (await db.execute(select(func.count()).select_from(ReviewRequest).where(
        ReviewRequest.subject_id == version_id))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(ReviewDecision))).scalar_one() == 0
    # 감사 로그는 남는다: 승인 당시의 기록도, 삭제 기록도.
    kept = (await db.execute(select(AuditEvent).where(AuditEvent.resource_id == version_id))).scalars().all()
    assert any(e.event_type == "REVIEW_DECIDED" for e in kept)
    deleted = (await db.execute(
        select(AuditEvent).where(AuditEvent.event_type == "ASSET_DELETED", AuditEvent.resource_id == asset_id)
    )).scalars().all()
    meta = [e.metadata_ for e in deleted if e.result == "SUCCESS"][0]
    assert meta["admin_override"] is True
    assert meta["version_statuses"] == ["APPROVED"]
    assert meta["reason"] == REASON["reason"]


async def _approved(db, name: str):
    version = await _draft(db, name)
    version.status = "APPROVED"
    await db.commit()
    return version


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "definition_key",
    ["knowledge_bindings", "mcp_bindings", "prompt_bindings", "agent_ref"],
)
async def test_any_service_binding_blocks_even_an_admin(client: AsyncClient, db, definition_key: str) -> None:
    """바인딩 종류를 가리지 않고 서비스 정의 안에 자산 id 가 있으면 막힌다 — knowledge 만 보던 시절
    승인된 프롬프트·MCP·에이전트를 지우면 게시된 서비스가 조용히 깨졌을 것이다."""
    version = await _approved(db, "참조되는 자산")
    service = Service(name="바인딩 서비스", owner_org="miracom", owner_creator_id="dev-user@miracom.com")
    db.add(service)
    await db.flush()
    reference = (
        {"id": version.asset_id, "version": "1.0.0"}
        if definition_key == "agent_ref"
        else [{"tool_id" if definition_key == "mcp_bindings" else "prompt_id" if definition_key == "prompt_bindings" else "knowledge_id": version.asset_id}]
    )
    db.add(ServiceVersion(
        service_id=service.id, version="1.0.0", status="APPROVED",
        service_definition={definition_key: reference},
    ))
    await db.commit()

    res = await client.request("DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"
    assert "서비스 버전" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_another_assets_manifest_reference_blocks_deletion(client: AsyncClient, db) -> None:
    target = await _approved(db, "프롬프트 자산")
    holder = await _draft(db, "프롬프트를 쓰는 에이전트")
    holder.manifest = {"type": "agent", "prompt_ref": {"id": target.asset_id, "version": "1.0.0"}}
    await db.commit()

    res = await client.request("DELETE", f"/api/v1/assets/{target.asset_id}", json=REASON, headers=ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"
    assert "다른 자산" in res.json()["error"]["message"]
    # 참조하는 쪽을 지우는 것은 막히지 않는다.
    assert (await client.request("DELETE", f"/api/v1/assets/{holder.asset_id}", json=REASON, headers=ADMIN)).status_code == 200


@pytest.mark.asyncio
async def test_being_another_versions_replacement_blocks_deletion(client: AsyncClient, db) -> None:
    successor = await _approved(db, "후속 자산")
    old = await _draft(db, "옛 자산")
    old.status = "DEPRECATED"
    old.replacement_version_id = successor.id
    await db.commit()

    res = await client.request("DELETE", f"/api/v1/assets/{successor.asset_id}", json=REASON, headers=ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"
    assert "대체 버전" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_a_revocation_record_blocks_even_an_admin(client: AsyncClient, db) -> None:
    """회수 기록은 설치본이 그 버전을 거부하는 근거다 — 지우면 회수가 풀린다."""
    version = await _approved(db, "회수된 자산")
    db.add(AssetVersionRevocation(
        version_id=version.id, reason="보안 이슈", approver_id="admin@miracom.com",
        effective_at=datetime.now(UTC),
    ))
    await db.commit()

    res = await client.request("DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"
    assert "회수 기록" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_reviewer_roles_cannot_delete_an_approved_asset(client: AsyncClient, db) -> None:
    version = await _approved(db, "남의 승인 자산")
    for token in ("dev-reviewer-token", "dev-security-token", "dev-release-token", "dev-auditor-token"):
        res = await client.request(
            "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=auth_header(token)
        )
        assert res.status_code in (403, 409), (token, res.status_code)
    assert (await client.get(f"/api/v1/assets/{version.asset_id}", headers=ADMIN)).status_code == 200


@pytest.mark.asyncio
async def test_changes_requested_is_deletable(client: AsyncClient, db) -> None:
    """반려된 초안은 지울 수 있어야 한다 — 승인된 적이 없다."""
    version = await _draft(db)
    version.status = "CHANGES_REQUESTED"
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_a_service_binding_blocks_deletion(client: AsyncClient, db) -> None:
    """서비스 정의는 knowledge_id 를 **JSON 안에** 들고 있어 FK 가 막지 못한다.
    확인하지 않고 지우면 게시된 챗봇이 조용히 빈 결과를 내기 시작한다."""
    version = await _draft(db)

    service = Service(
        name="바인딩 서비스", owner_org="miracom",
        owner_creator_id="dev-user@miracom.com",
    )
    db.add(service)
    await db.flush()
    db.add(ServiceVersion(
        service_id=service.id, version="1.0.0", status="DRAFT",
        service_definition={"knowledge_bindings": [{"knowledge_id": version.asset_id}]},
    ))
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"


@pytest.mark.asyncio
async def test_a_distribution_request_blocks_deletion(client: AsyncClient, db) -> None:
    """배포 요청의 root_id 도 FK 가 아니다."""
    version = await _draft(db)
    db.add(DistributionRequest(
        root_type="ASSET_VERSION", root_id=version.id, mode="ONLINE",
        requested_by="dev-user@miracom.com", status="QUEUED",
    ))
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_IN_USE"


@pytest.mark.asyncio
async def test_a_non_owner_cannot_delete(client: AsyncClient, db) -> None:
    """권한이 있다고 소유권이 생기지는 않는다."""
    version = await make_draft_asset_version(db, owner_creator_id="someone-else@miracom.com")

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_a_reader_role_cannot_delete(client: AsyncClient, db) -> None:
    version = await _draft(db)
    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON,
        headers=auth_header("dev-auditor-token"),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_deleting_removes_the_index_and_upload_directories(
    client: AsyncClient, db, _isolated_index_base, tmp_path
) -> None:
    """행만 지우면 아무도 모르는 데이터가 디스크에 남는다 — 21MB 문서 하나가
    525MB 인덱스를 만든다."""
    version = await _draft(db)

    storage_dir = settings.storage_root / "knowledge" / version.asset_id / "1.0.0"
    storage_dir.mkdir(parents=True, exist_ok=True)
    (storage_dir / "doc.md").write_text("본문", encoding="utf-8")
    version.storage_path = str(storage_dir)

    index_dir = _isolated_index_base / version.id
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "index-meta.json").write_text(json.dumps({"chunk_count": 3}), encoding="utf-8")

    db.add(IndexingJob(asset_version_id=version.id, status="COMPLETED", chunk_count=3))
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 200, res.text
    assert res.json()["removed_directories"] == 2
    assert not index_dir.exists()
    assert not storage_dir.exists()


@pytest.mark.asyncio
async def test_a_storage_path_outside_the_root_is_not_deleted(
    client: AsyncClient, db, tmp_path
) -> None:
    """경로는 DB 에서 오지만 그렇다고 검사를 생략하지 않는다 — 잘못된 행 하나가
    저장소 밖을 지우는 일로 이어지면 되돌릴 수 없다."""
    outsider = tmp_path / "밖에_있는_소중한_디렉터리"
    outsider.mkdir()
    (outsider / "keep.txt").write_text("지우면 안 된다", encoding="utf-8")

    version = await _draft(db)
    version.storage_path = str(outsider)
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=CREATOR
    )
    assert res.status_code == 200
    assert outsider.exists(), "저장소 루트 밖은 절대 지우지 않는다"
    assert (outsider / "keep.txt").exists()


@pytest.mark.asyncio
async def test_deletion_is_audited_with_the_reason(client: AsyncClient, db) -> None:
    version = await _draft(db)
    await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}",
        json={"reason": "오탈자로 다시 올림"}, headers=CREATOR,
    )

    events = (await client.get(
        "/api/v1/audit-events?event_type=ASSET_DELETED", headers=ADMIN
    )).json()
    rows = events["items"] if isinstance(events, dict) else events
    assert any(
        e.get("resource_id") == version.asset_id and e.get("result") == "SUCCESS"
        for e in rows
    ), rows


@pytest.mark.asyncio
async def test_unknown_asset_is_404(client: AsyncClient, db) -> None:
    res = await client.request(
        "DELETE", "/api/v1/assets/없는-자산", json=REASON, headers=ADMIN
    )
    assert res.status_code == 404
