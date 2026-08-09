"""Integration tests for the MCP_TOOL_CALL workflow stage (M05 -> M10 wiring).

No live office-mcp-server, Ollama, or search-runtime is required — the
`client` fixture (conftest.py) overrides the LLM/Knowledge/MCP adapters with
in-memory fakes. `FakeMCPAdapter` stands in for `HttpMCPAdapter` so these
tests exercise the *Runtime's* decision logic (allowlist/schema/confirmation
checks in `agent_runtime.mcp_tools`, orchestration in
`agent_runtime.workflow._run_mcp_tool_call`) without ever making a real
network call.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import pytest
from agent_runtime.adapters.mcp import MCPCallError
from agent_runtime.config import settings

from tests.integration.agent_runtime.conftest import (
    FakeKnowledgeAdapter,
    FakeLLMAdapter,
    FakeMCPAdapter,
)


async def _wait_for_status(
    client: httpx.AsyncClient, run_id: str, *, target: str, attempts: int = 100, delay: float = 0.02
) -> str:
    """Polls `GET /runs/{id}` until `status == target` (or gives up after
    `attempts * delay` seconds and returns whatever the last status was) —
    same polling pattern `test_cancel_mid_tool_call_is_handled` already uses
    for CANCELLED, generalized to any status."""
    status = ""
    for _ in range(attempts):
        status = (await client.get(f"/local/v1/runs/{run_id}")).json()["status"]
        if status == target:
            return status
        await asyncio.sleep(delay)
    return status


async def _read_all_sse_events(client: httpx.AsyncClient, run_id: str) -> list[dict[str, Any]]:
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


async def _start_db_agent_run(
    client: httpx.AsyncClient,
    *,
    question: str = "인터페이스 로그 테이블의 컬럼 목록을 알려주세요.",
    mcp_tool: str | None = "db_metadata.get_columns",
    mcp_tool_input: dict[str, Any] | None = None,
    mcp_confirmed: bool = False,
    agent_profile: str = "standard-db-agent",
    knowledge_id: str = "",
) -> httpx.Response:
    body_input: dict[str, Any] = {
        "question": question,
        "agent_profile": agent_profile,
        "knowledge_id": knowledge_id,
    }
    if mcp_tool is not None:
        default_input = {"schema": "APP", "table": "INTERFACE_LOG"}
        body_input["mcp_tool"] = mcp_tool
        body_input["mcp_tool_input"] = (
            mcp_tool_input if mcp_tool_input is not None else default_input
        )
        body_input["mcp_confirmed"] = mcp_confirmed
    return await client.post(
        "/local/v1/runs",
        json={"service_id": "db-metadata-service", "input": body_input},
    )


# --- Happy path ---


async def test_valid_tool_call_is_invoked_and_grounds_the_answer(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    fake_llm_adapter.tokens = ["INTERFACE_LOG", " 테이블에는", " ID 컬럼이 있습니다."]

    resp = await _start_db_agent_run(client)
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    _assert_subsequence(
        event_names,
        ["run.started", "mcp.call.started", "mcp.call.completed"]
        + ["answer.delta"] * len(fake_llm_adapter.tokens)
        + ["run.completed"],
    )

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"

    # The tool was actually invoked exactly once — schema-valid input passed
    # straight through, no live search-runtime needed (no knowledge_id given).
    assert fake_mcp_adapter.call_count == 1
    assert fake_knowledge_adapter.call_count == 0

    call_request = fake_mcp_adapter.calls[0]
    assert call_request["tool_name"] == "db_metadata.get_columns"
    assert call_request["server_alias"] == "oracle-connector"
    assert call_request["input"] == {"schema": "APP", "table": "INTERFACE_LOG"}

    # mcp.call.completed must never leak the raw tool output/body — only
    # counts/latency (02-...md §5.4 "Event Data에 전체 Prompt와 Secret을
    # 포함하지 않는다"; the MCP module docstring makes the same promise for
    # bodies specifically).
    completed_event = next(e for e in events if e["event"] == "mcp.call.completed")
    assert "output" not in completed_event["data"]
    assert set(completed_event["data"].keys()) <= {
        "tool_name",
        "success",
        "duration_ms",
        "row_count",
        "truncated",
        "error_code",
    }
    assert completed_event["data"]["success"] is True


async def test_trace_id_propagates_into_mcp_request_context(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    resp = await _start_db_agent_run(client)
    assert resp.status_code == 202
    body = resp.json()
    run_id, trace_id = body["id"], body["trace_id"]

    await _read_all_sse_events(client, run_id)

    assert fake_mcp_adapter.call_count == 1
    audit_context = fake_mcp_adapter.calls[0]["audit_context"]
    assert audit_context["trace_id"] == trace_id
    assert audit_context["run_id"] == run_id
    assert audit_context["requested_tool"] == "db_metadata.get_columns"
    assert audit_context["agent_id"] == "550e8400-e29b-41d4-a716-446655440011"
    # service_id must be a well-formed UUID (05-mcp-security-governance.md
    # §3) even though StartRunRequest.service_id was an opaque non-UUID
    # string ("db-metadata-service") — see workflow.py's
    # `_derive_service_uuid` docstring for why.
    uuid.UUID(audit_context["service_id"])
    assert audit_context["user"]["organization_id"] == "miracom"
    assert audit_context["user"]["roles"] == ["USER"]


# --- Refusals before any network call ---


async def test_tool_not_in_office_profile_allowlist_is_refused_before_dispatch(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    resp = await _start_db_agent_run(client, mcp_tool="db_metadata.drop_table")
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_TOOL_NOT_FOUND"

    assert fake_mcp_adapter.call_count == 0
    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "FAILED"


async def test_invalid_tool_input_is_rejected_before_dispatch(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    resp = await _start_db_agent_run(
        client, mcp_tool="db_metadata.get_columns", mcp_tool_input={"schema": "APP"}
    )
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_INPUT_INVALID"
    assert fake_mcp_adapter.call_count == 0


async def test_on_parameter_tool_enters_waiting_for_user(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """table_count.query is ON_PARAMETER — an unconfirmed call must park the
    Run in WAITING_FOR_USER (02-...md §5.3), not auto-approve and not fail
    outright, and must emit `mcp.confirmation_required` with a safe summary
    (never the raw filters)."""
    resp = await _start_db_agent_run(
        client,
        mcp_tool="table_count.query",
        mcp_tool_input={
            "schema": "APP",
            "table": "INTERFACE_LOG",
            "filters": [{"field": "STATUS", "operator": "eq", "value": "SECRET-VALUE"}],
        },
        mcp_confirmed=False,
    )
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"
    assert fake_mcp_adapter.call_count == 0

    run = (await client.get(f"/local/v1/runs/{run_id}")).json()
    pending = run["pending_confirmation"]
    assert pending["tool_name"] == "table_count.query"
    assert "APP.INTERFACE_LOG" in pending["summary"]
    # The safe summary carries structure (table/schema), never the raw
    # filter value — this is the same "no raw tool input/results" property
    # `mcp.call.*` events already hold (D-052 후속).
    assert "SECRET-VALUE" not in pending["summary"]
    assert pending["deadline"]

    # Clean up: deny so the background Run task doesn't outlive the test
    # waiting for the (long, real-settings) confirmation timeout.
    await client.post(f"/local/v1/runs/{run_id}/confirm", json={"decision": "deny"})


async def test_approve_executes_the_tool_and_run_succeeds(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    fake_mcp_adapter.response = {
        "success": True,
        "tool_name": "table_count.query",
        "output": {"count": 42},
        "duration_ms": 5,
        "trace_id": "fake-mcp-trace",
        "rows_returned": 1,
        "truncated": False,
    }
    fake_llm_adapter.tokens = ["42건", "입니다."]

    resp = await _start_db_agent_run(
        client,
        mcp_tool="table_count.query",
        mcp_tool_input={"schema": "APP", "table": "INTERFACE_LOG"},
        mcp_confirmed=False,
    )
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"

    confirm_resp = await client.post(
        f"/local/v1/runs/{run_id}/confirm", json={"decision": "approve"}
    )
    assert confirm_resp.status_code == 200

    final_status = await _wait_for_status(client, run_id, target="SUCCEEDED")
    assert final_status == "SUCCEEDED"

    assert fake_mcp_adapter.call_count == 1
    call_request = fake_mcp_adapter.calls[0]
    assert call_request["tool_name"] == "table_count.query"
    # An approved confirmation dispatches through the exact same
    # `confirmed=true` path as a caller-pre-confirmed request — no bypass of
    # office-mcp-server's own independent §8.4 re-validation.
    assert call_request["confirmed"] is True

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    _assert_subsequence(
        event_names,
        [
            "mcp.confirmation_required",
            "mcp.confirmation_resolved",
            "mcp.call.started",
            "mcp.call.completed",
            "run.completed",
        ],
    )
    resolved = next(e for e in events if e["event"] == "mcp.confirmation_resolved")
    assert resolved["data"] == {"tool_name": "table_count.query", "decision": "approve"}


async def test_deny_ends_the_run_cleanly_without_calling_the_tool(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """Denial is a first-class outcome, not an error — with no Knowledge
    citations either, the Run must land on INSUFFICIENT_EVIDENCE (D-036),
    never FAILED, and the tool must never be dispatched."""
    resp = await _start_db_agent_run(
        client,
        mcp_tool="table_count.query",
        mcp_tool_input={"schema": "APP", "table": "INTERFACE_LOG"},
        mcp_confirmed=False,
    )
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"

    confirm_resp = await client.post(f"/local/v1/runs/{run_id}/confirm", json={"decision": "deny"})
    assert confirm_resp.status_code == 200

    final_status = await _wait_for_status(client, run_id, target="INSUFFICIENT_EVIDENCE")
    assert final_status == "INSUFFICIENT_EVIDENCE"
    assert fake_mcp_adapter.call_count == 0

    final = (await client.get(f"/local/v1/runs/{run_id}")).json()
    assert final["error"] is None  # denial must never populate the error field


async def test_confirmation_expiry_terminates_the_run(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§5.3 '무한 대기를 방지하기 위해 만료시간을 가진다' — a Run left
    unconfirmed past the (settings-controlled) deadline must FAIL with a
    dedicated error code and stop, rather than wait forever."""
    monkeypatch.setattr(settings, "mcp_confirmation_timeout_seconds", 0.15)

    resp = await _start_db_agent_run(
        client,
        mcp_tool="table_count.query",
        mcp_tool_input={"schema": "APP", "table": "INTERFACE_LOG"},
        mcp_confirmed=False,
    )
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"

    final_status = await _wait_for_status(client, run_id, target="FAILED", attempts=200, delay=0.02)
    assert final_status == "FAILED"
    assert fake_mcp_adapter.call_count == 0

    final = (await client.get(f"/local/v1/runs/{run_id}")).json()
    assert final["error"]["code"] == "MCP_CONFIRMATION_TIMEOUT"
    assert final["pending_confirmation"] is None  # no longer pending once terminal

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    _assert_subsequence(
        event_names, ["mcp.confirmation_required", "mcp.confirmation_expired", "run.failed"]
    )


