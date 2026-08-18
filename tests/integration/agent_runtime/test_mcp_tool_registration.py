"""D-080 integration tests: HTTP surface (`/local/v1/mcp-tools*`) and the
ANALYZE-stage wiring — a registered tool's input_schema actually gates
`POST /local/v1/runs` exactly like a built-in's, and the 4 published Hosted
chatbots (standard-agent, mcp_allowed=false) are provably unaffected by any
of this.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from agent_runtime import manifests, mcp_tool_registry
from agent_runtime.config import settings
from agent_runtime.manifests import StandardKnowledgeChatConfig

from tests.integration.agent_runtime.conftest import FakeMCPAdapter
from tests.integration.agent_runtime.test_mcp import _read_all_sse_events

ALIAS = "oracle-connector"
CUSTOM_TOOL = "custom.echo_status"


@pytest.fixture
def registration_enabled(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Opts `oracle-connector` into dynamic registration, points the
    registry at a tmp file, and extends the *db-agent*'s Office Profile
    allowed_tools with `custom.echo_status` (the operator action D-080
    requires before registration can do anything) — without touching the
    real `config/office-profile-default/office-profile.json` on disk, so
    the 4 published standard-agent chatbots (which share that same file)
    are untouched by this fixture."""
    monkeypatch.setattr(
        settings, "mcp_tool_registration_allowed_aliases", (ALIAS,), raising=False
    )
    monkeypatch.setattr(
        settings, "mcp_tool_registry_path", tmp_path / "mcp-tool-registry.json", raising=False
    )
    mcp_tool_registry.reset_registry()

    base_config = manifests.get_db_agent_config()
    extended_profile = json.loads(json.dumps(base_config.office_profile))  # deep copy
    for server in extended_profile["allowed_mcp_servers"]:
        if server["alias"] == ALIAS:
            server["allowed_tools"].append(CUSTOM_TOOL)
    extended_config = StandardKnowledgeChatConfig(
        agent_manifest=base_config.agent_manifest,
        prompt_manifest=base_config.prompt_manifest,
        prompt_template=base_config.prompt_template,
        office_profile=extended_profile,
    )
    manifests.set_db_agent_config(extended_config)

    yield

    manifests.set_db_agent_config(None)
    mcp_tool_registry.reset_registry()


async def _register(
    client: httpx.AsyncClient,
    *,
    tool_name: str = CUSTOM_TOOL,
    server_alias: str = ALIAS,
    input_schema: dict[str, Any] | None = None,
    confirmation_policy: str = "NEVER",
    risk_level: str = "READ_ONLY",
) -> httpx.Response:
    return await client.post(
        "/local/v1/mcp-tools",
        json={
            "tool_name": tool_name,
            "server_alias": server_alias,
            "input_schema": input_schema
            if input_schema is not None
            else {
                "type": "object",
                "required": ["status"],
                "additionalProperties": False,
                "properties": {"status": {"type": "string"}},
            },
            "confirmation_policy": confirmation_policy,
            "risk_level": risk_level,
        },
    )


# --- HTTP surface: register / list / deregister -----------------------------


async def test_register_disabled_by_default(client: httpx.AsyncClient) -> None:
    """No fixture opting a server alias in — this is the deployment's actual
    default (`mcp_tool_registration_allowed_aliases == ()`)."""
    resp = await _register(client)
    assert resp.status_code == 403
    body = resp.json()
    assert body["error"]["code"] == "PERMISSION_DENIED"
    assert body["error"]["details"]["reason"] == "mcp_tool_registration_disabled"


async def test_register_list_deregister_round_trip(
    client: httpx.AsyncClient, registration_enabled: None
) -> None:
    resp = await _register(client)
    assert resp.status_code == 200, resp.text
    entry = resp.json()["entry"]
    assert entry["tool_name"] == CUSTOM_TOOL
    assert entry["server_alias"] == ALIAS

    listed = await client.get("/local/v1/mcp-tools")
    assert listed.status_code == 200
    body = listed.json()
    assert body["mcp_tool_registration_enabled"] is True
    assert [e["tool_name"] for e in body["entries"]] == [CUSTOM_TOOL]

    deleted = await client.delete(f"/local/v1/mcp-tools/{CUSTOM_TOOL}")
    assert deleted.status_code == 200
    assert deleted.json()["removed"] is True

    # Safe to call unconditionally (uninstall path).
    deleted_again = await client.delete(f"/local/v1/mcp-tools/{CUSTOM_TOOL}")
    assert deleted_again.status_code == 200
    assert deleted_again.json()["removed"] is False


