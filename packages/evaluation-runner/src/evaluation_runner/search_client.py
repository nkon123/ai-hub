"""SearchClient adapter — the only place this package talks to
services/search-runtime (M08) or, in tests, a fake.

CLAUDE.md 구현 원칙: "Provider/Vector Store/MCP Connector는 Adapter Interface
뒤에 둔다" and "외부 Library 타입을 Module Public Contract로 직접 노출하지
않는다" — HttpSearchClient uses httpx internally but the public contract
(SearchClient.search) only ever returns this module's own Citation/
SearchResponse dataclasses, never an httpx.Response or a raw dict. Every unit
test in tests/unit/evaluation_runner/ injects a FakeSearchClient and never
imports httpx or starts a real HTTP connection.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx


class SearchClientError(Exception):
    """Raised when the underlying search-runtime call fails (network error,
    non-2xx response, or a malformed response body)."""


@dataclass(frozen=True)
class Citation:
    """Mirrors one entry of search-runtime's POST /search/v1/query
    `citations[]` (services/search-runtime/src/search_runtime/hybrid.py)."""

    chunk_id: str
    parent_chunk_id: str | None
    document_path: str
    document_title: str
    page: int | None
    section: str | None
    excerpt: str
    parent_context: str
    score: float

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Citation:
        return Citation(
            chunk_id=data["chunk_id"],
            parent_chunk_id=data.get("parent_chunk_id"),
            document_path=data.get("document_path") or "",
            document_title=data.get("document_title") or "",
            page=data.get("page"),
            section=data.get("section"),
            excerpt=data.get("excerpt") or "",
            parent_context=data.get("parent_context") or "",
            score=float(data.get("score", 0.0)),
        )


@dataclass(frozen=True)
class SearchResponse:
    """Mirrors search-runtime's full POST /search/v1/query response body."""

    citations: list[Citation] = field(default_factory=list)
    total_chunks_searched: int = 0
    latency_ms: int = 0
    trace_id: str = ""
    search_id: str = ""

    @staticmethod
    def from_dict(data: dict[str, Any]) -> SearchResponse:
        return SearchResponse(
            citations=[Citation.from_dict(c) for c in data.get("citations", [])],
            total_chunks_searched=int(data.get("total_chunks_searched", 0)),
            latency_ms=int(data.get("latency_ms", 0)),
            trace_id=data.get("trace_id", ""),
            search_id=data.get("search_id", ""),
        )


class SearchClient(ABC):
    """Adapter interface for querying a Knowledge search backend.

    Every parameter matches services/search-runtime's SearchRequest field
    for field (see services/search-runtime/src/search_runtime/main.py) so a
    caller does not need to know it's talking to an HTTP service versus a
    fake.
    """

    @abstractmethod
    async def search(
        self,
        *,
        query: str,
        knowledge_id: str,
        knowledge_version: str = "latest",
        top_k: int = 5,
        alpha: float = 0.5,
        metadata_filters: dict[str, str] | None = None,
        trace_id: str | None = None,
        run_id: str | None = None,
        access_context: dict[str, Any] | None = None,
    ) -> SearchResponse:
        """Run one Knowledge search and return a SearchResponse."""
        raise NotImplementedError


# D-062, 04-knowledge-platform.md §3.8: evaluation-runner measures Knowledge
# quality against the *whole* indexed corpus (Recall@K etc.) regardless of
# any particular end user's clearance — it is a trusted, non-user-facing
# internal tool (never reachable from a browser), so it asserts the highest
# clearance by default rather than being silently blinded by ACL filtering
# once a Knowledge index carries real classification metadata. A caller that
# wants to measure quality *as a specific clearance would see it* can still
# override this via the `access_context` parameter below.
_DEFAULT_ACCESS_CONTEXT: dict[str, Any] = {"clearance": "RESTRICTED"}


class HttpSearchClient(SearchClient):
    """Calls the live search-runtime service over HTTP."""

    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        # `transport` is test-only (httpx.MockTransport) — never set in
        # production code paths, so no httpx type leaks into the CLI or into
        # any other module's public contract.
        self._transport = transport

    async def search(
        self,
        *,
        query: str,
        knowledge_id: str,
        knowledge_version: str = "latest",
        top_k: int = 5,
        alpha: float = 0.5,
        metadata_filters: dict[str, str] | None = None,
        trace_id: str | None = None,
        run_id: str | None = None,
        access_context: dict[str, Any] | None = None,
    ) -> SearchResponse:
        payload: dict[str, Any] = {
            "query": query,
            "knowledge_id": knowledge_id,
            "knowledge_version": knowledge_version,
            "top_k": top_k,
            "alpha": alpha,
            "access_context": access_context or _DEFAULT_ACCESS_CONTEXT,
        }
        if metadata_filters:
            payload["metadata_filters"] = metadata_filters
        if trace_id:
            payload["trace_id"] = trace_id
        if run_id:
            payload["run_id"] = run_id

        url = f"{self._base_url}/search/v1/query"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds, transport=self._transport
            ) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPError as exc:
            raise SearchClientError(f"search-runtime 호출 실패 ({url}): {exc}") from exc
        except ValueError as exc:  # JSON decode error
            raise SearchClientError(f"search-runtime 응답 파싱 실패 ({url}): {exc}") from exc

        try:
            return SearchResponse.from_dict(data)
        except (KeyError, TypeError) as exc:
            raise SearchClientError(f"search-runtime 응답 형식이 예상과 다릅니다: {exc}") from exc
