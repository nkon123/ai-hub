"""Unit tests for `agent_runtime.tool_router` (D-083 TOOL_ROUTE stage's pure
routing logic) and `agent_runtime.mcp_tools.list_candidate_tools` (the
candidate-narrowing function it depends on), exercised directly against a
`FakeLLMAdapter` — no HTTP/run_store/office-mcp-server involved.

Covers the fail-CLOSED contract the design requires (opposite of
`knowledge_router`'s fail-open): zero candidates skips the LLM call
entirely; a model declining/timing out/returning unparseable output/naming
an unknown tool all result in NO tool proposed, never a guessed one. Also
covers that `list_candidate_tools` never offers a tool the Office Profile
does not allow, and never offers a tool this Runtime has no schema for even
if the Office Profile allows it (`calculator.add` in the shared fixture
profile below has no registered/built-in schema).

See `test_runs.py::TestToolRoute` for the end-to-end `/local/v1/runs` proof
(chokepoint reuse, ai_derived confirmation wording, retrieved-content
isolation, Hosted opt-out) of the same behavior.
"""

from __future__ import annotations

import json

from agent_runtime.mcp_tools import list_candidate_tools
from agent_runtime.tool_router import route_tool_call

from tests.integration.agent_runtime.conftest import FakeLLMAdapter

OFFICE_PROFILE = {
    "allowed_mcp_servers": [
        {
            "alias": "oracle-connector",
            "allowed_tools": [
                "db_metadata.get_tables",
                "db_metadata.get_columns",
                "table_count.query",
                # No registered/built-in schema for this one in this PoC —
                # allowed by the profile but must NOT become a candidate.
                "calculator.add",
            ],
        }
    ]
}

CANDIDATES = list_candidate_tools(OFFICE_PROFILE)


def _tokens(payload: dict) -> list[str]:
    return [json.dumps(payload, ensure_ascii=False)]


# --- list_candidate_tools -----------------------------------------------


def test_list_candidate_tools_excludes_schema_less_allowed_tool() -> None:
    names = {c["tool_name"] for c in CANDIDATES}
    assert names == {"db_metadata.get_tables", "db_metadata.get_columns", "table_count.query"}
    assert "calculator.add" not in names


def test_list_candidate_tools_never_offers_tool_outside_office_profile() -> None:
    narrow_profile = {
        "allowed_mcp_servers": [
            {"alias": "oracle-connector", "allowed_tools": ["db_metadata.get_tables"]}
        ]
    }
    names = {c["tool_name"] for c in list_candidate_tools(narrow_profile)}
    assert names == {"db_metadata.get_tables"}


def test_list_candidate_tools_empty_office_profile_yields_no_candidates() -> None:
    assert list_candidate_tools({}) == []
    assert list_candidate_tools({"allowed_mcp_servers": []}) == []


# --- route_tool_call: skip (zero candidates) ------------------------------


