"""Knowledge search adapter backed by the search-runtime HTTP API."""

from __future__ import annotations

from typing import Any

import httpx

from agent_runtime.adapters import KnowledgeAdapter


class KnowledgeSearchError(Exception):
    """Raised by `HttpKnowledgeAdapter.search` for any non-success outcome —
    same shape as `agent_runtime.adapters.mcp.MCPCallError`: `code` mirrors
    search-runtime's own Error Envelope code (e.g. `KNOWLEDGE_ACCESS_DENIED`,
    04-knowledge-platform.md §3.8/§5) when it actually replied with one;
    `KNOWLEDGE_SEARCH_UNAVAILABLE` covers a transport failure (connection
    error/timeout/bad body) where it did not reply at all."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class HttpKnowledgeAdapter(KnowledgeAdapter):
    """Calls search-runtime's POST /search/v1/query."""

    def __init__(self, search_runtime_url: str) -> None:
        self._search_runtime_url = search_runtime_url

    async def search(self, request: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                response = await client.post(
                    f"{self._search_runtime_url}/search/v1/query",
                    json=request,
                )
            except httpx.HTTPError as exc:
                raise KnowledgeSearchError(
                    "KNOWLEDGE_SEARCH_UNAVAILABLE", f"search-runtime 호출 실패: {exc}"
                ) from exc

            if response.status_code >= 400:
                body: dict[str, Any] = {}
                try:
                    body = response.json()
                except ValueError:
                    pass
                error = body.get("error") if isinstance(body, dict) else None
                code = (error or {}).get("code", "KNOWLEDGE_SEARCH_UNAVAILABLE")
                message = (error or {}).get("message", f"search-runtime {response.status_code}")
                raise KnowledgeSearchError(code, message)

            return response.json()  # type: ignore[no-any-return]
