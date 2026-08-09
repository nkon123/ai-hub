"""E2E-02 — MCP 포함 Service (06-quality-delivery.md §8).

Covered live, against real agent-runtime + real office-mcp-server:
  2. Service에 선택 Tool 연결   -> `agent_profile=standard-db-agent` +
     `input.mcp_tool` on POST /local/v1/runs (D-052's explicit-field wiring;
     there is no free-form tool-calling/model-judgment path in this PoC)
  4. 사용자 확인                -> the ON_PARAMETER tool (`table_count.query`)
     parks the Run in WAITING_FOR_USER without `mcp_confirmed:true`, resumes
     on an explicit `POST /runs/{id}/confirm` decision — approve dispatches
     the call, deny ends the Run cleanly (§5.3/§8.4, D-052 후속)
  5. Tool 호출 성공             -> a real `db_metadata.get_columns` call
     reaches the mock Oracle connector and returns real columns
  6. 결과 요약과 Audit 확인     -> `mcp.call.started`/`mcp.call.completed`
     SSE events observed on agent-runtime, AND the same `trace_id` is
     independently queryable in office-mcp-server's own admin audit log
     (`GET /admin/audit/events`, `X-Actor-Role: ADMIN`) — this is the
     concrete cross-service Trace ID assertion NFR-04 requires, not just
     "an event arrived somewhere."

Also covers the RBAC-adjacent half of MCP: a disallowed role gets
MCP_PERMISSION_DENIED calling office-mcp-server directly, and that denial
itself lands as a DENIED row in the same admin audit log.

Explicitly out of scope today (skipped with a named reason):
  1. "Mock Office MCP와 Metadata Tool 등록" — Portal can register an
     MCP_TOOL asset manifest, but nothing wires that registration to
     office-mcp-server's actual Tool Registry (open-decisions.md D-049) —
     the 3 PoC tools are fixed at office-mcp-server startup.
  3. "Desktop 실행" — Electron cannot launch on this machine.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.e2e.conftest import (
    mcp_audit_context,
    stream_run_events,
    wait_for_run_status,
    wait_for_run_terminal,
)

pytestmark = pytest.mark.e2e


async def test_e2e_02_mcp_tool_call_success_and_cross_service_audit(
    agent: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    trace_id = str(uuid.uuid4())

    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "e2e-02-db-metadata-service",
            "trace_id": trace_id,
            "input": {
                "question": "인터페이스 로그 테이블의 컬럼 목록을 알려주세요.",
                "agent_profile": "standard-db-agent",
                "knowledge_id": "",
                "mcp_tool": "db_metadata.get_columns",
                "mcp_tool_input": {"schema": "APP", "table": "INTERFACE_LOG"},
                "mcp_confirmed": False,
            },
        },
    )
    assert resp.status_code == 202, resp.text
    run_id = resp.json()["id"]

    events = await stream_run_events(agent, run_id, timeout=120)
    names = [name for name, _ in events]
    assert "mcp.call.started" in names, names
    assert "mcp.call.completed" in names, names

    completed = next(data for name, data in events if name == "mcp.call.completed")
    assert completed["tool_name"] == "db_metadata.get_columns"
    assert completed["success"] is True, completed

    final = next(data for name, data in events if name == "run.completed")
    assert final["status"] == "SUCCEEDED", final
    assert final["output"]["answer"].strip()

    # Step 6: the SAME trace_id independently reaches office-mcp-server's
    # own audit trail — this is what NFR-04 ("Runtime·MCP 로그가 동일 Trace
    # ID로 연결된다") actually means, verified end-to-end rather than by
    # reading two services' source code side by side.
    resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    resp.raise_for_status()
    audit = resp.json()
    assert audit["count"] >= 1, audit
    mcp_event = audit["events"][0]
    assert mcp_event["tool_name"] == "db_metadata.get_columns"
    assert mcp_event["result"] == "SUCCEEDED"
    assert mcp_event["trace_id"] == trace_id


async def _skip_if_runtime_predates_confirmation(agent: httpx.AsyncClient) -> None:
    """These two tests exercise `WAITING_FOR_USER` (D-052 후속 / D-061). A
    long-running agent-runtime process started before that code existed will
    reject the very first request with `MCP_CONFIRMATION_REQUIRED`, which is a
    stale *deployment*, not a regression — so skip with a named reason instead
    of reporting a red suite.

    Deliberately narrow: we only skip when `/confirm` is absent (404 from the
    router, i.e. the endpoint was never registered). If the endpoint exists,
    every failure below is a real one and must fail loudly.
    """
    probe = await agent.post(
        "/local/v1/runs/00000000-0000-0000-0000-000000000000/confirm",
        json={"decision": "deny"},
    )
    if probe.status_code == 404 and "run" not in probe.text.lower():
        pytest.skip(
            "실행 중인 agent-runtime이 WAITING_FOR_USER 확인 흐름(D-061) 이전 버전입니다 "
            "— agent-runtime을 재기동하면 이 테스트가 실행됩니다."
        )


async def test_e2e_02_user_confirmation_required_then_allowed(agent: httpx.AsyncClient) -> None:
    """§8.4: `table_count.query` is policy ON_PARAMETER — an unconfirmed
    call parks the Run in WAITING_FOR_USER (§5.3, D-052 후속) instead of
    failing outright or auto-approving; an explicit
    `POST /runs/{id}/confirm` decision resumes it. `mcp_confirmed:true`
    pre-set on the original request (the pre-existing D-052 path — a caller
    that already obtained consent out-of-band) still skips the pause
    entirely, unchanged."""
    await _skip_if_runtime_predates_confirmation(agent)
    base_input = {
        "question": "인터페이스 로그 테이블의 행 수를 알려주세요.",
        "agent_profile": "standard-db-agent",
        "knowledge_id": "",
        "mcp_tool": "table_count.query",
        "mcp_tool_input": {"schema": "APP", "table": "INTERFACE_LOG"},
    }

    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "e2e-02-db-metadata-service",
            "input": {**base_input, "mcp_confirmed": False},
        },
    )
    assert resp.status_code == 202, resp.text
    run_id = resp.json()["id"]

    run = await wait_for_run_status(agent, run_id, "WAITING_FOR_USER")
    pending = run["pending_confirmation"]
    assert pending["tool_name"] == "table_count.query"
    assert "APP.INTERFACE_LOG" in pending["summary"]

    confirm_resp = await agent.post(
        f"/local/v1/runs/{run_id}/confirm", json={"decision": "approve"}
    )
    assert confirm_resp.status_code == 200, confirm_resp.text
    run = await wait_for_run_terminal(agent, run_id)
    assert run["status"] == "SUCCEEDED", run

    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "e2e-02-db-metadata-service",
            "input": {**base_input, "mcp_confirmed": True},
        },
    )
    assert resp.status_code == 202, resp.text
    run = await wait_for_run_terminal(agent, resp.json()["id"])
    assert run["status"] == "SUCCEEDED", run


async def test_e2e_02_user_denies_confirmation_and_run_ends_cleanly(
    agent: httpx.AsyncClient,
) -> None:
    """Denial is a first-class outcome (D-052 후속) — not FAILED. With no
    Knowledge evidence either, the hallucination guard (D-036) lands the Run
    on INSUFFICIENT_EVIDENCE, and the Tool is never actually dispatched."""
    await _skip_if_runtime_predates_confirmation(agent)
    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "e2e-02-db-metadata-service",
            "input": {
                "question": "인터페이스 로그 테이블의 행 수를 알려주세요.",
                "agent_profile": "standard-db-agent",
                "knowledge_id": "",
                "mcp_tool": "table_count.query",
                "mcp_tool_input": {"schema": "APP", "table": "INTERFACE_LOG"},
                "mcp_confirmed": False,
            },
        },
    )
    assert resp.status_code == 202, resp.text
    run_id = resp.json()["id"]

    await wait_for_run_status(agent, run_id, "WAITING_FOR_USER")
    confirm_resp = await agent.post(f"/local/v1/runs/{run_id}/confirm", json={"decision": "deny"})
    assert confirm_resp.status_code == 200, confirm_resp.text

    run = await wait_for_run_terminal(agent, run_id)
    assert run["status"] == "INSUFFICIENT_EVIDENCE", run
    assert run["error"] is None


async def test_e2e_02_direct_mcp_call_denied_for_disallowed_role_and_audited(
    mcp: httpx.AsyncClient,
) -> None:
    """Calling office-mcp-server directly (bypassing agent-runtime) with a
    role outside its allowlist (`USER, CREATOR, TECH_REVIEWER, ADMIN`) must
    be denied, and the denial itself must be auditable."""
    trace_id = str(uuid.uuid4())
    body = {
        "tool_name": "db_metadata.get_columns",
        "server_alias": "oracle-connector",
        "input": {"schema": "APP", "table": "INTERFACE_LOG"},
        "confirmed": False,
        "audit_context": mcp_audit_context(
            requested_tool="db_metadata.get_columns", roles=["AUDITOR"], trace_id=trace_id
        ),
    }
    resp = await mcp.post("/mcp/v1/tools/db_metadata.get_columns/call", json=body)
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "MCP_PERMISSION_DENIED"

    resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    resp.raise_for_status()
    events = resp.json()["events"]
    assert events, "expected the denial itself to be audited"
    assert events[0]["result"] == "DENIED", events[0]


def test_e2e_02_step1_mcp_tool_portal_registration_gap() -> None:
    pytest.skip(
        "E2E-02 step 1 (Mock Office MCP/Metadata Tool 등록) is not implemented: Portal "
        "can register an MCP_TOOL asset manifest, but nothing wires that registration "
        "to office-mcp-server's actual Tool Registry (open-decisions.md D-049) — the 3 "
        "PoC tools (db_metadata.get_tables/get_columns, table_count.query) are fixed at "
        "office-mcp-server startup, independent of Portal state."
    )


def test_e2e_02_step3_desktop_execution_not_available() -> None:
    pytest.skip(
        "E2E-02 step 3 (Desktop 실행) cannot run on this machine: Electron was "
        "quarantined by macOS Gatekeeper (unsigned runtime) this session."
    )
