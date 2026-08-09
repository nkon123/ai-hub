"""HttpSearchClient — request shape and error wrapping, using httpx.MockTransport
so no real network call or live search-runtime is needed."""

from __future__ import annotations

import json

import httpx
import pytest
from evaluation_runner.search_client import HttpSearchClient, SearchClient, SearchClientError


def test_search_client_is_abstract() -> None:
    with pytest.raises(TypeError):
        SearchClient()  # type: ignore[abstract]


@pytest.mark.asyncio
async def test_http_search_client_builds_expected_request_and_parses_response() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "citations": [
                    {
                        "chunk_id": "c1",
                        "parent_chunk_id": None,
                        "document_path": "/x/doc.md",
                        "document_title": "doc.md",
                        "page": 1,
                        "section": "s",
                        "excerpt": "hello",
                        "parent_context": "",
                        "score": 0.9,
                    }
                ],
                "total_chunks_searched": 1,
                "latency_ms": 42,
                "trace_id": "trace-1",
                "search_id": "search-1",
            },
        )

    client = HttpSearchClient(
        base_url="http://fake-search-runtime:8300",
        transport=httpx.MockTransport(handler),
    )

    response = await client.search(
        query="재택근무 신청 방법",
        knowledge_id="asset-version-1",
        knowledge_version="1.0.0",
        top_k=5,
        alpha=0.5,
        metadata_filters={"status": "active"},
        trace_id="trace-abc",
        run_id="run-abc",
    )

    assert captured["url"] == "http://fake-search-runtime:8300/search/v1/query"
    assert captured["body"] == {
        "query": "재택근무 신청 방법",
        "knowledge_id": "asset-version-1",
        "knowledge_version": "1.0.0",
        "top_k": 5,
        "alpha": 0.5,
        # D-062: evaluation-runner asserts RESTRICTED clearance by default so
        # quality metrics are never silently blinded by ACL filtering — see
        # search_client._DEFAULT_ACCESS_CONTEXT.
        "access_context": {"clearance": "RESTRICTED"},
        "metadata_filters": {"status": "active"},
        "trace_id": "trace-abc",
        "run_id": "run-abc",
    }
    assert response.latency_ms == 42
    assert response.trace_id == "trace-1"
    assert len(response.citations) == 1
    assert response.citations[0].chunk_id == "c1"
    assert response.citations[0].score == 0.9


@pytest.mark.asyncio
async def test_access_context_override_is_sent_verbatim_instead_of_default() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"citations": []})

    client = HttpSearchClient(
        base_url="http://fake-search-runtime:8300",
        transport=httpx.MockTransport(handler),
    )

    await client.search(
        query="q",
        knowledge_id="k",
        access_context={"clearance": "PUBLIC_INTERNAL", "user_id": "u1"},
    )

    assert captured["body"]["access_context"] == {"clearance": "PUBLIC_INTERNAL", "user_id": "u1"}


@pytest.mark.asyncio
async def test_http_search_client_wraps_non_2xx_as_search_client_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = HttpSearchClient(
        base_url="http://fake-search-runtime:8300",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(SearchClientError):
        await client.search(query="q", knowledge_id="k")


@pytest.mark.asyncio
async def test_http_search_client_wraps_malformed_response_as_search_client_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        # citations entries missing the required chunk_id field
        return httpx.Response(200, json={"citations": [{"unexpected": "shape"}]})

    client = HttpSearchClient(
        base_url="http://fake-search-runtime:8300",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(SearchClientError):
        await client.search(query="q", knowledge_id="k")
