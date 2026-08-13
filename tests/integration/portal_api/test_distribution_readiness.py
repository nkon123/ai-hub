"""Integration tests for M02's D-079 반출 준비 상태 점검
(`GET /api/v1/assets/{asset_id}/versions/{version_id}/distribution-readiness`).

Covers: normal (every check PASS, ready=true), each FAIL condition on its
own axis (missing index job, missing index dir, knowledge_id mismatch,
legacy-pickle-only BM25, missing BM25, missing chroma), the two WARN-only
checks (embed_model/classification not recorded — never block `ready`),
non-knowledge asset (400), asset/version not found (404), and authentication
(no role lacks ASSET_READ, same as `routers/knowledge_search.py` — see that
router's test suite for the same precedent, so there is no role-based 403
case here by design).

No real search-runtime process is involved — this endpoint never calls out
to it (portal-api predicts the D-079 registration outcome from its own
Registry + filesystem state only, per CLAUDE.md 구현 원칙 2).
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from portal_api.config import settings
from portal_api.models import Asset, AssetVersion, IndexingJob
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tests.integration.portal_api.conftest import auth_header


@pytest.fixture(autouse=True)
def _isolated_index_base(tmp_path, monkeypatch):
    """`resolve_knowledge_index_dir`'s legacy fallback candidate
    (`index_base/hr-policy-v1`) is a real directory in *this* checked-out
    repo (`data/indexes/hr-policy-v1/`) — without this, a test asserting
    "index dir not found" would silently pass by matching that real fixture
    instead of the deliberately-missing path it set up. Isolates every test
    in this module from `settings.index_base`'s real default."""
    monkeypatch.setattr(settings, "index_base", tmp_path / "_unused_index_base")


async def _make_knowledge_version(
    db: AsyncSession,
    *,
    job_status: str | None = "COMPLETED",
    index_path: str | None = None,
) -> AssetVersion:
    asset = Asset(
        type="knowledge",
        name="dist-readiness-knowledge",
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
        manifest={"type": "knowledge", "name": asset.name},
    )
    db.add(version)
    await db.flush()

    if job_status is not None:
        job = IndexingJob(
            asset_version_id=version.id,
            status=job_status,
            chunk_count=4,
            index_path=index_path,
        )
        db.add(job)

    await db.commit()
    await db.refresh(version)
    return version


def _write_index_dir(
    base: Path,
    *,
    knowledge_id: str,
    meta_extra: dict | None = None,
    bm25: str | None = "json",
    chroma: bool = True,
    omit_meta: bool = False,
) -> Path:
    """Builds a real on-disk index directory matching search-runtime's
    `local_index_registry` layout — the same artifacts D-079 registration
    checks for."""
    d = base / "index"
    d.mkdir(parents=True, exist_ok=True)
    if not omit_meta:
        meta = {
            "knowledge_id": knowledge_id,
            "embed_model": "qwen3-embedding:0.6b",
            "classification": "INTERNAL",
        }
        if meta_extra:
            meta.update(meta_extra)
        (d / "index-meta.json").write_text(json.dumps(meta), encoding="utf-8")
    if bm25 == "json":
        (d / "bm25.json").write_text("{}", encoding="utf-8")
    elif bm25 == "pkl":
        (d / "bm25.pkl").write_bytes(b"fake-pickle-bytes")
    if chroma:
        (d / "chroma").mkdir()
    return d


def _check(body: dict, check_id: str) -> dict:
    match = next(c for c in body["checks"] if c["id"] == check_id)
    return match


# --- Normal: everything present and correct ---


