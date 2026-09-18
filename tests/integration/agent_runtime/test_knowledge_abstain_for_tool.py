"""D-103 — 지식과 Tool 이 둘 다 켜진 턴에서 지식 라우터가 "지식 불필요"를 고를 수 있다.

실사용(2026-09-18): 지식(넥사크로)과 MCP 를 모두 켜고 "현재 시간"을 물었더니
넥사크로 문서에서 현재 시간을 찾았다. 지식 라우터에는 "0개 선택"이 없었고(빈 선택은
전체 검색으로 되돌아갔다), 후보가 1~2개면 라우터 자체를 건너뛰었기 때문이다.

이 suite 가 고정하는 것:
1. 지식 불필요 + Tool 결과 있음 → 지식 검색을 **하지 않는다**.
2. 지식 불필요 + Tool 결과 없음 → 결국 **전체를 검색한다**(라우터가 틀려도 이전보다
   나빠지지 않는다 — 근거 없이 답하는 경로가 생기지 않는다).
3. Tool 이 꺼진 턴은 **이전 동작 그대로**(후보 1개면 라우팅 없이 검색).
4. 라우터가 판단할 수 있도록 이번 턴의 Tool 후보(메타데이터만)가 프롬프트에 실린다.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from tests.integration.agent_runtime.conftest import (
    FakeKnowledgeAdapter,
    FakeLLMAdapter,
    FakeMCPAdapter,
)
from tests.integration.agent_runtime.test_mcp import _read_all_sse_events

KNOWLEDGE = {
    "knowledge_id": "nexacro-guide",
    "name": "넥사크로 17 레퍼런스",
    "description": "넥사크로 컴포넌트 API",
    "tags": ["nexacro"],
    "classification": "INTERNAL",
}


def _knowledge_route(selected: list[str]) -> list[str]:
    payload = {
        "selected": [{"knowledge_id": k, "reason": "관련"} for k in selected],
        "excluded": [
            {"knowledge_id": KNOWLEDGE["knowledge_id"], "reason": "Tool 질문"}
        ]
        if not selected
        else [],
    }
    return [json.dumps(payload, ensure_ascii=False)]


def _tool_route(tool_name: str | None) -> list[str]:
    payload: dict[str, Any] = {"tool_name": tool_name, "reason": "테스트"}
    if tool_name:
        payload["input"] = {"schema": "APP", "table": "INTERFACE_LOG"}
    return [json.dumps(payload, ensure_ascii=False)]


async def _start(client: httpx.AsyncClient, *, tool_route: bool) -> str:
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "desktop-chat",
            "input": {
                "question": "현재 시간",
                "agent_profile": "standard-db-agent",
                "knowledge_id": "",
                "knowledge_candidates": [KNOWLEDGE],
                "tool_route": tool_route,
            },
        },
    )
    assert resp.status_code == 202, resp.text
    return resp.json()["id"]


async def test_abstain_with_tool_result_skips_knowledge_search(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    fake_llm_adapter.responses = [
        _knowledge_route([]),
        _tool_route("db_metadata.get_columns"),
        ["Tool 결과로 답합니다."],
    ]
    run_id = await _start(client, tool_route=True)
    events = await _read_all_sse_events(client, run_id)
    names = [e["event"] for e in events]

    route = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route["data"]["status"] == "abstained"
    assert fake_knowledge_adapter.call_count == 0
    assert "knowledge.search.started" not in names
    assert "knowledge.route.abstain_reverted" not in names
    assert fake_mcp_adapter.call_count == 1
    final = (await client.get(f"/local/v1/runs/{run_id}")).json()
    assert final["status"] == "SUCCEEDED"


async def test_abstain_without_tool_result_searches_knowledge_after_all(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    """라우터는 "Tool 로 답한다"고 했는데 Tool 라우터가 아무것도 고르지 않았다 —
    근거 없이 답하지 않고 미뤘던 지식 검색을 한다."""
    fake_llm_adapter.responses = [
        _knowledge_route([]),
        _tool_route(None),
        ["지식 근거로 답합니다."],
    ]
    run_id = await _start(client, tool_route=True)
    events = await _read_all_sse_events(client, run_id)
    names = [e["event"] for e in events]

    assert "knowledge.route.abstain_reverted" in names
    assert fake_knowledge_adapter.call_count == 1
    assert fake_knowledge_adapter.calls[0]["knowledge_id"] == KNOWLEDGE["knowledge_id"]
    assert fake_mcp_adapter.call_count == 0
    # 미룬 검색은 Tool 판단 **뒤에** 일어난다.
    assert names.index("mcp.tool_route.selected") < names.index("knowledge.search.started")
    final = (await client.get(f"/local/v1/runs/{run_id}")).json()
    assert final["status"] == "SUCCEEDED"
    assert len(final["output"]["citations"]) > 0


async def test_selected_knowledge_is_searched_before_tool_route_as_before(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    fake_llm_adapter.responses = [
        _knowledge_route([KNOWLEDGE["knowledge_id"]]),
        _tool_route(None),
        ["답변"],
    ]
    run_id = await _start(client, tool_route=True)
    events = await _read_all_sse_events(client, run_id)
    names = [e["event"] for e in events]

    assert fake_knowledge_adapter.call_count == 1
    assert "knowledge.route.abstain_reverted" not in names
    assert names.index("knowledge.search.started") < names.index("mcp.tool_route.selected")


async def test_without_tool_route_behavior_is_unchanged(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Tool 이 꺼진 턴: 후보 1개는 기존대로 라우팅 없이(LLM 호출은 답변 1번뿐) 검색한다."""
    fake_llm_adapter.tokens = ["답변"]
    run_id = await _start(client, tool_route=False)
    events = await _read_all_sse_events(client, run_id)

    route = next(e for e in events if e["event"] == "knowledge.route.selected")
    assert route["data"]["status"] == "skipped"
    assert fake_llm_adapter.call_count == 1
    assert fake_knowledge_adapter.call_count == 1


async def test_router_prompt_carries_tool_hints_only_when_tools_are_on(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
) -> None:
    fake_llm_adapter.responses = [_knowledge_route([]), _tool_route(None), ["답변"]]
    run_id = await _start(client, tool_route=True)
    await _read_all_sse_events(client, run_id)

    first_call = fake_llm_adapter.calls[0]
    system = first_call[0]["content"]
    user = first_call[1]["content"]
    assert "지식 검색 라우터" in system
    assert "Tool 로 답할 질문" in system
    assert "db_metadata.get_columns" in user  # 이번 턴의 Tool 후보가 보인다
