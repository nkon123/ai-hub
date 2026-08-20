"""Integration tests for `GET /local/v1/models` (D-092, open-decisions.md).

Covers the two states that must never be collapsed into each other
(indexing-runtime's `GET /indexing/v1/models` sets this precedent, module
docstring of `agent_runtime.routers.models`):

- Ollama unreachable -> 503 MODEL_UNAVAILABLE.
- Ollama reachable, zero models installed -> 200 with `models: []`.

Plus: `chat_capable` flagging, and `default_chat_model` reflecting whatever
is ACTUALLY in effect right now (D-092 priority: Portal admin setting >
`AGENT_RUNTIME_CHAT_MODEL_ID` > office-profile.json).

`agent_runtime.routers.models.list_ollama_models`/`get_chat_model_setting_cache`
are monkeypatched directly (module-level functions/singletons, not FastAPI
`Depends` — there is no adapter-override seam for them the way
`get_llm_adapter` has one) — no real Ollama/portal-api process involved.
"""

from __future__ import annotations

import httpx
import pytest
from agent_runtime.routers import models as models_router


class _FakeChatModelSettingCache:
    def __init__(self, configured_model: str | None) -> None:
        self._configured_model = configured_model

    async def get_configured_chat_model(self) -> str | None:
        return self._configured_model


async def test_models_success_lists_installed_models_with_chat_capable_flag(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_list_ollama_models(endpoint: str, **kwargs: object) -> list[dict]:
        return [
            {"name": "exaone3.5:7.8b", "size": 123, "modified_at": "2026-08-01T00:00:00Z"},
            {"name": "qwen3-embedding:0.6b", "size": 45},
        ]

    monkeypatch.setattr(models_router, "list_ollama_models", fake_list_ollama_models)
    monkeypatch.setattr(
        models_router, "get_chat_model_setting_cache", lambda: _FakeChatModelSettingCache(None)
    )

    resp = await client.get("/local/v1/models")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_name = {m["name"]: m for m in body["models"]}
    assert by_name["exaone3.5:7.8b"]["chat_capable"] is True
    assert by_name["qwen3-embedding:0.6b"]["chat_capable"] is False
    assert body["source"].endswith("/api/tags")
    assert body["trace_id"]


async def test_models_zero_installed_is_a_200_empty_list_not_an_error(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_list_ollama_models(endpoint: str, **kwargs: object) -> list[dict]:
        return []

    monkeypatch.setattr(models_router, "list_ollama_models", fake_list_ollama_models)
    monkeypatch.setattr(
        models_router, "get_chat_model_setting_cache", lambda: _FakeChatModelSettingCache(None)
    )

    resp = await client.get("/local/v1/models")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["models"] == []


async def test_models_ollama_unreachable_is_503_model_unavailable_not_empty_list(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The state this test guards against: Ollama being down silently
    rendering the same `models: []` the zero-installed case above returns —
    an operator must be able to tell "nothing installed yet" apart from
    "couldn't even ask"."""

    async def fake_list_ollama_models(endpoint: str, **kwargs: object) -> list[dict]:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(models_router, "list_ollama_models", fake_list_ollama_models)
    monkeypatch.setattr(
        models_router, "get_chat_model_setting_cache", lambda: _FakeChatModelSettingCache(None)
    )

    resp = await client.get("/local/v1/models")

    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
    assert body["error"]["trace_id"]


async def test_models_default_chat_model_reflects_portal_setting_when_configured(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_list_ollama_models(endpoint: str, **kwargs: object) -> list[dict]:
        return [{"name": "llama3.1:8b"}]

    monkeypatch.setattr(models_router, "list_ollama_models", fake_list_ollama_models)
    monkeypatch.setattr(
        models_router,
        "get_chat_model_setting_cache",
        lambda: _FakeChatModelSettingCache("llama3.1:8b"),
    )

    resp = await client.get("/local/v1/models")

    assert resp.status_code == 200, resp.text
    assert resp.json()["default_chat_model"] == "llama3.1:8b"


async def test_models_default_chat_model_falls_back_to_office_profile_when_unset(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_list_ollama_models(endpoint: str, **kwargs: object) -> list[dict]:
        return []

    monkeypatch.setattr(models_router, "list_ollama_models", fake_list_ollama_models)
    monkeypatch.setattr(
        models_router, "get_chat_model_setting_cache", lambda: _FakeChatModelSettingCache(None)
    )

    resp = await client.get("/local/v1/models")

    assert resp.status_code == 200, resp.text
    # office-profile-default's default-chat model_id, see
    # services/agent-runtime/config/office-profile-default/office-profile.json
    assert resp.json()["default_chat_model"] == "exaone3.5:7.8b"
