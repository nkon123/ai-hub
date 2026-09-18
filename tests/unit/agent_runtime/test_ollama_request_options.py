"""`OllamaLLMAdapter` 가 실제로 보내는 요청 본문 — `keep_alive` 와 라우팅
호출의 생성 토큰 상한(`options.num_predict`).

**왜 생겼나(2026-09-18 실사용: "채팅 반응이 너무 느리다")**: 한 턴은 답변
전에 모델을 최대 세 번 부른다(KNOWLEDGE_ROUTE / 질의 재작성 / TOOL_ROUTE).
그 셋은 JSON 한 줄만 있으면 되는데 상한이 없어서, 모델이 계속 이어 쓰면
타임아웃(8초)까지 가고 **그 8초 전체가 사용자 대기 시간**이 됐다(실측
`tool.route.no_tool reason=error_or_timeout latency_ms=8010`). 결과는 어차피
버려지는데도 그렇다.

여기서 고정하는 것 셋:
1. 상한을 준 호출에만 `options.num_predict` 가 실린다.
2. **답변 생성에는 상한이 실리지 않는다** — 답을 길이로 자르면 잘린 답이 나온다.
3. `keep_alive` 는 설정이며 비우면 필드 자체를 보내지 않는다(= Ollama 기본값).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from agent_runtime.adapters.ollama import OllamaLLMAdapter
from agent_runtime.config import settings

_MODEL_ALIASES = {
    "default-chat": {
        "provider": "ollama",
        "model_id": "exaone3.5:7.8b",
        "endpoint": "http://127.0.0.1:11434",
    }
}


def _capturing_adapter(sink: list[dict[str, Any]]) -> OllamaLLMAdapter:
    def handler(request: httpx.Request) -> httpx.Response:
        sink.append(json.loads(request.content))
        body = json.dumps({"message": {"content": "ok"}, "done": True})
        return httpx.Response(200, content=(body + "\n").encode())

    return OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))


async def _drain(adapter: OllamaLLMAdapter, **kwargs: Any) -> list[str]:
    return [
        token
        async for token in adapter.generate(
            [{"role": "user", "content": "hi"}], model_alias="default-chat", **kwargs
        )
    ]


async def test_routing_call_carries_the_output_cap() -> None:
    sent: list[dict[str, Any]] = []
    await _drain(_capturing_adapter(sent), max_output_tokens=160)
    assert sent[0]["options"] == {"num_predict": 160}


async def test_answer_generation_sends_no_cap() -> None:
    """상한 없이 부르면 `options` 자체가 없다 — 답변은 길이로 자르지 않는다."""
    sent: list[dict[str, Any]] = []
    await _drain(_capturing_adapter(sent))
    assert "options" not in sent[0]


async def test_keep_alive_is_sent_from_settings(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ollama_keep_alive", "45m")
    sent: list[dict[str, Any]] = []
    await _drain(_capturing_adapter(sent))
    assert sent[0]["keep_alive"] == "45m"


async def test_blank_keep_alive_omits_the_field(monkeypatch) -> None:
    """빈 값은 "0초 유지"가 아니라 "이 필드를 보내지 않는다"여야 한다 —
    0 으로 보내면 매 호출마다 모델이 내려가 정반대로 느려진다."""
    monkeypatch.setattr(settings, "ollama_keep_alive", "")
    sent: list[dict[str, Any]] = []
    await _drain(_capturing_adapter(sent))
    assert "keep_alive" not in sent[0]


async def test_streaming_and_model_fields_are_unchanged() -> None:
    """기존 요청 형태를 그대로 둔다 — 추가 필드 때문에 무엇이 바뀌지 않는다."""
    sent: list[dict[str, Any]] = []
    await _drain(_capturing_adapter(sent), max_output_tokens=32)
    body = sent[0]
    assert body["model"] == "exaone3.5:7.8b"
    assert body["stream"] is True
    assert body["messages"] == [{"role": "user", "content": "hi"}]
