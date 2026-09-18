"""Integration tests for `POST /api/v1/assets/{asset_id}/knowledge-versions`
(`routers/assets.py::create_knowledge_version`) — 지식 자산의 새 버전을 만들고
색인을 다시 거는 유일한 경로.

왜 별도 엔드포인트인가는 그 함수의 docstring에 있다. 이 suite가 고정하려는
것은 **두 가지 서로 다른 의도가 서로로 둔갑하지 않는다**는 것이다:

- `documents_source=UPLOAD` — 새 문서를 올려 다시 색인한다.
- `documents_source=REUSE_PREVIOUS` — 문서는 그대로, 색인/검색 전략만 바꾼다.

특히 `test_upload_mode_rejects_empty_file_list`는 "업로드가 통째로 빠진 요청이
조용히 이전 문서 복사로 둔갑하지 않는다"를 지킨다 — 그 경우 등록자는 새 문서가
색인된 줄 알고 넘어가게 된다.

`settings.storage_root`는 테스트마다 격리되지 않으므로(conftest.py 참고,
`test_asset_upload_limits.py`와 같은 이유·같은 관례) 모든 자산은 새 `uuid4()`
id를 쓰고 실제 on-disk 경로를 `create_knowledge_version`과 같은 방식으로
계산해 확인한다.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
import pytest
from portal_api.config import settings
from portal_api.main import app
from portal_api.models import Asset, AssetVersion, AuditEvent
from portal_api.routers.assets import get_indexing_caller, get_indexing_session_factory
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

pytestmark = pytest.mark.asyncio

PARENT_CHILD_PROFILE = {
    "chunking_strategy": "parent_child",
    "chunk_size": 512,
    "chunk_overlap": 64,
    "parent_chunk_size": 2048,
    "minimum_size": 64,
    "language": "ko",
}
MARKDOWN_PROFILE = {
    "chunking_strategy": "markdown",
    "chunk_size": 800,
    "chunk_overlap": 80,
    "minimum_size": 64,
    "language": "ko",
}


@pytest.fixture(autouse=True)
def override_indexing_seams(session_factory):
    """`_trigger_indexing`의 두 DI seam을 이 테스트의 격리 엔진/가짜 호출자로
    바꾼다 — 실제 indexing-runtime 프로세스 없이 "무엇이 색인 요청으로
    나갔는가"를 그대로 관찰한다(`test_indexing_embedding_model.py`와 동일)."""
    captured: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        captured.append(payload)
        return {"status": "COMPLETED", "chunk_count": 3, "index_path": "/tmp/idx"}

    app.dependency_overrides[get_indexing_caller] = lambda: _fake_caller
    app.dependency_overrides[get_indexing_session_factory] = lambda: session_factory
    yield captured
    app.dependency_overrides.pop(get_indexing_caller, None)
    app.dependency_overrides.pop(get_indexing_session_factory, None)


def _knowledge_manifest(asset_id: str, **overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": asset_id,
        "type": "knowledge",
        "name": "재색인 테스트 Knowledge (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "team": "hr", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_knowledge_version_reindex.py fixture",
        "tags": ["test"],
        "source": {
            "type": "portal_upload",
            "documents": [
                {
                    "path": "documents/policy.md",
                    "mime_type": "text/markdown",
                    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "language": "ko",
                }
            ],
        },
        "indexing_profile_ref": {"name": "balanced-parent-child", "version": "1.0.0"},
        "indexing_profile": PARENT_CHILD_PROFILE,
        "access_control": {"allowed_orgs": ["miracom"], "allowed_roles": ["USER", "CREATOR"]},
    }
    manifest.update(overrides)
    return manifest


