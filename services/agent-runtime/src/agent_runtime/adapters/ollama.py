"""LLM adapter backed by a local Ollama server."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from agent_runtime.adapters import LLMAdapter
from agent_runtime.config import settings

logger = logging.getLogger(__name__)


class OllamaModelNotFoundError(Exception):
    """Ollama returned HTTP 404 with an `{"error": "model '<id>' not found"}`
    body from `/api/chat` — meaning `model_id` is not installed on the
    Ollama instance at `endpoint`, NOT that the endpoint/route is missing
    (Ollama's own `/api/chat` route exists regardless; a GET to it 405s, it
    never 404s). This is a configuration problem with a one-line fix
    (`ollama pull <model_id>`, or point `model_id` at a model that is
    already installed), and must never be reported to a user the same way
    as "Ollama is unreachable" (connection refused/timeout) or "Ollama
    itself errored" (500) — those need different remedies (실사용 제보
    2026-08-20, see docs/implementation-spec/open-decisions.md).

    `model_id`/`model_alias` are not secrets — safe to log and to surface
    verbatim in an API error response.
    """

    def __init__(self, *, model_id: str, model_alias: str) -> None:
        self.model_id = model_id
        self.model_alias = model_alias
        super().__init__(
            f"Ollama model '{model_id}' (alias '{model_alias}') is not installed"
        )


class OllamaLLMAdapter(LLMAdapter):
    """Calls Ollama's /api/chat streaming endpoint.

    model_aliases: the Office Profile's model_aliases mapping, e.g.
    {"default-chat": {"provider": "ollama", "model_id": "exaone3.5:7.8b",
    "endpoint": "http://127.0.0.1:11434", ...}}
    """

    def __init__(
        self,
        model_aliases: dict[str, dict[str, Any]],
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._model_aliases = model_aliases
        # Test-only hook (httpx.MockTransport) — production callers never
        # pass this, so `httpx.AsyncClient` still opens a real connection to
        # `endpoint` exactly as before.
        self._transport = transport

    # LLMAdapter.generate is declared `async def ... -> AsyncIterator[str]` in
    # the frozen ABC (agent_runtime/adapters/__init__.py, not modifiable here).
    # Implemented as an async generator (uses `yield`) so callers can
    # `async for` it directly without awaiting first; mypy sees this as a
    # Coroutine[..., AsyncIterator[str]] vs AsyncIterator[str] mismatch against
    # the supertype even though the runtime contract (and workflow.py's usage)
    # requires the generator form.
    async def generate(  # type: ignore[override, misc]
        self,
        messages: list[dict[str, Any]],
        model_alias: str,
        stream: bool = True,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        alias_config = self._model_aliases.get(model_alias)
        if alias_config is None:
            raise ValueError(f"Unknown model_alias: {model_alias}")

        model_id = alias_config["model_id"]
        endpoint = alias_config["endpoint"]

        async for token in self._stream_chat(
            endpoint,
            model_id,
            messages,
            model_alias=model_alias,
            transport=self._transport,
            max_output_tokens=max_output_tokens,
        ):
            yield token

    #: `think` 필드를 거부한 (endpoint, model). 한 번 거부되면 그 모델에는 다시
    #: 보내지 않는다 — 매 라우팅 호출마다 거부→재시도를 반복하면 줄이려던
    #: 대기 시간이 다시 늘어난다.
    _think_unsupported: set[tuple[str, str]] = set()

    @staticmethod
    async def _stream_chat(
        endpoint: str,
        model_id: str,
        messages: list[dict[str, Any]],
        *,
        model_alias: str,
        transport: httpx.BaseTransport | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        # `keep_alive` 를 명시하는 이유: 기본값(5분)으로 두면 대화가 잠깐만
        # 뜸해도 모델이 내려가고, 다음 질문의 첫 토큰이 모델 로딩 시간을 통째로
        # 기다린다. 값은 설정(`AGENT_RUNTIME_OLLAMA_KEEP_ALIVE`)이며, 빈 값으로
        # 두면 이 필드를 아예 보내지 않는다(= Ollama 기본값, 기존 동작).
        body: dict[str, Any] = {"model": model_id, "messages": messages, "stream": True}
        if settings.ollama_keep_alive:
            body["keep_alive"] = settings.ollama_keep_alive
        if max_output_tokens is not None:
            # 라우팅처럼 짧은 JSON 하나면 끝나는 호출에만 온다 — 그 자리에
            # 상한이 없으면 모델이 계속 쓰다 타임아웃까지 간다(ABC docstring).
            body["options"] = {"num_predict": max_output_tokens}
            # 상한을 준 호출은 **생각(thinking)을 끈다.** 생각하는 모델(gemma4,
            # qwen3 등)은 답 전에 숨은 추론을 쓰는데 그것도 `num_predict` 를
            # 소비한다 — 160 토큰을 추론에 다 쓰고 JSON 을 한 글자도 못 쓴 채
            # `done_reason=length` 로 끝난다(2026-09-18 실측: TOOL_ROUTE 6회 중
            # 5회가 빈 응답 → `unparseable`, "MCP 자동 선택이 전혀 동작 안 함").
            # 끄면 같은 질문이 6/6 정답에 0.2~0.4초. 답변 생성(상한 없음)은
            # 건드리지 않는다 — 거기서는 추론이 품질이다.
            if (endpoint, model_id) not in OllamaLLMAdapter._think_unsupported:
                body["think"] = False
        async with httpx.AsyncClient(timeout=None, transport=transport) as client:
            # `think` 를 모르는 모델/구버전 Ollama 가 400 으로 거부하면 그 필드만
            # 빼고 한 번 더 보낸다 — 이 최적화 때문에 원래 되던 호출이 실패하면
            # 안 된다. 아직 아무것도 yield 하지 않은 시점이라 재시도가 안전하다.
            if "think" in body:
                async with client.stream("POST", f"{endpoint}/api/chat", json=body) as first:
                    if first.status_code == 400:
                        error_text = (await first.aread()).decode("utf-8", "replace").lower()
                        if "think" in error_text:
                            OllamaLLMAdapter._think_unsupported.add((endpoint, model_id))
                            body = {k: v for k, v in body.items() if k != "think"}
                    if "think" in body:
                        async for token in OllamaLLMAdapter._consume(first, model_id, model_alias):
                            yield token
                        return
            async with client.stream(
                "POST",
                f"{endpoint}/api/chat",
                json=body,
            ) as response:
                async for token in OllamaLLMAdapter._consume(response, model_id, model_alias):
                    yield token

    @staticmethod
    async def _consume(
        response: httpx.Response, model_id: str, model_alias: str
    ) -> AsyncIterator[str]:
        """스트림 응답 하나를 읽어 content 토큰을 내보낸다(오류 판정 포함)."""
        if response.status_code == 404:
            # Ollama's own /api/chat route always exists (a GET to it
            # 405s, never 404s) — a 404 here means the model isn't
            # installed, distinguishable only by reading the body,
            # never by status code alone. Read it before
            # raise_for_status() consumes the response.
            raw_body = await response.aread()
            error_message = ""
            try:
                parsed_body = json.loads(raw_body)
            except json.JSONDecodeError:
                parsed_body = None
            if isinstance(parsed_body, dict):
                error_message = str(parsed_body.get("error", ""))
            if "not found" in error_message.lower():
                raise OllamaModelNotFoundError(
                    model_id=model_id, model_alias=model_alias
                )
            # Unrecognized 404 shape — fall through to the generic
            # HTTP error path rather than guessing.
        response.raise_for_status()
        async for raw_line in response.aiter_lines():
            if not raw_line.strip():
                continue
            line = json.loads(raw_line)
            content = line.get("message", {}).get("content")
            if content:
                yield content
            if line.get("done"):
                break
