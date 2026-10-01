"""서비스 영구 삭제 (D-110) — 되돌릴 수 없으므로 **거부 경로가 본체**다.

* 제작자는 소유한 초안·수정 요청만, 관리자는 어느 상태든.
* **게시 중인 서비스는 관리자도 못 지운다** — 그 URL 로 사용자가 아직 쓰고 있을 수 있다.
  종료(RETIRED)된 게시만 서비스와 함께 지워진다.
* 반출(배포 요청)이 가리키는 서비스는 막는다.
* 남의 서비스는 권한이 있어도 못 지운다.
* 감사 로그는 남는다.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from portal_api.models import DeploymentRevision, DistributionRequest
from portal_api.models.review import AuditEvent, ReviewDecision, ReviewRequest
from portal_api.models.service import Service, ServiceDeployment, ServiceVersion
from sqlalchemy import func, select

from .conftest import auth_header

CREATOR = auth_header("dev-user-token")
ADMIN = auth_header("dev-admin-token")
REASON = {"reason": "더 이상 쓰지 않는 서비스"}


async def _service(db, *, owner: str = "dev-user@miracom.com", status_value: str = "DRAFT", name: str = "삭제 대상 서비스"):
    service = Service(name=name, owner_org="miracom", owner_creator_id=owner)
    db.add(service)
    await db.flush()
    version = ServiceVersion(
        service_id=service.id, version="1.0.0", status=status_value, service_definition={"name": name}
    )
    db.add(version)
    await db.commit()
    await db.refresh(service)
    await db.refresh(version)
    return service, version


async def _deploy(db, service, version, *, status_value: str, slug: str):
    deployment = ServiceDeployment(
        service_id=service.id, service_version_id=version.id, slug=slug, environment="PROD",
        access_policy="INTERNAL", status=status_value, created_by="dev-user@miracom.com",
    )
    db.add(deployment)
    await db.flush()
    db.add(DeploymentRevision(
        deployment_id=deployment.id, revision_number=1, service_version_id=version.id,
        resolved_dependency_snapshot={}, created_by="dev-user@miracom.com",
    ))
    await db.commit()
    return deployment


async def _delete(client: AsyncClient, service_id: str, headers=ADMIN, body=REASON):
    return await client.request("DELETE", f"/api/v1/services/{service_id}", json=body, headers=headers)


@pytest.mark.asyncio
async def test_owner_can_delete_their_draft_service(client: AsyncClient, db) -> None:
    service, _ = await _service(db)
    res = await _delete(client, service.id, CREATOR)
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] is True
    assert (await client.get(f"/api/v1/services/{service.id}", headers=CREATOR)).status_code == 404


@pytest.mark.asyncio
async def test_reason_is_required(client: AsyncClient, db) -> None:
    service, _ = await _service(db)
    res = await _delete(client, service.id, CREATOR, {"reason": "   "})
    assert res.status_code == 400
    assert (await client.get(f"/api/v1/services/{service.id}", headers=CREATOR)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("status_value", ["APPROVED", "IN_REVIEW", "DEPRECATED", "SUSPENDED", "RETIRED"])
async def test_an_owner_cannot_delete_a_service_past_draft(client: AsyncClient, db, status_value: str) -> None:
    service, _ = await _service(db, status_value=status_value)
    res = await _delete(client, service.id, CREATOR)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SERVICE_NOT_DELETABLE"
    assert "관리자" in res.json()["error"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status_value", ["APPROVED", "IN_REVIEW", "DEPRECATED", "SUSPENDED", "RETIRED"])
async def test_an_admin_can_delete_an_unpublished_service_in_any_status(
    client: AsyncClient, db, status_value: str
) -> None:
    service, _ = await _service(db, status_value=status_value)
    res = await _delete(client, service.id, ADMIN)
    assert res.status_code == 200, res.text
    assert (await client.get(f"/api/v1/services/{service.id}", headers=ADMIN)).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("deployment_status", ["ACTIVE", "SUSPENDED", "PENDING"])
async def test_a_live_deployment_blocks_even_an_admin(client: AsyncClient, db, deployment_status: str) -> None:
    service, version = await _service(db, status_value="APPROVED")
    await _deploy(db, service, version, status_value=deployment_status, slug="hr-bot")

    res = await _delete(client, service.id, ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SERVICE_IN_USE"
    message = res.json()["error"]["message"]
    assert "hr-bot" in message and "게시를 종료" in message
    assert (await client.get(f"/api/v1/services/{service.id}", headers=ADMIN)).status_code == 200


@pytest.mark.asyncio
async def test_a_retired_deployment_is_removed_with_the_service_and_frees_its_slug(client: AsyncClient, db) -> None:
    service, version = await _service(db, status_value="APPROVED")
    deployment = await _deploy(db, service, version, status_value="RETIRED", slug="old-bot")
    service_id, deployment_id = service.id, deployment.id

    res = await _delete(client, service_id, ADMIN)
    assert res.status_code == 200, res.text
    assert res.json()["removed_deployments"] == 1

    db.expire_all()
    assert (await db.execute(select(func.count()).select_from(ServiceDeployment).where(
        ServiceDeployment.id == deployment_id))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(DeploymentRevision).where(
        DeploymentRevision.deployment_id == deployment_id))).scalar_one() == 0
    # 슬러그가 비었으니 같은 이름으로 다시 게시할 수 있다.
    other, other_version = await _service(db, status_value="APPROVED", name="새 서비스")
    await _deploy(db, other, other_version, status_value="ACTIVE", slug="old-bot")


@pytest.mark.asyncio
async def test_a_distribution_request_blocks_deletion(client: AsyncClient, db) -> None:
    service, version = await _service(db, status_value="APPROVED")
    db.add(DistributionRequest(
        root_type="SERVICE_VERSION", root_id=version.id, mode="OFFLINE",
        requested_by="dev-user@miracom.com", status="QUEUED",
    ))
    await db.commit()

    res = await _delete(client, service.id, ADMIN)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SERVICE_IN_USE"
    assert "반출" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_a_non_owner_cannot_delete_even_a_draft(client: AsyncClient, db) -> None:
    service, _ = await _service(db, owner="someone-else@miracom.com")
    res = await _delete(client, service.id, CREATOR)
    assert res.status_code == 403
    assert (await client.get(f"/api/v1/services/{service.id}", headers=ADMIN)).status_code == 200


@pytest.mark.asyncio
async def test_reviewer_and_auditor_roles_cannot_delete(client: AsyncClient, db) -> None:
    service, _ = await _service(db, status_value="APPROVED")
    for token in ("dev-reviewer-token", "dev-security-token", "dev-release-token", "dev-auditor-token"):
        res = await _delete(client, service.id, auth_header(token))
        assert res.status_code in (403, 409), (token, res.status_code)
    assert (await client.get(f"/api/v1/services/{service.id}", headers=ADMIN)).status_code == 200


@pytest.mark.asyncio
async def test_deletion_removes_review_records_but_keeps_the_audit_trail(client: AsyncClient, db) -> None:
    service, version = await _service(db, status_value="APPROVED")
    review = ReviewRequest(
        subject_type="SERVICE_VERSION", subject_id=version.id, stage="TECHNICAL",
        status="APPROVED", requested_by="dev-user@miracom.com",
    )
    db.add(review)
    await db.flush()
    db.add(ReviewDecision(
        review_id=review.id, decision="APPROVE", reviewer_id="reviewer@miracom.com", comments="ok",
    ))
    db.add(AuditEvent(
        event_type="REVIEW_DECIDED", actor_id="reviewer@miracom.com", resource_type="SERVICE_VERSION",
        resource_id=version.id, result="SUCCESS",
    ))
    await db.commit()
    service_id, version_id = service.id, version.id

    res = await _delete(client, service_id, ADMIN)
    assert res.status_code == 200, res.text

    db.expire_all()
    assert (await db.execute(select(func.count()).select_from(ReviewRequest).where(
        ReviewRequest.subject_id == version_id))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(ReviewDecision))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(AuditEvent).where(
        AuditEvent.event_type == "REVIEW_DECIDED", AuditEvent.resource_id == version_id))).scalar_one() == 1
    deleted = (await db.execute(select(AuditEvent).where(
        AuditEvent.event_type == "SERVICE_DELETED", AuditEvent.resource_id == service_id,
        AuditEvent.result == "SUCCESS"))).scalars().all()
    assert len(deleted) == 1
    meta = deleted[0].metadata_
    assert meta["admin_override"] is True and meta["version_statuses"] == ["APPROVED"]
    assert meta["reason"] == REASON["reason"]


@pytest.mark.asyncio
async def test_unknown_service_is_404(client: AsyncClient, db) -> None:
    res = await _delete(client, "00000000-0000-4000-8000-000000000000", ADMIN)
    assert res.status_code == 404
