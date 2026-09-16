"""`embedders.embed_batch` must actually batch, and must never misalign.

Both properties are here because both were real defects, and the first one
passed every existing test for months: `embed_batch` took a `batch_size`,
sliced the input with it, and then called a function that issued one HTTP
request per text anyway. Nothing asserted on the REQUEST COUNT, so a
parameter that changed literally nothing looked implemented. The consequence
showed up only at scale — a 21MB document (41,954 chunks) could not be indexed
inside portal-api's 300s budget and failed by timeout every time.

So the central assertion in this file is "how many HTTP requests were made",
not "were the embeddings right" — the old code got the embeddings right too.

No Ollama is contacted: `httpx.AsyncClient` is swapped for one bound to a
`MockTransport`, so these run offline like the rest of tests/unit.
"""

from __future__ import annotations

import httpx
import pytest
from indexing_runtime import embedders


def _install_mock_ollama(monkeypatch, handler) -> list[httpx.Request]:
    """Route every httpx request in this process to `handler`, recording them.

    `embed_batch` constructs its own `AsyncClient` internally (it owns the
    connection's lifetime), so there is no transport seam to inject — the
    client class itself is what gets replaced. monkeypatch restores it.
    """
    seen: list[httpx.Request] = []

    def recording_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(recording_handler)
    real_client = httpx.AsyncClient

    class _MockedClient(real_client):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):
            kwargs.pop("transport", None)
            super().__init__(*args, transport=transport, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _MockedClient)
    return seen


def _text_index(text: str) -> float:
    """Texts in these tests are named `t0`, `t1`, ... — the embedding encodes
    the index so a reordered or shifted result is detectable."""
    return float(int(text[1:]))


def _batch_handler(request: httpx.Request) -> httpx.Response:
    import json

    body = json.loads(request.content)
    return httpx.Response(200, json={"embeddings": [[_text_index(t)] for t in body["input"]]})


def _paths(requests: list[httpx.Request]) -> list[str]:
    return [r.url.path for r in requests]


@pytest.mark.asyncio
async def test_embed_batch_sends_one_request_per_batch_not_per_text(monkeypatch) -> None:
    """THE regression test. 10 texts at batch_size 4 is 3 requests.

    The old implementation would have made 10 — one per text — while passing
    every other assertion in this file.
    """
    seen = _install_mock_ollama(monkeypatch, _batch_handler)

    result = await embedders.embed_batch([f"t{i}" for i in range(10)], batch_size=4)

    assert len(result) == 10
    assert len(seen) == 3, f"expected 3 batched requests, got {len(seen)}"
    assert _paths(seen) == ["/api/embed"] * 3


@pytest.mark.asyncio
async def test_embedding_order_is_preserved_across_batch_boundaries(monkeypatch) -> None:
    """Chunk ids are matched to embeddings by list position in
    `pipeline.run_pipeline`. A batch reassembled out of order silently pairs
    every chunk with someone else's vector."""
    _install_mock_ollama(monkeypatch, _batch_handler)

    result = await embedders.embed_batch([f"t{i}" for i in range(25)], batch_size=7)

    assert result == [[float(i)] for i in range(25)]


@pytest.mark.asyncio
async def test_a_short_batch_fails_the_job_instead_of_shifting_every_later_chunk(
    monkeypatch,
) -> None:
    """If Ollama returns fewer embeddings than texts sent, every embedding
    after that point belongs to the wrong chunk for the rest of the run. The
    resulting index returns confident, well-formed, wrong citations and
    nothing downstream can detect it — so this must be fatal, not tolerated."""
    import json

    def short_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        inputs = body["input"]
        return httpx.Response(200, json={"embeddings": [[_text_index(t)] for t in inputs[:-1]]})

    _install_mock_ollama(monkeypatch, short_handler)

    with pytest.raises(embedders.EmbeddingCountMismatchError):
        await embedders.embed_batch([f"t{i}" for i in range(8)], batch_size=4)


@pytest.mark.asyncio
async def test_a_response_without_an_embeddings_array_is_fatal(monkeypatch) -> None:
    """A 200 with an unexpected body must not be read as zero embeddings —
    that would quietly produce an index missing every chunk it 'succeeded' on."""
    _install_mock_ollama(monkeypatch, lambda r: httpx.Response(200, json={"error": "nope"}))

    with pytest.raises(embedders.EmbeddingCountMismatchError):
        await embedders.embed_batch(["t0", "t1"], batch_size=2)


@pytest.mark.asyncio
async def test_falls_back_to_the_per_text_endpoint_when_api_embed_is_missing(
    monkeypatch,
) -> None:
    """An Ollama too old to serve `/api/embed` must keep working (closed
    networks pin versions) — correct, just slower."""
    import json

    def old_ollama(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/embed":
            return httpx.Response(404, json={"error": "not found"})
        body = json.loads(request.content)
        return httpx.Response(200, json={"embedding": [_text_index(body["prompt"])]})

    seen = _install_mock_ollama(monkeypatch, old_ollama)

    result = await embedders.embed_batch([f"t{i}" for i in range(5)], batch_size=2)

    assert result == [[float(i)] for i in range(5)]
    assert _paths(seen).count("/api/embeddings") == 5


@pytest.mark.asyncio
async def test_a_non_404_error_is_not_swallowed_by_the_fallback(monkeypatch) -> None:
    """Only a missing route justifies falling back. A 500 means Ollama is
    unwell, and quietly re-issuing the same work one text at a time would turn
    a fast, clear failure into a slow, confusing one."""
    _install_mock_ollama(monkeypatch, lambda r: httpx.Response(500, json={"error": "boom"}))

    with pytest.raises(httpx.HTTPStatusError):
        await embedders.embed_batch(["t0", "t1"], batch_size=2)


@pytest.mark.asyncio
async def test_no_texts_makes_no_request(monkeypatch) -> None:
    seen = _install_mock_ollama(monkeypatch, _batch_handler)

    assert await embedders.embed_batch([]) == []
    assert seen == []


@pytest.mark.asyncio
async def test_default_batch_size_comes_from_the_setting(monkeypatch) -> None:
    """The default must track `settings.EMBED_BATCH_SIZE` rather than a
    separate literal that can drift from it (the shadowed-setting mistake this
    repo has already made twice — see settings.py's module docstring)."""
    from indexing_runtime import settings

    seen = _install_mock_ollama(monkeypatch, _batch_handler)
    count = settings.EMBED_BATCH_SIZE + 1

    await embedders.embed_batch([f"t{i}" for i in range(count)])

    assert len(seen) == 2, "one full batch plus the remainder"


@pytest.mark.asyncio
async def test_batch_size_is_floored_at_one(monkeypatch) -> None:
    """A misconfigured 0 would make `range(0, n, 0)` raise, failing indexing
    with a ValueError that names nothing useful."""
    _install_mock_ollama(monkeypatch, _batch_handler)

    assert await embedders.embed_batch(["t0", "t1"], batch_size=0) == [[0.0], [1.0]]