async def _register_knowledge(client: httpx.AsyncClient, asset_id: str) -> dict:
    """기존 등록 경로로 v1.0.0을 만든다 — 새 버전 엔드포인트의 출발점."""
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_knowledge_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("policy.md", "# 정책\n\n기존 본문입니다.".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _url(asset_id: str) -> str:
    return f"/api/v1/assets/{asset_id}/knowledge-versions"


async def test_upload_mode_creates_draft_version_and_reindexes(
    client: httpx.AsyncClient, override_indexing_seams
) -> None:
    asset_id = str(uuid.uuid4())
    first = await _register_knowledge(client, asset_id)
    override_indexing_seams.clear()

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "UPLOAD", "changelog": "문서 교체"},
        files={"files": ("policy.md", "# 정책\n\n개정된 본문입니다.".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version"] == "1.1.0"
    assert body["status"] == "DRAFT"
    assert body["id"] != first["id"]

    # 새 파일이 새 디렉터리에 저장되고, 그 경로가 색인 요청으로 나갔다.
    new_dir = (settings.storage_root / "knowledge" / asset_id / body["id"]).resolve()
    assert (new_dir / "policy.md").read_text(encoding="utf-8").endswith("개정된 본문입니다.")
    assert len(override_indexing_seams) == 1
    assert override_indexing_seams[0]["storage_path"] == str(new_dir)
    assert override_indexing_seams[0]["version_id"] == body["id"]


async def test_upload_mode_records_real_checksums_in_manifest(
    client: httpx.AsyncClient, db
) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "UPLOAD"},
        files={"files": ("new-policy.md", "# 새 문서".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == resp.json()["id"]))
    ).scalar_one()
    documents = version.manifest["source"]["documents"]
    assert [d["path"] for d in documents] == ["documents/new-policy.md"]
    # 0으로 채운 자리표시자가 아니라 실제로 저장하며 계산한 해시여야 한다.
    assert documents[0]["sha256"] != "0" * 64
    assert documents[0]["mime_type"] == "text/markdown"


async def test_reuse_previous_reindexes_with_new_profile_without_reuploading(
    client: httpx.AsyncClient, db, override_indexing_seams
) -> None:
    """파일 갱신 없이 색인 전략만 바꾸는 경로 — 이 엔드포인트의 존재 이유 중 하나."""
    asset_id = str(uuid.uuid4())
    first = await _register_knowledge(client, asset_id)
    override_indexing_seams.clear()

    resp = await client.post(
        _url(asset_id),
        data={
            "version": "1.0.1",
            "documents_source": "REUSE_PREVIOUS",
            "indexing_profile": json.dumps(MARKDOWN_PROFILE),
            "indexing_profile_ref": json.dumps({"name": "markdown-headers", "version": "1.0.0"}),
            "changelog": "청킹 전략만 변경",
        },
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()

    # 이전 문서가 새 버전 디렉터리에 그대로 있다.
    new_dir = (settings.storage_root / "knowledge" / asset_id / body["id"]).resolve()
    assert (new_dir / "policy.md").read_text(encoding="utf-8").endswith("기존 본문입니다.")

    # 새 전략이 Manifest에 박히고, 그 값 그대로 색인 요청에 실려 나갔다 —
    # 전략을 바꿔 놓고 예전 전략으로 다시 색인하면 화면만 바뀐 셈이 된다.
    version = (await db.execute(select(AssetVersion).where(AssetVersion.id == body["id"]))).scalar_one()
    assert version.manifest["indexing_profile"] == MARKDOWN_PROFILE
    assert version.manifest["indexing_profile_ref"]["name"] == "markdown-headers"
    assert len(override_indexing_seams) == 1
    assert override_indexing_seams[0]["profile"] == MARKDOWN_PROFILE

    # 문서는 바뀌지 않았으므로 Manifest의 문서 목록도 그대로다.
    source_version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == first["id"]))
    ).scalar_one()
    assert version.manifest["source"] == source_version.manifest["source"]


async def test_source_version_is_never_modified_in_place(
    client: httpx.AsyncClient, db
) -> None:
    asset_id = str(uuid.uuid4())
    first = await _register_knowledge(client, asset_id)
    before = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == first["id"]))
    ).scalar_one()
    before_hash, before_storage = before.manifest_hash, before.storage_path

    resp = await client.post(
        _url(asset_id),
        data={
            "version": "2.0.0",
            "documents_source": "REUSE_PREVIOUS",
            "indexing_profile": json.dumps(MARKDOWN_PROFILE),
        },
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    await db.refresh(before)
    assert before.manifest_hash == before_hash
    assert before.storage_path == before_storage
    assert before.manifest["indexing_profile"] == PARENT_CHILD_PROFILE
    assert Path(before_storage or "").exists()


async def test_upload_mode_rejects_empty_file_list(client: httpx.AsyncClient) -> None:
    """빈 업로드를 "이전 문서 재사용"으로 해석하지 않는다.

    해석해 버리면 파일 선택이 빠진 요청이 201로 끝나고, 등록자는 새 문서가
    색인된 줄 안다 — 화면에는 새 버전이 보이므로 끝까지 드러나지 않는다.
    """
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "UPLOAD"},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "REUSE_PREVIOUS" in resp.json()["error"]["message"]


