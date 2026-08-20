"""GET /local/v1/models — installed chat model discovery (D-092,
open-decisions.md).

Mirrors indexing-runtime's `GET /indexing/v1/models`
(services/indexing-runtime/src/indexing_runtime/main.py) — same response
shape, same "Ollama unreachable vs zero models installed are two different,
distinguishable states" rule, same reason it exists on this side and not
portal-api's: root CLAUDE.md "Portal API는 모델을 직접 호출하지 않는다"
means the service that already owns the Ollama relationship for chat
completions (this one) is what portal-api's P15 admin screen calls over
HTTP, not the other way around.
"""

from __future__ import annotations

import logging
import uuid

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from observability import bind_trace_id

from agent_runtime.chat_model_setting_cache import get_chat_model_setting_cache
from agent_runtime.config import settings
from agent_runtime.manifests import get_standard_config
from agent_runtime.ollama_models import is_chat_capable, list_ollama_models

logger = logging.getLogger(__name__)

router = APIRouter()


def _error_envelope(status_code: int, code: str, message: str, trace_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "trace_id": trace_id}},
    )


@router.get("/models")
async def list_chat_models() -> JSONResponse:
    """설치된 채팅 모델 목록과, 지금 실제로 적용되는 `default_chat_model`을
    함께 돌려준다 — portal-api의 P15 관리자 화면(D-092)이 이 endpoint를
    호출해 선택지를 채우고, 저장 시 그 안에서 고른 모델이 설치돼 있는지
    다시 검증한다.

    Ollama에 닿지 못하는 것(MODEL_UNAVAILABLE, 503)과 설치된 모델이 0개인
    것(`models: []`, 200 성공)은 반드시 구별한다 — 전자는 원인이 이
    서비스/Ollama 쪽에 있고, 후자는 정상 상태(그저 아직 아무 모델도 pull
    되지 않았을 뿐)다. 이 둘을 뭉뚱그리면 관리자가 "모델이 하나도 없다"는
    화면과 "지금 물어볼 수조차 없다"는 화면을 구별하지 못한다.
    """
    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)

    try:
        raw_models = await list_ollama_models(settings.ollama_endpoint)
    except httpx.HTTPError as exc:
        logger.warning("agent_runtime.models.ollama_unavailable error=%s", exc)
        return _error_envelope(
            503,
            "MODEL_UNAVAILABLE",
            "Ollama에 연결할 수 없어 사용 가능한 채팅 모델 목록을 가져올 수 없습니다.",
            trace_id,
        )

    models = [
        {
            "name": name,
            "chat_capable": is_chat_capable(m),
            "size": m.get("size"),
            "modified_at": m.get("modified_at"),
        }
        for m in raw_models
        if (name := (m.get("name") or m.get("model")))
    ]

    # 지금 실제로 적용되는 default-chat model_id — D-092 우선순위: Portal
    # 설정 > AGENT_RUNTIME_CHAT_MODEL_ID > office-profile.json. 뒤 두 층은
    # 이미 `manifests._load_default_office_profile`이 기동 시점에 반영해
    # `office_profile`에 구워 넣어 두므로, 여기서는 그 값을 기본값으로 두고
    # Portal 설정(TTL 캐시, 있으면)이 있을 때만 그 위에 올려 덮어쓴다 —
    # `routers/runs.get_llm_adapter`가 실제 LLM 호출에 쓰는 것과 동일한
    # 우선순위 계산이다.
    office_profile_model_id = (
        get_standard_config()
        .office_profile.get("model_aliases", {})
        .get("default-chat", {})
        .get("model_id")
    )
    configured_model = await get_chat_model_setting_cache().get_configured_chat_model()
    default_chat_model = configured_model or office_profile_model_id

    return JSONResponse({
        "models": models,
        "default_chat_model": default_chat_model,
        "source": f"{settings.ollama_endpoint}/api/tags",
        "trace_id": trace_id,
    })
