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

import pytest
from httpx import AsyncClient
from portal_api.config import settings
from portal_api.models import DistributionRequest, IndexingJob
from portal_api.models.service import Service, ServiceVersion

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
async def test_a_version_past_draft_is_never_deleted(
    client: AsyncClient, db, status_value: str
) -> None:
    """명세 §4.1: 삭제가 허용되는 상태는 DRAFT/CHANGES_REQUESTED 뿐이다.
    승인 절차에 들어간 자산을 내리는 수단은 따로 있다(중단/지원 종료)."""
    version = await _draft(db)
    version.status = status_value
    await db.commit()

    res = await client.request(
        "DELETE", f"/api/v1/assets/{version.asset_id}", json=REASON, headers=ADMIN
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ASSET_NOT_DELETABLE"


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
