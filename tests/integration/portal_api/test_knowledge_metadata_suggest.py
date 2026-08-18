"""Integration tests for M02's AI 추천 passthrough
(`POST /api/v1/knowledge/suggest-metadata`).

Covers: normal (relays suggested_name/suggested_description from
agent-runtime unchanged), agent-runtime unreachable (503, never blocks
registration), agent-runtime returns 503/5xx (relayed as 503), missing/
invalid auth (401), no ASSET_CREATE permission (403), and an audit
assertion — the persisted `AuditEvent.metadata_` must never contain the
excerpt text (root CLAUDE.md 로그 규칙, same rule `test_knowledge_search.py`
already enforces for query text).

agent-runtime is faked via a `get_suggest_caller` dependency override (no
real agent-runtime process required), mirroring
`test_knowledge_search.py`'s `get_search_caller` override pattern.
"""

from __future__ import annotations

import httpx
import pytest
from portal_api.main import app
from portal_api.models import AuditEvent
from portal_api.routers.knowledge_metadata_suggest import get_suggest_caller
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

_DISTINCTIVE_EXCERPT = "이것은-감사로그에-절대-남으면-안되는-발췌문-XQ7"


@pytest.fixture(autouse=True)
def _clear_suggest_caller_override():
    yield
    app.dependency_overrides.pop(get_suggest_caller, None)


def _fake_response(status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(status_code, json=json_body, request=httpx.Request("POST", "http://x"))


# --- Normal ---


async def test_suggest_metadata_relays_agent_runtime_response(client: httpx.AsyncClient) -> None:
    calls: list[dict] = []

    async def fake_caller(payload: dict) -> httpx.Response:
        calls.append(payload)
        return _fake_response(
            200,
            {
                "suggested_name": "HR 정책 Knowledge",
                "suggested_description": "인사 정책을 다룹니다.",
                "trace_id": payload["trace_id"],
            },
        )

    app.dependency_overrides[get_suggest_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": "육아휴직은 최대 1년입니다.", "filename": "hr-policy.md"},
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["suggested_name"] == "HR 정책 Knowledge"
    assert body["suggested_description"] == "인사 정책을 다룹니다."
    assert body["trace_id"]
    assert calls[0]["filename"] == "hr-policy.md"


# --- Failure: registration must never depend on this succeeding ---


async def test_suggest_metadata_agent_runtime_unreachable_returns_503(
    client: httpx.AsyncClient,
) -> None:
    async def fake_caller(payload: dict) -> httpx.Response:
        raise httpx.ConnectError("simulated agent-runtime unavailable")

    app.dependency_overrides[get_suggest_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": "내용", "filename": "a.md"},
        headers=auth_header(),
    )

    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "KNOWLEDGE_METADATA_SUGGEST_UNAVAILABLE"


async def test_suggest_metadata_model_unavailable_relays_503(client: httpx.AsyncClient) -> None:
    async def fake_caller(payload: dict) -> httpx.Response:
        return _fake_response(503, {"error": {"code": "MODEL_UNAVAILABLE", "message": "..."}})

    app.dependency_overrides[get_suggest_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": "내용", "filename": "a.md"},
        headers=auth_header(),
    )

    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "KNOWLEDGE_METADATA_SUGGEST_UNAVAILABLE"


# --- Authentication / Permission ---


async def test_suggest_metadata_missing_auth_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata", json={"excerpt": "내용", "filename": "a.md"}
    )
    assert resp.status_code == 401


async def test_suggest_metadata_invalid_token_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": "내용", "filename": "a.md"},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


async def test_suggest_metadata_without_asset_create_permission_returns_403(
    client: httpx.AsyncClient,
) -> None:
    # AUDITOR has no ASSET_CREATE permission (security_policy.roles).
    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": "내용", "filename": "a.md"},
        headers=auth_header("dev-auditor-token"),
    )
    assert resp.status_code == 403


# --- Audit: excerpt text must never be persisted ---


async def test_suggest_metadata_audit_never_contains_excerpt_text(
    client: httpx.AsyncClient, db
) -> None:
    async def fake_caller(payload: dict) -> httpx.Response:
        return _fake_response(
            200,
            {"suggested_name": "이름", "suggested_description": "설명", "trace_id": "t"},
        )

    app.dependency_overrides[get_suggest_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/suggest-metadata",
        json={"excerpt": _DISTINCTIVE_EXCERPT, "filename": "a.md"},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text

    events = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "KNOWLEDGE_METADATA_SUGGEST")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    assert events[0].result == "SUCCESS"
    assert _DISTINCTIVE_EXCERPT not in str(events[0].metadata_)
