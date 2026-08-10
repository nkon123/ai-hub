"""Fixtures for agent-runtime integration tests.

Uses httpx.AsyncClient with ASGITransport so requests run in-process on the
test's own asyncio event loop — this gives genuine incremental SSE streaming
and lets a `cancel` request run concurrently with an in-flight `events`
stream on the same loop (the starlette/fastapi TestClient's thread-portal
bridge buffers the whole response before yielding any lines, which defeats
mid-stream cancellation tests). app.dependency_overrides swaps the real
Ollama/search-runtime adapters for fully in-memory fakes.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from agent_runtime.adapters import (
    AssetRegistryResolver,
    DeploymentResolver,
    KnowledgeAdapter,
    LLMAdapter,
    MCPAdapter,
)
from agent_runtime.adapters.mcp import MCPCallError
from agent_runtime.main import app
from agent_runtime.routers.chat import get_deployment_resolver
from agent_runtime.routers.runs import (
    get_asset_registry_resolver,
    get_knowledge_adapter,
    get_llm_adapter,
    get_mcp_adapter,
)

DEFAULT_CITATIONS: list[dict[str, Any]] = [
    {
        "chunk_id": "chunk-001",
        "parent_chunk_id": "parent-001",
        "document_path": "hr-policy/leave.md",
        "document_title": "연차 휴가 정책",
        "page": 1,
        "section": "3.1 연차 발생 기준",
        "excerpt": "연차는 입사일 기준 매년 15일이 발생합니다.",
        "parent_context": "연차 휴가 정책 전문...",
        "score": 0.92,
    },
    {
        "chunk_id": "chunk-002",
        "parent_chunk_id": "parent-002",
        "document_path": "hr-policy/leave.md",
        "document_title": "연차 휴가 정책",
        "page": 2,
        "section": "3.2 연차 사용 방법",
        "excerpt": "연차는 팀장 승인 후 사내 시스템에서 신청합니다.",
        "parent_context": "연차 휴가 정책 전문...",
        "score": 0.81,
    },
]


class FakeLLMAdapter(LLMAdapter):
    """Yields a configurable list of token strings.

    - call_count: incremented once per generate() invocation.
    - aclose_called: set True only when the underlying generator is closed
      early (GeneratorExit), i.e. the caller cancelled mid-stream — not on
      normal exhaustion.
    - calls: every `messages` list this adapter was invoked with, in order —
      lets a test inspect exactly what was sent to the "model" (e.g. to
      confirm a history block is/isn't present).
    - responses: when given, each successive generate() call yields the next
      entry (clamped to the last once exhausted) instead of `tokens` — added
      so a single test can distinguish workflow.py's two possible generate()
      calls (§3.4 Query Rewrite, then ANSWER_GENERATE) with different canned
      output for each.
    """

    def __init__(
        self,
        tokens: list[str] | None = None,
        delay: float = 0.0,
        responses: list[list[str]] | None = None,
    ) -> None:
        self.tokens = tokens if tokens is not None else ["안녕", "하세요"]
        self.delay = delay
        self.responses = responses
        self.call_count = 0
        self.aclose_called = False
        self.calls: list[list[dict[str, Any]]] = []

    async def generate(
        self,
        messages: list[dict[str, Any]],
        model_alias: str,
        stream: bool = True,
    ) -> AsyncIterator[str]:
        self.calls.append(messages)
        call_index = self.call_count
        self.call_count += 1
        if self.responses:
            tokens = self.responses[min(call_index, len(self.responses) - 1)]
        else:
            tokens = self.tokens
        try:
            for token in tokens:
                if self.delay:
                    await asyncio.sleep(self.delay)
                yield token
        except GeneratorExit:
            self.aclose_called = True
            raise


class FakeKnowledgeAdapter(KnowledgeAdapter):
    """Returns a configurable fixed citations list."""

    def __init__(self, citations: list[dict[str, Any]] | None = None) -> None:
        self.citations = citations if citations is not None else list(DEFAULT_CITATIONS)
        self.call_count = 0
        # Records every request dict this adapter was called with — added
        # for the multi-turn/Query Rewrite tests (test_runs.py), which need
        # to assert *what query text* was actually searched for, not just
        # that a search happened.
        self.calls: list[dict[str, Any]] = []

    async def search(self, request: dict[str, Any]) -> dict[str, Any]:
        self.call_count += 1
        self.calls.append(request)
        return {
            "citations": self.citations,
            "total_chunks_searched": len(self.citations),
            "latency_ms": 5,
            "trace_id": request.get("trace_id"),
            "search_id": "fake-search-id",
        }


DEFAULT_MCP_RESPONSE: dict[str, Any] = {
    "success": True,
    "tool_name": "db_metadata.get_columns",
    "output": {
        "columns": [
            {"name": "ID", "data_type": "NUMBER", "nullable": False, "is_primary_key": True}
        ]
    },
    "duration_ms": 5,
    "trace_id": "fake-mcp-trace",
    "rows_returned": 1,
    "truncated": False,
}


class FakeMCPAdapter(MCPAdapter):
    """Records every `call_tool` invocation and returns a configurable
    canned ToolCallResult-shaped dict — no live office-mcp-server needed.

    - `error_to_raise`: if set, `call_tool` raises this `MCPCallError`
      instead of returning (simulates a live MCP server error response).
    - `delay`: artificial per-call delay (seconds), used to exercise
      mid-call cancellation/timeout.
    """

    def __init__(
        self,
        response: dict[str, Any] | None = None,
        error_to_raise: MCPCallError | None = None,
        delay: float = 0.0,
    ) -> None:
        self.calls: list[dict[str, Any]] = []
        self.call_count = 0
        self.response = response if response is not None else dict(DEFAULT_MCP_RESPONSE)
        self.error_to_raise = error_to_raise
        self.delay = delay

    async def call_tool(self, request: dict[str, Any]) -> dict[str, Any]:
        self.call_count += 1
        self.calls.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error_to_raise is not None:
            raise self.error_to_raise
        return dict(self.response)


DEFAULT_DEPLOYMENTS: dict[str, dict[str, Any]] = {
    "remote-work-guide": {
        "deployment_id": "dep-001",
        "slug": "remote-work-guide",
        "status": "ACTIVE",
        "name": "재택근무 안내 챗봇",
        "chatbot_config": {
            "welcome_message": "안녕하세요! 재택근무 정책에 대해 물어보세요.",
            "suggested_questions": ["재택근무 신청 방법은?", "재택근무 가능 직군은?"],
            "citation_display": True,
        },
        "active_revision_id": "rev-001",
        "knowledge_id": "hr-policy-knowledge",
        "model_alias": "default-chat",
    }
}


class FakeDeploymentResolver(DeploymentResolver):
    """Returns a configurable fixed deployment map — no live portal-api needed.

    Mirrors the real portal-api `by-slug` contract: an unknown key resolves
    to None, identical to a suspended/non-ACTIVE deployment.
    """

    def __init__(self, deployments: dict[str, dict[str, Any]] | None = None) -> None:
        self.deployments = deployments if deployments is not None else dict(DEFAULT_DEPLOYMENTS)
        self.call_count = 0

    async def resolve(self, slug: str) -> dict[str, Any] | None:
        self.call_count += 1
        return self.deployments.get(slug)


class FakeAssetRegistryResolver(AssetRegistryResolver):
    """In-memory stand-in for `HttpAssetRegistryResolver` (D-034) — no live
    portal-api needed. `versions`/`templates` are keyed by version id;
    `error_to_raise`, when set, simulates portal-api being unreachable
    (raised from both methods, mirroring an httpx connection error)."""

    def __init__(
        self,
        versions: dict[str, dict[str, Any] | None] | None = None,
        templates: dict[str, str | None] | None = None,
        error_to_raise: Exception | None = None,
    ) -> None:
        self.versions = versions if versions is not None else {}
        self.templates = templates if templates is not None else {}
        self.error_to_raise = error_to_raise
        self.get_asset_version_calls: list[str] = []
        self.get_prompt_template_calls: list[str] = []

    async def get_asset_version(self, version_id: str) -> dict[str, Any] | None:
        self.get_asset_version_calls.append(version_id)
        if self.error_to_raise is not None:
            raise self.error_to_raise
        return self.versions.get(version_id)

    async def get_prompt_template(self, version_id: str) -> str | None:
        self.get_prompt_template_calls.append(version_id)
        if self.error_to_raise is not None:
            raise self.error_to_raise
        return self.templates.get(version_id)


@pytest.fixture
def fake_llm_adapter() -> FakeLLMAdapter:
    return FakeLLMAdapter()


@pytest.fixture
def fake_knowledge_adapter() -> FakeKnowledgeAdapter:
    return FakeKnowledgeAdapter()


@pytest.fixture
def fake_mcp_adapter() -> FakeMCPAdapter:
    return FakeMCPAdapter()


@pytest.fixture
def fake_deployment_resolver() -> FakeDeploymentResolver:
    return FakeDeploymentResolver()


@pytest.fixture
def fake_asset_registry_resolver() -> FakeAssetRegistryResolver:
    return FakeAssetRegistryResolver()


@pytest.fixture
async def client(
    fake_llm_adapter: FakeLLMAdapter,
    fake_knowledge_adapter: FakeKnowledgeAdapter,
    fake_mcp_adapter: FakeMCPAdapter,
    fake_deployment_resolver: FakeDeploymentResolver,
    fake_asset_registry_resolver: FakeAssetRegistryResolver,
) -> AsyncIterator[httpx.AsyncClient]:
    app.dependency_overrides[get_llm_adapter] = lambda: fake_llm_adapter
    app.dependency_overrides[get_knowledge_adapter] = lambda: fake_knowledge_adapter
    app.dependency_overrides[get_mcp_adapter] = lambda: fake_mcp_adapter
    app.dependency_overrides[get_deployment_resolver] = lambda: fake_deployment_resolver
    app.dependency_overrides[get_asset_registry_resolver] = lambda: fake_asset_registry_resolver
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()
