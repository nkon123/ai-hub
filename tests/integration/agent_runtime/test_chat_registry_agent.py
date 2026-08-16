"""D-034 — Hosted Chat answers with the Agent the deployment was published with.

Before this, `routers/chat.py` was hardwired to `get_standard_config()`. A
Service published with a Registry-registered Agent therefore answered as a
*different* Agent than the one it was published with, and nothing in the
reply revealed the substitution.

Two properties matter here and each has its own test:

  - a deployment WITHOUT the id pair (every chatbot published before
    2026-08-16, all of which run on the two standard Agents) must keep
    working exactly as before and must never reach the Registry;
  - a deployment WITH the pair, whose Agent cannot be resolved, must
    **fail** rather than quietly answer with the standard Agent.

No live portal-api/Ollama — the conftest fakes cover all of it.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest

from tests.integration.agent_runtime.conftest import (
    DEFAULT_DEPLOYMENTS,
    FakeAssetRegistryResolver,
    FakeDeploymentResolver,
)

AGENT_VERSION_ID = str(uuid.uuid4())
PROMPT_VERSION_ID = str(uuid.uuid4())
# `manifests.py` caches a successful resolution per id pair on purpose, so a
# later Registry outage cannot break a run that already resolved once. That
# cache is module-global and outlives a single test, so the failure case below
# MUST use an id pair that was never resolved successfully — reusing the happy
# path's ids would hit the cache and quietly test nothing.
MISSING_AGENT_VERSION_ID = str(uuid.uuid4())
MISSING_PROMPT_VERSION_ID = str(uuid.uuid4())


def _registry_deployment(
    slug: str = "registry-agent-bot",
    agent_version_id: str = AGENT_VERSION_ID,
    prompt_version_id: str = PROMPT_VERSION_ID,
) -> dict[str, Any]:
    base = dict(DEFAULT_DEPLOYMENTS["remote-work-guide"])
    base["slug"] = slug
    base["registry_agent_version_id"] = agent_version_id
    base["registry_prompt_version_id"] = prompt_version_id
    return base


def _agent_version() -> dict[str, Any]:
    return {
        "id": AGENT_VERSION_ID,
        "asset_id": str(uuid.uuid4()),
        "version": "1.0.0",
        "status": "APPROVED",
        "manifest": {
            "schema_version": "1.0",
            "id": str(uuid.uuid4()),
            "type": "agent",
            "name": "등록된 정책 에이전트",
            "version": "1.0.0",
            "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
            "classification": "INTERNAL",
            "workflow": {
                "entry_role": "answerer",
                "roles": [{"id": "answerer", "type": "answerer", "requires_knowledge": True}],
            },
            "capabilities": {"knowledge_required": True, "mcp_allowed": False},
        },
    }


def _prompt_version() -> dict[str, Any]:
    return {
        "id": PROMPT_VERSION_ID,
        "asset_id": str(uuid.uuid4()),
        "version": "1.0.0",
        "status": "APPROVED",
        "manifest": {
            "schema_version": "1.0",
            "id": str(uuid.uuid4()),
            "type": "prompt",
            "name": "등록된 정책 프롬프트",
            "version": "1.0.0",
            "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
            "classification": "INTERNAL",
            "template": {"system": "당신은 사내 정책 안내자입니다.", "file": "template.md"},
            "variables": [{"name": "question", "type": "string", "required": True}],
        },
    }


async def _create_session(client: httpx.AsyncClient, slug: str) -> str:
    resp = await client.post("/chat-api/v1/sessions", json={"slug": slug})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]  # type: ignore[no-any-return]


@pytest.mark.parametrize(
    "fake_deployment_resolver",
    [FakeDeploymentResolver({"registry-agent-bot": _registry_deployment()})],
)
async def test_registry_agent_deployment_resolves_through_the_registry(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
) -> None:
    fake_asset_registry_resolver.versions = {
        AGENT_VERSION_ID: _agent_version(),
        PROMPT_VERSION_ID: _prompt_version(),
    }
    fake_asset_registry_resolver.templates = {PROMPT_VERSION_ID: "{{question}}에 답하세요."}

    session_id = await _create_session(client, "registry-agent-bot")
    async with client.stream(
        "POST",
        f"/chat-api/v1/sessions/{session_id}/messages",
        json={"message": "재택근무 신청 방법은?"},
    ) as response:
        assert response.status_code == 200
        async for _ in response.aiter_lines():
            pass

    # The Registry was actually consulted — i.e. the standard Agent was not
    # silently used for a deployment published with a Registry Agent.
    assert fake_asset_registry_resolver.get_asset_version_calls


@pytest.mark.parametrize(
    "fake_deployment_resolver",
    [
        FakeDeploymentResolver(
            {
                "missing-agent-bot": _registry_deployment(
                    slug="missing-agent-bot",
                    agent_version_id=MISSING_AGENT_VERSION_ID,
                    prompt_version_id=MISSING_PROMPT_VERSION_ID,
                )
            }
        )
    ],
)
async def test_unresolvable_registry_agent_fails_instead_of_substituting(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
) -> None:
    """The Agent asset is gone from the Registry. Answering anyway with the
    standard Agent would produce a reply attributed to a chatbot that never
    ran — worse than an explicit failure the user can see."""
    fake_asset_registry_resolver.versions = {
        MISSING_AGENT_VERSION_ID: None,
        MISSING_PROMPT_VERSION_ID: None,
    }

    session_id = await _create_session(client, "missing-agent-bot")
    resp = await client.post(
        f"/chat-api/v1/sessions/{session_id}/messages",
        json={"message": "재택근무 신청 방법은?"},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "CHAT_AGENT_UNAVAILABLE"


async def test_standard_deployment_never_touches_the_registry(
    client: httpx.AsyncClient,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
) -> None:
    """The four already-published chatbots have no id pair. This is the
    regression guard for them: unchanged behaviour, and no new dependency on
    portal-api being reachable at chat time."""
    session_id = await _create_session(client, "remote-work-guide")
    async with client.stream(
        "POST",
        f"/chat-api/v1/sessions/{session_id}/messages",
        json={"message": "재택근무 신청 방법은?"},
    ) as response:
        assert response.status_code == 200
        async for _ in response.aiter_lines():
            pass

    assert fake_asset_registry_resolver.get_asset_version_calls == []
    assert fake_asset_registry_resolver.get_prompt_template_calls == []