async def test_register_tool_not_in_office_profile_is_refused(
    client: httpx.AsyncClient, registration_enabled: None
) -> None:
    resp = await _register(client, tool_name="db_metadata.drop_table")
    assert resp.status_code == 403
    assert resp.json()["error"]["details"]["reason"] == "tool_not_in_server_allowlist"


async def test_register_weaker_than_builtin_confirmation_is_refused(
    client: httpx.AsyncClient, registration_enabled: None
) -> None:
    resp = await _register(client, tool_name="table_count.query", confirmation_policy="NEVER")
    assert resp.status_code == 403
    assert resp.json()["error"]["details"]["reason"] == "confirmation_policy_weaker_than_builtin"


# --- ANALYZE-stage wiring: a registered tool actually gates a run -----------


async def test_registered_tool_reaches_validate_tool_input_via_analyze(
    client: httpx.AsyncClient,
    registration_enabled: None,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    """Before registration this tool_name is not a built-in, so ANALYZE
    would refuse it with MCP_TOOL_NOT_FOUND. After registering its schema,
    a valid call must actually dispatch to the MCP Adapter."""
    reg = await _register(client)
    assert reg.status_code == 200, reg.text

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "db-metadata-service",
            "input": {
                "knowledge_id": "",
                "question": "상태를 알려주세요.",
                "agent_profile": "standard-db-agent",
                "mcp_tool": CUSTOM_TOOL,
                "mcp_tool_input": {"status": "ok"},
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]

    assert "run.failed" not in event_names, [e for e in events if e["event"] == "run.failed"]
    assert "mcp.call.started" in event_names
    assert fake_mcp_adapter.call_count == 1
    assert fake_mcp_adapter.calls[0]["tool_name"] == CUSTOM_TOOL


async def test_registered_tool_rejects_input_that_violates_its_own_schema(
    client: httpx.AsyncClient,
    registration_enabled: None,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    reg = await _register(client)
    assert reg.status_code == 200, reg.text

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "db-metadata-service",
            "input": {
                "knowledge_id": "",
                "question": "상태를 알려주세요.",
                "agent_profile": "standard-db-agent",
                "mcp_tool": CUSTOM_TOOL,
                "mcp_tool_input": {},  # missing required "status"
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_INPUT_INVALID"
    assert fake_mcp_adapter.call_count == 0


# --- regression: standard-agent (4 published Hosted chatbots) untouched -----


async def test_standard_agent_unaffected_by_mcp_tool_registration(
    client: httpx.AsyncClient,
    registration_enabled: None,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    """standard-agent (mcp_allowed=false) is what every published Hosted
    chatbot runs through. Even with a live registration for a tool_name,
    starting a plain standard-agent run must never touch the MCP adapter."""
    reg = await _register(client)
    assert reg.status_code == 200, reg.text

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "연차는 며칠인가요?",
                # agent_profile omitted -> defaults to standard-agent
            },
        },
    )
    run_id = resp.json()["id"]
    await _read_all_sse_events(client, run_id)
    assert fake_mcp_adapter.call_count == 0


async def test_standard_agent_still_refuses_mcp_tool_even_when_registered(
    client: httpx.AsyncClient,
    registration_enabled: None,
    fake_mcp_adapter: FakeMCPAdapter,
) -> None:
    reg = await _register(client)
    assert reg.status_code == 200, reg.text

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "knowledge_id": "hr-policy-knowledge",
                "question": "연차는 며칠인가요?",
                "mcp_tool": CUSTOM_TOOL,
                "mcp_tool_input": {"status": "ok"},
            },
        },
    )
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "MCP_PERMISSION_DENIED"
    assert fake_mcp_adapter.call_count == 0
