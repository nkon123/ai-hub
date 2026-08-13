"""Unit tests for `agent_runtime.knowledge_router` — the KNOWLEDGE_ROUTE
stage's pure routing logic, exercised directly against a `FakeLLMAdapter`
(no HTTP/run_store involved; see `test_runs.py` for the end-to-end
`/local/v1/runs` proof of the same behavior).

Covers the fail-open contract the design requires: below-threshold skips
the LLM call entirely; any LLM error/timeout/unparseable output/invalid id
falls back to searching every candidate; a valid-but-empty selection
("abstained") is likewise treated as search-all, never search-nothing.
"""

from __future__ import annotations

from agent_runtime.knowledge_router import route_knowledge_candidates

from tests.integration.agent_runtime.conftest import FakeLLMAdapter

CANDIDATES = [
    {
        "knowledge_id": "hr-policy-knowledge",
        "name": "HR 정책",
        "description": "연차, 휴직 등 인사 정책 문서",
        "tags": ["HR", "정책"],
        "classification": "INTERNAL",
    },
    {
        "knowledge_id": "it-runbook-knowledge",
        "name": "IT 운영 Runbook",
        "description": "서버 장애 대응 절차",
        "tags": ["IT", "운영"],
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


def _valid_json_tokens(selected_ids: list[str], excluded_ids: list[str]) -> list[str]:
    import json

    payload = {
        "selected": [{"knowledge_id": kid, "reason": "관련 있음"} for kid in selected_ids],
        "excluded": [{"knowledge_id": kid, "reason": "관련 없음"} for kid in excluded_ids],
    }
    return [json.dumps(payload, ensure_ascii=False)]


async def test_below_threshold_skips_llm_call_entirely() -> None:
    """`skip_threshold=2` with exactly 2 candidates: no LLM call, every
    candidate is searched, status is "skipped"."""
    adapter = FakeLLMAdapter()
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES[:2],
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert adapter.call_count == 0
    assert result.status == "skipped"
    assert result.fallback_reason is None
    assert set(result.selected_ids) == {"hr-policy-knowledge", "it-runbook-knowledge"}


async def test_above_threshold_calls_llm_and_selects_subset() -> None:
    adapter = FakeLLMAdapter(
        tokens=_valid_json_tokens(
            ["hr-policy-knowledge"], ["it-runbook-knowledge", "finance-policy-knowledge"]
        )
    )
    result = await route_knowledge_candidates(
        "연차는 며칠인가요?",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert adapter.call_count == 1
    assert result.status == "ran"
    assert result.fallback_reason is None
    assert result.selected_ids == ["hr-policy-knowledge"]
    assert {c["knowledge_id"] for c in result.excluded} == {
        "it-runbook-knowledge",
        "finance-policy-knowledge",
    }
    assert all(c["reason"] for c in result.selected)
    assert all(c["reason"] for c in result.excluded)


async def test_llm_error_falls_back_to_searching_every_candidate() -> None:
    class _RaisingAdapter(FakeLLMAdapter):
        async def generate(self, messages, model_alias, stream=True):  # type: ignore[override]
            self.call_count += 1
            raise RuntimeError("llm unavailable")
            yield ""  # pragma: no cover - unreachable, keeps this an async generator

    adapter = _RaisingAdapter()
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "error_or_timeout"
    assert set(result.selected_ids) == {c["knowledge_id"] for c in CANDIDATES}


async def test_llm_timeout_falls_back_to_searching_every_candidate() -> None:
    adapter = FakeLLMAdapter(tokens=["{}"], delay=0.5)
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=0.05,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "error_or_timeout"
    assert set(result.selected_ids) == {c["knowledge_id"] for c in CANDIDATES}


async def test_unparseable_output_falls_back_to_searching_every_candidate() -> None:
    adapter = FakeLLMAdapter(tokens=["이건 JSON이 아닙니다"])
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "unparseable"
    assert set(result.selected_ids) == {c["knowledge_id"] for c in CANDIDATES}


async def test_unknown_knowledge_id_falls_back_to_searching_every_candidate() -> None:
    """The router naming an id outside the candidate list must never be
    trusted — this is exactly the class of bug the fail-open design exists
    to contain."""
    adapter = FakeLLMAdapter(tokens=_valid_json_tokens(["not-a-real-knowledge-id"], []))
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "invalid_ids"
    assert set(result.selected_ids) == {c["knowledge_id"] for c in CANDIDATES}


async def test_empty_selection_abstains_and_falls_back_to_searching_every_candidate() -> None:
    """A valid, well-formed "I choose nothing" response is NOT the same as
    "search nothing" — it must still search every candidate (D-036's guard
    means 0 citations after a real search, not 0 after the router declined
    to search at all)."""
    adapter = FakeLLMAdapter(tokens=_valid_json_tokens([], [c["knowledge_id"] for c in CANDIDATES]))
    result = await route_knowledge_candidates(
        "질문",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "abstained"
    assert set(result.selected_ids) == {c["knowledge_id"] for c in CANDIDATES}


async def test_prompt_sent_to_llm_contains_only_question_and_candidate_metadata() -> None:
    """The core boundary this stage must hold: the LLM prompt is built ONLY
    from `question` and candidate metadata — never document text, citations,
    or prior answers (there is no parameter to pass them through even by
    mistake)."""
    marker = "내부-문서-비밀-마커-QK9x"
    adapter = FakeLLMAdapter(
        tokens=_valid_json_tokens(["hr-policy-knowledge"], ["it-runbook-knowledge"])
    )
    candidates = CANDIDATES[:2]
    await route_knowledge_candidates(
        "연차는 며칠인가요?",
        candidates,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=0,
    )
    assert adapter.call_count == 1
    sent_messages = adapter.calls[0]
    sent_text = " ".join(m["content"] for m in sent_messages)
    assert marker not in sent_text
    assert "연차는 며칠인가요?" in sent_text
    assert "HR 정책" in sent_text
    assert "IT 운영 Runbook" in sent_text


async def test_malformed_candidates_are_dropped_defensively() -> None:
    """Non-dict entries and entries missing `knowledge_id` are skipped
    rather than raising — a caller sending garbage degrades gracefully."""
    adapter = FakeLLMAdapter()
    junk = ["not-a-dict", {"name": "이름만 있고 id 없음"}, {"knowledge_id": ""}]
    result = await route_knowledge_candidates(
        "질문",
        junk,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5.0,
        skip_threshold=2,
    )
    assert adapter.call_count == 0
    assert result.status == "skipped"
    assert result.selected_ids == []
