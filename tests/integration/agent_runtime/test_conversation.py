"""Unit tests for agent_runtime.conversation — pure history bounding/
rendering and the (LLM-backed) Query Rewrite step, exercised with a fake
adapter rather than a live client (kept alongside the other agent-runtime
tests in this directory, which is where every agent-runtime test lives in
this repo — see tests/integration/agent_runtime/conftest.py)."""

from __future__ import annotations

from typing import Any

from agent_runtime.conversation import bound_history, build_history_block, rewrite_query_for_search

from tests.integration.agent_runtime.conftest import FakeLLMAdapter


def test_bound_history_none_input_is_empty() -> None:
    assert bound_history(None, max_turns=6, max_chars=4000) == []


def test_bound_history_keeps_most_recent_turns_oldest_first_eviction() -> None:
    history = [{"question": f"q{i}", "answer": f"a{i}"} for i in range(10)]
    bounded = bound_history(history, max_turns=3, max_chars=10_000)
    assert [t["question"] for t in bounded] == ["q7", "q8", "q9"]


def test_bound_history_trims_by_char_budget_dropping_oldest_first() -> None:
    # Each turn is ~10 chars ("qN" + "aN" style short strings below are
    # padded so the budget math is exact and not accidentally lenient).
    history = [{"question": "x" * 50, "answer": "y" * 50} for _ in range(5)]
    # 5 turns * 100 chars = 500; budget only fits 2 turns (200 chars).
    bounded = bound_history(history, max_turns=10, max_chars=200)
    assert len(bounded) == 2


def test_bound_history_skips_malformed_entries_without_crashing() -> None:
    history: list[Any] = ["not-a-dict", {"question": "실제 질문", "answer": "실제 답변"}, 42]
    bounded = bound_history(history, max_turns=6, max_chars=4000)
    assert bounded == [{"question": "실제 질문", "answer": "실제 답변"}]


def test_bound_history_zero_or_negative_settings_disables_history() -> None:
    history = [{"question": "q", "answer": "a"}]
    assert bound_history(history, max_turns=0, max_chars=4000) == []
    assert bound_history(history, max_turns=6, max_chars=0) == []


def test_build_history_block_renders_korean_transcript() -> None:
    history = [
        {"question": "연차는 며칠인가요?", "answer": "연차는 매년 15일 발생합니다."},
        {"question": "그럼 신청은 어떻게 해?", "answer": ""},
    ]
    block = build_history_block(history)
    assert "사용자: 연차는 며칠인가요?" in block
    assert "어시스턴트: 연차는 매년 15일 발생합니다." in block
    assert "사용자: 그럼 신청은 어떻게 해?" in block
    # An empty answer contributes no "어시스턴트:" line for that turn.
    assert block.count("어시스턴트:") == 1


def test_build_history_block_empty_input_is_empty_string() -> None:
    assert build_history_block([]) == ""


async def test_rewrite_query_for_search_no_history_is_a_pure_noop() -> None:
    adapter = FakeLLMAdapter(tokens=["should never be used"])
    query, meta = await rewrite_query_for_search(
        "연차는 며칠인가요?", [], adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert query == "연차는 며칠인가요?"
    assert meta == {"rewritten": False, "reason": "no_history"}
    assert adapter.call_count == 0  # no LLM call at all when there is no history


async def test_rewrite_query_for_search_uses_model_output_when_history_present() -> None:
    history = [
        {"question": "재택근무는 주 며칠까지 가능한가요?", "answer": "주 3회까지 가능합니다."}
    ]
    adapter = FakeLLMAdapter(tokens=["재택근무 신청 절차 및 승인 방법"])
    query, meta = await rewrite_query_for_search(
        "그럼 신청은 어떻게 해?", history, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert query == "재택근무 신청 절차 및 승인 방법"
    assert meta["rewritten"] is True
    assert meta["original_query"] == "그럼 신청은 어떻게 해?"
    assert meta["rewritten_query"] == "재택근무 신청 절차 및 승인 방법"
    assert adapter.call_count == 1


async def test_rewrite_query_for_search_only_takes_the_first_line() -> None:
    history = [{"question": "q", "answer": "a"}]
    adapter = FakeLLMAdapter(tokens=["첫 줄만 사용\n다음 줄은 무시"])
    query, meta = await rewrite_query_for_search(
        "follow-up", history, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert query == "첫 줄만 사용"
    assert meta["rewritten"] is True


async def test_rewrite_query_for_search_falls_back_to_original_on_empty_output() -> None:
    history = [{"question": "q", "answer": "a"}]
    adapter = FakeLLMAdapter(tokens=["   ", ""])  # yields only whitespace
    query, meta = await rewrite_query_for_search(
        "그럼 신청은?", history, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert query == "그럼 신청은?"
    assert meta["rewritten"] is False
    assert meta["reason"] == "empty_output"


async def test_rewrite_query_for_search_falls_back_to_original_on_timeout() -> None:
    history = [{"question": "q", "answer": "a"}]
    # delay longer than the timeout forces asyncio.wait_for to time out.
    adapter = FakeLLMAdapter(tokens=["느린 응답"], delay=0.2)
    query, meta = await rewrite_query_for_search(
        "그럼 신청은?", history, adapter, model_alias="default-chat", timeout_seconds=0.01
    )
    assert query == "그럼 신청은?"
    assert meta["rewritten"] is False
    assert meta["reason"] == "error_or_timeout"


async def test_rewrite_query_for_search_falls_back_to_original_on_adapter_error() -> None:
    class ExplodingLLMAdapter(FakeLLMAdapter):
        async def generate(  # type: ignore[override]
            self, messages: list[dict[str, Any]], model_alias: str, stream: bool = True
        ):
            raise RuntimeError("ollama unreachable")
            yield ""  # pragma: no cover - makes this an async generator

    history = [{"question": "q", "answer": "a"}]
    query, meta = await rewrite_query_for_search(
        "그럼 신청은?",
        history,
        ExplodingLLMAdapter(),
        model_alias="default-chat",
        timeout_seconds=5.0,
    )
    assert query == "그럼 신청은?"
    assert meta["rewritten"] is False
    assert meta["reason"] == "error_or_timeout"