async def test_confirming_an_already_terminal_run_is_rejected_cleanly(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Confirming a Run that is not (or no longer) WAITING_FOR_USER must be a
    clean, typed rejection — never a crash, never a silent no-op success."""
    resp = await _start_db_agent_run(
        client,
        question="연차는 며칠인가요?",
        mcp_tool=None,
        knowledge_id="hr-policy-knowledge",
    )
    run_id = resp.json()["id"]
    await _wait_for_status(client, run_id, target="SUCCEEDED")

    confirm_resp = await client.post(
        f"/local/v1/runs/{run_id}/confirm", json={"decision": "approve"}
    )
    assert confirm_resp.status_code == 409
    assert confirm_resp.json()["detail"]["code"] == "RUN_NOT_WAITING_FOR_USER"


async def test_confirm_unknown_run_is_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        f"/local/v1/runs/{uuid.uuid4()}/confirm", json={"decision": "approve"}
    )
    assert resp.status_code == 404


async def test_cancel_while_waiting_for_user_still_works(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    """D06 규칙: 'Cancel must still work while waiting' — cancelling a Run
    parked in WAITING_FOR_USER must land on CANCELLED, not hang until the
    confirmation timeout."""
    resp = await _start_db_agent_run(
        client,
        mcp_tool="table_count.query",
        mcp_tool_input={"schema": "APP", "table": "INTERFACE_LOG"},
        mcp_confirmed=False,
    )
    run_id = resp.json()["id"]

    status = await _wait_for_status(client, run_id, target="WAITING_FOR_USER")
    assert status == "WAITING_FOR_USER"

    cancel_resp = await client.post(f"/local/v1/runs/{run_id}/cancel")
    assert cancel_resp.status_code == 200

    final_status = await _wait_for_status(client, run_id, target="CANCELLED")
    assert final_status == "CANCELLED"
    assert fake_mcp_adapter.call_count == 0


# --- Live-server error surfaces as a clean run failure ---


async def test_mcp_error_response_surfaces_as_clean_run_failure(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    fake_mcp_adapter.error_to_raise = MCPCallError(
        "MCP_PERMISSION_DENIED", "이 Tool을 호출할 권한이 없습니다.", "server-trace-id"
    )

    resp = await _start_db_agent_run(client)
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    _assert_subsequence(event_names, ["mcp.call.started", "mcp.call.completed", "run.failed"])

    completed_event = next(e for e in events if e["event"] == "mcp.call.completed")
    assert completed_event["data"]["success"] is False
    assert completed_event["data"]["error_code"] == "MCP_PERMISSION_DENIED"

    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_PERMISSION_DENIED"

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "FAILED"
    assert fake_mcp_adapter.call_count == 1


# --- Cancellation ---


async def test_cancel_mid_tool_call_is_handled(
    client: httpx.AsyncClient, fake_mcp_adapter: FakeMCPAdapter
) -> None:
    fake_mcp_adapter.delay = 0.3

    resp = await _start_db_agent_run(client)
    run_id = resp.json()["id"]

    await asyncio.sleep(0.1)
    cancel_resp = await client.post(f"/local/v1/runs/{run_id}/cancel")
    assert cancel_resp.status_code == 200

    for _ in range(20):
        status = (await client.get(f"/local/v1/runs/{run_id}")).json()["status"]
        if status == "CANCELLED":
            break
        await asyncio.sleep(0.1)

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "CANCELLED"

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.cancelled" in event_names
    assert "run.completed" not in event_names


# --- The Knowledge-only agent never triggers MCP ---


async def test_standard_agent_never_calls_mcp_even_if_requested(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    """standard-agent has capabilities.mcp_allowed=false — an mcp_tool on
    the input must be refused loudly (never silently ignored, never
    forwarded to the adapter)."""
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "연차는 며칠인가요?",
                "mcp_tool": "db_metadata.get_columns",
                "mcp_tool_input": {"schema": "APP", "table": "INTERFACE_LOG"},
            },
        },
    )
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_PERMISSION_DENIED"
    assert fake_mcp_adapter.call_count == 0


async def test_standard_agent_plain_run_never_touches_mcp_adapter(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
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
    assert final.json()["status"] == "SUCCEEDED"
    assert fake_mcp_adapter.call_count == 0


# --- Agent selection ---


async def test_unknown_agent_profile_is_rejected(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "agent_profile": "nonexistent-agent",
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "AGENT_PROFILE_UNKNOWN"

    assert fake_llm_adapter.call_count == 0
    assert fake_knowledge_adapter.call_count == 0
    assert fake_mcp_adapter.call_count == 0


async def test_db_agent_can_still_use_knowledge_search_without_mcp(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    """The MCP-capable agent must not force a tool call — a plain Knowledge
    question (knowledge_id given, no mcp_tool) still works exactly like the
    standard agent's path."""
    resp = await _start_db_agent_run(
        client,
        question="연차는 며칠인가요?",
        mcp_tool=None,
        knowledge_id="hr-policy-knowledge",
    )
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)

    final = await client.get(f"/local/v1/runs/{run_id}")
    assert final.json()["status"] == "SUCCEEDED"
    assert fake_knowledge_adapter.call_count == 1
    assert fake_mcp_adapter.call_count == 0
