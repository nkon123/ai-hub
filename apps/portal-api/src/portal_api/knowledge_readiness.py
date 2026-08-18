"""D-079 Knowledge distribution readiness — shared judgement, M02.

Moved out of `routers/knowledge_diagnostics.py` (not copied) so that the
producer-facing 반출 준비 상태 점검 screen
(`GET /api/v1/assets/{asset_id}/versions/{version_id}/distribution-readiness`)
and the Distribution-creation gate (`routers/distributions.py`) evaluate the
exact same checks and can never disagree about whether a Knowledge version's
index will actually activate on a Desktop after install.

This predicts, before a Distribution ZIP is even built, whether this
version's index will register successfully with search-runtime's
`POST /search/v1/local-indexes` (D-079). It reuses
`routers.assets.resolve_knowledge_index_dir` — the one place this service
resolves an index directory — rather than inventing a second resolution
path, and never imports `services/search-runtime`: the shared vocabulary
between this prediction and that service's real refusals is the schema file
(`packages/schemas/api/knowledge-local-index.schema.json`) only, guarded by
`tests/contract/test_distribution_readiness_activation_reasons.py`.
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.models import IndexingJob
from portal_api.routers.assets import resolve_knowledge_index_dir
from portal_api.schemas import DistributionReadinessCheckOut

# `activation_reason` values below are exactly the `details.reason`
# vocabulary knowledge-local-index.schema.json documents on
# RegisterLocalIndexResponse — never invented here. See
# tests/contract/test_distribution_readiness_activation_reasons.py.
REASON_INDEX_META_MISSING = "index_meta_missing"
REASON_INDEX_META_UNREADABLE = "index_meta_unreadable"
REASON_INDEX_META_MISMATCH = "index_meta_knowledge_id_mismatch"
REASON_BM25_LEGACY_PICKLE_ONLY = "bm25_legacy_pickle_only"
REASON_BM25_MISSING = "bm25_missing"
REASON_CHROMA_MISSING = "chroma_missing"

CANNOT_VERIFY_MESSAGE = "이전 점검 항목이 실패해 이 항목을 확인할 수 없습니다."


async def latest_indexing_job(db: AsyncSession, version_id: str) -> IndexingJob | None:
    stmt = (
        select(IndexingJob)
        .where(IndexingJob.asset_version_id == version_id)
        .order_by(IndexingJob.created_at.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def _check(
    check_id: str, status_: str, message: str, *, remedy: str | None = None,
    activation_reason: str | None = None,
) -> DistributionReadinessCheckOut:
    return DistributionReadinessCheckOut(
        id=check_id, status=status_, message=message, remedy=remedy,
        activation_reason=activation_reason,
    )


def distribution_readiness_checks(
    job: IndexingJob | None, version_id: str
) -> list[DistributionReadinessCheckOut]:
    checks: list[DistributionReadinessCheckOut] = []

    # 1. INDEXING_COMPLETED — activation_reason is always null: an
    # incomplete/absent index job is a state *before* an installable index
    # exists at all, not one of search-runtime's D-079 registration
    # refusals (those all assume a directory was actually shipped).
    if job is None:
        checks.append(_check(
            "INDEXING_COMPLETED", "FAIL",
            "이 버전은 아직 색인 작업이 실행되지 않았습니다.",
            remedy="색인 작업을 실행하세요.",
        ))
    elif job.status != "COMPLETED":
        checks.append(_check(
            "INDEXING_COMPLETED", "FAIL",
            f"색인 작업이 완료되지 않았습니다 (현재 상태: {job.status}).",
            remedy="색인 작업이 완료될 때까지 기다리거나 실패했다면 다시 실행하세요.",
        ))
    else:
        checks.append(_check("INDEXING_COMPLETED", "PASS", "색인 작업이 완료되었습니다."))

    # 2. INDEX_DIR_FOUND — reuses the exact same resolution
    # get_knowledge_info uses (resolve_knowledge_index_dir), which itself
    # returns None whenever check 1 failed (no COMPLETED job to resolve
    # from) — the cascade below is therefore automatic, not duplicated
    # logic.
    index_dir = resolve_knowledge_index_dir(job, version_id)
    if index_dir is None:
        checks.append(_check(
            "INDEX_DIR_FOUND", "FAIL",
            "index-meta.json을 가진 색인 디렉터리를 찾을 수 없습니다.",
            remedy="색인 작업을 다시 실행하세요.",
            activation_reason=REASON_INDEX_META_MISSING,
        ))
        # Nothing below this line can be verified without a resolved
        # directory — cascade honestly (WARN "확인 불가", never a fabricated
        # FAIL/PASS) rather than guessing. See this module's docstring.
        for check_id in (
            "INDEX_META_KNOWLEDGE_ID", "BM25_FORMAT", "CHROMA_PRESENT",
            "EMBED_MODEL_RECORDED", "CLASSIFICATION_STAMPED",
        ):
            checks.append(_check(check_id, "WARN", CANNOT_VERIFY_MESSAGE))
        return checks

    # index-meta.json's existence was already confirmed by
    # resolve_knowledge_index_dir; a parse failure here is a corrupt-file
    # edge case that check table's "index-meta.json을 가진 디렉터리를 못
    # 찾음" wording doesn't literally cover, but the schema documents
    # exactly this reason (`index_meta_unreadable`) — using it here instead
    # of silently treating a corrupt file as "found" would be dishonest.
    meta: dict | None = None
    try:
        with open(index_dir / "index-meta.json", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            meta = loaded
    except (OSError, json.JSONDecodeError):
        meta = None

    if meta is None:
        checks.append(_check(
            "INDEX_DIR_FOUND", "FAIL",
            "index-meta.json을 읽을 수 없습니다 (손상되었을 수 있습니다).",
            remedy="색인 작업을 다시 실행하세요.",
            activation_reason=REASON_INDEX_META_UNREADABLE,
        ))
        for check_id in (
            "INDEX_META_KNOWLEDGE_ID", "BM25_FORMAT", "CHROMA_PRESENT",
            "EMBED_MODEL_RECORDED", "CLASSIFICATION_STAMPED",
        ):
            checks.append(_check(check_id, "WARN", CANNOT_VERIFY_MESSAGE))
        return checks

    checks.append(_check("INDEX_DIR_FOUND", "PASS", "색인 디렉터리를 찾았습니다."))

    # 3. INDEX_META_KNOWLEDGE_ID
    recorded_id = meta.get("knowledge_id")
    if recorded_id != version_id:
        checks.append(_check(
            "INDEX_META_KNOWLEDGE_ID", "FAIL",
            "색인 메타데이터에 기록된 knowledge_id가 이 버전과 다릅니다 — "
            "다른 Knowledge의 색인일 수 있습니다.",
            activation_reason=REASON_INDEX_META_MISMATCH,
        ))
    else:
        checks.append(_check(
            "INDEX_META_KNOWLEDGE_ID", "PASS", "색인 메타데이터가 이 버전과 일치합니다.",
        ))

    # 4. BM25_FORMAT (D-054)
    if (index_dir / "bm25.json").is_file():
        checks.append(_check("BM25_FORMAT", "PASS", "BM25 색인이 최신(JSON) 형식입니다."))
    elif (index_dir / "bm25.pkl").is_file():
        checks.append(_check(
            "BM25_FORMAT", "FAIL",
            "BM25 색인이 실행 가능한 legacy 형식(pickle)만 가지고 있어 Desktop에서 "
            "활성화될 수 없습니다.",
            remedy=f"convert-bm25-format {index_dir}",
            activation_reason=REASON_BM25_LEGACY_PICKLE_ONLY,
        ))
    else:
        checks.append(_check(
            "BM25_FORMAT", "FAIL",
            "BM25 색인 파일이 없습니다 — 색인이 불완전합니다.",
            remedy="색인 작업을 다시 실행하세요.",
            activation_reason=REASON_BM25_MISSING,
        ))

    # 5. CHROMA_PRESENT
    if (index_dir / "chroma").is_dir():
        checks.append(_check("CHROMA_PRESENT", "PASS", "벡터 색인(chroma) 디렉터리가 있습니다."))
    else:
        checks.append(_check(
            "CHROMA_PRESENT", "FAIL",
            "벡터 색인(chroma) 디렉터리가 없습니다 — 색인이 불완전합니다.",
            remedy="색인 작업을 다시 실행하세요.",
            activation_reason=REASON_CHROMA_MISSING,
        ))

    # 6. EMBED_MODEL_RECORDED (D-075, WARN only — never blocks `ready`)
    if isinstance(meta.get("embed_model"), str) and meta.get("embed_model"):
        checks.append(_check(
            "EMBED_MODEL_RECORDED", "PASS", "embed_model이 색인 메타데이터에 기록되어 있습니다.",
        ))
    else:
        checks.append(_check(
            "EMBED_MODEL_RECORDED", "WARN",
            "embed_model이 색인 메타데이터에 기록되지 않았습니다 — 검색 시 이 배포의 "
            "폴백 기본값에 의존하게 됩니다.",
        ))

    # 7. CLASSIFICATION_STAMPED (D-062 fail-closed, WARN only)
    if isinstance(meta.get("classification"), str) and meta.get("classification"):
        checks.append(_check(
            "CLASSIFICATION_STAMPED", "PASS",
            "classification이 색인 메타데이터에 기록되어 있습니다.",
        ))
    else:
        checks.append(_check(
            "CLASSIFICATION_STAMPED", "WARN",
            "classification이 기록되지 않았습니다 — 이 배포의 fail-closed 정책상 "
            "아무 사용자에게도 검색 결과가 보이지 않을 수 있습니다.",
            remedy="stamp-classification",
        ))

    return checks


def is_ready(checks: list[DistributionReadinessCheckOut]) -> bool:
    return all(c.status != "FAIL" for c in checks)


def first_failing_check(
    checks: list[DistributionReadinessCheckOut],
) -> DistributionReadinessCheckOut | None:
    """First FAIL-status check, in the fixed evaluation order
    `distribution_readiness_checks` produces — used by the Distribution
    gate to name *which* check blocked creation (never just "not ready")."""
    for c in checks:
        if c.status == "FAIL":
            return c
    return None
