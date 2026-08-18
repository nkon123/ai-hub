"""End-to-end (`/local/v1/runs`) tests for the D-083 TOOL_ROUTE stage —
proves the workflow-level wiring on top of `test_tool_router.py`'s pure
routing-logic unit tests: the unchanged chokepoint is actually reused, a
schema rejection is never retried and never fails the Run, the confirmation
summary states AI-derivation, and Hosted Chat (`chat.py`) never opts in.

No live office-mcp-server/Ollama/search-runtime needed — `client` fixture
(conftest.py) overrides the LLM/Knowledge/MCP adapters with in-memory fakes,
same as `test_mcp.py`.
"""

from __future__ import annotations

import inspect
import json
from typing import Any

import httpx
from agent_runtime.routers import chat as chat_router

from tests.integration.agent_runtime.conftest import FakeLLMAdapter, FakeMCPAdapter
from tests.integration.agent_runtime.test_mcp import _read_all_sse_events, _wait_for_status


def _route_tokens(tool_name: str | None, tool_input: dict[str, Any] | None = None) -> list[str]:
    payload: dict[str, Any] = {"tool_name": tool_name, "reason": "테스트"}
    if tool_input is not None:
        payload["input"] = tool_input
    return [json.dumps(payload, ensure_ascii=False)]


async def _start_tool_route_run(
    client: httpx.AsyncClient,
    *,
    question: str = "인터페이스 로그 테이블의 컬럼 목록을 알려주세요.",
    tool_route: bool = True,
    mcp_tool: str | None = None,
) -> httpx.Response:
    body_input: dict[str, Any] = {
        "question": question,
        "agent_profile": "standard-db-agent",
        "knowledge_id": "",
        "tool_route": tool_route,
    }
    if mcp_tool is not None:
        body_input["mcp_tool"] = mcp_tool
        body_input["mcp_tool_input"] = {"schema": "APP", "table": "INTERFACE_LOG"}
    return await client.post(
        "/local/v1/runs",
        json={"service_id": "db-metadata-service", "input": body_input},
    )


# --- opt-out unchanged -----------------------------------------------------


