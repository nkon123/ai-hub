"""OllamaLLMAdapter — distinguishing "model not installed" (404 +
`{"error": "model ... not found"}`) from every other Ollama failure mode
(connection refused, timeout, 500, an unrecognized 404 shape).

실사용 제보(2026-08-20, D-091, open-decisions.md): Ollama's own `/api/chat`
route always exists (a GET to it 405s, never 404s) — a 404 from a POST means
the configured `model_id` isn't installed. `OllamaLLMAdapter` must raise the
dedicated `OllamaModelNotFoundError` ONLY for that specific shape, so a
caller can tell a one-line-fix configuration problem
(`ollama pull <model_id>`) apart from "Ollama is down" — conflating them
was exactly the reported bug (routers/knowledge_metadata_suggest.py and
workflow.py both collapsed every failure into the same generic message).

Uses `httpx.MockTransport` (via `OllamaLLMAdapter(transport=...)`, a
test-only hook) — no real Ollama process involved.
"""

from __future__ import annotations

import json

import httpx
import pytest
from agent_runtime.adapters.ollama import OllamaLLMAdapter, OllamaModelNotFoundError

_MODEL_ALIASES = {
    "default-chat": {
        "provider": "ollama",
        "model_id": "exaone3.5:7.8b",
        "endpoint": "http://127.0.0.1:11434",
    }
}


async def _drain(adapter: OllamaLLMAdapter) -> list[str]:
    return [
        token
        async for token in adapter.generate(
            [{"role": "user", "content": "hi"}], model_alias="default-chat"
        )
    ]


# --- The bug being fixed: 404 + "model ... not found" is distinguishable ---


async def test_model_not_found_404_raises_dedicated_exception() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404, json={"error": "model 'exaone3.5:7.8b' not found, try pulling it first"}
        )

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(OllamaModelNotFoundError) as exc_info:
        await _drain(adapter)

    assert exc_info.value.model_id == "exaone3.5:7.8b"
    assert exc_info.value.model_alias == "default-chat"


async def test_model_not_found_error_message_names_model_and_alias() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "model 'exaone3.5:7.8b' not found"})

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(OllamaModelNotFoundError) as exc_info:
        await _drain(adapter)

    message = str(exc_info.value)
    assert "exaone3.5:7.8b" in message
    assert "default-chat" in message


# --- Every other failure mode must NOT be misclassified as model-not-found ---


async def test_connection_refused_is_not_misclassified_as_model_not_found() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.ConnectError):
        await _drain(adapter)


async def test_timeout_is_not_misclassified_as_model_not_found() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.TimeoutException):
        await _drain(adapter)


async def test_server_500_is_not_misclassified_as_model_not_found() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "internal server error"})

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await _drain(adapter)

    assert exc_info.value.response.status_code == 500


async def test_404_without_not_found_body_is_not_misclassified() -> None:
    """A 404 whose body doesn't say "not found" (unrecognized shape) must
    fall through to the generic HTTP error path rather than being guessed
    at as a missing model."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "something else entirely"})

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await _drain(adapter)

    assert exc_info.value.response.status_code == 404


async def test_404_with_non_json_body_is_not_misclassified() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"not json at all")

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        await _drain(adapter)


# --- Regression: normal streaming success is unaffected ---


async def test_successful_stream_yields_content_tokens() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["model"] == "exaone3.5:7.8b"
        lines = [
            json.dumps({"message": {"content": "안녕"}, "done": False}),
            json.dumps({"message": {"content": "하세요"}, "done": True}),
        ]
        return httpx.Response(200, content=("\n".join(lines) + "\n").encode("utf-8"))

    adapter = OllamaLLMAdapter(_MODEL_ALIASES, transport=httpx.MockTransport(handler))

    tokens = await _drain(adapter)

    assert tokens == ["안녕", "하세요"]