async def test_zero_candidates_skips_llm_call_entirely() -> None:
    adapter = FakeLLMAdapter()
    result = await route_tool_call(
        "테이블 목록 알려줘", [], adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert adapter.call_count == 0
    assert result.status == "skipped"
    assert result.reason == "no_candidate_tools"
    assert result.tool_name is None
    assert result.tool_input is None


# --- route_tool_call: successful proposal ---------------------------------


async def test_model_proposes_valid_tool_and_input() -> None:
    adapter = FakeLLMAdapter(
        tokens=_tokens(
            {
                "tool_name": "db_metadata.get_columns",
                "input": {"schema": "APP", "table": "ORDERS"},
                "reason": "컬럼 목록 조회",
            }
        )
    )
    result = await route_tool_call(
        "ORDERS 테이블 컬럼 알려줘", CANDIDATES, adapter, model_alias="default-chat",
        timeout_seconds=5.0,
    )
    assert result.status == "ran"
    assert result.tool_name == "db_metadata.get_columns"
    assert result.tool_input == {"schema": "APP", "table": "ORDERS"}


# --- route_tool_call: fail-CLOSED paths -----------------------------------


async def test_model_declines_yields_no_tool() -> None:
    """Valid JSON, tool_name explicitly null — the expected/common case for
    a question that needs no tool at all."""
    adapter = FakeLLMAdapter(tokens=_tokens({"tool_name": None, "reason": "Tool 불필요"}))
    result = await route_tool_call(
        "오늘 날씨 어때?", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert result.status == "no_tool"
    assert result.reason == "declined_by_model"
    assert result.tool_name is None
    assert result.tool_input is None


async def test_unparseable_output_yields_no_tool_never_a_guess() -> None:
    adapter = FakeLLMAdapter(tokens=["이건 JSON이 아닙니다 그냥 텍스트입니다"])
    result = await route_tool_call(
        "질문", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert result.status == "no_tool"
    assert result.reason == "unparseable"
    assert result.tool_name is None


async def test_unknown_tool_name_yields_no_tool_never_the_invented_one() -> None:
    adapter = FakeLLMAdapter(
        tokens=_tokens({"tool_name": "not_a_real_tool.action", "input": {}})
    )
    result = await route_tool_call(
        "질문", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert result.status == "no_tool"
    assert result.reason == "unknown_tool_name"
    assert result.tool_name is None


async def test_timeout_yields_no_tool_never_calls_the_only_candidate() -> None:
    """Fail-CLOSED, the opposite of knowledge_router: even a single
    candidate is never called as a "consolation" fallback on timeout."""
    adapter = FakeLLMAdapter(tokens=["db_metadata.get_tables"], delay=0.2)
    result = await route_tool_call(
        "질문",
        CANDIDATES[:1],
        adapter,
        model_alias="default-chat",
        timeout_seconds=0.01,
        skip_threshold=0,
    )
    assert result.status == "no_tool"
    assert result.reason == "error_or_timeout"
    assert result.tool_name is None


async def test_llm_error_yields_no_tool() -> None:
    class _RaisingAdapter(FakeLLMAdapter):
        async def generate(self, messages, model_alias, stream=True):  # type: ignore[override]
            raise RuntimeError("boom")
            yield ""  # pragma: no cover - unreachable, keeps this an async generator

    adapter = _RaisingAdapter()
    result = await route_tool_call(
        "질문", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert result.status == "no_tool"
    assert result.reason == "error_or_timeout"


async def test_non_dict_input_from_model_normalizes_to_empty_dict() -> None:
    """A malformed `input` (not a dict) must not crash routing — it
    normalizes to `{}`, which `validate_tool_input` downstream will then
    reject on its own terms (missing required fields) rather than this
    module guessing at a shape."""
    adapter = FakeLLMAdapter(
        tokens=_tokens({"tool_name": "db_metadata.get_tables", "input": "not-a-dict"})
    )
    result = await route_tool_call(
        "질문", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    assert result.status == "ran"
    assert result.tool_input == {}


# --- retrieved-content isolation (mirrors D-078 discipline) --------------


async def test_routing_prompt_never_contains_citation_or_history_text() -> None:
    """The routing prompt must be built ONLY from `question` and candidate
    tool metadata — never Knowledge citation text or conversation history,
    even if a caller tried to smuggle it in via `question` itself vs. what
    this function actually accepts as parameters. This asserts on the
    literal messages sent to the LLM adapter."""
    adapter = FakeLLMAdapter(tokens=_tokens({"tool_name": None}))
    secret_citation_text = "극비 문서 내용: 전사 M&A 협상가 500억원"
    await route_tool_call(
        "일반 질문", CANDIDATES, adapter, model_alias="default-chat", timeout_seconds=5.0
    )
    sent_text = json.dumps(adapter.calls[-1], ensure_ascii=False)
    assert secret_citation_text not in sent_text
    # And structurally: route_tool_call has no parameter through which
    # citation/history text could even flow in the first place — its only
    # free-text input is `question`.
    import inspect

    params = set(inspect.signature(route_tool_call).parameters)
    assert params == {
        "question",
        "candidates",
        "llm_adapter",
        "model_alias",
        "timeout_seconds",
        "skip_threshold",
    }
