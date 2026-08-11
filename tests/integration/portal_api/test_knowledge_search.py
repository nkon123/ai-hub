"""Integration tests for M02's cross-Knowledge Hub Search API
(`POST /api/v1/knowledge-search`).

Covers: normal (citations returned, tagged with asset_id/asset_name),
empty (no APPROVED Knowledge exists → empty citations, 200 not error),
authentication (missing/invalid token → 401 — there is no role-based 403
case for this endpoint by design: `Permission.ASSET_READ` is granted to
every role, see `routers/knowledge_search.py`'s handler), partial failure
(one of several downstream search-runtime calls raises → still returns the
others' results, doesn't 500), total failure (every targeted Knowledge's
call fails → 503 KNOWLEDGE_SEARCH_UNAVAILABLE, not a silent empty result),
and an audit assertion — the persisted `AuditEvent.metadata_` must never
contain the query text (CLAUDE.md 로그 규칙).

search-runtime is faked via a `get_search_caller` dependency override (no
real search-runtime process required), mirroring
`test_distributions.py`'s `get_distribution_caller` override pattern.
"""

from __future__ import annotations

import httpx
import pytest
from portal_api.main import app
from portal_api.models import Asset, AssetVersion, AuditEvent
from portal_api.routers.knowledge_search import get_search_caller
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header, make_indexed_knowledge

_DISTINCTIVE_QUERY = "이것은-감사로그에-절대-남으면-안되는-질의문자열-XQ7"


async def _asset_for(db, version: AssetVersion) -> Asset:
    return (await db.execute(select(Asset).where(Asset.id == version.asset_id))).scalar_one()


def _fake_citation(chunk_id: str, *, similarity: float = 0.8, score: float = 0.5) -> dict:
    return {
        "chunk_id": chunk_id,
        "parent_chunk_id": None,
        "document_path": "docs/policy.md",
        "document_title": "정책 문서",
        "page": 1,
        "section": "1장",
        "excerpt": "발췌문",
        "parent_context": "",
        "score": score,
        "similarity": similarity,
    }


@pytest.fixture(autouse=True)
def _clear_search_caller_override():
    yield
    app.dependency_overrides.pop(get_search_caller, None)


# --- Normal ---


async def test_knowledge_search_returns_citations_tagged_with_asset_info(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    asset = await _asset_for(db, knowledge)

    calls: list[dict] = []

    async def fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return {"citations": [_fake_citation("chunk-1")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search",
        json={"query": "육아휴직 정책은?", "top_k": 5},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["knowledge_ids_searched"] == [knowledge.id]
    assert len(body["citations"]) == 1
    citation = body["citations"][0]
    assert citation["chunk_id"] == "chunk-1"
    assert citation["knowledge_id"] == knowledge.id
    assert citation["asset_id"] == asset.id
    assert citation["asset_name"] == asset.name
    assert citation["source"] == "hub"

    # The fan-out call carries no ACL override field — clearance is
    # server-derived, never taken from the request body.
    assert calls[0]["knowledge_id"] == knowledge.id
    assert calls[0]["access_context"]["clearance"] == "INTERNAL"


async def test_knowledge_search_scopes_to_requested_knowledge_ids(
    client: httpx.AsyncClient, db
) -> None:
    k1 = await make_indexed_knowledge(db)
    k2 = await make_indexed_knowledge(db)

    async def fake_caller(payload: dict) -> dict:
        return {"citations": [_fake_citation(f"chunk-{payload['knowledge_id']}")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search",
        json={"query": "질문", "knowledge_ids": [k1.id]},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["knowledge_ids_searched"] == [k1.id]
    assert k2.id not in [c["knowledge_id"] for c in body["citations"]]


async def test_knowledge_search_unknown_requested_id_is_silently_dropped_not_error(
    client: httpx.AsyncClient, db
) -> None:
    async def fake_caller(payload: dict) -> dict:
        return {"citations": []}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search",
        json={"query": "질문", "knowledge_ids": ["00000000-0000-0000-0000-000000000000"]},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["knowledge_ids_searched"] == []
    assert body["citations"] == []


# --- Empty ---


async def test_knowledge_search_empty_when_no_approved_knowledge_exists(
    client: httpx.AsyncClient, db
) -> None:
    resp = await client.post(
        "/api/v1/knowledge-search", json={"query": "질문"}, headers=auth_header()
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["citations"] == []
    assert body["knowledge_ids_searched"] == []


# --- Authentication (no role lacks ASSET_READ, so there is no RBAC 403
# case for this endpoint by design — see handler docstring) ---


async def test_knowledge_search_missing_auth_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/v1/knowledge-search", json={"query": "질문"})
    assert resp.status_code == 401


async def test_knowledge_search_invalid_token_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/knowledge-search",
        json={"query": "질문"},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


# --- Partial / total failure ---


async def test_knowledge_search_partial_failure_returns_other_results(
    client: httpx.AsyncClient, db
) -> None:
    ok_knowledge = await make_indexed_knowledge(db)
    failing_knowledge = await make_indexed_knowledge(db)

    async def fake_caller(payload: dict) -> dict:
        if payload["knowledge_id"] == failing_knowledge.id:
            raise httpx.ConnectError("simulated search-runtime unavailable")
        return {"citations": [_fake_citation("chunk-ok")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search", json={"query": "질문"}, headers=auth_header()
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["knowledge_ids_searched"] == [ok_knowledge.id]
    assert len(body["citations"]) == 1
    assert body["citations"][0]["knowledge_id"] == ok_knowledge.id


async def test_knowledge_search_all_failed_returns_service_unavailable(
    client: httpx.AsyncClient, db
) -> None:
    await make_indexed_knowledge(db)

    async def fake_caller(payload: dict) -> dict:
        raise httpx.ConnectError("simulated search-runtime unavailable")

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search", json={"query": "질문"}, headers=auth_header()
    )

    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "KNOWLEDGE_SEARCH_UNAVAILABLE"


# --- Audit: query text must never be persisted ---


async def test_knowledge_search_audit_never_contains_query_text(
    client: httpx.AsyncClient, db
) -> None:
    await make_indexed_knowledge(db)

    async def fake_caller(payload: dict) -> dict:
        return {"citations": [_fake_citation("chunk-1")]}

    app.dependency_overrides[get_search_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge-search",
        json={"query": _DISTINCTIVE_QUERY},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text

    events = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "KNOWLEDGE_SEARCH_HUB")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    event = events[0]
    assert event.result == "SUCCESS"
    # The security-relevant regression check: the distinctive query string
    # must not appear anywhere in the persisted audit row's metadata.
    assert _DISTINCTIVE_QUERY not in str(event.metadata_)
