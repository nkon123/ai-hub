"""D-034 closure — agent-runtime resolving Agent/Prompt from the portal-api
Registry, instead of only ever reading `services/agent-runtime/config/`
local copies.

Covers both levels:
- Unit-level: `agent_runtime.manifests.resolve_registry_agent_config` against
  `FakeAssetRegistryResolver` (no live portal-api).
- Router-level: `POST /local/v1/runs` with `input.registry_agent_version_id`/
  `registry_prompt_version_id`, proving the two resolution paths documented
  in `manifests.py`'s module docstring behave exactly as specified —
  including the non-negotiable safety property that a Registry outage never
  breaks the pre-existing `standard-agent`-only path.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from agent_runtime.manifests import (
    RegistryResolutionError,
    reset_registry_cache,
    resolve_registry_agent_config,
)

from tests.integration.agent_runtime.conftest import (
    FakeAssetRegistryResolver,
    FakeKnowledgeAdapter,
    FakeLLMAdapter,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _reset_registry_cache():
    # `_registry_cache` in manifests.py is a module-level global — without
    # this, a cache hit from an earlier test could mask this file's own
    # "was the resolver actually called" assertions.
    reset_registry_cache()
    yield
    reset_registry_cache()


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


def _agent_version(status: str = "APPROVED", **overrides: Any) -> dict[str, Any]:
    # Shape matches the real wire contract exactly — portal-api's
    # `AssetVersionOut` (`GET /api/v1/asset-versions/{id}`) has NO top-level
    # `type`/`name`, only `manifest.type`/`manifest.name`. An earlier draft
    # of this fixture included fictional top-level `type`/`name` keys, which
    # masked a real bug (manifests.py read the non-existent top-level
    # `type`) that only live verification against real portal-api caught.
    version = {
        "id": str(uuid.uuid4()),
        "asset_id": str(uuid.uuid4()),
        "version": "1.0.0",
        "status": status,
        "manifest": {
            "schema_version": "1.0",
            "id": str(uuid.uuid4()),
            "type": "agent",
            "name": "Registry Test Agent",
            "version": "1.0.0",
            "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
            "classification": "INTERNAL",
            "workflow": {
                "entry_role": "answerer",
                "roles": [
                    {
                        "id": "answerer",
                        "type": "answerer",
                        "requires_knowledge": True,
                        "requires_mcp": False,
                        "requires_prompt": True,
                    }
                ],
            },
            "capabilities": {"knowledge_required": True, "mcp_allowed": False},
        },
    }
    version.update(overrides)
    return version


def _prompt_version(status: str = "APPROVED", **overrides: Any) -> dict[str, Any]:
    version = {
        "id": str(uuid.uuid4()),
        "asset_id": str(uuid.uuid4()),
        "version": "1.0.0",
        "status": status,
        "manifest": {
            "schema_version": "1.0",
            "id": str(uuid.uuid4()),
            "type": "prompt",
            "name": "Registry Test Prompt",
            "version": "1.0.0",
            "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
            "classification": "INTERNAL",
            "template": {"system": "당신은 테스트 어시스턴트입니다.", "file": "template.md"},
            "variables": [{"name": "question", "type": "string", "required": True}],
        },
    }
    version.update(overrides)
    return version


# --- Unit-level: resolve_registry_agent_config -----------------------------


async def test_resolve_registry_agent_config_happy_path() -> None:
    agent = _agent_version()
    prompt = _prompt_version()
    resolver = FakeAssetRegistryResolver(
        versions={agent["id"]: agent, prompt["id"]: prompt},
        templates={prompt["id"]: "{{question}}에 답하세요."},
    )

    config = await resolve_registry_agent_config(agent["id"], prompt["id"], resolver)

    assert config.agent_manifest["name"] == "Registry Test Agent"
    assert config.prompt_manifest["name"] == "Registry Test Prompt"
    assert config.prompt_template == "{{question}}에 답하세요."
    assert config.office_profile.get("org") is not None  # falls back to the local default file

    # Cached: a second call with the same id pair must not re-invoke the resolver.
    resolver.get_asset_version_calls.clear()
    resolver.get_prompt_template_calls.clear()
    config2 = await resolve_registry_agent_config(agent["id"], prompt["id"], resolver)
    assert config2 is config
    assert resolver.get_asset_version_calls == []
    assert resolver.get_prompt_template_calls == []


@pytest.mark.parametrize(
    "agent_status,prompt_status,expected_code",
    [
        ("DRAFT", "APPROVED", "AGENT_VERSION_NOT_APPROVED"),
        ("APPROVED", "IN_REVIEW", "PROMPT_VERSION_NOT_APPROVED"),
    ],
)
async def test_resolve_registry_agent_config_unapproved_refused(
    agent_status: str, prompt_status: str, expected_code: str
) -> None:
    agent = _agent_version(status=agent_status)
    prompt = _prompt_version(status=prompt_status)
    resolver = FakeAssetRegistryResolver(
        versions={agent["id"]: agent, prompt["id"]: prompt},
        templates={prompt["id"]: "template"},
    )

    with pytest.raises(RegistryResolutionError) as exc_info:
        await resolve_registry_agent_config(agent["id"], prompt["id"], resolver)
    assert exc_info.value.code == expected_code


async def test_resolve_registry_agent_config_not_found() -> None:
    resolver = FakeAssetRegistryResolver(versions={}, templates={})

    with pytest.raises(RegistryResolutionError) as exc_info:
        await resolve_registry_agent_config("missing-agent", "missing-prompt", resolver)
    assert exc_info.value.code == "AGENT_NOT_FOUND"


async def test_resolve_registry_agent_config_registry_unavailable() -> None:
    resolver = FakeAssetRegistryResolver(error_to_raise=httpx.ConnectError("connection refused"))

    with pytest.raises(RegistryResolutionError) as exc_info:
        await resolve_registry_agent_config("agent-id", "prompt-id", resolver)
    assert exc_info.value.code == "ASSET_REGISTRY_UNAVAILABLE"


async def test_resolve_registry_agent_config_wrong_type_rejected() -> None:
    not_an_agent = _prompt_version()  # type: "prompt", used as if it were an agent id
    prompt = _prompt_version()
    resolver = FakeAssetRegistryResolver(
        versions={not_an_agent["id"]: not_an_agent, prompt["id"]: prompt},
    )

    with pytest.raises(RegistryResolutionError) as exc_info:
        await resolve_registry_agent_config(not_an_agent["id"], prompt["id"], resolver)
    assert exc_info.value.code == "AGENT_ASSET_WRONG_TYPE"


# --- Router-level: POST /local/v1/runs with registry ids -------------------


async def test_run_with_registry_ids_happy_path(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    agent = _agent_version()
    prompt = _prompt_version()
    fake_asset_registry_resolver.versions = {agent["id"]: agent, prompt["id"]: prompt}
    fake_asset_registry_resolver.templates = {prompt["id"]: "{{question}}"}

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "registry-test-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "registry_agent_version_id": agent["id"],
                "registry_prompt_version_id": prompt["id"],
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.completed" in event_names
    assert fake_llm_adapter.call_count == 1
    assert fake_knowledge_adapter.call_count == 1


async def test_run_with_unapproved_registry_agent_refused(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    agent = _agent_version(status="DRAFT")
    prompt = _prompt_version()
    fake_asset_registry_resolver.versions = {agent["id"]: agent, prompt["id"]: prompt}

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "registry-test-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "registry_agent_version_id": agent["id"],
                "registry_prompt_version_id": prompt["id"],
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "AGENT_VERSION_NOT_APPROVED"
    # An unapproved Agent/Prompt must be refused before any LLM/Knowledge
    # call is ever made — same "fail before doing anything" contract
    # AGENT_PROFILE_UNKNOWN already had.
    assert fake_llm_adapter.call_count == 0
    assert fake_knowledge_adapter.call_count == 0


async def test_run_with_only_one_registry_id_rejected(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "registry-test-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "registry_agent_version_id": "some-agent-id",
                # registry_prompt_version_id deliberately omitted
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    failed = next(e for e in events if e["event"] == "run.failed")
    assert failed["data"]["code"] == "REGISTRY_AGENT_PROMPT_PAIR_REQUIRED"


async def test_default_agent_profile_unaffected_by_registry_outage(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """The non-negotiable safety property: a Run that never supplies
    registry_agent_version_id/registry_prompt_version_id (i.e. every
    pre-existing caller, including the 4 live published chatbots) must
    succeed exactly as before even when the Registry resolver would raise on
    any call — because it must never be called at all for this path."""
    fake_asset_registry_resolver.error_to_raise = httpx.ConnectError("portal-api unreachable")

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                # no agent_profile, no registry ids -> default standard-agent path
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    event_names = [e["event"] for e in events]
    assert "run.completed" in event_names
    assert fake_asset_registry_resolver.get_asset_version_calls == []
    assert fake_asset_registry_resolver.get_prompt_template_calls == []


async def test_explicit_standard_agent_profile_also_unaffected_by_outage(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
) -> None:
    """Same property, but with `agent_profile: "standard-db-agent"` supplied
    explicitly — both built-in aliases are Registry-outage-proof, not just
    the omitted-field default."""
    fake_asset_registry_resolver.error_to_raise = httpx.ConnectError("portal-api unreachable")

    resp = await client.post(
        "/local/v1/runs",
        json={
            "service_id": "hr-chatbot-service",
            "input": {
                "question": "연차는 며칠인가요?",
                "knowledge_id": "hr-policy-knowledge",
                "agent_profile": "standard-db-agent",
            },
        },
    )
    assert resp.status_code == 202
    run_id = resp.json()["id"]

    events = await _read_all_sse_events(client, run_id)
    assert "run.completed" in [e["event"] for e in events]
    assert fake_asset_registry_resolver.get_asset_version_calls == []
