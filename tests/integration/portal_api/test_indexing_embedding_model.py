"""Integration tests for the P15 인덱싱 임베딩 모델 설정 — the one editable
sub-area of the otherwise-read-only P15 관리자 설정 screen
(open-decisions.md D-065 UPDATE / D-075):

- `GET /api/v1/admin/settings`'s new `indexing_embedding_model` section
- `GET /api/v1/admin/embedding-models` (`routers/admin.py::list_embedding_models`)
- `PUT /api/v1/admin/indexing-embedding-model`
  (`routers/admin.py::set_indexing_embedding_model`)
- `routers/assets.py::_trigger_indexing` actually forwarding the configured
  model to indexing-runtime (and omitting the field when unset)

Both `routers.admin.get_embedding_models_caller` and
`routers.assets.get_indexing_caller`/`get_indexing_session_factory` are
FastAPI dependency seams (mirroring `routers.distributions
.get_distribution_caller`/`get_session_factory` exactly) — this suite never
needs a real indexing-runtime process or Ollama listening anywhere, and
`_trigger_indexing`'s own DB writes go through the isolated in-memory
`session_factory` fixture, never the real `portal.db`.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from portal_api.main import app
from portal_api.models import AuditEvent, PlatformSetting
from portal_api.platform_settings import INDEXING_EMBED_MODEL_KEY
from portal_api.routers.admin import get_embedding_models_caller
from portal_api.routers.assets import (
    _trigger_indexing,
    get_indexing_caller,
    get_indexing_session_factory,
)
from security_policy import Role
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

SETTINGS_URL = "/api/v1/admin/settings"
MODELS_URL = "/api/v1/admin/embedding-models"
UPDATE_URL = "/api/v1/admin/indexing-embedding-model"

pytestmark = pytest.mark.asyncio

NON_ADMIN_TOKENS = [
    ("dev-user-token", Role.CREATOR),
    ("dev-reviewer-token", Role.TECH_REVIEWER),
    ("dev-security-token", Role.SECURITY_REVIEWER),
    ("dev-release-token", Role.RELEASE_MANAGER),
    ("dev-auditor-token", Role.AUDITOR),
]

_FAKE_MODELS = [
    {"name": "qwen3-embedding:0.6b", "embedding_capable": True, "size": 100, "modified_at": None},
    {"name": "exaone3.5:7.8b", "embedding_capable": False, "size": 200, "modified_at": None},
]


@pytest.fixture
def fake_models_available():
    """Overrides `get_embedding_models_caller` with a canned "Ollama has
    these two models" response — no real indexing-runtime/Ollama needed."""

    async def _fake_caller():
        return list(_FAKE_MODELS), "qwen3-embedding:0.6b", None

    app.dependency_overrides[get_embedding_models_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_embedding_models_caller, None)


@pytest.fixture
def fake_models_unreachable():
    """Deterministically exercises the MODEL_UNAVAILABLE path — same shape
    `_call_indexing_runtime_models_http` returns on a real connection
    failure, without depending on whether anything is listening on :8200."""

    async def _fake_caller():
        return [], None, "indexing-runtime(http://localhost:8200)에 연결할 수 없습니다"

    app.dependency_overrides[get_embedding_models_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_embedding_models_caller, None)


# --- GET /api/v1/admin/settings — new section -------------------------------


async def test_admin_settings_reports_unset_indexing_embedding_model(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get(SETTINGS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 200
    section = resp.json()["indexing_embedding_model"]

    assert section["status"] == "AVAILABLE"
    assert section["configured_model"] is None
    assert section["updated_at"] is None
    assert "index-meta.json" in section["note"]  # re-index warning present


async def test_admin_settings_reports_configured_indexing_embedding_model(
    client: httpx.AsyncClient, db
) -> None:
    db.add(
        PlatformSetting(
            key=INDEXING_EMBED_MODEL_KEY,
            value="qwen3-embedding:0.6b",
            updated_by_user_id="admin@miracom.com",
            trace_id="t-1",
        )
    )
    await db.commit()

    resp = await client.get(SETTINGS_URL, headers=auth_header("dev-admin-token"))
    section = resp.json()["indexing_embedding_model"]
    assert section["configured_model"] == "qwen3-embedding:0.6b"
    assert section["updated_by"] == "admin@miracom.com"
    assert section["updated_at"] is not None


# --- GET /api/v1/admin/embedding-models -------------------------------------


async def test_list_embedding_models_happy_path(
    client: httpx.AsyncClient, fake_models_available
) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 200
    body = resp.json()

    assert body["default_embed_model"] == "qwen3-embedding:0.6b"
    assert body["trace_id"]
    by_name = {m["name"]: m for m in body["models"]}
    assert by_name["qwen3-embedding:0.6b"]["embedding_capable"] is True
    assert by_name["exaone3.5:7.8b"]["embedding_capable"] is False


async def test_list_embedding_models_ollama_unreachable_returns_503(
    client: httpx.AsyncClient, fake_models_unreachable
) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
    # Never a silently-empty models list disguised as a normal response.
    assert "models" not in body


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_list_embedding_models_non_admin_denied_and_audited(
    client: httpx.AsyncClient, db, fake_models_available, token: str, role: Role
) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header(token))
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "PERMISSION_DENIED:ADMIN_SETTINGS_READ"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].result == "DENIED"
    assert rows[0].metadata_["role"] == role.value


