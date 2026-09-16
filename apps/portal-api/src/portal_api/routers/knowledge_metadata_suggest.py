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


def _downstream_error(resp: httpx.Response) -> tuple[str | None, str | None]:
    """agent-runtime이 보낸 `{"error": {"code", "message"}}`에서 code/message를
    꺼낸다. 없으면 `(None, None)`.

    이걸 꺼내 쓰는 이유(2026-09-16 실사용): agent-runtime은 D-091 이후
    "모델 'X'가 Ollama에 설치되어 있지 않습니다 — `ollama pull X`" 처럼 한 줄로
    끝나는 조치를 알려주는데, 여기서 고정 문구로 덮어쓰면 그 안내가 사용자에게
    도달하지 못하고 화면에는 원인도 조치도 없는 막다른 메시지만 남는다.
    downstream이 JSON이 아닐 수 있는 것은 프로세스 경계라 실제로 가능하다
    (중간 프록시의 502 HTML 등) — 그때는 기존 고정 문구로 되돌아간다."""
    try:
        payload = resp.json()
    except ValueError:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None, None

    def _text(key: str) -> str | None:
        value = error.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else None

    return _text("code"), _text("message")


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

    if resp.status_code >= 500:
        downstream_code, downstream_message = _downstream_error(resp)
        logger.warning(
            "knowledge_metadata_suggest.downstream_failed trace_id=%s status=%d code=%s",
            trace_id,
            resp.status_code,
            downstream_code,
        )
        await record_audit(
            db,
            event_type="KNOWLEDGE_METADATA_SUGGEST",
            actor=user,
            resource_type="ASSET",
            resource_id="-",
            result="ERROR",
            trace_id=trace_id,
            metadata={"reason": downstream_code or "MODEL_UNAVAILABLE"},
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_METADATA_SUGGEST_UNAVAILABLE",
            downstream_message or "AI 추천을 생성하지 못했습니다. 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    if resp.status_code != 200:
        downstream_code, downstream_message = _downstream_error(resp)
        logger.warning(
            "knowledge_metadata_suggest.downstream_rejected trace_id=%s status=%d code=%s",
            trace_id,
            resp.status_code,
            downstream_code,
        )
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "KNOWLEDGE_METADATA_SUGGEST_REJECTED",
            downstream_message or "AI 추천 요청이 거부되었습니다. 직접 입력해 등록을 진행할 수 있습니다.",
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
