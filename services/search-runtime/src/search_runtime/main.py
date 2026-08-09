"""Search Runtime — Hybrid Knowledge Search API (M08)."""

from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from observability import bind_run_id, bind_trace_id, configure_logging
from pydantic import BaseModel

from search_runtime import access_control
from search_runtime.errors import error_envelope, status_for
from search_runtime.hybrid import hybrid_search
from search_runtime.settings import (
    ALLOW_UNKNOWN_CLASSIFICATION,
    DEFAULT_MIN_RELEVANCE_SCORE,
    DEFAULT_QUERY_INSTRUCT_PREFIX,
)

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn.
configure_logging("search-runtime")
_logger = logging.getLogger("search_runtime")

app = FastAPI(title="Knowledge Search Runtime", version="0.1.0")


class SearchRequest(BaseModel):
    query: str
    knowledge_id: str
    knowledge_version: str = "latest"
    top_k: int = 5
    alpha: float = 0.5
    metadata_filters: dict | None = None
    # Additive/optional (D-062-style precedent: indexing-runtime's
    # `profile: dict | None`, D-053): a possibly-partial, already-resolved
    # Retrieval Profile dict (packages/schemas/profiles/retrieval-profile
    # .schema.json subset). Only `metadata_filters` (§3.8 step 3, "Profile
    # Default Filter") is read today — there is no Profile Registry in this
    # PoC, so this is caller-supplied JSON in the same request, the same
    # trust boundary as `metadata_filters` (see access_control module
    # docstring: both go through reject_acl_override).
    retrieval_profile: dict | None = None
    # §3.8 step 1. Optional on the wire for backward compatibility with
    # callers that predate this feature — see
    # access_control.validate_access_context for exactly what "missing"
    # resolves to (least privilege, not "no check").
    access_context: dict | None = None
    trace_id: str | None = None
    run_id: str | None = None
    # D-046: relevance floor + query-side embedding prefix. Both default to
    # the policy settings in search_runtime.settings (env-overridable), not
    # a literal here — same pattern top_k/alpha already follow for callers
    # that want a per-request override (e.g. the evaluation runner).
    min_relevance_score: float = DEFAULT_MIN_RELEVANCE_SCORE
    query_instruct_prefix: str = DEFAULT_QUERY_INSTRUCT_PREFIX


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.1.0"})


@app.post("/search/v1/query")
async def query(req: SearchRequest) -> JSONResponse:
    import time

    start = time.monotonic()
    trace_id = req.trace_id or str(uuid.uuid4())
    search_id = str(uuid.uuid4())
    # Bind the caller's trace_id/run_id (agent-runtime's Knowledge Search
    # stage, or any other caller) so the rest of this request's log lines
    # correlate with the same id the caller already logged (README §15 step
    # 12 / NFR-04). No reset needed — each request runs in its own task.
    bind_trace_id(trace_id)
    bind_run_id(req.run_id)

    _logger.info(
        "search.query.started knowledge_id=%s top_k=%d alpha=%.2f",
        req.knowledge_id,
        req.top_k,
        req.alpha,
    )

    # 04-knowledge-platform.md §3.8, in this exact order — see
    # access_control.py's module docstring for why each step lives where it
    # does. Any AccessControlError here means the request is rejected
    # outright (never a silent drop of the offending field).
    try:
        # Step 1: 사용자 Access Context 검증
        access_context = access_control.validate_access_context(req.access_context)

        profile_default_filters = (req.retrieval_profile or {}).get("metadata_filters")
        # §3.8: "사용자가 요청에서 ACL Field를 덮어쓸 수 없다" — checked
        # against both candidate filter sources before either is merged.
        access_control.reject_acl_override(req.metadata_filters, source="metadata_filters")
        access_control.reject_acl_override(
            profile_default_filters, source="retrieval_profile.metadata_filters"
        )

        # Step 2: 강제 ACL Filter 생성 — derived only from the validated
        # clearance + the service-level policy setting, never from the
        # request body (this is what makes it unoverridable).
        allowed_classifications = access_control.forced_allowed_classifications(
            access_context.clearance,
            allow_unknown_classification=ALLOW_UNKNOWN_CLASSIFICATION,
        )

        # Steps 3-5: Profile Default Filter, 사용자가 요청한 허용 Filter,
        # 충돌 시 더 제한적인 조건 사용 — one merge function, see its
        # docstring for the conflict rule.
        business_filters = access_control.merge_business_filters(
            profile_default_filters, req.metadata_filters
        )
    except access_control.AccessControlError as exc:
        _logger.warning(
            "search.query.access_denied trace_id=%s reason=%s",
            trace_id,
            exc.details.get("reason"),
        )
        return JSONResponse(
            status_code=status_for(exc.code),
            content=error_envelope(exc.code, exc.message, trace_id, details=exc.details),
        )

    def _visible(metadata: dict) -> bool:
        return access_control.chunk_is_visible(
            metadata,
            allowed_classifications=allowed_classifications,
            business_filters=business_filters,
        )

    citations = await hybrid_search(
        query=req.query,
        knowledge_id=req.knowledge_id,
        top_k=req.top_k,
        alpha=req.alpha,
        min_relevance_score=req.min_relevance_score,
        query_instruct_prefix=req.query_instruct_prefix,
        metadata_predicate=_visible,
    )

    latency_ms = int((time.monotonic() - start) * 1000)
    _logger.info(
        "search.query.completed citation_count=%d latency_ms=%d",
        len(citations),
        latency_ms,
    )

    return JSONResponse({
        "citations": citations,
        "total_chunks_searched": len(citations),
        "latency_ms": latency_ms,
        "trace_id": trace_id,
        "search_id": search_id,
        # D-046: additive field — echoes the threshold actually applied
        # (request override or the settings default) for debugging and for
        # packages/evaluation-runner's Data Card. Existing consumers
        # (agent_runtime.adapters.search.HttpKnowledgeAdapter,
        # evaluation_runner.search_client.SearchResponse.from_dict) only
        # read known keys and ignore unrecognized ones.
        "min_relevance_score_applied": req.min_relevance_score,
    })