async def test_distribution_readiness_ready_true_when_all_checks_pass(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    asset = Asset(
        type="knowledge", name="ready-knowledge", owner_org="miracom",
        owner_creator_id="dev-user@miracom.com", classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()
    version = AssetVersion(
        asset_id=asset.id, version="1.0.0", status="DRAFT",
        manifest={"type": "knowledge", "name": asset.name},
    )
    db.add(version)
    await db.flush()
    index_dir = _write_index_dir(tmp_path, knowledge_id=version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{asset.id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version_id"] == version.id
    assert body["ready"] is True
    assert {c["id"] for c in body["checks"]} == {
        "INDEXING_COMPLETED", "INDEX_DIR_FOUND", "INDEX_META_KNOWLEDGE_ID",
        "BM25_FORMAT", "CHROMA_PRESENT", "EMBED_MODEL_RECORDED", "CLASSIFICATION_STAMPED",
    }
    for check in body["checks"]:
        assert check["status"] == "PASS", check
        assert check["activation_reason"] is None


# --- FAIL axes ---


async def test_distribution_readiness_no_indexing_job_fails_and_cascades(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db, job_status=None)

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    assert _check(body, "INDEXING_COMPLETED")["status"] == "FAIL"
    assert _check(body, "INDEXING_COMPLETED")["activation_reason"] is None
    dir_found = _check(body, "INDEX_DIR_FOUND")
    assert dir_found["status"] == "FAIL"
    assert dir_found["activation_reason"] == "index_meta_missing"
    # Cascade: downstream checks cannot be verified, never fabricated PASS/FAIL.
    for check_id in (
        "INDEX_META_KNOWLEDGE_ID", "BM25_FORMAT", "CHROMA_PRESENT",
        "EMBED_MODEL_RECORDED", "CLASSIFICATION_STAMPED",
    ):
        check = _check(body, check_id)
        assert check["status"] == "WARN"
        assert check["activation_reason"] is None


async def test_distribution_readiness_job_not_completed_fails(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db, job_status="RUNNING")

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    assert _check(body, "INDEXING_COMPLETED")["status"] == "FAIL"
    assert "RUNNING" in _check(body, "INDEXING_COMPLETED")["message"]


async def test_distribution_readiness_index_dir_missing_from_disk(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    # job.index_path points somewhere with nothing on disk.
    version = await _make_knowledge_version(
        db, index_path=str(tmp_path / "does-not-exist")
    )

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    assert _check(body, "INDEXING_COMPLETED")["status"] == "PASS"
    dir_found = _check(body, "INDEX_DIR_FOUND")
    assert dir_found["status"] == "FAIL"
    assert dir_found["activation_reason"] == "index_meta_missing"


async def test_distribution_readiness_knowledge_id_mismatch(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(
        tmp_path, knowledge_id="00000000-0000-0000-0000-000000000000",
    )
    # Point the job at this dir (job was created in _make_knowledge_version
    # with index_path=None — patch it now that the dir exists).
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    mismatch = _check(body, "INDEX_META_KNOWLEDGE_ID")
    assert mismatch["status"] == "FAIL"
    assert mismatch["activation_reason"] == "index_meta_knowledge_id_mismatch"


async def test_distribution_readiness_bm25_legacy_pickle_only(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(tmp_path, knowledge_id=version.id, bm25="pkl")
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    bm25_check = _check(body, "BM25_FORMAT")
    assert bm25_check["status"] == "FAIL"
    assert bm25_check["activation_reason"] == "bm25_legacy_pickle_only"
    assert "convert-bm25-format" in bm25_check["remedy"]
    assert str(index_dir) in bm25_check["remedy"]


async def test_distribution_readiness_bm25_missing(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(tmp_path, knowledge_id=version.id, bm25=None)
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    body = resp.json()
    bm25_check = _check(body, "BM25_FORMAT")
    assert bm25_check["status"] == "FAIL"
    assert bm25_check["activation_reason"] == "bm25_missing"


async def test_distribution_readiness_chroma_missing(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(tmp_path, knowledge_id=version.id, chroma=False)
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    body = resp.json()
    chroma_check = _check(body, "CHROMA_PRESENT")
    assert chroma_check["status"] == "FAIL"
    assert chroma_check["activation_reason"] == "chroma_missing"


# --- WARN-only checks never block ready ---


async def test_distribution_readiness_missing_embed_model_is_warn_not_fail(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(
        tmp_path, knowledge_id=version.id,
        meta_extra={"embed_model": None, "classification": "INTERNAL"},
    )
    # embed_model=None would serialize as JSON null; rewrite meta without the key.
    meta_path = index_dir / "index-meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.pop("embed_model", None)
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    body = resp.json()
    assert body["ready"] is True  # WARN never blocks readiness
    embed_check = _check(body, "EMBED_MODEL_RECORDED")
    assert embed_check["status"] == "WARN"
    assert embed_check["activation_reason"] is None


async def test_distribution_readiness_missing_classification_is_warn_with_remedy(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path: Path
) -> None:
    version = await _make_knowledge_version(db, index_path=None)
    index_dir = _write_index_dir(tmp_path, knowledge_id=version.id)
    meta_path = index_dir / "index-meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.pop("classification", None)
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    job = (
        await db.execute(
            select(IndexingJob).where(IndexingJob.asset_version_id == version.id)
        )
    ).scalar_one()
    job.index_path = str(index_dir)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    body = resp.json()
    assert body["ready"] is True
    classification_check = _check(body, "CLASSIFICATION_STAMPED")
    assert classification_check["status"] == "WARN"
    assert classification_check["remedy"] == "stamp-classification"


# --- Asset shape / existence ---


async def test_distribution_readiness_non_knowledge_asset_returns_400(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    asset = Asset(
        type="agent", name="not-knowledge", owner_org="miracom",
        owner_creator_id="dev-user@miracom.com", classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()
    version = AssetVersion(
        asset_id=asset.id, version="1.0.0", status="DRAFT",
        manifest={"type": "agent", "name": asset.name},
    )
    db.add(version)
    await db.commit()

    resp = await client.get(
        f"/api/v1/assets/{asset.id}/versions/{version.id}/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_distribution_readiness_unknown_asset_returns_404(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    resp = await client.get(
        "/api/v1/assets/00000000-0000-0000-0000-000000000000/versions/"
        "00000000-0000-0000-0000-000000000001/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


async def test_distribution_readiness_unknown_version_under_known_asset_returns_404(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/"
        "00000000-0000-0000-0000-000000000001/distribution-readiness",
        headers=auth_header(),
    )
    assert resp.status_code == 404


# --- Authentication (no role lacks ASSET_READ — see module docstring) ---


async def test_distribution_readiness_missing_auth_returns_401(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.get(
        f"/api/v1/assets/{version.asset_id}/versions/{version.id}/distribution-readiness",
    )
    assert resp.status_code == 401
