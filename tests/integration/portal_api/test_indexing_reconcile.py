"""색인은 끝났는데 Job 만 FAILED 로 남은 상태를 되살린다.

`_trigger_indexing` 은 indexing-runtime 의 HTTP 응답으로만 결과를 안다. 그
연결이 끊기면(타임아웃, 프록시, 프로세스 재시작) portal-api 는 FAILED 로
기록하지만 색인 자체는 계속 돌아 정상적으로 끝난다 — 인덱스는 멀쩡히 있는데
Job 행만 영원히 FAILED 다. 2026-09-17 사내 테스트에서 "인덱싱 서버는 완료됐는데
허브는 실패라고 나온다"로 보고됐고, 재색인 API 가 없어서 몇 분치 임베딩을 버리고
처음부터 다시 등록하는 것 말고는 방법이 없었다.

여기서 가장 중요한 성질은 **반쯤 만들어진 인덱스를 성공으로 뒤집지 않는 것**
이다. 검색이 조용히 빈 결과를 내는 상태가 FAILED 로 남아 있는 것보다 나쁘다.
"""

from __future__ import annotations

import json

import pytest
from httpx import AsyncClient
from portal_api.models.asset import IndexingJob

from .conftest import make_draft_asset_version

ADMIN = {"Authorization": "Bearer dev-admin-token"}


async def _seed_failed_job(db) -> tuple[str, str, str]:
    """실제 등록 경로가 만드는 것과 같은 모양의 DRAFT 자산 + FAILED 색인 Job."""
    version = await make_draft_asset_version(db, name="복구 테스트 지식")
    job = IndexingJob(
        asset_version_id=version.id,
        status="FAILED",
        error_message="indexing-runtime 응답이 제한 시간 안에 오지 않았습니다(ReadTimeout).",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return version.asset_id, job.id, version.id


def _write_index(index_dir, *, chunk_count: int = 15, omit: str | None = None) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "index-meta.json": json.dumps({"chunk_count": chunk_count, "parent_count": 7}),
        "bm25.json": "{}",
        "parents.json": "{}",
    }
    for name, body in artifacts.items():
        if name == omit:
            continue
        (index_dir / name).write_text(body, encoding="utf-8")
    if omit != "chroma":
        (index_dir / "chroma").mkdir(exist_ok=True)


@pytest.mark.asyncio
async def test_completed_index_on_disk_flips_a_failed_job(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    asset_id, job_id, version_id = await _seed_failed_job(db)
    _write_index(_isolated_index_base / version_id, chunk_count=41954)

    res = await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["changed"] is True
    assert body["status"] == "COMPLETED"
    assert body["chunk_count"] == 41954

    jobs = (await client.get(f"/api/v1/assets/{asset_id}/indexing-jobs", headers=ADMIN)).json()
    assert jobs[0]["status"] == "COMPLETED"
    assert jobs[0]["chunk_count"] == 41954
    assert jobs[0]["error_message"] is None, "되살렸으면 실패 사유도 지워야 한다"


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["index-meta.json", "bm25.json", "parents.json", "chroma"])
async def test_a_partial_index_is_not_flipped_to_success(
    client: AsyncClient, db, _isolated_index_base, missing: str
) -> None:
    """산출물이 하나라도 없으면 뒤집지 않는다. 반쯤 만들어진 인덱스를 성공으로
    표시하면 검색이 조용히 빈 결과를 내는, FAILED 보다 나쁜 상태가 된다."""
    asset_id, job_id, version_id = await _seed_failed_job(db)
    _write_index(_isolated_index_base / version_id, omit=missing)

    res = await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )
    assert res.status_code == 200
    body = res.json()
    assert body["changed"] is False
    assert body["status"] == "FAILED"
    assert any(missing in m for m in body["missing"])


@pytest.mark.asyncio
async def test_zero_chunk_index_is_not_flipped_to_success(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    """청크 0개짜리 인덱스는 파일이 다 있어도 검색에 쓸 수 없다."""
    asset_id, job_id, version_id = await _seed_failed_job(db)
    _write_index(_isolated_index_base / version_id, chunk_count=0)

    body = (await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )).json()
    assert body["changed"] is False


@pytest.mark.asyncio
async def test_no_index_at_all_reports_why(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    asset_id, job_id, version_id = await _seed_failed_job(db)

    body = (await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )).json()
    assert body["changed"] is False
    assert body["missing"], "무엇이 없는지 말해 줘야 한다"
    assert "다시 등록" in body["message"]


@pytest.mark.asyncio
async def test_reconciling_a_completed_job_is_a_no_op(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    asset_id, job_id, version_id = await _seed_failed_job(db)
    _write_index(_isolated_index_base / version_id)

    first = (await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )).json()
    second = (await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/{job_id}/reconcile", headers=ADMIN
    )).json()

    assert first["changed"] is True
    assert second["changed"] is False, "멱등이어야 한다"


@pytest.mark.asyncio
async def test_listing_marks_a_failed_job_as_recoverable(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    """화면이 '다시 확인'을 헛되이 권하지 않도록, 복구 가능할 때만 알려 준다."""
    asset_id, _, version_id = await _seed_failed_job(db)
    _write_index(_isolated_index_base / version_id)

    jobs = (await client.get(f"/api/v1/assets/{asset_id}/indexing-jobs", headers=ADMIN)).json()
    assert jobs[0]["index_recoverable"] is True


@pytest.mark.asyncio
async def test_listing_does_not_promise_recovery_without_an_index(
    client: AsyncClient, db, _isolated_index_base
) -> None:
    asset_id, _, version_id = await _seed_failed_job(db)

    jobs = (await client.get(f"/api/v1/assets/{asset_id}/indexing-jobs", headers=ADMIN)).json()
    assert jobs[0]["index_recoverable"] is False


@pytest.mark.asyncio
async def test_unknown_job_is_404(client: AsyncClient, db) -> None:
    asset_id, _, _version_id = await _seed_failed_job(db)
    res = await client.post(
        f"/api/v1/assets/{asset_id}/indexing-jobs/nope/reconcile", headers=ADMIN
    )
    assert res.status_code == 404
