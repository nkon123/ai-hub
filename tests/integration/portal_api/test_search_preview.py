"""Integration tests for M02's D-079 검색 품질 테스트
(`POST /api/v1/assets/{asset_id}/versions/{version_id}/search-preview`).

Covers: normal (citations + diagnostics echoed from search-runtime), empty
result on a built index (NO_CITATIONS, retry offered), empty result on a
version with no index at all (INDEX_NOT_BUILT, no retry offered), the
ignore_relevance_threshold flow (retry after threshold-caused empty result),
the ACL-not-relaxed assertion (the one property the router brief calls out
explicitly — `ignore_relevance_threshold` changes only `min_relevance_score`
in the outbound payload, never `access_context`), works on a non-APPROVED
(DRAFT) version, non-knowledge asset (400), asset/version not found (404),
search-runtime unavailable (503 KNOWLEDGE_SEARCH_UNAVAILABLE, never a silent
empty 200), and authentication (no role lacks ASSET_READ — same as
`routers/knowledge_search.py`, so no role-based 403 case here by design).

search-runtime is faked via the shared `get_search_caller` dependency
override (the same seam `routers.knowledge_search` already uses and this
router reuses directly) — no real search-runtime process required.
"""

from __future__ import annotations

import httpx
import pytest
from portal_api.config import settings
from portal_api.main import app
from portal_api.models import Asset, AssetVersion, IndexingJob
from portal_api.routers.knowledge_search import get_search_caller
from sqlalchemy.ext.asyncio import AsyncSession

from tests.integration.portal_api.conftest import auth_header


@pytest.fixture(autouse=True)
def _isolated_index_base(tmp_path, monkeypatch):
    # Same rationale as test_distribution_readiness.py's fixture of the same
    # name — `index_base/hr-policy-v1` is a real directory in this repo.
    monkeypatch.setattr(settings, "index_base", tmp_path / "_unused_index_base")


@pytest.fixture(autouse=True)
def _clear_search_caller_override():
    yield
    app.dependency_overrides.pop(get_search_caller, None)


async def _make_knowledge_version(
    db: AsyncSession,
    *,
    status: str = "DRAFT",
    index_path: str | None = None,
    classification: str = "INTERNAL",
) -> AssetVersion:
    asset = Asset(
        type="knowledge", name="preview-knowledge", owner_org="miracom",
        owner_creator_id="dev-user@miracom.com", classification=classification,
    )
    db.add(asset)
    await db.flush()
    version = AssetVersion(
        asset_id=asset.id, version="1.0.0", status=status,
        manifest={"type": "knowledge", "name": asset.name},
    )
    db.add(version)
    await db.flush()
    if index_path is not None:
        job = IndexingJob(
            asset_version_id=version.id, status="COMPLETED", chunk_count=4,
            index_path=index_path,
        )
        db.add(job)
    await db.commit()
    await db.refresh(version)
    return version


def _make_built_index(tmp_path, version_id: str):
    d = tmp_path / "index"
    d.mkdir()
    (d / "index-meta.json").write_text(
        f'{{"knowledge_id": "{version_id}", "embed_model": "qwen3-embedding:0.6b"}}',
        encoding="utf-8",
    )
    return d


def _fake_citation(chunk_id: str, *, similarity: float = 0.8, score: float = 0.5) -> dict:
    return {
        "chunk_id": chunk_id,
        "parent_chunk_id": None,
        "document_path": "docs/policy.md",
        "document_title": "정책 문서",
        "page": 1,
        "section": "1장",
        "excerpt": "발췌문",
        "parent_context": "",
        "score": score,
        "similarity": similarity,
    }


def _url(asset_id: str, version_id: str) -> str:
    return f"/api/v1/assets/{asset_id}/versions/{version_id}/search-preview"


# --- Normal ---


async def test_search_preview_returns_citations_and_diagnostics(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    version = await _make_knowledge_version(db, status="DRAFT")
    index_dir = _make_built_index(tmp_path, version.id)

    job_row = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job_row)
    await db.commit()

    calls: list[dict] = []

    async def fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return {
            "citations": [_fake_citation("chunk-1")],
            "min_relevance_score_applied": 0.3,
            "embed_model_applied": "qwen3-embedding:0.6b",
            "embed_model_source": "index_meta",
        }

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id),
        json={"query": "육아휴직 정책은?", "top_k": 5},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["citations"]) == 1
    assert body["citations"][0]["chunk_id"] == "chunk-1"
    assert body["diagnostics"]["index_found"] is True
    assert body["diagnostics"]["no_result_reason"] is None
    assert body["diagnostics"]["retry_without_threshold_available"] is False
    assert body["diagnostics"]["min_relevance_score_applied"] == 0.3
    assert body["diagnostics"]["embed_model_applied"] == "qwen3-embedding:0.6b"
    assert body["diagnostics"]["relevance_threshold_ignored"] is False
    assert body["diagnostics"]["clearance_applied"] == settings.default_search_clearance
    assert "trace_id" in body

    assert calls[0]["knowledge_id"] == version.id  # D-060: version id, not asset id
    assert "min_relevance_score" not in calls[0]  # not sent unless ignore_relevance_threshold


