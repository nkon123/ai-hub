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
        async def generate(self, messages, model_alias, stream=True, max_output_tokens=None):  # type: ignore[override]
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


# --- D-103: Tool 이 있는 턴의 "지식 불필요" -------------------------------------

TOOL_HINTS = ["hello.now: 서버 PC 의 현재 시각을 돌려줍니다"]


async def test_empty_selection_with_tool_hints_abstains_and_searches_nothing() -> None:
    adapter = FakeLLMAdapter()
    adapter.tokens = _valid_json_tokens([], [c["knowledge_id"] for c in CANDIDATES])
    result = await route_knowledge_candidates(
        "현재 시간",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5,
        skip_threshold=2,
        tool_hints=TOOL_HINTS,
    )
    assert result.status == "abstained"
    assert result.selected_ids == []
    # 미룬 검색이 전체를 다시 찾을 수 있도록 제외 목록에 전부 남는다.
    assert {c["knowledge_id"] for c in result.excluded} == {c["knowledge_id"] for c in CANDIDATES}


async def test_tool_hints_route_even_below_skip_threshold() -> None:
    """지식 1개 + Tool 이면 "지식이 필요한가"를 판단해야 한다 — 건너뛰면 늘 검색한다."""
    adapter = FakeLLMAdapter()
    adapter.tokens = _valid_json_tokens([], [CANDIDATES[0]["knowledge_id"]])
    result = await route_knowledge_candidates(
        "현재 시간",
        CANDIDATES[:1],
        adapter,
        model_alias="default-chat",
        timeout_seconds=5,
        skip_threshold=2,
        tool_hints=TOOL_HINTS,
    )
    assert adapter.call_count == 1
    assert result.status == "abstained"


async def test_without_tool_hints_prompt_and_empty_selection_are_unchanged() -> None:
    adapter = FakeLLMAdapter()
    adapter.tokens = _valid_json_tokens([], [c["knowledge_id"] for c in CANDIDATES])
    result = await route_knowledge_candidates(
        "현재 시간",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5,
        skip_threshold=2,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "abstained"
    assert len(result.selected_ids) == len(CANDIDATES)
    system = adapter.calls[0][0]["content"]
    assert "Tool 로 답할 질문" not in system
    assert "Tool:" not in adapter.calls[0][1]["content"]


async def test_tool_name_in_selected_is_read_as_abstain_not_invalid_id() -> None:
    """실측(gemma4, 2026-09-18): 모델이 지식은 excluded 에 옳게 넣고 "Tool 로 답하겠다"를
    Tool 이름을 selected 에 넣어 표현했다. 이것을 '모르는 id → 전체 검색'으로 읽으면
    abstain 이 한 번도 성립하지 않는다(실측 24회 중 0회였다)."""
    import json

    adapter = FakeLLMAdapter()
    adapter.tokens = [
        json.dumps(
            {
                "selected": [{"knowledge_id": "hello.now", "reason": "시각은 Tool 로"}],
                "excluded": [{"knowledge_id": c["knowledge_id"], "reason": "무관"} for c in CANDIDATES],
            },
            ensure_ascii=False,
        )
    ]
    result = await route_knowledge_candidates(
        "현재 시간",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5,
        skip_threshold=2,
        tool_hints=TOOL_HINTS,
    )
    assert result.status == "abstained"
    assert result.selected_ids == []


async def test_unknown_non_tool_id_still_falls_back_with_tool_hints() -> None:
    """Tool 이름이 아닌 진짜 모르는 id 는 기존대로 전체 검색으로 되돌린다."""
    adapter = FakeLLMAdapter()
    adapter.tokens = _valid_json_tokens(["made-up-knowledge"], [])
    result = await route_knowledge_candidates(
        "현재 시간",
        CANDIDATES,
        adapter,
        model_alias="default-chat",
        timeout_seconds=5,
        skip_threshold=2,
        tool_hints=TOOL_HINTS,
    )
    assert result.status == "fallback"
    assert result.fallback_reason == "invalid_ids"
    assert len(result.selected_ids) == len(CANDIDATES)
