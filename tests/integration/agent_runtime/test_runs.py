"""Integration tests for /local/v1/runs* (agent-runtime, M05)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from agent_runtime.adapters.hub_search import HubSearchError
from agent_runtime.config import settings as agent_runtime_settings

from tests.integration.agent_runtime.conftest import (
    FakeHubSearchAdapter,
    FakeKnowledgeAdapter,
    FakeLLMAdapter,
)


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


# --- Desktop 대화 고도화 (multi-turn / `input.history`) ---------------------


async def test_history_omitted_reproduces_prior_behavior_exactly(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """The 4 published Hosted chatbots (and every caller that predates this
    feature) never send `history` — proves that path is untouched: exactly
    one LLM call (answer generation — no Query Rewrite call at all), the
    search adapter receives the raw question unchanged, and no history block
    appears anywhere in the prompt sent to the model."""
    fake_llm_adapter.tokens = ["답변", "입니다"]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)

    assert "knowledge.query_rewritten" not in [e["event"] for e in events]
    assert fake_llm_adapter.call_count == 1  # no Query Rewrite call
    assert len(fake_knowledge_adapter.calls) == 1
    assert fake_knowledge_adapter.calls[0]["query"] == "연차는 며칠인가요?"
    sent_user_content = fake_llm_adapter.calls[0][-1]["content"]
    assert "이전 대화" not in sent_user_content


async def test_history_is_used_for_query_rewrite_and_shown_as_prompt_context(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """A bare follow-up ("그럼 신청은 어떻게 해?") is rewritten into a
    standalone search query using the given history before Knowledge search
    runs (§3.4 Query Rewrite), and the bounded history is shown to the model
    — labeled as context, not evidence — when generating the answer."""
    fake_llm_adapter.responses = [
        ["재택근무 신청 절차"],  # 1st generate() call: Query Rewrite
        ["신청", "은", " 팀장", " 승인", "으로"],  # 2nd call: ANSWER_GENERATE
    ]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "그럼 신청은 어떻게 해?",
                "history": [
                    {
                        "question": "재택근무는 주 며칠까지 가능한가요?",
                        "answer": "주 3회까지 가능합니다.",
                    }
                ],
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "knowledge.query_rewritten" in event_names
    rewrite_event = next(e for e in events if e["event"] == "knowledge.query_rewritten")
    assert rewrite_event["data"]["rewritten"] is True
    assert rewrite_event["data"]["rewritten_query"] == "재택근무 신청 절차"

    assert fake_llm_adapter.call_count == 2
    assert len(fake_knowledge_adapter.calls) == 1
    # The rewritten query — not the bare follow-up — is what was searched.
    assert fake_knowledge_adapter.calls[0]["query"] == "재택근무 신청 절차"

    answer_generation_user_content = fake_llm_adapter.calls[1][-1]["content"]
    assert "이전 대화" in answer_generation_user_content
    assert "재택근무는 주 며칠까지 가능한가요?" in answer_generation_user_content
    assert "근거로 사용하지 마세요" in answer_generation_user_content

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"


async def test_history_is_bounded_by_settings(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Growth is bounded server-side (AgentRuntimeSettings), regardless of
    how many turns a caller sends — proves "cap by turns" is a real setting,
    not something a caller can grow unboundedly."""
    monkeypatch.setattr(agent_runtime_settings, "max_history_turns", 1)
    fake_llm_adapter.responses = [["재작성된 Query"], ["답", "변"]]

    long_history = [{"question": f"질문{i}", "answer": f"답변{i}"} for i in range(10)]
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "새 질문",
                "history": long_history,
            },
        },
    )
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)

    answer_generation_user_content = fake_llm_adapter.calls[1][-1]["content"]
    # Only the single most recent turn (max_history_turns=1) is present.
    assert "질문9" in answer_generation_user_content
    assert "질문0" not in answer_generation_user_content


