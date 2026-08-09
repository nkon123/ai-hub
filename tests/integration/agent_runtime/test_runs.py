"""Integration tests for /local/v1/runs* (agent-runtime, M05)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from tests.integration.agent_runtime.conftest import FakeKnowledgeAdapter, FakeLLMAdapter


async def _read_all_sse_events(client: httpx.AsyncClient, run_id: str) -> list[dict[str, Any]]:
    """Read the full SSE event stream for a run until the connection closes.

    The server closes the stream itself once a terminal event has been sent,
    so this naturally terminates for happy/failure/insufficient-evidence paths.
    """
    events: list[dict[str, Any]] = []
    current_event: str | None = None
    current_data: str | None = None
    async with client.stream("GET", f"/local/v1/runs/{run_id}/events") as response:
        assert response.status_code == 200
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
    """Assert `expected` appears as an in-order subsequence of `event_names`.

    Does not require exact full-list equality — other legitimate events
    (e.g. preflight.completed) may also appear in the log.
    """
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


async def test_happy_path_streams_events_in_order_and_succeeds(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    fake_llm_adapter.tokens = ["안녕", "하세요", "!"]
    # fake_knowledge_adapter already has 2 default citations.

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]
    assert resp.json()["status"] == "CREATED"

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    expected_order = (
        ["run.started", "knowledge.search.started", "knowledge.search.completed"]
        + ["citation.added"] * 2
        + ["answer.delta"] * len(fake_llm_adapter.tokens)
        + ["run.completed"]
    )
    _assert_subsequence(event_names, expected_order)

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.status_code == 200
    body = final.json()
    assert body["status"] == "SUCCEEDED"
    assert body["output"]["answer"] == "안녕하세요!"
    assert len(body["output"]["citations"]) == 2


async def test_insufficient_evidence_does_not_call_llm(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    fake_knowledge_adapter.citations = []

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "run.completed" in event_names
    assert "run.failed" not in event_names

    completed_event = next(e for e in events if e["event"] == "run.completed")
    assert completed_event["data"]["status"] == "INSUFFICIENT_EVIDENCE"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"

    # Hallucination guard: the LLM must never be called when there is no evidence.
    assert fake_llm_adapter.call_count == 0


async def test_missing_question_fails_run(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Covers the input-validation failure path end-to-end.

    `input` is an opaque dict (StartRunRequest.input: dict), so a missing
    `question` key is not caught by pydantic body validation — it surfaces as
    a workflow-level run.failed / FAILED status instead of a 422. This test
    documents that choice.
    """
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge"},  # no "question"
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "run.failed" in event_names
    failed_event = next(e for e in events if e["event"] == "run.failed")
    assert failed_event["data"]["code"] == "INVALID_INPUT"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "FAILED"
    assert fake_llm_adapter.call_count == 0
    assert fake_knowledge_adapter.call_count == 0


async def test_cancel_mid_stream_stops_generation(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Cancel a run while the LLM is still mid-generation.

    Note: httpx.ASGITransport.handle_async_request awaits the whole ASGI app
    call (including a StreamingResponse's full body) to completion before
    handing back a Response — there is no cross-request incremental
    streaming available through it. So instead of reading the SSE stream
    line-by-line while concurrently posting `cancel` (which would only ever
    observe the fully-finished run), we interleave via plain `asyncio.sleep`
    on the same event loop: the POST /runs handler schedules the workflow as
    a background asyncio task and returns immediately, so sleeping here
    yields control to the loop and lets that background task progress at
    real wall-clock speed (FakeLLMAdapter's artificial per-token delay) while
    we send the cancel request mid-generation. The event log is then read
    (safely, post-hoc, once the run is already terminal) via the real
    /events SSE endpoint to confirm run.cancelled was recorded.
    """
    fake_llm_adapter.tokens = ["t1", "t2", "t3", "t4", "t5"]
    fake_llm_adapter.delay = 0.3  # seconds — slow enough to cancel mid-stream

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    # Let preflight + knowledge search (both effectively instant) run, but
    # cancel well before the first 0.3s-delayed token would be emitted.
    await asyncio.sleep(0.1)
    cancel_resp = await client.post(f"/local/v1/runs/{run_id}/cancel")
    assert cancel_resp.status_code == 200

    # Give the background task time to observe cancel_event on its next
    # token cycle, close the generator, and reach a terminal state.
    for _ in range(20):
        status = (await client.get(f"/local/v1/runs/{run_id}")).json()["status"]
        if status == "CANCELLED":
            break
        await asyncio.sleep(0.1)

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "CANCELLED"
    assert fake_llm_adapter.aclose_called is True
    # Generation must have stopped before all 5 tokens were produced.
    assert fake_llm_adapter.call_count == 1

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.cancelled" in event_names
    assert "run.completed" not in event_names
    assert len([n for n in event_names if n == "answer.delta"]) < len(fake_llm_adapter.tokens)


async def test_cancel_unknown_run_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post("/local/v1/runs/does-not-exist/cancel")
    assert resp.status_code == 404


async def test_get_unknown_run_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/local/v1/runs/does-not-exist")
    assert resp.status_code == 404