async def test_tool_route_omitted_never_calls_router_or_emits_event(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """Omitting `tool_route` entirely (every caller today) must be
    byte-for-byte the pre-existing behavior. With no `knowledge_id` and no
    explicit `mcp_tool` either, that pre-existing behavior is the same
    INPUT_VALIDATE rejection this agent has always given — D-083 must not
    change that, i.e. `tool_route_enabled=False` must NOT count as "an MCP
    tool request may happen" the way `tool_route=True` now does."""
    resp = await _start_tool_route_run(client, tool_route=False)
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "mcp.tool_route.selected" not in event_names
    assert fake_mcp_adapter.call_count == 0
    assert fake_llm_adapter.call_count == 0  # never even reached TOOL_ROUTE/ANSWER_GENERATE
    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "FAILED"
    assert final.json()["error"]["code"] == "INVALID_INPUT"


async def test_explicit_mcp_tool_request_wins_over_tool_route(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """An explicit caller-declared `mcp_tool` must disable TOOL_ROUTE
    entirely, even when `tool_route=true` is also sent — the explicit path
    keeps working exactly as before, with no routing LLM call at all."""
    fake_llm_adapter.tokens = ["답변"]
    resp = await _start_tool_route_run(
        client, tool_route=True, mcp_tool="db_metadata.get_columns"
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "mcp.tool_route.selected" not in event_names
    assert fake_mcp_adapter.call_count == 1
    assert fake_llm_adapter.call_count == 1  # only ANSWER_GENERATE — no routing call


# --- successful proposal reuses the unchanged chokepoint --------------------


async def test_tool_route_proposal_dispatches_through_unchanged_chokepoint(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    fake_llm_adapter.responses = [
        _route_tokens("db_metadata.get_columns", {"schema": "APP", "table": "INTERFACE_LOG"}),
        ["INTERFACE_LOG", " 테이블 컬럼 정보입니다."],
    ]
    resp = await _start_tool_route_run(client)
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "mcp.tool_route.selected" in event_names
    route_event = next(e for e in events if e["event"] == "mcp.tool_route.selected")
    assert route_event["data"]["status"] == "ran"
    assert route_event["data"]["tool_name"] == "db_metadata.get_columns"
    # Never the raw prompt or model output.
    assert "input" not in route_event["data"]

    assert fake_mcp_adapter.call_count == 1
    call_request = fake_mcp_adapter.calls[0]
    assert call_request["tool_name"] == "db_metadata.get_columns"
    assert call_request["server_alias"] == "oracle-connector"
    assert call_request["input"] == {"schema": "APP", "table": "INTERFACE_LOG"}

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"


async def test_tool_route_candidate_block_excludes_profile_disallowed_tool(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """`calculator.add` is in the fixture Office Profile's `allowed_tools`
    but has no registered/built-in schema in this PoC — it must never appear
    in the routing prompt, and the model declining leaves no tool called."""
    fake_llm_adapter.tokens = _route_tokens(None)
    resp = await _start_tool_route_run(client)
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)

    sent_prompt = json.dumps(fake_llm_adapter.calls[0], ensure_ascii=False)
    assert "calculator.add" not in sent_prompt
    assert "db_metadata.get_columns" in sent_prompt
    assert fake_mcp_adapter.call_count == 0


# --- fail-CLOSED: no retry, no Run failure on schema rejection -------------


async def test_schema_rejected_proposal_is_not_retried_and_does_not_fail_run(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """The model proposes `table_count.query` missing its required `table`
    field. `validate_tool_input` rejects it (MCP_INPUT_INVALID) — this must
    NOT be retried (only one LLM call total) and must NOT fail the Run; with
    no Knowledge citations either, the Run lands on INSUFFICIENT_EVIDENCE
    via the unchanged D-036 guard, not a new MCP_INPUT_INVALID failure."""
    fake_llm_adapter.tokens = _route_tokens("table_count.query", {"schema": "APP"})
    resp = await _start_tool_route_run(client)
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "mcp.tool_route.rejected" in event_names
    rejected_event = next(e for e in events if e["event"] == "mcp.tool_route.rejected")
    assert rejected_event["data"]["code"] == "MCP_INPUT_INVALID"

    assert fake_llm_adapter.call_count == 1  # one shot — never retried
    assert fake_mcp_adapter.call_count == 0  # never dispatched — preflight rejected first
    assert "run.failed" not in event_names  # NOT a Run failure

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"


async def test_model_declines_leaves_no_tool_call(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    fake_llm_adapter.tokens = _route_tokens(None)
    resp = await _start_tool_route_run(client, question="오늘 날씨 어때요?")
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    route_event = next(e for e in events if e["event"] == "mcp.tool_route.selected")
    assert route_event["data"]["status"] == "no_tool"
    assert route_event["data"]["reason"] == "declined_by_model"
    assert fake_mcp_adapter.call_count == 0

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "INSUFFICIENT_EVIDENCE"


# --- confirmation summary states AI-derivation ------------------------------


async def test_ai_derived_confirmation_summary_states_ai_derived(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """`table_count.query` is ON_PARAMETER — same confirmation policy as an
    explicit caller request, unweakened by routing — but the summary text
    must additionally state the arguments were AI-derived."""
    fake_llm_adapter.tokens = _route_tokens(
        "table_count.query", {"schema": "APP", "table": "INTERFACE_LOG"}
    )
    resp = await _start_tool_route_run(client, question="인터페이스 로그 몇 건이야?")
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"

    run = (await client.get(f"/local/v1/runs/{run_id}")).json()
    pending = run["pending_confirmation"]
    assert pending["tool_name"] == "table_count.query"
    assert "AI가 질문에서 자동으로 추출했습니다" in pending["summary"]
    assert "APP.INTERFACE_LOG" in pending["summary"]

    # Denying must still be a clean non-failure, same as the explicit path.
    confirm = await client.post(
        f"/local/v1/runs/{run_id}/confirm", json={"decision": "deny"}
    )
    assert confirm.status_code == 200
    final_status = await _wait_for_status(client, run_id, target="INSUFFICIENT_EVIDENCE")
    assert final_status == "INSUFFICIENT_EVIDENCE"
    assert fake_mcp_adapter.call_count == 0  # denied — never dispatched


async def test_explicit_mcp_tool_confirmation_summary_never_says_ai_derived(
    client: httpx.AsyncClient, fake_llm_adapter: FakeLLMAdapter, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """A caller-supplied `mcp_tool_input` (no routing involved at all) must
    never get the AI-derived suffix — that wording is reserved for
    TOOL_ROUTE proposals only."""
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "db-metadata-service",
            "input": {
                "question": "인터페이스 로그 몇 건이야?",
                "agent_profile": "standard-db-agent",
                "knowledge_id": "",
                "mcp_tool": "table_count.query",
                "mcp_tool_input": {"schema": "APP", "table": "INTERFACE_LOG"},
            },
        },
    )
    run_id = resp.json()["id"]
    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"
    run = (await client.get(f"/local/v1/runs/{run_id}")).json()
    assert "AI가" not in run["pending_confirmation"]["summary"]


# --- Hosted Chat never enables routing --------------------------------------


def test_chat_router_never_passes_tool_route_enabled() -> None:
    """Structural regression guard: `chat.py`'s `send_message` must never
    pass `tool_route_enabled` to `run_knowledge_chat` — Hosted Chat has no
    Office Profile-scoped consent mechanism for this yet, so routing must
    stay off for all 4 published Hosted chatbots. Source-inspection, not a
    live call, so this fails loudly the moment anyone adds the argument
    rather than relying on every future test remembering to check."""
    source = inspect.getsource(chat_router.send_message)
    assert "tool_route" not in source


def test_tool_route_events_excluded_from_hosted_event_map() -> None:
    """Mirrors `knowledge.route.selected`'s deliberate exclusion — see
    chat.py's comment above `_INTERNAL_TO_HOSTED_EVENT`."""
    assert "mcp.tool_route.selected" not in chat_router._INTERNAL_TO_HOSTED_EVENT
    assert "mcp.tool_route.rejected" not in chat_router._INTERNAL_TO_HOSTED_EVENT