async def test_history_does_not_bypass_hallucination_guard(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """The core guarantee this feature must not weaken: a follow-up question
    with history but NO Knowledge evidence for the current question still
    terminates at INSUFFICIENT_EVIDENCE — never an answer synthesised from
    conversation history. The Query Rewrite step (a search-shaping LLM call
    made before citations are known — see workflow.py's module docstring)
    still runs once, but ANSWER_GENERATE — the only LLM call whose output
    ever reaches the user — is never reached."""
    fake_knowledge_adapter.citations = []
    fake_llm_adapter.responses = [["존재하지 않는 주제에 대한 재작성"]]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "완전히 무관한 새 질문",
                "history": [
                    {
                        "question": "이전 질문",
                        "answer": "이전 답변으로 답할 수 있는 상세한 내용입니다.",
                    }
                ],
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "answer.delta" not in event_names  # ANSWER_GENERATE never reached
    completed_event = next(e for e in events if e["event"] == "run.completed")
    assert completed_event["data"]["status"] == "INSUFFICIENT_EVIDENCE"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"
    assert final.json()["output"]["citations"] == []

    # Only the Query Rewrite call happened — never a second (answer) call.
    assert fake_llm_adapter.call_count == 1


# --- Hub (central Knowledge registry, portal-api M02) lookup ---------------
#
# `allow_hub_lookup`/`knowledge_ids` (additive/optional). Stage 2 (hub) only
# ever runs when Stage 1 (local) found zero citations AND the caller
# explicitly opted in — see agent_runtime.hub_query's module docstring for
# the security guarantee these tests exist to prove: local retrieval
# results, local document/chunk text, and any query built from conversation
# history's *assistant answers* must never reach the hub.


async def test_local_citations_are_tagged_source_local(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Stage 1 (local) citations are additively tagged `"source": "local"` —
    every pre-existing key from search-runtime's response is preserved."""
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)

    final = await client.get(f"/local/v1/runs/{run_id}")
    citations = final.json()["output"]["citations"]
    assert len(citations) == 2
    assert all(c["source"] == "local" for c in citations)
    assert citations[0]["chunk_id"] == "chunk-001"  # original key preserved


async def test_knowledge_ids_fans_out_local_search_and_merges_citations(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """`knowledge_ids` (plural, additive) fans Stage 1 out across every id
    via asyncio.gather using the same search query, merging all citations —
    the single-`knowledge_id` path (every other test in this file) stays
    byte-for-byte unaffected when `knowledge_ids` is omitted."""
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "knowledge_ids": ["hr-policy-knowledge", "it-policy-knowledge"],
                "question": "연차는 며칠인가요?",
            },
        },
    )
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)

    assert len(fake_knowledge_adapter.calls) == 2
    searched_ids = {c["knowledge_id"] for c in fake_knowledge_adapter.calls}
    assert searched_ids == {"hr-policy-knowledge", "it-policy-knowledge"}

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"
    # 2 knowledge_ids × 2 default citations each = 4, all tagged "local".
    citations = final.json()["output"]["citations"]
    assert len(citations) == 4
    assert all(c["source"] == "local" for c in citations)


async def test_hub_lookup_never_leaks_prior_answer_text_to_hub(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_hub_search_adapter: FakeHubSearchAdapter,
) -> None:
    """The core security regression test. Stage 1 (local) finds nothing;
    `allow_hub_lookup=True`; a prior turn's *answer* contains a marker string
    simulating local Knowledge document content quoted back by a previous
    assistant reply (exactly what a real Knowledge-chatbot answer looks
    like). That marker must NEVER appear in the outbound hub query text —
    only user-typed `.question` fields may reach the hub. Also proves Stage
    2 actually ran and contributed hub-sourced citations to the final
    result, not that it was silently skipped."""
    fake_knowledge_adapter.citations = []
    marker = "국세청-내부문서-비밀조항-QK9x"
    fake_hub_search_adapter.citations = [
        {
            "chunk_id": "hub-chunk-1",
            "parent_chunk_id": None,
            "document_path": "central-hr/leave.md",
            "document_title": "연차 휴가 정책 (Hub)",
            "page": 1,
            "section": "1.1",
            "excerpt": "휴가 정책 관련 Hub 검색 결과",
            "parent_context": "휴가 정책 전문...",
            "score": 0.9,
            "similarity": 0.9,
            "knowledge_id": "central-hr-knowledge",
            "asset_id": "asset-1",
            "asset_name": "HR 정책",
            "source": "hub",
        }
    ]
    fake_hub_search_adapter.knowledge_ids_searched = ["central-hr-knowledge"]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "그 정책 더 알려줘",
                "allow_hub_lookup": True,
                "history": [{"question": "연차 정책이 뭐야?", "answer": marker}],
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    # The security guarantee: the marker (simulated local document content
    # from a prior assistant answer) never reaches the actual outbound
    # payload sent to the hub adapter.
    assert fake_hub_search_adapter.call_count == 1
    for text in fake_hub_search_adapter.received_query_text:
        assert marker not in text

    assert "hub.query_sent" in event_names
    assert "hub.search.completed" in event_names
    query_sent_event = next(e for e in events if e["event"] == "hub.query_sent")
    assert marker not in query_sent_event["data"]["query"]
    assert "그 정책 더 알려줘" in query_sent_event["data"]["query"]
    assert "연차 정책이 뭐야?" in query_sent_event["data"]["query"]

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"
    citations = final.json()["output"]["citations"]
    hub_citations = [c for c in citations if c.get("source") == "hub"]
    assert len(hub_citations) == 1


