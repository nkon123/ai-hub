"""AI 추천 passthrough — M02.

  POST /api/v1/knowledge/suggest-metadata

Root CLAUDE.md UI 구현 규칙: "Portal API는 모델을 직접 호출하지 않는다." This
router never calls Ollama or any model — it is a thin, stateless relay to
`services/agent-runtime`'s `POST /local/v1/knowledge-metadata-suggest`,
exactly mirroring `routers.knowledge_search`'s division of labor
(`_call_search_runtime_http`/`get_search_caller`): portal-api owns
auth/RBAC, the downstream service does the actual work, and the caller seam
is a `Depends`-based function so tests never need a live agent-runtime
process.

Gated by `ASSET_CREATE` (registering a Knowledge asset already requires
this permission — P12 등록 화면). Stores nothing: no DB write, no audit
metadata containing the excerpt/prompt/output (root CLAUDE.md 코드 규칙: 로그에
Prompt 원문/문서 전체 저장 금지 — same rule `knowledge_search.py` already
follows for query text).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

import httpx
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import Permission
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.errors import error_response
from portal_api.rbac import require_permission
from portal_api.schemas import SuggestKnowledgeMetadataRequest, SuggestKnowledgeMetadataResponseOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["knowledge-search"])

SuggestCaller = Callable[[dict], Awaitable[httpx.Response]]


async def _call_agent_runtime_http(payload: dict) -> httpx.Response:
    timeout = settings.knowledge_metadata_suggest_timeout_seconds
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(
            f"{settings.agent_runtime_url}/local/v1/knowledge-metadata-suggest", json=payload
        )


def get_suggest_caller() -> SuggestCaller:
    """FastAPI dependency seam, overridden in integration tests
    (`app.dependency_overrides[get_suggest_caller]`) — mirrors
    `routers.knowledge_search.get_search_caller`."""
    return _call_agent_runtime_http


def _trace_id() -> str:
    return get_trace_id() or str(uuid.uuid4())


@router.post("/knowledge/suggest-metadata", response_model=SuggestKnowledgeMetadataResponseOut)
async def suggest_knowledge_metadata(
    body: SuggestKnowledgeMetadataRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    suggest_caller: SuggestCaller = Depends(get_suggest_caller),
) -> SuggestKnowledgeMetadataResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.ASSET_CREATE, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    payload = {"excerpt": body.excerpt, "filename": body.filename, "trace_id": trace_id}

    try:
        resp = await suggest_caller(payload)
    except Exception:
        # Never logs excerpt/prompt/output — only that the call failed.
        logger.warning(
            "knowledge_metadata_suggest.downstream_unreachable trace_id=%s",
            trace_id,
            exc_info=True,
        )
        await record_audit(
            db,
            event_type="KNOWLEDGE_METADATA_SUGGEST",
            actor=user,
            resource_type="ASSET",
            resource_id="-",
            result="ERROR",
            trace_id=trace_id,
            metadata={"reason": "AGENT_RUNTIME_UNREACHABLE"},
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_METADATA_SUGGEST_UNAVAILABLE",
            "AI 추천 서비스에 연결할 수 없습니다. 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    if resp.status_code >= 500 or resp.status_code == 503:
        logger.warning(
            "knowledge_metadata_suggest.downstream_failed trace_id=%s status=%d",
            trace_id,
            resp.status_code,
        )
        await record_audit(
            db,
            event_type="KNOWLEDGE_METADATA_SUGGEST",
            actor=user,
            resource_type="ASSET",
            resource_id="-",
            result="ERROR",
            trace_id=trace_id,
            metadata={"reason": "MODEL_UNAVAILABLE"},
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_METADATA_SUGGEST_UNAVAILABLE",
            "AI 추천을 생성하지 못했습니다. 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    if resp.status_code != 200:
        logger.warning(
            "knowledge_metadata_suggest.downstream_rejected trace_id=%s status=%d",
            trace_id,
            resp.status_code,
        )
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "KNOWLEDGE_METADATA_SUGGEST_REJECTED",
            "AI 추천 요청이 거부되었습니다. 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    body_json = resp.json()

    await record_audit(
        db,
        event_type="KNOWLEDGE_METADATA_SUGGEST",
        actor=user,
        resource_type="ASSET",
        resource_id="-",
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"filename": body.filename},
    )

    return SuggestKnowledgeMetadataResponseOut(
        suggested_name=body_json.get("suggested_name", ""),
        suggested_description=body_json.get("suggested_description", ""),
        trace_id=trace_id,
    )