async def test_search_preview_works_on_non_approved_draft_version(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db, status="DRAFT")
    assert version.status == "DRAFT"

    async def fake_caller(payload: dict) -> dict:
        return {"citations": [_fake_citation("chunk-1")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text


# --- Empty results: distinguish INDEX_NOT_BUILT from NO_CITATIONS ---


async def test_search_preview_empty_with_no_index_reports_index_not_built(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db, index_path=None)  # no IndexingJob at all

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["citations"] == []
    assert body["diagnostics"]["index_found"] is False
    assert body["diagnostics"]["no_result_reason"] == "INDEX_NOT_BUILT"
    # No point offering a threshold retry when there is nothing indexed.
    assert body["diagnostics"]["retry_without_threshold_available"] is False


async def test_search_preview_empty_with_built_index_reports_no_citations_and_offers_retry(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    version = await _make_knowledge_version(db)
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["index_found"] is True
    assert body["diagnostics"]["no_result_reason"] == "NO_CITATIONS"
    # Never a more specific guess than this from a single call — see the
    # router's docstring: only a *second* call with the threshold ignored
    # can prove the threshold was the cause.
    assert body["diagnostics"]["retry_without_threshold_available"] is True


async def test_search_preview_retry_with_threshold_ignored_no_longer_offers_retry(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    version = await _make_knowledge_version(db)
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id),
        json={"query": "질문", "ignore_relevance_threshold": True},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["relevance_threshold_ignored"] is True
    assert body["diagnostics"]["retry_without_threshold_available"] is False


# --- CLASSIFICATION_ABOVE_CLEARANCE: the third "조용한 0건" cause ---
#
# `settings.default_search_clearance` defaults to "INTERNAL" (see
# portal_api.config.Settings) and none of these tests override it, so
# CONFIDENTIAL is "above" it and PUBLIC_INTERNAL is "covered by" it —
# matching the ascending order PUBLIC_INTERNAL < INTERNAL < CONFIDENTIAL <
# RESTRICTED that security_policy.classification._ORDER encodes.


async def test_search_preview_classification_above_clearance_reports_reason_and_no_retry(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    version = await _make_knowledge_version(db, classification="CONFIDENTIAL")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["index_found"] is True
    assert body["diagnostics"]["no_result_reason"] == "CLASSIFICATION_ABOVE_CLEARANCE"
    # Turning the relevance filter off cannot change an ACL outcome — never
    # send the user into a guaranteed-failure retry.
    assert body["diagnostics"]["retry_without_threshold_available"] is False
    assert body["diagnostics"]["asset_classification"] == "CONFIDENTIAL"
    assert body["diagnostics"]["clearance_applied"] == settings.default_search_clearance


async def test_search_preview_classification_covered_by_clearance_still_reports_no_citations(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    # PUBLIC_INTERNAL is below (covered by) the default INTERNAL clearance —
    # proves the router does not over-claim CLASSIFICATION_ABOVE_CLEARANCE
    # whenever an asset merely has a non-default classification recorded.
    version = await _make_knowledge_version(db, classification="PUBLIC_INTERNAL")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["no_result_reason"] == "NO_CITATIONS"
    assert body["diagnostics"]["retry_without_threshold_available"] is True
    assert body["diagnostics"]["asset_classification"] == "PUBLIC_INTERNAL"


async def test_search_preview_citations_present_beats_classification_above_clearance(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    # Should be impossible in practice (search-runtime's own forced ACL
    # filter would have already dropped every chunk) — but the router must
    # never contradict what it actually observed. Citations present always
    # means no_result_reason is None, regardless of the classification
    # computation.
    version = await _make_knowledge_version(db, classification="CONFIDENTIAL")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": [_fake_citation("chunk-1")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["citations"]) == 1
    assert body["diagnostics"]["no_result_reason"] is None


async def test_search_preview_index_not_built_wins_over_classification_above_clearance(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    # Branch ordering: INDEX_NOT_BUILT must be checked before
    # CLASSIFICATION_ABOVE_CLEARANCE — no point diagnosing an ACL outcome
    # for an index that was never built at all.
    version = await _make_knowledge_version(db, classification="CONFIDENTIAL", index_path=None)

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["index_found"] is False
    assert body["diagnostics"]["no_result_reason"] == "INDEX_NOT_BUILT"


async def test_search_preview_unknown_asset_classification_does_not_claim_classification_reason(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    # An unparseable/foreign classification value parses to UNKNOWN
    # (security_policy.parse_classification never guesses a real level) —
    # "판정할 근거가 없음" means the router must not claim
    # CLASSIFICATION_ABOVE_CLEARANCE, and must fall back to NO_CITATIONS.
    version = await _make_knowledge_version(db, classification="NOT_A_REAL_LEVEL")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["no_result_reason"] == "NO_CITATIONS"
    assert body["diagnostics"]["retry_without_threshold_available"] is True
    assert body["diagnostics"]["asset_classification"] == "NOT_A_REAL_LEVEL"


async def test_search_preview_unknown_caller_clearance_does_not_claim_classification_reason(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path, monkeypatch
) -> None:
    # Same rule, other side: an unparseable configured
    # `default_search_clearance` also parses to UNKNOWN, so the comparison
    # has no basis and the reason must not be claimed either.
    monkeypatch.setattr(settings, "default_search_clearance", "NOT_A_REAL_CLEARANCE")
    version = await _make_knowledge_version(db, classification="CONFIDENTIAL")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["diagnostics"]["no_result_reason"] == "NO_CITATIONS"
    assert body["diagnostics"]["retry_without_threshold_available"] is True


# --- asset_classification is always echoed in diagnostics ---


async def test_search_preview_echoes_asset_classification_in_diagnostics(
    client: httpx.AsyncClient, db: AsyncSession, tmp_path
) -> None:
    version = await _make_knowledge_version(db, classification="RESTRICTED")
    index_dir = _make_built_index(tmp_path, version.id)
    job = IndexingJob(
        asset_version_id=version.id, status="COMPLETED", chunk_count=4,
        index_path=str(index_dir),
    )
    db.add(job)
    await db.commit()

    async def fake_caller(payload: dict) -> dict:
        return {"citations": [_fake_citation("chunk-1")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["diagnostics"]["asset_classification"] == "RESTRICTED"


# --- ACL is never relaxed by ignore_relevance_threshold ---


async def test_search_preview_ignore_threshold_does_not_relax_acl(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)

    calls: list[dict] = []

    async def fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp_normal = await client.post(
        _url(version.asset_id, version.id),
        json={"query": "질문", "ignore_relevance_threshold": False},
        headers=auth_header(),
    )
    resp_ignored = await client.post(
        _url(version.asset_id, version.id),
        json={"query": "질문", "ignore_relevance_threshold": True},
        headers=auth_header(),
    )
    assert resp_normal.status_code == 200
    assert resp_ignored.status_code == 200
    assert len(calls) == 2

    normal_payload, ignored_payload = calls
    # The only difference the flag makes to the outbound payload is
    # min_relevance_score — access_context is byte-for-byte identical.
    assert normal_payload["access_context"] == ignored_payload["access_context"]
    assert "min_relevance_score" not in normal_payload
    assert ignored_payload["min_relevance_score"] == 0.0
    # And no request ever carries an ACL override field at all (the whole
    # point of this endpoint's narrow request body).
    for payload in calls:
        assert "metadata_filters" not in payload
        assert "retrieval_profile" not in payload


# --- search-runtime failure ---


async def test_search_preview_downstream_failure_returns_503_never_empty_200(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)

    async def fake_caller(payload: dict) -> dict:
        raise httpx.ConnectError("simulated search-runtime unavailable")

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "KNOWLEDGE_SEARCH_UNAVAILABLE"


# --- Asset shape / existence ---


async def test_search_preview_non_knowledge_asset_returns_400(
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

    resp = await client.post(
        _url(asset.id, version.id), json={"query": "질문"}, headers=auth_header()
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_search_preview_unknown_asset_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        _url("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"),
        json={"query": "질문"},
        headers=auth_header(),
    )
    assert resp.status_code == 404


async def test_search_preview_unknown_version_returns_404(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.post(
        _url(version.asset_id, "00000000-0000-0000-0000-000000000001"),
        json={"query": "질문"},
        headers=auth_header(),
    )
    assert resp.status_code == 404


# --- Validation ---


async def test_search_preview_rejects_empty_query(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.post(
        _url(version.asset_id, version.id), json={"query": ""}, headers=auth_header()
    )
    assert resp.status_code == 422


async def test_search_preview_rejects_top_k_above_20(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.post(
        _url(version.asset_id, version.id),
        json={"query": "질문", "top_k": 21},
        headers=auth_header(),
    )
    assert resp.status_code == 422


# --- Authentication (no role lacks ASSET_READ — see module docstring) ---


async def test_search_preview_missing_auth_returns_401(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    version = await _make_knowledge_version(db)
    resp = await client.post(_url(version.asset_id, version.id), json={"query": "질문"})
    assert resp.status_code == 401