async def test_reuse_previous_rejects_uploaded_files(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        files={"files": ("policy.md", "# 새 문서".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_unknown_documents_source_is_rejected(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "MAYBE"},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("bad_version", ["1.0.0", "0.9.9", "not-a-version"])
async def test_version_must_be_greater_than_every_existing_version(
    client: httpx.AsyncClient, bad_version: str
) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={
            "version": bad_version,
            "documents_source": "REUSE_PREVIOUS",
        },
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_invalid_profile_json_is_rejected(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={
            "version": "1.1.0",
            "documents_source": "REUSE_PREVIOUS",
            "indexing_profile": "{not json",
        },
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_profile_violating_schema_is_rejected_and_leaves_no_storage(
    client: httpx.AsyncClient, db
) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)
    before = len((await db.execute(select(AssetVersion))).scalars().all())

    resp = await client.post(
        _url(asset_id),
        data={
            "version": "1.1.0",
            "documents_source": "REUSE_PREVIOUS",
            # chunking_strategy 가 스키마의 enum 밖이다.
            "indexing_profile": json.dumps({**PARENT_CHILD_PROFILE, "chunking_strategy": "nope"}),
        },
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    after = len((await db.execute(select(AssetVersion))).scalars().all())
    assert after == before
    # 복사해 둔 디렉터리를 남기지 않는다(다음 시도의 같은 경로와 충돌한다).
    asset_dir = settings.storage_root / "knowledge" / asset_id
    assert len([p for p in asset_dir.iterdir() if p.is_dir()]) == 1


async def test_non_owner_creator_is_denied_and_audited(
    client: httpx.AsyncClient, db
) -> None:
    asset_id = str(uuid.uuid4())
    other_owner = Asset(
        id=asset_id,
        type="knowledge",
        name="남의 지식 자산",
        owner_org="miracom",
        owner_creator_id="someone-else@miracom.com",
        classification="INTERNAL",
    )
    db.add(other_owner)
    db.add(
        AssetVersion(
            id=str(uuid.uuid4()),
            asset_id=asset_id,
            version="1.0.0",
            status="APPROVED",
            manifest=_knowledge_manifest(asset_id),
            manifest_hash="x" * 64,
        )
    )
    await db.commit()

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"
    events = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "KNOWLEDGE_VERSION_CREATE_DENIED")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    assert events[0].result == "DENIED"


async def test_role_without_asset_create_is_denied(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-reviewer-token"),
    )

    assert resp.status_code == 403, resp.text


async def test_non_knowledge_asset_is_rejected(client: httpx.AsyncClient, db) -> None:
    asset_id = str(uuid.uuid4())
    db.add(
        Asset(
            id=asset_id,
            type="prompt",
            name="프롬프트 자산",
            owner_org="miracom",
            owner_creator_id="dev-user@miracom.com",
            classification="INTERNAL",
        )
    )
    db.add(
        AssetVersion(
            id=str(uuid.uuid4()),
            asset_id=asset_id,
            version="1.0.0",
            status="APPROVED",
            manifest={"type": "prompt"},
            manifest_hash="y" * 64,
        )
    )
    await db.commit()

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_unknown_asset_is_not_found(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        _url(str(uuid.uuid4())),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 404, resp.text


async def test_reuse_previous_without_stored_documents_is_rejected(
    client: httpx.AsyncClient, db
) -> None:
    """DB에는 버전이 있는데 디스크에 문서가 없는 경우 — 복사할 것이 없다."""
    asset_id = str(uuid.uuid4())
    db.add(
        Asset(
            id=asset_id,
            type="knowledge",
            name="문서 없는 지식 자산",
            owner_org="miracom",
            owner_creator_id="dev-user@miracom.com",
            classification="INTERNAL",
        )
    )
    db.add(
        AssetVersion(
            id=str(uuid.uuid4()),
            asset_id=asset_id,
            version="1.0.0",
            status="APPROVED",
            manifest=_knowledge_manifest(asset_id),
            manifest_hash="z" * 64,
            storage_path=None,
        )
    )
    await db.commit()

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"


async def test_audit_event_records_how_the_version_was_made(
    client: httpx.AsyncClient, db
) -> None:
    asset_id = str(uuid.uuid4())
    await _register_knowledge(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "documents_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    event = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.resource_id == resp.json()["id"])
            )
        )
        .scalars()
        .one()
    )
    assert event.metadata_["documents_source"] == "REUSE_PREVIOUS"
    assert event.metadata_["reindexed"] is True
