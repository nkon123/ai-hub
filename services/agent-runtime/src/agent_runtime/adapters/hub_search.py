"""Hub (central Knowledge registry, portal-api M02) search adapter.

A DIFFERENT network/trust boundary than `agent_runtime.adapters.search`'s
`HttpKnowledgeAdapter` (this machine's local search-runtime, an
offline/loopback index). This adapter calls portal-api's
`POST /api/v1/knowledge-search`, which fans out across the CENTRAL hub
Knowledge registry — a capability that must be used sparingly and only with
explicit run-level consent (`run_knowledge_chat`'s `allow_hub_lookup`), and
only ever with query text built by `agent_runtime.hub_query.build_hub_query`
(never local retrieval results, local document/chunk text, or a query built
from conversation history's assistant-answer text). See `hub_query.py`'s
module docstring for the full security rationale.
"""

from __future__ import annotations

from typing import Any

import httpx

from agent_runtime.adapters import HubSearchAdapter
from agent_runtime.hub_query import UserTypedQuery


class HubSearchError(Exception):
    """Raised by `HttpHubSearchAdapter.search` for any non-success outcome —
    same shape as `agent_runtime.adapters.search.KnowledgeSearchError`:
    `code` mirrors portal-api's own Error Envelope code when it actually
    replied with one; `HUB_SEARCH_UNAVAILABLE` covers a transport failure
    (connection error/timeout/bad body) where it did not reply at all. The
    hub being unreachable must degrade gracefully (Stage 2 simply
    contributes nothing) — callers must catch this and continue, never let
    it fail the whole run."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class HttpHubSearchAdapter(HubSearchAdapter):
    """Calls portal-api's `POST /api/v1/knowledge-search` (M02).

    Request: `{"query": "<string>", "top_k": <int>}`.
    Response: `{"trace_id", "knowledge_ids_searched": [...], "citations":
    [{"chunk_id", "parent_chunk_id", "document_path", "document_title",
    "page", "section", "excerpt", "parent_context", "score", "similarity",
    "knowledge_id", "asset_id", "asset_name", "source": "hub"}]}` — the same
    shape as Desktop's local `Citation`, plus the four additive fields
    (`knowledge_id`/`asset_id`/`asset_name`/`source`). See
    `packages/schemas/api/portal-openapi.yaml`'s `KnowledgeSearchCitation`
    for the authoritative contract.
    """

    def __init__(self, portal_api_url: str, token: str) -> None:
        self._portal_api_url = portal_api_url
        self._token = token

    async def search(
        self, query: UserTypedQuery, *, top_k: int = 5, trace_id: str | None = None
    ) -> dict[str, Any]:
        if not isinstance(query, UserTypedQuery):
            raise TypeError(
                "HttpHubSearchAdapter.search only accepts UserTypedQuery — "
                "build it with agent_runtime.hub_query.build_hub_query, "
                "never pass a raw str (which could carry local content)."
            )

        async with httpx.AsyncClient(timeout=30) as client:
            try:
                response = await client.post(
                    f"{self._portal_api_url}/api/v1/knowledge-search",
                    json={"query": query.text, "top_k": top_k},
                    headers={"Authorization": f"Bearer {self._token}"},
                )
            except httpx.HTTPError as exc:
                raise HubSearchError(
                    "HUB_SEARCH_UNAVAILABLE", f"portal-api knowledge-search 호출 실패: {exc}"
                ) from exc

            if response.status_code >= 400:
                body: dict[str, Any] = {}
                try:
                    body = response.json()
                except ValueError:
                    pass
                error = body.get("error") if isinstance(body, dict) else None
                code = (error or {}).get("code", "HUB_SEARCH_UNAVAILABLE")
                message = (error or {}).get("message", f"portal-api {response.status_code}")
                raise HubSearchError(code, message)

            return response.json()  # type: ignore[no-any-return]
