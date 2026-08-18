"""AI 추천 — POST /local/v1/knowledge-metadata-suggest.

Narrow, single-purpose endpoint: given a bounded plain-text excerpt of a
document the caller is about to register as Knowledge (plus its filename),
ask the LLM for a suggested 지식 명/설명 and return them verbatim. This is
NOT a general-purpose "send me a prompt, get text" route — deliberately so
(구현 원칙 7). It never touches `/local/v1/runs*`, `RunStore`, or the D-036
hallucination guard: this is one non-streaming completion, not a Run.

Callers (see `apps/portal-api/src/portal_api/routers/knowledge_metadata_suggest.py`,
which relays here) must treat the response as a suggestion only — editable
text, never auto-submitted, never executed, never used to build a path.

로그 규칙 (root CLAUDE.md 코드 규칙): the excerpt, the assembled prompt, and
the raw model output are never logged — only call outcome/timing/trace_id,
mirroring `routers/knowledge_search.py`'s "never log the query text" rule
in portal-api.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from typing import cast

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from agent_runtime.adapters import LLMAdapter
from agent_runtime.config import settings
from agent_runtime.routers.runs import get_llm_adapter

logger = logging.getLogger(__name__)

router = APIRouter()

_SYSTEM_PROMPT = (
    "당신은 사내 지식 등록 화면에서 문서 일부를 보고 등록 정보를 제안하는 "
    "도우미입니다. 주어진 파일명과 문서 앞부분을 참고해 이 문서를 "
    "대표하는 짧은 '지식 명'과 2~3문장의 '설명'을 한국어로 제안하세요. "
    "다른 말은 절대 덧붙이지 말고, 아래 JSON 형식으로만 답하세요: "
    '{"name": "...", "description": "..."}'
)

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


class SuggestKnowledgeMetadataRequest(BaseModel):
    excerpt: str = Field(min_length=1)
    filename: str
    trace_id: str | None = None


class SuggestKnowledgeMetadataResponse(BaseModel):
    suggested_name: str
    suggested_description: str
    trace_id: str


def _error_envelope(status_code: int, code: str, message: str, trace_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "trace_id": trace_id}},
    )


def _parse_suggestion(raw_text: str, *, filename: str) -> tuple[str, str]:
    """Best-effort extraction of {"name": ..., "description": ...} from
    untrusted model output. Never raises — malformed output degrades to a
    filename-derived name and the raw (trimmed) text as description, since
    the caller always renders both as plain editable text (never executed,
    never parsed as anything else)."""
    match = _JSON_OBJECT_RE.search(raw_text)
    if match:
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name")
            description = parsed.get("description")
            if isinstance(name, str) and name.strip():
                return name.strip(), (description.strip() if isinstance(description, str) else "")

    # Fallback: model didn't return valid JSON. Derive a plain name from the
    # filename and use the raw text (trimmed) as the description so nothing
    # is silently dropped.
    stem = re.sub(r"\.[^.]+$", "", filename)
    fallback_name = re.sub(r"[_-]+", " ", stem).strip() or filename
    return fallback_name, raw_text.strip()


@router.post("/knowledge-metadata-suggest", response_model=SuggestKnowledgeMetadataResponse)
async def suggest_knowledge_metadata(
    body: SuggestKnowledgeMetadataRequest,
    llm_adapter: LLMAdapter = Depends(get_llm_adapter),
) -> SuggestKnowledgeMetadataResponse | JSONResponse:
    trace_id = body.trace_id or str(uuid.uuid4())

    excerpt = body.excerpt.strip()
    if not excerpt:
        return _error_envelope(
            400, "VALIDATION_ERROR", "문서에서 추출한 내용이 비어 있습니다.", trace_id
        )

    bounded_excerpt = excerpt[: settings.knowledge_metadata_suggest_excerpt_max_chars]

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"파일명: {body.filename}\n\n문서 내용 일부:\n{bounded_excerpt}",
        },
    ]

    try:
        async with asyncio.timeout(settings.knowledge_metadata_suggest_timeout_seconds):
            agen = cast(
                "asyncio.AsyncIterator[str]",
                llm_adapter.generate(messages, model_alias="default-chat", stream=False),
            )
            parts: list[str] = []
            async for token in agen:
                parts.append(token)
    except TimeoutError:
        logger.warning("knowledge_metadata_suggest.timeout trace_id=%s", trace_id)
        return _error_envelope(
            503,
            "MODEL_UNAVAILABLE",
            "AI 추천 응답이 시간 내에 오지 않았습니다. 직접 입력해 주세요.",
            trace_id,
        )
    except Exception:
        logger.warning(
            "knowledge_metadata_suggest.model_call_failed trace_id=%s", trace_id, exc_info=True
        )
        return _error_envelope(
            503,
            "MODEL_UNAVAILABLE",
            "AI 추천을 생성하지 못했습니다. 직접 입력해 주세요.",
            trace_id,
        )

    raw_text = "".join(parts)
    if not raw_text.strip():
        return _error_envelope(
            503,
            "MODEL_UNAVAILABLE",
            "AI 추천을 생성하지 못했습니다. 직접 입력해 주세요.",
            trace_id,
        )

    suggested_name, suggested_description = _parse_suggestion(raw_text, filename=body.filename)
    logger.info("knowledge_metadata_suggest.completed trace_id=%s", trace_id)

    return SuggestKnowledgeMetadataResponse(
        suggested_name=suggested_name,
        suggested_description=suggested_description,
        trace_id=trace_id,
    )
