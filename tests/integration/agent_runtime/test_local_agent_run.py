"""D-034 해석 경로 4 — router-level: `POST /local/v1/runs` with
`input.local_agent_id`, and the safety properties this path must not break.

Covers:
- happy path: a Desktop-installed Agent Package actually runs a Run.
- allow-root disabled by default -> LOCAL_AGENT_NOT_REGISTERED (unchanged
  deployment behavior — this path does not exist until an operator opts in).
- `capabilities.mcp_allowed=false` on the local Agent means no MCP tool is
  ever offered, mirroring the same property resolution path 2 already has.
- structural unreachability: `routers/chat.py`'s source never mentions
  `local_agent_id`/`local_agent_registry`/`resolve_local_agent_config` —
  Hosted Chat cannot reach this resolution path no matter what a caller
  sends, because the code to reach it is not imported there at all
  (same technique `test_tool_route_workflow.py`'s
  `test_chat_router_never_passes_tool_route_enabled` uses for D-083).
- resolution path 1 (`load_standard_config`/`load_db_agent_config`) is
  unaffected: this file adds no monkeypatches to `manifests.py`'s standard
  config globals, and `test_default_agent_profile_unaffected_by_registry_
  outage`-style coverage already exists in `test_registry_resolution.py`.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from agent_runtime import local_agent_registry as local_agent_registry_module
from agent_runtime.local_agent_registry import LocalAgentRegistry
from agent_runtime.main import app
from agent_runtime.routers import chat as chat_router
from agent_runtime.routers.runs import get_local_agent_registry_dependency

from tests.integration.agent_runtime.conftest import FakeKnowledgeAdapter, FakeLLMAdapter

AGENT_ID = "44444444-4444-4444-8444-444444444444"
PROMPT_ID = "55555555-5555-4555-8555-555555555555"
VERSION = "1.0.0"


def _agent_manifest(mcp_allowed: bool = False) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "id": AGENT_ID,
        "type": "agent",
        "name": "로컬 설치 Agent",
        "version": VERSION,
        "owner": {"org": "miracom", "creator_id": "tester@miracom.com"},
        "classification": "PUBLIC_INTERNAL",
        "workflow": {
            "entry_role": "answerer",
            "roles": [
                {
                    "id": "answerer",
                    "type": "answerer",
                    "requires_knowledge": True,
                    "requires_mcp": mcp_allowed,
                    "requires_prompt": True,
                }
            ],
        },
        "capabilities": {
            "knowledge_required": True,
            "mcp_allowed": mcp_allowed,
            "streaming": True,
            "citation_required": True,
        },
    }


def _prompt_manifest() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "id": PROMPT_ID,
        "type": "prompt",
        "name": "로컬 설치 Prompt",
        "version": VERSION,
        "owner": {"org": "miracom", "creator_id": "tester@miracom.com"},
        "classification": "PUBLIC_INTERNAL",
        "template": {"system": "당신은 테스트 assistant입니다.", "file": "template.md"},
        "variables": [{"name": "question", "type": "string", "required": True}],
    }


def _install(root: Path, *, mcp_allowed: bool = False) -> None:
    agent_dir = root / "assets" / "agents" / AGENT_ID / VERSION
    prompt_dir = root / "assets" / "prompts" / PROMPT_ID / VERSION
    agent_dir.mkdir(parents=True, exist_ok=True)
    prompt_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "manifest.json").write_text(
        json.dumps(_agent_manifest(mcp_allowed)), encoding="utf-8"
    )
    (prompt_dir / "manifest.json").write_text(json.dumps(_prompt_manifest()), encoding="utf-8")
    (prompt_dir / "template.md").write_text("질문: {{question}}", encoding="utf-8")


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


@pytest.fixture(autouse=True)
def _reset_local_agent_registry_singleton():
    local_agent_registry_module.reset_registry()
    yield
    local_agent_registry_module.reset_registry()


def _override_local_agent_registry(registry: LocalAgentRegistry) -> None:
    app.dependency_overrides[get_local_agent_registry_dependency] = lambda: registry


@pytest.fixture(autouse=True)
def _clear_local_agent_override():
    yield
    app.dependency_overrides.pop(get_local_agent_registry_dependency, None)


# --- happy path --------------------------------------------------------


async def test_run_with_local_agent_id_happy_path(
    tmp_path: Path,
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    root = tmp_path / "company-ai-client"
    _install(root)
    registry = LocalAgentRegistry(
        registry_path=tmp_path / "state" / "local-agents.json", allowed_roots=(str(root),)
    )
    registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION, label="테스트")
    _override_local_agent_registry(registry)

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "local-agent-test-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "local_agent_id": AGENT_ID,
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.completed" in event_names, events
    assert fake_llm_adapter.call_count == 1
    assert fake_knowledge_adapter.call_count == 1
    # Proves the *locally installed* manifest/prompt were actually used, not
    # some other resolution path's config.
    sent_messages = fake_llm_adapter.calls[0]
    assert any("당신은 테스트 assistant입니다" in m.get("content", "") for m in sent_messages)


async def test_run_with_unregistered_local_agent_id_refused(
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Default deployment behavior: no allow-root configured -> this
    resolution path is entirely off, and any `local_agent_id` is refused
    with a distinct, non-guessable code — never silently ignored/falls back
    to a different agent."""
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "local-agent-test-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "local_agent_id": AGENT_ID,
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "LOCAL_AGENT_NOT_REGISTERED"
    assert fake_llm_adapter.call_count == 0
    assert fake_knowledge_adapter.call_count == 0