# --- PUT /api/v1/admin/indexing-embedding-model -----------------------------


async def test_set_indexing_embedding_model_happy_path(
    client: httpx.AsyncClient, db, fake_models_available
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "qwen3-embedding:0.6b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["configured_model"] == "qwen3-embedding:0.6b"

    row = (
        await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == INDEXING_EMBED_MODEL_KEY)
        )
    ).scalar_one()
    assert row.value == "qwen3-embedding:0.6b"

    audit_rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "INDEXING_EMBEDDING_MODEL_UPDATED"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].result == "SUCCESS"
    assert audit_rows[0].metadata_["new_model"] == "qwen3-embedding:0.6b"
    assert audit_rows[0].metadata_["previous_model"] is None


async def test_set_indexing_embedding_model_rejects_unavailable_model(
    client: httpx.AsyncClient, db, fake_models_available
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "not-installed-model:1b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert "not-installed-model:1b" in body["error"]["details"]["requested_model"]
    assert "qwen3-embedding:0.6b" in body["error"]["details"]["available_embedding_models"]
    # exaone3.5:7.8b is installed but not embedding_capable — must not be
    # offered as usable either.
    assert "exaone3.5:7.8b" not in body["error"]["details"]["available_embedding_models"]

    # Nothing was persisted.
    row = (
        await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == INDEXING_EMBED_MODEL_KEY)
        )
    ).scalar_one_or_none()
    assert row is None

    audit_rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "INDEXING_EMBEDDING_MODEL_UPDATE_REJECTED"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].result == "FAILED"


async def test_set_indexing_embedding_model_unreachable_returns_503_and_persists_nothing(
    client: httpx.AsyncClient, db, fake_models_unreachable
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "qwen3-embedding:0.6b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "MODEL_UNAVAILABLE"

    row = (
        await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == INDEXING_EMBED_MODEL_KEY)
        )
    ).scalar_one_or_none()
    assert row is None


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_set_indexing_embedding_model_non_admin_denied_and_audited(
    client: httpx.AsyncClient, db, fake_models_available, token: str, role: Role
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "qwen3-embedding:0.6b"},
        headers=auth_header(token),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "PERMISSION_DENIED:ADMIN_SETTINGS_WRITE"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].result == "DENIED"
    assert rows[0].metadata_["role"] == role.value

    row = (
        await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == INDEXING_EMBED_MODEL_KEY)
        )
    ).scalar_one_or_none()
    assert row is None