async def test_hub_lookup_default_off_never_calls_hub_adapter(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_hub_search_adapter: FakeHubSearchAdapter,
) -> None:
    """`allow_hub_lookup` omitted (defaults False) — Stage 2 must never run
    even when Stage 1 found zero citations: the hub adapter's `search()` is
    never called at all, and the run terminates INSUFFICIENT_EVIDENCE
    exactly as it did before this feature existed (consent-default-off)."""
    fake_knowledge_adapter.citations = []

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"knowledge_id": "hr-policy-knowledge", "question": "연차는 며칠인가요?"},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert fake_hub_search_adapter.call_count == 0
    assert "hub.query_sent" not in event_names
    assert "hub.search.completed" not in event_names

    completed_event = next(e for e in events if e["event"] == "run.completed")
    assert completed_event["data"]["status"] == "INSUFFICIENT_EVIDENCE"
    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"


async def test_hub_lookup_d036_guard_holds_when_both_stages_find_nothing(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_hub_search_adapter: FakeHubSearchAdapter,
) -> None:
    """Both stages return zero citations even with `allow_hub_lookup=True` —
    the hallucination guard (D-036) still fires: INSUFFICIENT_EVIDENCE, and
    the LLM's generate() is never invoked at all (no history here, so there
    is no Query Rewrite call either — a clean zero calls)."""
    fake_knowledge_adapter.citations = []
    fake_hub_search_adapter.citations = []

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "완전히 새로운 질문",
                "allow_hub_lookup": True,
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert fake_hub_search_adapter.call_count == 1  # Stage 2 did run...
    assert "answer.delta" not in event_names  # ...but ANSWER_GENERATE never reached
    completed_event = next(e for e in events if e["event"] == "run.completed")
    assert completed_event["data"]["status"] == "INSUFFICIENT_EVIDENCE"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"
    assert fake_llm_adapter.call_count == 0


async def test_hub_lookup_error_degrades_gracefully_without_failing_run(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_hub_search_adapter: FakeHubSearchAdapter,
) -> None:
    """The hub being unreachable/erroring must never fail the Run — Stage 2
    simply contributes nothing, falling through to the same
    INSUFFICIENT_EVIDENCE path as if it had never been tried."""
    fake_knowledge_adapter.citations = []
    fake_hub_search_adapter.error_to_raise = HubSearchError(
        "HUB_SEARCH_UNAVAILABLE", "portal-api unreachable"
    )

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "완전히 새로운 질문",
                "allow_hub_lookup": True,
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "run.failed" not in event_names
    assert "hub.query_sent" not in event_names  # only emitted on success
    completed_event = next(e for e in events if e["event"] == "run.completed")
    assert completed_event["data"]["status"] == "INSUFFICIENT_EVIDENCE"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"


# --- Agentic Knowledge selection (KNOWLEDGE_ROUTE stage, `knowledge_candidates`) ---
#
# Additive/optional (`input.knowledge_candidates`), analogous to
# `knowledge_ids`/`allow_hub_lookup` above. See
# `tests/integration/agent_runtime/test_knowledge_router.py` for the pure
# routing-logic unit tests; these prove the same fail-open behavior through
# a real `/local/v1/runs` request, plus the D-078 boundary extended to
# routing metadata.

