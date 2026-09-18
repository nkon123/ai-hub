"""라우팅 3종이 생성 토큰 상한을 **실제로 넘기는지** 고정한다.

어댑터가 상한을 보낼 줄 아는 것(`test_ollama_request_options.py`)과 호출부가
그것을 넘기는 것은 다른 사실이다. 한쪽만 있으면 설정은 있는데 아무 효과가
없는 상태가 조용히 생긴다 — 이 저장소가 반복해서 겪은 유형이다(설정이 있는데
읽는 쪽이 다른 것을 본다).

`settings.router_max_output_tokens <= 0` 이면 상한을 보내지 않는다(기존 동작
그대로 되돌릴 수 있는 탈출구).
"""

from __future__ import annotations

from typing import Any

import pytest
from agent_runtime.config import settings
from agent_runtime.conversation import ConversationTurn, rewrite_query_for_search
from agent_runtime.knowledge_router import route_knowledge_candidates
from agent_runtime.tool_router import route_tool_call


class _RecordingAdapter:
    """모델 호출 인자만 기록하고 빈 응답을 돌려주는 가짜 어댑터."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(  # type: ignore[override]
        self,
        messages: list[dict[str, Any]],
        model_alias: str,
        stream: bool = True,
        max_output_tokens: int | None = None,
    ):
        self.calls.append({"model_alias": model_alias, "max_output_tokens": max_output_tokens})
        yield "{}"


CANDIDATE_TOOLS = [
    {"tool_name": "hello.now", "input_schema": {"type": "object"}, "description": "현재 시각"},
    {"tool_name": "hello.echo", "input_schema": {"type": "object"}, "description": "에코"},
]
CANDIDATE_KNOWLEDGE = [
    {"knowledge_id": "k1", "name": "인사 규정", "description": ""},
    {"knowledge_id": "k2", "name": "보안 규정", "description": ""},
]


@pytest.mark.parametrize("configured", [160, 32])
async def test_tool_route_passes_the_cap(configured: int, monkeypatch) -> None:
    monkeypatch.setattr(settings, "router_max_output_tokens", configured)
    adapter = _RecordingAdapter()
    await route_tool_call(
        "지금 몇 시야?", CANDIDATE_TOOLS, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert adapter.calls and adapter.calls[0]["max_output_tokens"] == configured


async def test_knowledge_route_passes_the_cap(monkeypatch) -> None:
    monkeypatch.setattr(settings, "router_max_output_tokens", 160)
    adapter = _RecordingAdapter()
    await route_knowledge_candidates(
        "연차 규정 알려줘",
        CANDIDATE_KNOWLEDGE,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        # 후보가 이 값 이하면 라우팅 자체를 건너뛴다 — 0 이어야 실제로 호출된다.
        skip_threshold=0,
    )
    assert adapter.calls and adapter.calls[0]["max_output_tokens"] == 160


async def test_query_rewrite_passes_the_cap(monkeypatch) -> None:
    monkeypatch.setattr(settings, "router_max_output_tokens", 160)
    adapter = _RecordingAdapter()
    history: list[ConversationTurn] = [{"question": "육아휴직 알려줘", "answer": "..."}]
    await rewrite_query_for_search(
        "그럼 신청은 어떻게 해?",
        history,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
    )
    assert adapter.calls and adapter.calls[0]["max_output_tokens"] == 160


async def test_zero_or_negative_setting_sends_no_cap(monkeypatch) -> None:
    """상한을 끄는 방법이 있어야 한다 — 새 기본값이 어떤 모델에서 답을 잘라
    먹더라도 설정 하나로 예전 동작으로 돌아갈 수 있어야 한다."""
    monkeypatch.setattr(settings, "router_max_output_tokens", 0)
    adapter = _RecordingAdapter()
    await route_tool_call(
        "지금 몇 시야?", CANDIDATE_TOOLS, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert adapter.calls and adapter.calls[0]["max_output_tokens"] is None
