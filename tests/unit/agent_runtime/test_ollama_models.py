"""`agent_runtime.ollama_models` — installed-model discovery + the
chat-capable naming-convention heuristic (D-092, open-decisions.md), mirror
of indexing-runtime's `embedders.list_ollama_models`/`is_embedding_capable`.
"""

from __future__ import annotations

import httpx
import pytest
from agent_runtime.ollama_models import is_chat_capable, list_ollama_models


async def test_list_ollama_models_returns_raw_models_array() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/tags"
        return httpx.Response(
            200,
            json={"models": [{"name": "exaone3.5:7.8b"}, {"name": "qwen3-embedding:0.6b"}]},
        )

    models = await list_ollama_models(
        "http://127.0.0.1:11434", transport=httpx.MockTransport(handler)
    )

    assert [m["name"] for m in models] == ["exaone3.5:7.8b", "qwen3-embedding:0.6b"]


async def test_list_ollama_models_empty_is_a_valid_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": []})

    models = await list_ollama_models(
        "http://127.0.0.1:11434", transport=httpx.MockTransport(handler)
    )

    assert models == []


async def test_list_ollama_models_raises_on_connection_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(httpx.HTTPError):
        await list_ollama_models("http://127.0.0.1:11434", transport=httpx.MockTransport(handler))


async def test_list_ollama_models_raises_on_server_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    with pytest.raises(httpx.HTTPError):
        await list_ollama_models("http://127.0.0.1:11434", transport=httpx.MockTransport(handler))


# --- is_chat_capable heuristic ---


def test_regular_chat_model_is_chat_capable() -> None:
    assert is_chat_capable({"name": "exaone3.5:7.8b"}) is True


def test_embedding_named_model_is_not_chat_capable() -> None:
    assert is_chat_capable({"name": "qwen3-embedding:0.6b"}) is False


def test_embedding_family_metadata_is_not_chat_capable() -> None:
    assert is_chat_capable({"name": "some-model", "details": {"family": "bge"}}) is False


def test_unrecognized_model_defaults_to_chat_capable() -> None:
    """An uncertain model must not be hidden or defaulted to
    non-chat-capable — the heuristic only flags well-known embedding naming
    conventions; everything else is assumed chat-capable (display hint, not
    a filter)."""
    assert is_chat_capable({"name": "totally-novel-model-xyz"}) is True
