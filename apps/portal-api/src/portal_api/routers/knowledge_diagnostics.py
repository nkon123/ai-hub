"""D-079 Knowledge diagnostics — M02.

  POST /api/v1/assets/{asset_id}/versions/{version_id}/search-preview
  GET  /api/v1/assets/{asset_id}/versions/{version_id}/distribution-readiness

Two read-only diagnostics for Knowledge producers, both scoped to a single
AssetVersion (never the parent Asset — D-060) and both deliberately narrower
than they could be, for the same reason: neither hands the caller a surface
to widen its own access.

Feature 1 (검색 품질 테스트) answers "이 질문을 하면 실제로 무엇이 검색되는가"
at the retrieval level (no LLM answer — the chatbot Quick Create wizard
already covers that). It works on non-APPROVED versions on purpose: a
producer needs to see search behavior *before* submitting for review, not
just after publication.

Feature 2 (반출 준비 상태 점검) predicts, before a Distribution ZIP is even
built, whether this version's index will actually activate on a Desktop
after install (`POST /search/v1/local-indexes`, D-079). It reuses
`routers.assets.resolve_knowledge_index_dir` — the one place this service
resolves an index directory — rather than inventing a second resolution
path, and never imports `services/search-runtime`: the shared vocabulary
between this prediction and that service's real refusals is the schema file
(`packages/schemas/api/knowledge-local-index.schema.json`) only, guarded by
`tests/contract/test_distribution_readiness_activation_reasons.py`.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import (
    Classification,
    Permission,
    clearance_covers,
    parse_classification,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.errors import error_response, not_found
from portal_api.knowledge_readiness import (
    distribution_readiness_checks,
    is_ready,
    latest_indexing_job,
)
from portal_api.models import Asset, AssetVersion
from portal_api.rbac import require_permission
from portal_api.routers.assets import resolve_knowledge_index_dir
from portal_api.routers.knowledge_search import SearchCaller, get_search_caller
from portal_api.schemas import (
    DistributionReadinessResponseOut,
    SearchPreviewCitationOut,
    SearchPreviewDiagnosticsOut,
    SearchPreviewRequest,
    SearchPreviewResponseOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["knowledge-diagnostics"])


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale.
    return get_trace_id() or str(uuid.uuid4())


async def _load_knowledge_version(
    db: AsyncSession, asset_id: str, version_id: str, trace_id: str
) -> tuple[Asset, AssetVersion] | JSONResponse:
    """Shared 404/400 resolution for both endpoints — same rules
    `routers.assets.get_knowledge_info` applies (asset must exist, must be
    type `knowledge`), plus a version lookup neither endpoint can skip since
    both operate on one AssetVersion, not the whole Asset."""
    asset = (await db.execute(select(Asset).where(Asset.id == asset_id))).scalar_one_or_none()
    if not asset:
        return not_found("자산을 찾을 수 없습니다.", trace_id)
    if asset.type != "knowledge":
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "이 자산은 Knowledge 유형이 아닙니다.",
            trace_id,
        )
    version = (
        await db.execute(
            select(AssetVersion).where(
                AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
            )
        )
    ).scalar_one_or_none()
    if not version:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)
    return asset, version


# ---------------------------------------------------------------------------
# Feature 1 — 검색 품질 테스트 (retrieval preview)
# ---------------------------------------------------------------------------


def _search_preview_payload(
    *, query: str, version_id: str, top_k: int, ignore_relevance_threshold: bool,
    user: UserContext, trace_id: str,
) -> dict:
    """Mirrors `routers.knowledge_search._search_one`'s payload exactly,
    except `knowledge_id` is the caller-specified `version_id` (a single
    Knowledge, not a Hub fan-out) and, when `ignore_relevance_threshold` is
    set, the caller-visible knob is *only* `min_relevance_score: 0` —
    `access_context` is built identically either way, so relaxing the
    relevance floor can never also relax ACL/classification filtering
    (asserted by `test_search_preview_ignore_threshold_does_not_relax_acl`).
    """
    payload: dict = {
        "query": query,
        "knowledge_id": version_id,
        "knowledge_version": "latest",
        "top_k": top_k,
        "access_context": {
            "clearance": settings.default_search_clearance,
            "user_id": user.user_id,
            "organization_id": user.org,
            "permissions": [],
        },
        "trace_id": trace_id,
    }
    if ignore_relevance_threshold:
        payload["min_relevance_score"] = 0.0
    return payload


@router.post(
    "/assets/{asset_id}/versions/{version_id}/search-preview",
    response_model=SearchPreviewResponseOut,
)
async def search_preview(
    asset_id: str,
    version_id: str,
    body: SearchPreviewRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    search_caller: SearchCaller = Depends(get_search_caller),
) -> SearchPreviewResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    loaded = await _load_knowledge_version(db, asset_id, version_id, trace_id)
    if isinstance(loaded, JSONResponse):
        return loaded
    asset, version = loaded

    # Independent of the search-runtime call below — this is portal-api's
    # own filesystem fact, resolved the one way this service resolves index
    # directories (see resolve_knowledge_index_dir), so `index_found` is
    # trustworthy even if the downstream call itself fails or times out.
    job = await latest_indexing_job(db, version.id)
    index_found = resolve_knowledge_index_dir(job, version.id) is not None

    payload = _search_preview_payload(
        query=body.query,
        version_id=version.id,
        top_k=body.top_k,
        ignore_relevance_threshold=body.ignore_relevance_threshold,
        user=user,
        trace_id=trace_id,
    )

    try:
        result = await search_caller(payload)
    except Exception:
        # search-runtime unreachable/erroring must never collapse into an
        # empty-citations 200 — that would be indistinguishable from "근거
        # 없음" (the router brief's explicit requirement).
        logger.warning(
            "knowledge_search_preview.downstream_failed version_id=%s trace_id=%s",
            version.id, trace_id, exc_info=True,
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_SEARCH_UNAVAILABLE",
            "Knowledge 검색 서비스에 연결할 수 없어 미리보기를 완료하지 못했습니다.",
            trace_id,
        )

    citations = result.get("citations") if isinstance(result, dict) else None
    citations = citations or []

    # 세 번째 "조용한 0건" 원인: 자산의 보안등급이 이 플랫폼이 assert 하는
    # clearance 로는 아예 볼 수 없는 등급인 경우. 이건 검색 품질 문제가
    # 아니라 정책상 전면 차단이며, 측정으로 확인된 실제 상황이다 — 저장소의
    # CONFIDENTIAL Knowledge 색인은 같은 질의에 대해 clearance=INTERNAL 이면
    # 0건, CONFIDENTIAL 이면 2건을 돌려준다. `default_search_clearance` 는
    # 서버가 정하는 고정값이고 사용자가 올릴 방법이 없으므로(D-062/D-015),
    # 이유를 말해주지 않으면 등록자는 "내 문서가 검색이 안 된다"만 보고
    # 원인을 영원히 알 수 없다.
    #
    # 판정은 `security_policy` 의 공개 API 로만 한다(등급 순서를 여기서 다시
    # 구현하지 않는다). `allow_unknown_classification=False`: 여기서 비교하는
    # 값은 Registry 에 기록된 자산 등급이라 UNKNOWN 이면 "판정할 근거가 없음"
    # 이라는 뜻이고, 그때는 아래에서 이 원인을 주장하지 않는다.
    asset_classification = parse_classification(asset.classification)
    caller_clearance = parse_classification(settings.default_search_clearance)
    classification_blocks_everything = (
        asset_classification is not Classification.UNKNOWN
        and caller_clearance is not Classification.UNKNOWN
        and not clearance_covers(
            caller_clearance, asset_classification, allow_unknown_classification=False
        )
    )

    if citations:
        no_result_reason = None
    elif not index_found:
        no_result_reason = "INDEX_NOT_BUILT"
    elif classification_blocks_everything:
        no_result_reason = "CLASSIFICATION_ABOVE_CLEARANCE"
    else:
        # Cannot distinguish "임계값에 걸렸다" from "아무것도 안 맞았다" from a
        # single call — see this module's docstring and the diagnostics
        # field's own docstring. Never guessed more precisely than this.
        no_result_reason = "NO_CITATIONS"

    # 등급 때문에 막힌 경우에는 재시도 안내를 하지 않는다 — 관련도 필터를
    # 꺼도 결과는 그대로 0건이고, 사용자를 반드시 실패하는 행동으로 보내는
    # 안내는 없는 것만 못하다.
    retry_without_threshold_available = (
        not citations
        and index_found
        and not body.ignore_relevance_threshold
        and not classification_blocks_everything
    )

    diagnostics = SearchPreviewDiagnosticsOut(
        index_found=index_found,
        embed_model_applied=result.get("embed_model_applied") if isinstance(result, dict) else None,
        embed_model_source=result.get("embed_model_source") if isinstance(result, dict) else None,
        min_relevance_score_applied=(
            result.get("min_relevance_score_applied", 0.0) if isinstance(result, dict) else 0.0
        ),
        relevance_threshold_ignored=body.ignore_relevance_threshold,
        clearance_applied=settings.default_search_clearance,
        asset_classification=asset.classification,
        no_result_reason=no_result_reason,
        retry_without_threshold_available=retry_without_threshold_available,
    )

    await record_audit(
        db,
        event_type="KNOWLEDGE_SEARCH_PREVIEW",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        # Never the query text (CLAUDE.md 로그 규칙) — same discipline
        # `routers.knowledge_search.knowledge_search` already follows.
        metadata={
            "top_k": body.top_k,
            "result_count": len(citations),
            "ignore_relevance_threshold": body.ignore_relevance_threshold,
        },
    )

    return SearchPreviewResponseOut(
        citations=[SearchPreviewCitationOut(**c) for c in citations],
        diagnostics=diagnostics,
        trace_id=trace_id,
    )


# ---------------------------------------------------------------------------
# Feature 2 — 반출 준비 상태 점검 (distribution readiness)
#
# The check computation itself now lives in `portal_api.knowledge_readiness`
# (D-079 gate task) so this screen and `routers/distributions.py`'s
# Distribution-creation gate share one judgement and can never disagree.
# ---------------------------------------------------------------------------


@router.get(
    "/assets/{asset_id}/versions/{version_id}/distribution-readiness",
    response_model=DistributionReadinessResponseOut,
)
async def distribution_readiness(
    asset_id: str,
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DistributionReadinessResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    loaded = await _load_knowledge_version(db, asset_id, version_id, trace_id)
    if isinstance(loaded, JSONResponse):
        return loaded
    _asset, version = loaded

    job = await latest_indexing_job(db, version.id)
    checks = distribution_readiness_checks(job, version.id)
    ready = is_ready(checks)

    return DistributionReadinessResponseOut(
        version_id=version.id, ready=ready, checks=checks, trace_id=trace_id,
    )