_ROUTE_CANDIDATES = [
    {
        "knowledge_id": "hr-policy-knowledge",
        "name": "HR 정책",
        "description": "연차, 휴직 등 인사 정책 문서",
        "tags": ["HR"],
        "classification": "INTERNAL",
    },
    {
        "knowledge_id": "it-runbook-knowledge",
        "name": "IT 운영 Runbook",
        "description": "서버 장애 대응 절차",
        "tags": ["IT"],
        "classification": "INTERNAL",
    },
    {
        "knowledge_id": "finance-policy-knowledge",
        "name": "재무 정책",
        "description": "비용 처리와 정산 규정",
        "tags": ["재무"],
        "classification": "CONFIDENTIAL",
    },
]


async def test_knowledge_candidates_routes_to_selected_subset_only(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """KNOWLEDGE_ROUTE narrows Stage 1 search to only the LLM-selected
    subset of `knowledge_candidates` — an unrelated candidate (IT Runbook,
    Finance policy) is never searched at all for an HR question."""
    routing_json = json.dumps(
        {
            "selected": [
                {"knowledge_id": "hr-policy-knowledge", "reason": "연차 정책과 직접 관련"}
            ],
            "excluded": [
                {"knowledge_id": "it-runbook-knowledge", "reason": "IT 운영과 무관"},
                {"knowledge_id": "finance-policy-knowledge", "reason": "재무와 무관"},
            ],
        },
        ensure_ascii=False,
    )
    fake_llm_adapter.responses = [[routing_json], ["연차", "는", " 15일", "입니다"]]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"question": "연차는 며칠인가요?", "knowledge_candidates": _ROUTE_CANDIDATES},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "knowledge.route.selected" in event_names
    route_event = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route_event["data"]["status"] == "ran"
    assert route_event["data"]["fallback_reason"] is None
    selected_ids = {c["knowledge_id"] for c in route_event["data"]["selected"]}
    excluded_ids = {c["knowledge_id"] for c in route_event["data"]["excluded"]}
    assert selected_ids == {"hr-policy-knowledge"}
    assert excluded_ids == {"it-runbook-knowledge", "finance-policy-knowledge"}

    # The KNOWLEDGE_ROUTE event must appear before knowledge.search.started.
    _assert_subsequence(event_names, ["knowledge.route.selected", "knowledge.search.started"])

    # Only the selected candidate was actually searched.
    assert len(fake_knowledge_adapter.calls) == 1
    assert fake_knowledge_adapter.calls[0]["knowledge_id"] == "hr-policy-knowledge"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"


async def test_knowledge_route_unparseable_output_falls_back_to_searching_all(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """A routing failure (here: unparseable model output) must fall back to
    searching every candidate — never zero, never a guessed-at subset."""
    fake_llm_adapter.responses = [["이건 JSON이 아닙니다"], ["답", "변"]]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"question": "질문", "knowledge_candidates": _ROUTE_CANDIDATES},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    route_event = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route_event["data"]["status"] == "fallback"
    assert route_event["data"]["fallback_reason"] == "unparseable"

    searched_ids = {c["knowledge_id"] for c in fake_knowledge_adapter.calls}
    assert searched_ids == {c["knowledge_id"] for c in _ROUTE_CANDIDATES}


async def test_knowledge_route_empty_selection_falls_back_to_searching_all(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """A valid-but-empty selection ("abstained") is NOT the same as "search
    nothing" — it must still search every candidate, because D-036's guard
    (0 citations -> INSUFFICIENT_EVIDENCE) means "we searched and found
    nothing", not "we chose not to search"."""
    routing_json = json.dumps({"selected": [], "excluded": []})
    fake_llm_adapter.responses = [[routing_json], ["답", "변"]]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"question": "질문", "knowledge_candidates": _ROUTE_CANDIDATES},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    route_event = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route_event["data"]["status"] == "fallback"
    assert route_event["data"]["fallback_reason"] == "abstained"

    searched_ids = {c["knowledge_id"] for c in fake_knowledge_adapter.calls}
    assert searched_ids == {c["knowledge_id"] for c in _ROUTE_CANDIDATES}


