"""Unit tests for the hub-query chokepoint —
`agent_runtime.hub_query.build_hub_query`/`UserTypedQuery` and
`agent_runtime.adapters.hub_search.HttpHubSearchAdapter`'s type
enforcement.

This is the core security guarantee behind the hub (central Knowledge
registry, portal-api M02) lookup feature: hub-bound query text must be
built ONLY from user-typed text — this turn's `question` plus prior turns'
`["question"]` fields — and must NEVER include a prior turn's `["answer"]`
(which can legitimately contain local Knowledge document content, since
that is what a Knowledge chatbot answer IS), retrieved citations, or the
locally-rewritten search query. See `agent_runtime/hub_query.py`'s module
docstring for the full rationale; see
`tests/integration/agent_runtime/test_runs.py`'s
`test_hub_lookup_never_leaks_prior_answer_text_to_hub` for the same
guarantee proven end-to-end through a real Run."""

from __future__ import annotations

import pytest
from agent_runtime.adapters.hub_search import HttpHubSearchAdapter
from agent_runtime.hub_query import UserTypedQuery, build_hub_query


def test_build_hub_query_returns_user_typed_query() -> None:
    query = build_hub_query("질문입니다", [])
    assert isinstance(query, UserTypedQuery)
    assert query.text == "질문입니다"


def test_build_hub_query_includes_prior_question_fields_only() -> None:
    history = [
        {"question": "이전 질문 1", "answer": "이전 답변 1"},
        {"question": "이전 질문 2", "answer": "이전 답변 2"},
    ]
    query = build_hub_query("새 질문", history)
    assert query.text == "이전 질문 1\n이전 질문 2\n새 질문"


def test_build_hub_query_never_includes_answer_text_even_with_marker() -> None:
    """Direct unit-level proof of the chokepoint: a hand-built history list
    with a distinctive marker string only in `["answer"]` fields must never
    surface in the built query text, regardless of how many turns or how
    much answer text is present."""
    marker = "국세청-내부문서-비밀조항-QK9x"
    history = [
        {"question": "정책이 뭐야?", "answer": f"내부 문서에 따르면 {marker} 입니다."},
        {"question": "더 알려줘", "answer": f"추가 세부사항: {marker}-detail"},
    ]
    query = build_hub_query("계속 설명해줘", history)
    assert marker not in query.text
    assert query.text == "정책이 뭐야?\n더 알려줘\n계속 설명해줘"


def test_build_hub_query_skips_blank_turns() -> None:
    history = [{"question": "", "answer": "무언가"}, {"question": "  ", "answer": ""}]
    query = build_hub_query("실제 질문", history)
    assert query.text == "실제 질문"


def test_build_hub_query_strips_whitespace() -> None:
    history = [{"question": "  공백 있는 질문  ", "answer": ""}]
    query = build_hub_query("  새 질문  ", history)
    assert query.text == "공백 있는 질문\n새 질문"


async def test_http_hub_search_adapter_rejects_plain_string() -> None:
    """The enforced boundary: `HttpHubSearchAdapter.search` refuses, at the
    type level, anything that isn't a `UserTypedQuery` — a raw `str` could
    smuggle local document/citation text or conversation-history assistant
    answers across the hub's trust boundary."""
    adapter = HttpHubSearchAdapter(portal_api_url="http://example.invalid", token="t")
    with pytest.raises(TypeError, match="UserTypedQuery"):
        await adapter.search("plain string, not a UserTypedQuery")  # type: ignore[arg-type]


async def test_http_hub_search_adapter_rejects_none() -> None:
    adapter = HttpHubSearchAdapter(portal_api_url="http://example.invalid", token="t")
    with pytest.raises(TypeError):
        await adapter.search(None)  # type: ignore[arg-type]


async def test_http_hub_search_adapter_accepts_user_typed_query_type_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A well-formed `UserTypedQuery` passes the type guard (the actual HTTP
    call is not exercised here — that needs a live/mocked portal-api and is
    out of scope for this type-enforcement test)."""
    adapter = HttpHubSearchAdapter(portal_api_url="http://example.invalid", token="t")
    query = UserTypedQuery(text="안전한 질문")

    called = {}

    class _FakeResponse:
        status_code = 200

        def json(self) -> dict[str, object]:
            return {"trace_id": None, "knowledge_ids_searched": [], "citations": []}

    class _FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> _FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(
            self, url: str, *, json: dict[str, object], headers: dict[str, str]
        ) -> _FakeResponse:
            called["url"] = url
            called["json"] = json
            called["headers"] = headers
            return _FakeResponse()

    import httpx as httpx_module

    monkeypatch.setattr(httpx_module, "AsyncClient", _FakeAsyncClient)

    result = await adapter.search(query, top_k=3, trace_id="trace-1")
    assert result == {"trace_id": None, "knowledge_ids_searched": [], "citations": []}
    assert called["json"] == {"query": "안전한 질문", "top_k": 3}
    assert called["headers"] == {"Authorization": "Bearer t"}
