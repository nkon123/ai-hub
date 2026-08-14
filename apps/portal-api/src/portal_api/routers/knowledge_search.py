"""Cross-Knowledge Hub Search router — M02.

  POST /api/v1/knowledge-search

`services/search-runtime` (M08) only ever searches a single `knowledge_id`
per request — see its `SearchRequest` in
`services/search-runtime/src/search_runtime/main.py`. This router adds the
missing capability: search across every Knowledge asset the caller is
allowed to see, by fanning out concurrently to search-runtime per Knowledge
and merging the results. Mirrors `routers.distributions.create_distribution`
exactly in division of labor: portal-api resolves everything from its own
Registry (Asset/AssetVersion), then calls a downstream service via
`httpx.AsyncClient` with the caller injected through a `Depends`-based seam
(`get_search_caller`) so tests never need a live search-runtime process —
and `_call_indexing_runtime_http`/`get_indexing_caller` in `routers/
assets.py` for the simpler read-style version of the same pattern.

Deliberate design point, not an oversight: `KnowledgeSearchRequest` (see
`schemas.py`) has NO ACL/clearance/classification/metadata_filters field.
There is no override surface for a caller to widen its own access — every
fan-out call's `access_context.clearance` is `settings
.default_search_clearance`, derived entirely server-side, never from the
request body. See that setting's docstring for the same D-062 PoC-honesty
caveat search-runtime and agent-runtime already document (this platform
ASSERTS a clearance on the caller's behalf; it does not verify one against a
real identity/session, because no such system exists yet in this PoC).

Audit (`KNOWLEDGE_SEARCH_HUB`): the query text itself is NEVER written into
`AuditEvent.metadata` or any log line — CLAUDE.md's 로그 규칙 (no raw prompt
text in logs) applies here exactly as it does to every other call site in
`distributions.py`. The audit row records that a search happened and what it
touched (ids searched, result count, top_k), never what was asked.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

import httpx
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import Permission
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.errors import error_response
from portal_api.models import Asset, AssetVersion
from portal_api.rbac import require_permission
from portal_api.schemas import (
    KnowledgeSearchCitationOut,
    KnowledgeSearchRequest,
    KnowledgeSearchResponseOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["knowledge-search"])

# Fan-out cap for the "search everything visible" case (`knowledge_ids`
# omitted) — bounds how many concurrent search-runtime calls one request can
# trigger. A PoC constant, not a measured capacity limit; revisit alongside
# NFR-08 once multi-Knowledge search has real load data. Does not apply when
# the caller supplies an explicit `knowledge_ids` list shorter than this.
_MAX_FANOUT_KNOWLEDGE_COUNT = 20

SearchCaller = Callable[[dict], Awaitable[dict]]


async def _call_search_runtime_http(payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{settings.search_runtime_url}/search/v1/query", json=payload)
        resp.raise_for_status()
        return resp.json()


def get_search_caller() -> SearchCaller:
    """FastAPI dependency seam — overridden in integration tests
    (`app.dependency_overrides[get_search_caller]`) so the test suite never
    needs a real search-runtime process running (mirrors
    `routers.distributions.get_distribution_caller`)."""
    return _call_search_runtime_http


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale.
    return get_trace_id() or str(uuid.uuid4())


async def _visible_knowledge(
    db: AsyncSession, knowledge_ids: list[str] | None
) -> list[tuple[AssetVersion, Asset]]:
    """Every APPROVED Knowledge AssetVersion the caller may see, optionally
    intersected with a caller-supplied id allowlist.

    An id the caller passed that isn't in the visible set is silently
    dropped, never surfaced as an error — a caller passing an id it can't
    see should get nothing back for that id, not a signal about whether it
    exists at all.
    """
    stmt = (
        select(AssetVersion, Asset)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .where(Asset.type == "knowledge", AssetVersion.status == "APPROVED")
    )
    rows = list((await db.execute(stmt)).all())
    if knowledge_ids is not None:
        wanted = set(knowledge_ids)
        rows = [(v, a) for v, a in rows if v.id in wanted]
    return rows[:_MAX_FANOUT_KNOWLEDGE_COUNT]


async def _search_one(
    caller: SearchCaller,
    *,
    query: str,
    version: AssetVersion,
    asset: Asset,
    top_k: int,
    user: UserContext,
    trace_id: str,
) -> tuple[bool, list[dict]]:
    """Search one Knowledge. Returns `(succeeded, tagged_citations)` —
    `succeeded` distinguishes "search-runtime answered with zero hits" from
    "the call itself failed", so the caller can report `knowledge_ids_searched`
    accurately and degrade gracefully on partial failure (never raises)."""
    manifest = dict(version.manifest or {})
    retrieval_profile = manifest.get("retrieval_profile")
    retrieval_profile = retrieval_profile if isinstance(retrieval_profile, dict) else {}
    profile_top_k = retrieval_profile.get("top_k")
    applied_top_k = min(top_k, profile_top_k) if type(profile_top_k) is int else top_k
    payload = {
        "query": query,
        "knowledge_id": version.id,
        "knowledge_version": "latest",
        "top_k": applied_top_k,
        "access_context": {
            "clearance": settings.default_search_clearance,
            "user_id": user.user_id,
            "organization_id": user.org,
            "permissions": [],
        },
        "trace_id": trace_id,
    }
    if type(retrieval_profile.get("hybrid_alpha")) in {int, float}:
        payload["alpha"] = retrieval_profile["hybrid_alpha"]
    if type(retrieval_profile.get("min_relevance_score")) in {int, float}:
        payload["min_relevance_score"] = retrieval_profile["min_relevance_score"]
    if retrieval_profile:
        payload["retrieval_profile"] = retrieval_profile
    try:
        result = await caller(payload)
    except Exception:
        # Tolerate individual failures (04-knowledge-platform.md scope for
        # this router's task brief: "partial failure — skip the failed
        # ones, still return citations from the ones that succeeded, and
        # don't error"). Never logs the query text (CLAUDE.md 로그 규칙).
        logger.warning(
            "knowledge_search.downstream_failed knowledge_id=%s trace_id=%s",
            version.id,
            trace_id,
            exc_info=True,
        )
        return False, []

    citations = result.get("citations") if isinstance(result, dict) else None
    tagged = []
    for citation in citations or []:
        tagged_citation = dict(citation)
        tagged_citation["knowledge_id"] = version.id
        tagged_citation["asset_id"] = asset.id
        tagged_citation["asset_name"] = asset.name
        tagged_citation["source"] = "hub"
        tagged.append(tagged_citation)
    return True, tagged


@router.post("/knowledge-search", response_model=KnowledgeSearchResponseOut)
async def knowledge_search(
    body: KnowledgeSearchRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    search_caller: SearchCaller = Depends(get_search_caller),
) -> KnowledgeSearchResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id, resource_type="KNOWLEDGE"
    )
    if denial:
        return denial

    visible = await _visible_knowledge(db, body.knowledge_ids)

    if not visible:
        # Empty visible set (no APPROVED Knowledge exists, or every
        # requested id was invisible/unknown) is a normal empty result, not
        # an error — 07-data-api-contracts.md §10.3 "검색 결과는 사용자에게
        # 허용된 자산만 포함한다" plus README §16 Empty-state requirement.
        await record_audit(
            db,
            event_type="KNOWLEDGE_SEARCH_HUB",
            actor=user,
            resource_type="KNOWLEDGE",
            resource_id="-",
            result="SUCCESS",
            trace_id=trace_id,
            metadata={"knowledge_ids_searched": [], "result_count": 0, "top_k": body.top_k},
        )
        return KnowledgeSearchResponseOut(
            trace_id=trace_id, knowledge_ids_searched=[], citations=[]
        )

    outcomes = await asyncio.gather(
        *[
            _search_one(
                search_caller,
                query=body.query,
                version=version,
                asset=asset,
                top_k=body.top_k,
                user=user,
                trace_id=trace_id,
            )
            for version, asset in visible
        ]
    )

    searched_ids = [
        version.id for (version, _asset), (succeeded, _c) in zip(visible, outcomes) if succeeded
    ]

    if not searched_ids:
        # Every targeted Knowledge's search-runtime call failed — a real,
        # actionable outage, not a silent 0-citation response (which would
        # look identical to "no relevant evidence found").
        await record_audit(
            db,
            event_type="KNOWLEDGE_SEARCH_HUB",
            actor=user,
            resource_type="KNOWLEDGE",
            resource_id="-",
            result="ERROR",
            trace_id=trace_id,
            metadata={
                "knowledge_ids_searched": [],
                "result_count": 0,
                "top_k": body.top_k,
                "attempted_count": len(visible),
            },
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_SEARCH_UNAVAILABLE",
            "Knowledge 검색 서비스에 연결할 수 없어 검색을 완료하지 못했습니다.",
            trace_id,
            details={"attempted_count": len(visible)},
        )

    all_citations: list[dict] = [c for _succeeded, citations in outcomes for c in citations]

    # D-046-style ranking: similarity when present, falling back to score —
    # same fallback search-runtime's own consumers already use (see
    # hybrid.py's docstring: similarity is null only for BM25-only chunks).
    def _rank_key(citation: dict) -> float:
        similarity = citation.get("similarity")
        return similarity if similarity is not None else citation.get("score", 0.0)

    all_citations.sort(key=_rank_key, reverse=True)
    truncated = all_citations[: body.top_k]

    await record_audit(
        db,
        event_type="KNOWLEDGE_SEARCH_HUB",
        actor=user,
        resource_type="KNOWLEDGE",
        resource_id="-",
        result="SUCCESS",
        trace_id=trace_id,
        metadata={
            "knowledge_ids_searched": searched_ids,
            "result_count": len(truncated),
            "top_k": body.top_k,
        },
    )

    return KnowledgeSearchResponseOut(
        trace_id=trace_id,
        knowledge_ids_searched=searched_ids,
        citations=[KnowledgeSearchCitationOut(**c) for c in truncated],
    )
