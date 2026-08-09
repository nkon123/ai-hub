"""D-046: the query-side instruct prefix must actually land in the text sent
for embedding. Faked httpx transport only — never a real Ollama call."""

from __future__ import annotations

import pytest
from search_runtime import hybrid


@pytest.mark.asyncio
async def test_embed_query_applies_instruct_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    sent_payloads: list[dict] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"embedding": [0.1, 0.2, 0.3]}

    class FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *exc: object) -> None:
            return None

        async def post(self, url: str, json: dict) -> FakeResponse:  # noqa: A002
            sent_payloads.append({"url": url, "json": json})
            return FakeResponse()

    monkeypatch.setattr(hybrid.httpx, "AsyncClient", FakeAsyncClient)

    prefix = (
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\n"
        "Query: "
    )
    embedding = await hybrid.embed_query("장비 지원은 무엇이 있나요?", instruct_prefix=prefix)

    assert embedding == [0.1, 0.2, 0.3]
    assert len(sent_payloads) == 1
    sent_prompt = sent_payloads[0]["json"]["prompt"]
    assert sent_prompt == (
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\n"
        "Query: 장비 지원은 무엇이 있나요?"
    )


@pytest.mark.asyncio
async def test_embed_query_empty_prefix_sends_raw_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty prefix (e.g. for a model that doesn't use this convention)
    must send the query text unchanged, not "" + query mangled some other way."""
    sent_payloads: list[dict] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"embedding": [0.1]}

    class FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *exc: object) -> None:
            return None

        async def post(self, url: str, json: dict) -> FakeResponse:  # noqa: A002
            sent_payloads.append({"url": url, "json": json})
            return FakeResponse()

    monkeypatch.setattr(hybrid.httpx, "AsyncClient", FakeAsyncClient)

    await hybrid.embed_query("연차 휴가는 몇 일인가요?", instruct_prefix="")

    assert sent_payloads[0]["json"]["prompt"] == "연차 휴가는 몇 일인가요?"