async def test_set_indexing_embedding_model_requires_non_empty_model(
    client: httpx.AsyncClient, fake_models_available
) -> None:
    resp = await client.put(
        UPDATE_URL, json={"model": "   "}, headers=auth_header("dev-admin-token")
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- _trigger_indexing actually forwards the configured model --------------


async def test_trigger_indexing_sends_configured_embed_model(session_factory, db) -> None:
    from portal_api.models import Asset, AssetVersion, IndexingJob

    asset = Asset(
        type="knowledge",
        name="embed-model-fixture",
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
        manifest={"type": "knowledge"},
    )
    db.add(version)
    await db.flush()
    job = IndexingJob(asset_version_id=version.id, status="PENDING")
    db.add(job)
    await db.commit()

    captured: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        captured.append(payload)
        return {"status": "COMPLETED", "chunk_count": 3, "index_path": "/tmp/idx"}

    await _trigger_indexing(
        job.id,
        version.id,
        "/tmp/storage",
        "trace-1",
        "INTERNAL",
        "qwen3-embedding:0.6b",
        _fake_caller,
        session_factory,
    )

    assert len(captured) == 1
    assert captured[0]["embed_model"] == "qwen3-embedding:0.6b"

    await db.refresh(job)
    assert job.status == "COMPLETED"
    assert job.chunk_count == 3


async def test_trigger_indexing_omits_embed_model_when_unset(session_factory, db) -> None:
    """No admin override configured (`embed_model=None`) must NOT send an
    explicit JSON `null` — indexing-runtime's own IndexJobRequest.embed_model
    is a non-Optional `str` field with its own default; sending `null` would
    fail validation instead of falling through to it."""
    from portal_api.models import Asset, AssetVersion, IndexingJob

    asset = Asset(
        type="knowledge",
        name="embed-model-fixture-2",
        owner_org="miracom",
        owner_creator_id="dev-user@miracom.com",
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()
    version = AssetVersion(
        asset_id=asset.id, version="1.0.0", status="DRAFT", manifest={"type": "knowledge"}
    )
    db.add(version)
    await db.flush()
    job = IndexingJob(asset_version_id=version.id, status="PENDING")
    db.add(job)
    await db.commit()

    captured: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        captured.append(payload)
        return {"status": "COMPLETED"}

    await _trigger_indexing(
        job.id, version.id, "/tmp/storage", "trace-2", None, None, _fake_caller, session_factory
    )

    assert len(captured) == 1
    assert "embed_model" not in captured[0]


async def test_trigger_indexing_forwards_version_profile_snapshot(session_factory, db) -> None:
    from portal_api.models import Asset, AssetVersion, IndexingJob

    asset = Asset(
        type="knowledge",
        name="profile-fixture",
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
        manifest={"type": "knowledge"},
    )
    db.add(version)
    await db.flush()
    job = IndexingJob(asset_version_id=version.id, status="PENDING")
    db.add(job)
    await db.commit()
    captured: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        captured.append(payload)
        return {"status": "COMPLETED"}

    profile = {
        "chunking_strategy": "markdown",
        "chunk_size": 768,
        "chunk_overlap": 80,
        "parent_chunk_size": 2048,
        "minimum_size": 80,
        "language": "ko",
    }
    await _trigger_indexing(
        job.id,
        version.id,
        "/tmp/storage",
        "trace-profile",
        "INTERNAL",
        None,
        _fake_caller,
        session_factory,
        profile,
    )
    assert captured[0]["profile"] == profile


# --- End-to-end via POST /api/v1/assets: configured setting actually reaches
# the indexing-runtime call the background task makes. -----------------------


@pytest.fixture(autouse=True)
def override_indexing_seams(session_factory):
    """`_trigger_indexing` opens its own DB session after the request's
    `Depends(get_db)` session has already closed — point both seams at this
    test's isolated in-memory engine/a fake caller, mirroring
    `test_distributions.py`'s `override_session_factory`."""
    captured: list[dict] = []

    async def _fake_caller(payload: dict) -> dict:
        captured.append(payload)
        return {"status": "COMPLETED", "chunk_count": 1, "index_path": "/tmp/idx"}

    app.dependency_overrides[get_indexing_caller] = lambda: _fake_caller
    app.dependency_overrides[get_indexing_session_factory] = lambda: session_factory
    yield captured
    app.dependency_overrides.pop(get_indexing_caller, None)
    app.dependency_overrides.pop(get_indexing_session_factory, None)


def _knowledge_manifest(**overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "knowledge",
        "name": "테스트 Knowledge (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "team": "hr", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_indexing_embedding_model.py fixture",
        "tags": ["test"],
        "source": {
            "type": "portal_upload",
            "documents": [
                {
                    "path": "documents/doc.md",
                    "mime_type": "text/markdown",
                    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "language": "ko",
                }
            ],
        },
        "indexing_profile_ref": {"name": "default-korean-parent-child", "version": "1.0.0"},
        "access_control": {"allowed_orgs": ["miracom"], "allowed_roles": ["USER", "CREATOR"]},
    }
    manifest.update(overrides)
    return manifest


async def test_asset_upload_forwards_configured_embed_model_to_indexing_job(
    client: httpx.AsyncClient, db, override_indexing_seams
) -> None:
    db.add(
        PlatformSetting(
            key=INDEXING_EMBED_MODEL_KEY,
            value="custom-embed:1b",
            updated_by_user_id="admin@miracom.com",
            trace_id="t-x",
        )
    )
    await db.commit()

    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_knowledge_manifest(), ensure_ascii=False)},
        files={"files": ("doc.md", "# 제목\n\n본문 내용입니다.".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    captured = override_indexing_seams
    assert len(captured) == 1
    assert captured[0]["embed_model"] == "custom-embed:1b"


async def test_asset_upload_omits_embed_model_when_unset(
    client: httpx.AsyncClient, override_indexing_seams
) -> None:
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_knowledge_manifest(), ensure_ascii=False)},
        files={"files": ("doc.md", "# 제목\n\n본문 내용입니다.".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    captured = override_indexing_seams
    assert len(captured) == 1
    assert "embed_model" not in captured[0]
