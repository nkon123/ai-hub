"""Integration tests for /chat-api/v1/* (Hosted Chat Runtime, M05).

No live portal-api, search-runtime, or Ollama is required — the `client`
fixture (tests/integration/agent_runtime/conftest.py) overrides the LLM,
Knowledge, and Deployment-resolver dependencies with in-memory fakes.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from tests.integration.agent_runtime.conftest import (
    FakeDeploymentResolver,
    FakeKnowledgeAdapter,
    FakeLLMAdapter,
)


async def _read_all_sse_events(response: httpx.Response) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    current_event: str | None = None
    current_data: str | None = None
    async for line in response.aiter_lines():
        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            current_data = line[len("data:") :].strip()
        elif line == "":
            if current_event is not None:
                data = json.loads(current_data) if current_data else {}
                events.append({"event": current_event, "data": data})
            current_event = None
            current_data = None
    return events


def _assert_subsequence(event_names: list[str], expected: list[str]) -> None:
    search_from = 0
    for name in expected:
        try:
            found_at = event_names.index(name, search_from)
        except ValueError:
            raise AssertionError(
                f"Expected event {name!r} not found after index {search_from} "
                f"in {event_names!r}"
            ) from None
        search_from = found_at + 1


async def _create_session(
    client: httpx.AsyncClient, slug: str = "remote-work-guide"
) -> dict[str, Any]:
    resp = await client.post("/chat-api/v1/sessions", json={"slug": slug})
    assert resp.status_code == 201
    return resp.json()  # type: ignore[no-any-return]


# --- GET /chat-api/v1/chatbots/{slug} ---


async def test_unknown_slug_returns_safe_404_without_existence_leak(
    client: httpx.AsyncClient,
) -> None:
    resp_unknown = await client.get("/chat-api/v1/chatbots/never-registered-slug")
    resp_other_unknown = await client.get("/chat-api/v1/chatbots/also-never-registered")

    assert resp_unknown.status_code == 404
    assert resp_other_unknown.status_code == 404

    body_a = resp_unknown.json()["error"]
    body_b = resp_other_unknown.json()["error"]
    # Same code and message regardless of slug — no distinction between
    # "never existed" and "exists but suspended" is observable.
    assert body_a["code"] == "DEPLOYMENT_NOT_ACTIVE"
    assert body_a["code"] == body_b["code"]
    assert body_a["message"] == body_b["message"]
    assert "trace_id" in body_a


async def test_get_chatbot_config_for_active_slug(client: httpx.AsyncClient) -> None:
    resp = await client.get("/chat-api/v1/chatbots/remote-work-guide")
    assert resp.status_code == 200
    body = resp.json()
    assert body["slug"] == "remote-work-guide"
    assert body["name"] == "재택근무 안내 챗봇"
    assert body["deployment_revision_id"] == "rev-001"
    assert body["citation_display"] is True
    assert len(body["suggested_questions"]) == 2


# --- POST /chat-api/v1/sessions ---


async def test_create_session_for_unknown_slug_returns_safe_forbidden(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post("/chat-api/v1/sessions", json={"slug": "never-registered-slug"})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"


async def test_create_session_for_active_slug(client: httpx.AsyncClient) -> None:
    session = await _create_session(client)
    assert session["status"] == "ACTIVE"
    assert "trace_id" in session
    assert "expires_at" in session


# --- POST /chat-api/v1/sessions/{session_id}/messages ---


async def test_message_streams_hosted_events_with_citations_and_completes(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    fake_llm_adapter.tokens = ["재택근무는", " 주 2회", " 가능합니다."]
    session = await _create_session(client)

    async with client.stream(
        "POST",
        f"/chat-api/v1/sessions/{session['id']}/messages",
        json={"message": "재택근무 신청 방법은?"},
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = await _read_all_sse_events(resp)

    event_names = [e["event"] for e in events]

    # Only hosted-enum event names must appear — no internal-only leakage.
    hosted_enum = {
        "run.started",
        "search.completed",
        "answer.delta",
        "citation.added",
        "run.completed",
        "run.failed",
    }
    assert set(event_names) <= hosted_enum
    assert "knowledge.search.started" not in event_names
    assert "preflight.completed" not in event_names

    expected_order = (
        ["run.started", "search.completed"]
        + ["citation.added"] * 2
        + ["answer.delta"] * len(fake_llm_adapter.tokens)
        + ["run.completed"]
    )
    _assert_subsequence(event_names, expected_order)

    # Every event carries a trace_id.
    for e in events:
        assert e["data"].get("trace_id")

    completed = next(e for e in events if e["event"] == "run.completed")
    assert completed["data"]["status"] == "SUCCEEDED"
    assert completed["data"]["output"]["answer"] == "재택근무는 주 2회 가능합니다."


async def test_zero_citation_ends_insufficient_evidence_without_calling_llm(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    fake_knowledge_adapter.citations = []
    session = await _create_session(client)

    async with client.stream(
        "POST",
        f"/chat-api/v1/sessions/{session['id']}/messages",
        json={"message": "재택근무 신청 방법은?"},
    ) as resp:
        assert resp.status_code == 200
        events = await _read_all_sse_events(resp)

    event_names = [e["event"] for e in events]
    assert "run.completed" in event_names
    assert "run.failed" not in event_names

    completed = next(e for e in events if e["event"] == "run.completed")
    assert completed["data"]["status"] == "INSUFFICIENT_EVIDENCE"

    # Hallucination guard (D-036): the LLM must never be called with no evidence.
    assert fake_llm_adapter.call_count == 0


async def test_oversized_message_returns_chat_input_too_large(client: httpx.AsyncClient) -> None:
    session = await _create_session(client)
    oversized_message = "가" * 4097

    resp = await client.post(
        f"/chat-api/v1/sessions/{session['id']}/messages",
        json={"message": oversized_message},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CHAT_INPUT_TOO_LARGE"


async def test_unknown_session_id_returns_chat_session_expired(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/chat-api/v1/sessions/00000000-0000-0000-0000-000000000000/messages",
        json={"message": "안녕하세요"},
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "CHAT_SESSION_EXPIRED"


async def test_deployment_resolver_not_called_on_message_send(
    client: httpx.AsyncClient, fake_deployment_resolver: FakeDeploymentResolver
) -> None:
    """The knowledge_id is bound into the session at creation time — sending a
    message must not re-resolve the slug (so a later suspend/republish cannot
    silently redirect an in-flight session)."""
    session = await _create_session(client)
    assert fake_deployment_resolver.call_count == 1

    async with client.stream(
        "POST",
        f"/chat-api/v1/sessions/{session['id']}/messages",
        json={"message": "재택근무 신청 방법은?"},
    ) as resp:
        await _read_all_sse_events(resp)

    assert fake_deployment_resolver.call_count == 1