async def test_knowledge_candidates_below_threshold_skips_llm_routing_call(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """At/below `AgentRuntimeSettings.knowledge_route_skip_threshold`
    (default 2) candidates, the router is never called at all — the LLM
    adapter is only ever invoked once, for ANSWER_GENERATE."""
    two_candidates = _ROUTE_CANDIDATES[:2]
    fake_llm_adapter.tokens = ["답", "변"]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {"question": "질문", "knowledge_candidates": two_candidates},
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    route_event = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route_event["data"]["status"] == "skipped"
    assert route_event["data"]["fallback_reason"] is None

    searched_ids = {c["knowledge_id"] for c in fake_knowledge_adapter.calls}
    assert searched_ids == {c["knowledge_id"] for c in two_candidates}
    # Exactly one LLM call total (ANSWER_GENERATE) — the router itself never
    # calls the adapter when skipped.
    assert fake_llm_adapter.call_count == 1


async def test_knowledge_ids_only_callers_are_unaffected_by_routing(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Baseline regression: a caller that only sends `knowledge_ids` (no
    `knowledge_candidates`) — exactly what the 4 published Hosted chatbots
    and every pre-existing caller do — never triggers KNOWLEDGE_ROUTE: no
    `knowledge.route.selected` event, and the LLM is called exactly once
    (ANSWER_GENERATE only, same as before this feature existed)."""
    fake_llm_adapter.tokens = ["답", "변"]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "knowledge_ids": ["hr-policy-knowledge", "it-policy-knowledge"],
                "question": "질문",
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "knowledge.route.selected" not in event_names
    assert fake_llm_adapter.call_count == 1
    assert len(fake_knowledge_adapter.calls) == 2


async def test_knowledge_route_metadata_never_leaks_to_hub_query(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_hub_search_adapter: FakeHubSearchAdapter,
) -> None:
    """D-078 extended to KNOWLEDGE_ROUTE: candidate metadata (name/
    description) and the router's own selection reasons must never reach
    the hub query — `build_hub_query` (agent_runtime.hub_query) only ever
    reads `question` and prior turns' `.question` fields, and nothing about
    KNOWLEDGE_ROUTE changes that chokepoint. Stage 1 (local, routed to only
    the selected candidate) finds nothing, so Stage 2 (hub) runs."""
    marker_name = "극비-내부전용-라우팅후보-QK9x"
    marker_reason = "극비-라우팅-사유-마커-ZZ77"
    fake_knowledge_adapter.citations = []  # Stage 1 finds nothing -> Stage 2 hub runs
    routing_json = json.dumps(
        {
            "selected": [{"knowledge_id": "hr-policy-knowledge", "reason": marker_reason}],
            "excluded": [
                {"knowledge_id": "it-runbook-knowledge", "reason": "무관"},
                {"knowledge_id": "finance-policy-knowledge", "reason": "무관"},
            ],
        },
        ensure_ascii=False,
    )
    fake_llm_adapter.tokens = [routing_json]  # ANSWER_GENERATE is never reached either way
    fake_hub_search_adapter.citations = [
        {
            "chunk_id": "hub-chunk-1",
            "parent_chunk_id": None,
            "document_path": "central-hr/leave.md",
            "document_title": "연차 휴가 정책 (Hub)",
            "page": 1,
            "section": "1.1",
            "excerpt": "휴가 정책 관련 Hub 검색 결과",
            "parent_context": "휴가 정책 전문...",
            "score": 0.9,
            "similarity": 0.9,
            "knowledge_id": "central-hr-knowledge",
            "asset_id": "asset-1",
            "asset_name": "HR 정책",
            "source": "hub",
        }
    ]

    candidates_with_marker = [
        {**_ROUTE_CANDIDATES[0], "name": marker_name, "description": marker_name},
        _ROUTE_CANDIDATES[1],
        _ROUTE_CANDIDATES[2],
    ]

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "question": "정책이 궁금해요",
                "allow_hub_lookup": True,
                "knowledge_candidates": candidates_with_marker,
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)

    assert fake_hub_search_adapter.call_count == 1
    for text in fake_hub_search_adapter.received_query_text:
        assert marker_name not in text
        assert marker_reason not in text

    query_sent_event = next(e for e in events if e["event"] == "hub.query_sent")
    assert marker_name not in query_sent_event["data"]["query"]
    assert marker_reason not in query_sent_event["data"]["query"]
    assert "정책이 궁금해요" in query_sent_event["data"]["query"]

    # Sanity: the routing reason marker *was* emitted in the local
    # knowledge.route.selected event trail — proving the assertions above
    # are a real negative result, not an artifact of the marker never
    # appearing anywhere in this run at all.
    route_event = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert marker_reason in json.dumps(route_event["data"], ensure_ascii=False)
