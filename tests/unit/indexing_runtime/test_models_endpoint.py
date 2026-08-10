"""GET /indexing/v1/models — model discovery for portal-api's P15 admin
screen (open-decisions.md D-075 follow-up).

No live Ollama is used: `indexing_runtime.embedders.list_ollama_models` is
monkeypatched directly (same style as `.conftest.patch_embed_batch`) rather
than mocking `httpx` at the transport level, since the endpoint's own
contract is "what does this do with whatever `list_ollama_models` returns/
raises", not "does httpx work". The Ollama-unreachable path is exercised by
having the fake raise `httpx.HTTPError`, exactly what `list_ollama_models`
documents itself as doing on any connection/HTTP failure.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient
from indexing_runtime import embedders
from indexing_runtime.main import app
from indexing_runtime.settings import EMBED_MODEL

client = TestClient(app)


def test_models_endpoint_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list_ollama_models() -> list[dict]:
        return [
            {
                "name": "qwen3-embedding:0.6b",
                "size": 123,
                "modified_at": "2026-08-01T00:00:00Z",
                "details": {"family": "qwen3", "families": ["qwen3"]},
            },
            {
                "name": "exaone3.5:7.8b",
                "size": 456,
                "modified_at": "2026-08-01T00:00:00Z",
                "details": {"family": "exaone", "families": ["exaone"]},
            },
        ]

    monkeypatch.setattr(embedders, "list_ollama_models", fake_list_ollama_models)
    # main.py imported list_ollama_models by name — patch its local binding too.
    import indexing_runtime.main as main_module

    monkeypatch.setattr(main_module, "list_ollama_models", fake_list_ollama_models)

    resp = client.get("/indexing/v1/models")
    assert resp.status_code == 200
    body = resp.json()

    assert body["default_embed_model"] == EMBED_MODEL
    assert body["source"].endswith("/api/tags")
    assert "trace_id" in body and body["trace_id"]

    by_name = {m["name"]: m for m in body["models"]}
    assert by_name.keys() == {"qwen3-embedding:0.6b", "exaone3.5:7.8b"}
    assert by_name["qwen3-embedding:0.6b"]["embedding_capable"] is True
    assert by_name["qwen3-embedding:0.6b"]["size"] == 123
    assert by_name["exaone3.5:7.8b"]["embedding_capable"] is False


def test_models_endpoint_never_returns_empty_list_disguised_as_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unparseable/missing name entry is dropped, but a genuinely empty
    Ollama install (zero models, no error) still returns 200 with an empty
    list — distinguishable from the unreachable case below only by status
    code/error envelope, never by list emptiness alone."""
    async def fake_list_ollama_models() -> list[dict]:
        return []

    import indexing_runtime.main as main_module

    monkeypatch.setattr(main_module, "list_ollama_models", fake_list_ollama_models)

    resp = client.get("/indexing/v1/models")
    assert resp.status_code == 200
    assert resp.json()["models"] == []


def test_models_endpoint_ollama_unreachable_returns_clear_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ollama unreachable must be a clear MODEL_UNAVAILABLE error — never a
    500, and never a silently-empty `models: []` that looks identical to
    'Ollama has no models installed'."""
    async def fake_list_ollama_models() -> list[dict]:
        raise httpx.ConnectError("connection refused")

    import indexing_runtime.main as main_module

    monkeypatch.setattr(main_module, "list_ollama_models", fake_list_ollama_models)

    resp = client.get("/indexing/v1/models")
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
    assert "trace_id" in body["error"] and body["error"]["trace_id"]
    # Never leak the raw exception string / stack trace into the message.
    assert "connection refused" not in body["error"]["message"]


def test_embedding_capable_heuristic_matches_known_families() -> None:
    assert embedders.is_embedding_capable({"name": "qwen3-embedding:0.6b"}) is True
    assert embedders.is_embedding_capable({"name": "nomic-embed-text"}) is True
    assert embedders.is_embedding_capable({"name": "bge-m3"}) is True
    assert embedders.is_embedding_capable({"name": "exaone3.5:7.8b"}) is False
    assert embedders.is_embedding_capable({"name": "llama3.1:8b"}) is False
