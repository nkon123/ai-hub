"""Adapter interfaces — Phase 1 implementation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agent_runtime.hub_query import UserTypedQuery


class LLMAdapter(ABC):
    """Interface for LLM providers (Ollama, OpenAI-compatible)."""

    @abstractmethod
    async def generate(
        self,
        messages: list[dict[str, Any]],
        model_alias: str,
        stream: bool = True,
    ) -> AsyncIterator[str]:
        ...


class KnowledgeAdapter(ABC):
    """Interface for Knowledge search."""

    @abstractmethod
    async def search(self, request: dict[str, Any]) -> dict[str, Any]:
        ...


class HubSearchAdapter(ABC):
    """Interface for hub (central Knowledge registry, portal-api M02)
    search — a DIFFERENT network/trust boundary than `KnowledgeAdapter`
    (this machine's local search-runtime). Backed in production by
    `agent_runtime.adapters.hub_search.HttpHubSearchAdapter`, which calls
    portal-api's `POST /api/v1/knowledge-search`.

    Only ever invoked with a `UserTypedQuery`
    (`agent_runtime.hub_query.UserTypedQuery`, built exclusively by
    `agent_runtime.hub_query.build_hub_query`) — never a raw `str`, which
    could carry local document/citation text or conversation-history
    assistant answers across this trust boundary. See
    `agent_runtime.adapters.hub_search.HttpHubSearchAdapter.search`'s
    `TypeError` guard, the actual enforcement point.
    """

    @abstractmethod
    async def search(
        self, query: UserTypedQuery, *, top_k: int = 5, trace_id: str | None = None
    ) -> dict[str, Any]:
        ...


class MCPAdapter(ABC):
    """Interface for MCP tool execution (READ_ONLY only)."""

    @abstractmethod
    async def call_tool(self, request: dict[str, Any]) -> dict[str, Any]:
        ...


class DeploymentResolver(ABC):
    """Interface for resolving a Hosted Chat slug to its published deployment.

    Backed in production by portal-api's no-auth, server-to-server
    `GET /api/v1/deployments/by-slug/{slug}` (M02). Returning `None` means
    "not usable" — callers must not distinguish an unknown slug from a
    suspended/non-ACTIVE one (slug-existence must not leak).
    """

    @abstractmethod
    async def resolve(self, slug: str) -> dict[str, Any] | None:
        ...


class AssetRegistryResolver(ABC):
    """Interface for resolving a single AssetVersion (manifest + status) from
    portal-api's Registry (M02) — D-034: the actual fix, replacing the
    Agent/Prompt "local copy only" workaround with a real (opt-in, cached,
    fail-safe) Registry lookup. See `agent_runtime.manifests` module
    docstring for the full resolution order this backs.

    Backed in production by the authenticated
    `GET /api/v1/asset-versions/{version_id}` (`get_asset_version`) and
    `GET /api/v1/asset-versions/{version_id}/template` (`get_prompt_template`,
    PROMPT only). Unlike `DeploymentResolver`, these are ordinary
    ASSET_READ-gated reads (not deliberately unauthenticated) — a genuine
    UUID version id needs no anti-enumeration protection the way a
    human-guessable Hosted Chat slug does.
    """

    @abstractmethod
    async def get_asset_version(self, version_id: str) -> dict[str, Any] | None:
        """Returns portal-api's `AssetVersionOut` shape — `{id, asset_id,
        version, status, manifest, ...}` — or `None` if the version does not
        exist. Note there is NO top-level `type`/`name`: the asset type only
        ever appears inside `manifest["type"]` (callers must read it from
        there, not from a top-level key that doesn't exist). Does NOT filter
        by status — callers must check `status == "APPROVED"` themselves."""
        ...

    @abstractmethod
    async def get_prompt_template(self, version_id: str) -> str | None:
        """Returns the PROMPT asset version's template file content, or
        `None` if the version doesn't exist / isn't type `prompt` / the file
        is missing. Only meaningful after `get_asset_version` confirms the
        type is `prompt`."""
        ...
