"""AI 추천 문서 텍스트 추출 passthrough — M02.

  POST /api/v1/knowledge/extract-text

.pdf/.docx는 브라우저가 텍스트를 직접 뽑을 수 없다(`.md`/`.txt`는
portal-web이 client-side에서 그대로 읽어 `POST /api/v1/knowledge/
suggest-metadata`에 보낸다 — 이 라우터는 그 경로를 바꾸지 않는다). 이
라우터는 업로드된 파일 bytes를 그대로 `services/indexing-runtime`의
`POST /indexing/v1/extract-text`로 relay해 bounded plain-text excerpt를
받아온다 — root CLAUDE.md UI 구현 규칙 "Portal API는 모델을 직접 호출하지
않는다"의 연장: portal-api는 문서 파싱도 직접 하지 않는다(그 책임은
indexing-runtime의 `loaders/`가 소유, D-073). `knowledge_metadata_suggest.py`
와 정확히 같은 구조(Depends 기반 caller seam, 실 downstream 프로세스 없이
테스트) — portal-api는 auth/RBAC만 담당하고 실제 추출은 downstream이 한다.

Gated by `ASSET_CREATE`(Knowledge 자산 등록과 동일 권한, P12 등록 화면).
Stores nothing: excerpt/문서 bytes 어느 것도 DB에 쓰거나 감사 메타데이터에
남기지 않는다(root CLAUDE.md 코드 규칙: 로그에 문서 원문 저장 금지 —
`knowledge_metadata_suggest.py`가 excerpt에 대해 이미 지키는 것과 동일한
규칙을 여기서는 원본 문서 bytes에 대해서도 지킨다).

두 가지 실패를 UI가 서로 다른 사실로 구분할 수 있게 그대로 살려서 전달한다
(brief의 요구사항, 하나로 뭉개면 안 됨):
- 형식 자체가 지원 대상이 아님 (indexing-runtime의 `VALIDATION_ERROR`) →
  `KNOWLEDGE_TEXT_EXTRACT_REJECTED`, "이 형식은 추천을 지원하지 않습니다"
  계열 문구.
- 형식은 지원되지만 이 배포에 pypdf/python-docx가 설치되지 않음
  (indexing-runtime의 `DEPENDENCY_UNAVAILABLE`, D-073) →
  `KNOWLEDGE_TEXT_EXTRACT_DEPENDENCY_MISSING`, "서버에 PDF/Word 추출
  의존성이 설치되어 있지 않습니다" — 관리자가 고칠 수 있는 사실이라는 점이
  위 형식-미지원과 다르다.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

import httpx
from fastapi import APIRouter, Depends, File, UploadFile, status
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
from portal_api.schemas import ExtractKnowledgeTextResponseOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["knowledge-search"])

ExtractCaller = Callable[[bytes, str], Awaitable[httpx.Response]]


async def _call_indexing_runtime_http(content: bytes, filename: str) -> httpx.Response:
    timeout = settings.knowledge_text_extract_timeout_seconds
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(
            f"{settings.indexing_runtime_url}/indexing/v1/extract-text",
            files={"file": (filename, content)},
        )


def get_extract_caller() -> ExtractCaller:
    """FastAPI dependency seam, overridden in integration tests
    (`app.dependency_overrides[get_extract_caller]`) — mirrors
    `routers.knowledge_metadata_suggest.get_suggest_caller`."""
    return _call_indexing_runtime_http


def _trace_id() -> str:
    return get_trace_id() or str(uuid.uuid4())


@router.post("/knowledge/extract-text", response_model=ExtractKnowledgeTextResponseOut)
async def extract_knowledge_text(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    extract_caller: ExtractCaller = Depends(get_extract_caller),
) -> ExtractKnowledgeTextResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.ASSET_CREATE, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    if not file.filename:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "파일명이 없어 형식을 확인할 수 없습니다.",
            trace_id,
        )

    content = await file.read()

    try:
        resp = await extract_caller(content, file.filename)
    except Exception:
        # Never logs the document bytes — only that the call failed.
        logger.warning(
            "knowledge_text_extract.downstream_unreachable trace_id=%s", trace_id, exc_info=True
        )
        await record_audit(
            db,
            event_type="KNOWLEDGE_TEXT_EXTRACT",
            actor=user,
            resource_type="ASSET",
            resource_id="-",
            result="ERROR",
            trace_id=trace_id,
            metadata={"reason": "INDEXING_RUNTIME_UNREACHABLE"},
        )
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_TEXT_EXTRACT_UNAVAILABLE",
            "문서 추출 서비스에 연결할 수 없습니다. "
            "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    if resp.status_code == 200:
        body_json = resp.json()
        await record_audit(
            db,
            event_type="KNOWLEDGE_TEXT_EXTRACT",
            actor=user,
            resource_type="ASSET",
            resource_id="-",
            result="SUCCESS",
            trace_id=trace_id,
            metadata={"filename": file.filename},
        )
        return ExtractKnowledgeTextResponseOut(
            excerpt=body_json.get("excerpt", ""),
            trace_id=trace_id,
        )

    downstream_code: str | None = None
    try:
        downstream_code = resp.json().get("error", {}).get("code")
    except Exception:
        pass

    logger.warning(
        "knowledge_text_extract.downstream_failed trace_id=%s status=%d code=%s",
        trace_id,
        resp.status_code,
        downstream_code,
    )
    await record_audit(
        db,
        event_type="KNOWLEDGE_TEXT_EXTRACT",
        actor=user,
        resource_type="ASSET",
        resource_id="-",
        result="ERROR",
        trace_id=trace_id,
        metadata={"reason": downstream_code or "UNKNOWN", "status": resp.status_code},
    )

    # 형식은 지원되지만 이 배포에 의존성이 없는 경우 — 재시도해도 절대 성공하지
    # 않고, 관리자가 설치해야만 고쳐지는 사실이므로 별도 코드/문구로 남긴다
    # (형식 미지원과 절대 같은 문구로 뭉개지 않는다 — 이 브리프의 핵심 요구사항).
    if downstream_code == "DEPENDENCY_UNAVAILABLE":
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_TEXT_EXTRACT_DEPENDENCY_MISSING",
            "서버에 PDF/Word 추출 의존성이 설치되어 있지 않습니다. "
            "관리자에게 설치를 요청하거나, 이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    if resp.status_code >= 500:
        return error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "KNOWLEDGE_TEXT_EXTRACT_UNAVAILABLE",
            "문서에서 내용을 추출하지 못했습니다. "
            "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
            trace_id,
        )

    # 형식 미지원(422)/크기 초과(413) 등 — indexing-runtime의 메시지는 이미
    # 한국어·사용자용이므로(원본 문서 내용은 절대 포함하지 않음) 그대로 전달한다.
    downstream_message: str | None = None
    try:
        downstream_message = resp.json().get("error", {}).get("message")
    except Exception:
        pass

    fallback_message = (
        "문서에서 내용을 추출하지 못했습니다. 이름과 설명을 직접 입력해 등록을 진행할 수 있습니다."
    )
    return error_response(
        status.HTTP_400_BAD_REQUEST,
        "KNOWLEDGE_TEXT_EXTRACT_REJECTED",
        downstream_message or fallback_message,
        trace_id,
    )