# --- mcp_allowed=false on the local Agent is honored ------------------------


async def test_local_agent_with_mcp_allowed_false_never_gets_mcp_tool(
    tmp_path: Path,
    client: httpx.AsyncClient,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter,
) -> None:
    """Mirrors resolution path 2's own `capabilities.mcp_allowed` gate
    (workflow.py) — a locally installed Agent that declares
    `mcp_allowed: false` must never be able to call an MCP tool even if the
    caller asks for one."""
    root = tmp_path / "company-ai-client"
    _install(root, mcp_allowed=False)
    registry = LocalAgentRegistry(
        registry_path=tmp_path / "state" / "local-agents.json", allowed_roots=(str(root),)
    )
    registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION)
    _override_local_agent_registry(registry)

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "local-agent-test-service",
            "input": {
                "question": "테이블 목록을 알려줘",
                "knowledge_id": "hr-policy-knowledge",
                "local_agent_id": AGENT_ID,
                "mcp_tool": "db_metadata.get_tables",
                "mcp_tool_input": {"schema": "APP"},
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]
    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.completed" in event_names or "run.failed" in event_names, events
    assert fake_mcp_adapter.call_count == 0


# --- structural unreachability from Hosted Chat -----------------------------


def test_chat_router_never_references_local_agent_resolution() -> None:
    """Structural regression guard (this brief's constraint C, D-084 방식):
    `routers/chat.py`'s entire source must never mention `local_agent_id`,
    `local_agent_registry`, or `resolve_local_agent_config` — Hosted Chat
    (multi-user, no Portal-approval-chain equivalent for this path) must be
    structurally unable to reach a locally installed, unapproved Agent
    Package no matter what a caller sends. A live-call test cannot prove a
    code path is absent, only that a particular input didn't trigger it;
    reading the source text is what actually forecloses it."""
    source = inspect.getsource(chat_router)
    for forbidden in ("local_agent_id", "local_agent_registry", "resolve_local_agent_config"):
        assert forbidden not in source, f"chat.py must never reference {forbidden!r}"


def test_local_agents_router_is_not_mounted_under_chat_api_prefix() -> None:
    """`local_agents.router` must only ever be included under `/local/v1`
    (see `main.py`) — this is the mount-point half of the structural
    boundary the source-text test above pins from the chat.py side. Reads
    the resolved OpenAPI path table (not `app.routes`, whose entries are
    lazily-flattened `_IncludedRouter` wrappers in this FastAPI version and
    do not expose a `.path` until the schema is built)."""
    paths = app.openapi()["paths"]
    local_agent_paths = [p for p in paths if "/local-agents" in p]
    assert local_agent_paths, "expected /local/v1/local-agents* routes to be mounted"
    assert all(p.startswith("/local/v1/") for p in local_agent_paths)
    assert not any(p.startswith("/chat-api/") for p in local_agent_paths)
