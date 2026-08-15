"""Integration tests for M02's AI 추천 텍스트 추출 passthrough
(`POST /api/v1/knowledge/extract-text`) — the .pdf/.docx leg of P12's AI
추천 button.

Covers: normal (relays excerpt/trace_id from indexing-runtime unchanged),
indexing-runtime unreachable (503), indexing-runtime rejects (format
unsupported / empty extraction, 400), indexing-runtime reports a missing
loader dependency (503, a DIFFERENT code/message than the rejection case —
this is the brief's central requirement), missing/invalid auth (401), no
ASSET_CREATE permission (403), and an audit assertion — the persisted
`AuditEvent.metadata_` must never contain the uploaded document's bytes/text
(root CLAUDE.md 로그 규칙, same rule `test_knowledge_metadata_suggest.py`
already enforces for the excerpt).

indexing-runtime is faked via a `get_extract_caller` dependency override (no
real indexing-runtime process required), mirroring
`test_knowledge_metadata_suggest.py`'s `get_suggest_caller` override pattern.
"""

from __future__ import annotations

import io

import httpx
import pytest
from portal_api.main import app
from portal_api.models import AuditEvent
from portal_api.routers.knowledge_text_extract import get_extract_caller
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header


def _fake_response(status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(status_code, json=json_body, request=httpx.Request("POST", "http://x"))


def _pdf_file(name: str = "a.pdf") -> dict:
    return {"file": (name, io.BytesIO(b"%PDF-1.4\n%%EOF"), "application/pdf")}


@pytest.fixture(autouse=True)
def _clear_extract_caller_override():
    yield
    app.dependency_overrides.pop(get_extract_caller, None)


# --- Normal ---


async def test_extract_text_relays_indexing_runtime_response(client: httpx.AsyncClient) -> None:
    calls: list[tuple[bytes, str]] = []

    async def fake_caller(content: bytes, filename: str) -> httpx.Response:
        calls.append((content, filename))
        return _fake_response(200, {"excerpt": "문서 발췌", "trace_id": "t-1"})

    app.dependency_overrides[get_extract_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers=auth_header(),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["excerpt"] == "문서 발췌"
    assert body["trace_id"]
    assert calls[0][1] == "a.pdf"


# --- Failure: indexing-runtime unreachable ---


async def test_extract_text_indexing_runtime_unreachable_returns_503(
    client: httpx.AsyncClient,
) -> None:
    async def fake_caller(content: bytes, filename: str) -> httpx.Response:
        raise httpx.ConnectError("simulated indexing-runtime unavailable")

    app.dependency_overrides[get_extract_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers=auth_header(),
    )

    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "KNOWLEDGE_TEXT_EXTRACT_UNAVAILABLE"


# --- Failure: 지원하지 않는 형식 / 빈 추출 결과 (indexing-runtime VALIDATION_ERROR) ---


async def test_extract_text_unsupported_format_returns_400_rejected(
    client: httpx.AsyncClient,
) -> None:
    async def fake_caller(content: bytes, filename: str) -> httpx.Response:
        return _fake_response(
            422,
            {
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": (
                        ".xlsx 형식은 추천을 지원하지 않습니다. "
                        "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다."
                    ),
                    "trace_id": "t-2",
                }
            },
        )

    app.dependency_overrides[get_extract_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files={"file": ("a.xlsx", io.BytesIO(b"x"), "application/octet-stream")},
        headers=auth_header(),
    )

    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "KNOWLEDGE_TEXT_EXTRACT_REJECTED"
    assert "지원하지 않습니다" in body["error"]["message"]


# --- Failure: 의존성 미설치 — 반드시 위와 다른 code/message ---


async def test_extract_text_missing_dependency_returns_distinct_error(
    client: httpx.AsyncClient,
) -> None:
    async def fake_caller(content: bytes, filename: str) -> httpx.Response:
        return _fake_response(
            503,
            {
                "error": {
                    "code": "DEPENDENCY_UNAVAILABLE",
                    "message": "PDF 로더에 필요한 pypdf가 설치되어 있지 않습니다.",
                    "trace_id": "t-3",
                }
            },
        )

    app.dependency_overrides[get_extract_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers=auth_header(),
    )

    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["error"]["code"] == "KNOWLEDGE_TEXT_EXTRACT_DEPENDENCY_MISSING"
    assert "의존성이 설치되어 있지 않습니다" in body["error"]["message"]
    # Must be a genuinely different code/message than the unsupported-format
    # rejection above — collapsing them would tell the user the wrong thing
    # about whether an operator can fix it.
    assert body["error"]["code"] != "KNOWLEDGE_TEXT_EXTRACT_REJECTED"
    assert "지원하지 않습니다" not in body["error"]["message"]


# --- Authentication / Permission ---


async def test_extract_text_missing_auth_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/v1/knowledge/extract-text", files=_pdf_file())
    assert resp.status_code == 401


async def test_extract_text_invalid_token_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


async def test_extract_text_without_asset_create_permission_returns_403(
    client: httpx.AsyncClient,
) -> None:
    # AUDITOR has no ASSET_CREATE permission (security_policy.roles).
    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers=auth_header("dev-auditor-token"),
    )
    assert resp.status_code == 403


# --- Audit: 업로드된 문서 bytes/텍스트는 절대 감사 로그에 남지 않는다 ---


async def test_extract_text_audit_never_contains_document_content(
    client: httpx.AsyncClient, db
) -> None:
    async def fake_caller(content: bytes, filename: str) -> httpx.Response:
        return _fake_response(
            200, {"excerpt": "이것은-절대-감사로그에-남으면-안되는-발췌문-XQ9", "trace_id": "t-4"}
        )

    app.dependency_overrides[get_extract_caller] = lambda: fake_caller

    resp = await client.post(
        "/api/v1/knowledge/extract-text",
        files=_pdf_file(),
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text

    events = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "KNOWLEDGE_TEXT_EXTRACT")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    assert events[0].result == "SUCCESS"
    assert "이것은-절대-감사로그에-남으면-안되는-발췌문-XQ9" not in str(events[0].metadata_)
