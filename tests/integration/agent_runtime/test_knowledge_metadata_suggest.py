"""Integration tests for the AI 추천 endpoint
(`POST /local/v1/knowledge-metadata-suggest`).

Covers: normal (valid JSON model output parsed into suggested_name/
suggested_description), malformed model output (best-effort fallback,
never a 500 — the caller always gets editable text back), empty excerpt
(400 VALIDATION_ERROR), model/adapter failure (503 MODEL_UNAVAILABLE — this
endpoint never touches `/local/v1/runs*`/`RunStore`/the D-036 guard), and
that the excerpt is bounded before being sent to the model (never a literal
in the router — `AgentRuntimeSettings
.knowledge_metadata_suggest_excerpt_max_chars`).

Uses the shared `client`/`fake_llm_adapter` fixtures from conftest.py — the
real Ollama adapter is never invoked.
"""

from __future__ import annotations

import httpx
import pytest
from agent_runtime.adapters import LLMAdapter
from agent_runtime.adapters.ollama import OllamaModelNotFoundError
from agent_runtime.config import settings
from agent_runtime.main import app
from agent_runtime.routers.runs import get_llm_adapter

from tests.integration.agent_runtime.conftest import FakeLLMAdapter

# --- Normal ---


async def test_suggest_returns_parsed_name_and_description(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter
) -> None:
    fake_llm_adapter.tokens = ['{"name": "HR 정책 Knowledge", "description": "인사 정책 문서."}']

    resp = await client.post(
        "/local/v1/knowledge-metadata-suggest",
        json={"excerpt": "육아휴직은 최대 1년입니다.", "filename": "hr-policy.md"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["suggested_name"] == "HR 정책 Knowledge"
    assert body["suggested_description"] == "인사 정책 문서."
    assert body["trace_id"]


async def test_suggest_sends_bounded_excerpt_to_model(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings, "knowledge_metadata_suggest_excerpt_max_chars", 10, raising=False
    )
    fake_llm_adapter.tokens = ['{"name": "n", "description": "d"}']
    long_excerpt = "가" * 1000

    resp = await client.post(
        "/local/v1/knowledge-metadata-suggest",
        json={"excerpt": long_excerpt, "filename": "a.md"},
    )

    assert resp.status_code == 200, resp.text
    sent_content = fake_llm_adapter.calls[0][1]["content"]
    # Only the bounded excerpt (10 chars) reached the prompt, not all 1000.
    assert "가" * 20 not in sent_content
    assert "가" * 10 in sent_content


# --- Malformed model output (untrusted text) never 500s ---


async def test_suggest_falls_back_gracefully_on_non_json_output(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter
) -> None:
    fake_llm_adapter.tokens = ["이건 JSON이 아닙니다."]

    resp = await client.post(
        "/local/v1/knowledge-metadata-suggest",
        json={"excerpt": "내용", "filename": "my_report-final.md"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["suggested_name"]  # derived from filename, never empty
    assert body["suggested_description"] == "이건 JSON이 아닙니다."


# --- Empty input ---


async def test_suggest_empty_excerpt_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/local/v1/knowledge-metadata-suggest", json={"excerpt": "   ", "filename": "a.md"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- Model/adapter failure — registration must never depend on this ---


class _FailingLLMAdapter(LLMAdapter):
    async def generate(self, messages, model_alias, stream=True):  # type: ignore[override]
        raise ConnectionError("simulated Ollama unavailable")
        yield  # pragma: no cover - makes this an async generator function


async def test_suggest_model_unavailable_returns_503(client: httpx.AsyncClient) -> None:
    app.dependency_overrides[get_llm_adapter] = lambda: _FailingLLMAdapter()
    try:
        resp = await client.post(
            "/local/v1/knowledge-metadata-suggest",
            json={"excerpt": "내용", "filename": "a.md"},
        )
    finally:
        app.dependency_overrides.pop(get_llm_adapter, None)

    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "MODEL_UNAVAILABLE"


# --- Model not installed (실사용 제보 2026-08-20, D-091) — a distinguishable
# diagnosis, not the same generic message as a dead/unreachable Ollama ---


class _ModelNotFoundLLMAdapter(LLMAdapter):
    async def generate(self, messages, model_alias, stream=True):  # type: ignore[override]
        raise OllamaModelNotFoundError(model_id="exaone3.5:7.8b", model_alias="default-chat")
        yield  # pragma: no cover - makes this an async generator function


async def test_suggest_model_not_found_names_model_and_alias_in_message(
    client: httpx.AsyncClient,
) -> None:
    app.dependency_overrides[get_llm_adapter] = lambda: _ModelNotFoundLLMAdapter()
    try:
        resp = await client.post(
            "/local/v1/knowledge-metadata-suggest",
            json={"excerpt": "내용", "filename": "a.md"},
        )
    finally:
        app.dependency_overrides.pop(get_llm_adapter, None)

    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
    # The message must name the specific missing model_id and the
    # office-profile alias it came from — a generic "AI 추천을 생성하지
    # 못했습니다" (the pre-fix message, still used for every OTHER failure
    # mode) gives the user no actionable next step.
    assert "exaone3.5:7.8b" in body["error"]["message"]
    assert "default-chat" in body["error"]["message"]
    assert "ollama pull" in body["error"]["message"]
