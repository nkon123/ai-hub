"""search-runtime must embed a query with the model the TARGET INDEX was
actually built with (`index-meta.json`'s `embed_model`), not with its own
configured default. Before this fix, `hybrid_search` always embedded every
query with a hardcoded constant, silently ignoring whatever model an index
recorded — an index built with a different model than the constant would
return low-relevance/meaningless nearest neighbors with no error at all
(embeddings from different models are not comparable). See
`search_runtime.hybrid.resolve_embed_model`.

No live Ollama/Chroma — same fakes as test_relevance_filter.py
(embed_query and chromadb.PersistentClient are both monkeypatched via
conftest.py)."""

from __future__ import annotations

import json
import logging

import pytest
from search_runtime import hybrid

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "44444444-4444-4444-4444-444444444444"

CHUNK_IDS = ["c1", "c2"]
CHUNK_TEXTS = ["c1 text", "c2 text"]
CHUNK_METADATA = [
    {"source_path": "doc.md", "title": "Doc", "section": "s1", "page": 1},
    {"source_path": "doc.md", "title": "Doc", "section": "s2", "page": 1},
]
BM25_SCORES = [10, 5]
VECTOR_IDS = ["c1", "c2"]
VECTOR_DISTANCES = [0.3, 0.4]


def _write_index(tmp_path, *, embed_model: str | None, monkeypatch) -> None:
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=BM25_SCORES,
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, VECTOR_IDS, VECTOR_DISTANCES)
    if embed_model is not None:
        index_dir = tmp_path / KNOWLEDGE_ID
        meta = {"knowledge_id": KNOWLEDGE_ID, "embed_model": embed_model}
        (index_dir / "index-meta.json").write_text(json.dumps(meta))


# ---------------------------------------------------------------------------
# resolve_embed_model — pure function, no hybrid_search involved
# ---------------------------------------------------------------------------


def test_resolve_uses_index_meta_when_present(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    (index_dir / "index-meta.json").write_text(
        json.dumps({"knowledge_id": KNOWLEDGE_ID, "embed_model": "recorded-model:1b"})
    )

    model, source = hybrid.resolve_embed_model(
        str(tmp_path), KNOWLEDGE_ID, configured_default="configured-default:9b"
    )

    assert model == "recorded-model:1b"
    assert source == "index_meta"


def test_resolve_falls_back_when_index_meta_missing(tmp_path) -> None:
    model, source = hybrid.resolve_embed_model(
        str(tmp_path), "no-such-knowledge-id", configured_default="configured-default:9b"
    )

    assert model == "configured-default:9b"
    assert source == "fallback_default"


def test_resolve_falls_back_when_index_meta_has_no_embed_model_field(tmp_path) -> None:
    """Older index built before indexing-runtime stamped embed_model."""
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    (index_dir / "index-meta.json").write_text(json.dumps({"knowledge_id": KNOWLEDGE_ID}))

    model, source = hybrid.resolve_embed_model(
        str(tmp_path), KNOWLEDGE_ID, configured_default="configured-default:9b"
    )

    assert model == "configured-default:9b"
    assert source == "fallback_default"


def test_resolve_falls_back_on_corrupt_index_meta(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    (index_dir / "index-meta.json").write_text("{not valid json")

    model, source = hybrid.resolve_embed_model(
        str(tmp_path), KNOWLEDGE_ID, configured_default="configured-default:9b"
    )

    assert model == "configured-default:9b"
    assert source == "fallback_default"


def test_resolve_falls_back_when_embed_model_is_empty_string(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    (index_dir / "index-meta.json").write_text(
        json.dumps({"knowledge_id": KNOWLEDGE_ID, "embed_model": ""})
    )

    model, source = hybrid.resolve_embed_model(
        str(tmp_path), KNOWLEDGE_ID, configured_default="configured-default:9b"
    )

    assert model == "configured-default:9b"
    assert source == "fallback_default"


# ---------------------------------------------------------------------------
# hybrid_search end to end: the resolved model is what actually gets used to
# embed the query, not the `embed_model` parameter/default.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hybrid_search_embeds_with_the_index_recorded_model(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The core correctness fix: an index recorded as built with model A must
    be queried with model A even when hybrid_search's own configured
    `embed_model` default/argument says B — the two must be capable of
    disagreeing, and the index must win."""
    _write_index(tmp_path, embed_model="index-was-built-with:A", monkeypatch=monkeypatch)
    calls = patch_embed_query(monkeypatch, hybrid)

    await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=2,
        index_base=str(tmp_path),
        embed_model="service-configured-default:B",
        min_relevance_score=0,
    )

    assert len(calls) == 1
    assert calls[0]["model"] == "index-was-built-with:A"


@pytest.mark.asyncio
async def test_hybrid_search_falls_back_when_index_has_no_recorded_model(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No index-meta.json at all (older index) -> the configured default is
    used, and this must be a visible fallback, not a silent one (see the
    logging test below)."""
    _write_index(tmp_path, embed_model=None, monkeypatch=monkeypatch)
    calls = patch_embed_query(monkeypatch, hybrid)

    await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=2,
        index_base=str(tmp_path),
        embed_model="service-configured-default:B",
        min_relevance_score=0,
    )

    assert len(calls) == 1
    assert calls[0]["model"] == "service-configured-default:B"


@pytest.mark.asyncio
async def test_fallback_is_logged_as_a_warning(
    tmp_path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The fallback must be observable — an operator reading logs should be
    able to tell a query silently used the configured default instead of a
    model recorded on the index, per the task's 'make the fallback visible'
    requirement."""
    _write_index(tmp_path, embed_model=None, monkeypatch=monkeypatch)
    patch_embed_query(monkeypatch, hybrid)

    with caplog.at_level(logging.WARNING, logger="search_runtime"):
        await hybrid.hybrid_search(
            query="질문",
            knowledge_id=KNOWLEDGE_ID,
            top_k=2,
            index_base=str(tmp_path),
            embed_model="service-configured-default:B",
            min_relevance_score=0,
        )

    assert any(
        "search.embed_model.fallback" in record.message for record in caplog.records
    )


@pytest.mark.asyncio
async def test_mismatch_between_recorded_and_configured_is_logged(
    tmp_path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """When the index DOES record a model but it disagrees with the
    service's configured default, the index still wins for correctness, but
    the disagreement itself must be visible in logs (not just silently
    resolved) so an operator can notice a deployment-wide default drifted
    from what specific indexes were actually built with."""
    _write_index(tmp_path, embed_model="index-was-built-with:A", monkeypatch=monkeypatch)
    patch_embed_query(monkeypatch, hybrid)

    with caplog.at_level(logging.INFO, logger="search_runtime"):
        await hybrid.hybrid_search(
            query="질문",
            knowledge_id=KNOWLEDGE_ID,
            top_k=2,
            index_base=str(tmp_path),
            embed_model="service-configured-default:B",
            min_relevance_score=0,
        )

    assert any(
        "search.embed_model.mismatch" in record.message for record in caplog.records
    )


@pytest.mark.asyncio
async def test_no_log_noise_when_index_matches_configured_default(
    tmp_path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The normal/expected case (index recorded model == configured default,
    true for every seeded demo index today) must not emit a fallback or
    mismatch log line — those are for the two cases that actually need an
    operator's attention."""
    _write_index(tmp_path, embed_model="qwen3-embedding:0.6b", monkeypatch=monkeypatch)
    patch_embed_query(monkeypatch, hybrid)

    with caplog.at_level(logging.INFO, logger="search_runtime"):
        await hybrid.hybrid_search(
            query="질문",
            knowledge_id=KNOWLEDGE_ID,
            top_k=2,
            index_base=str(tmp_path),
            embed_model="qwen3-embedding:0.6b",
            min_relevance_score=0,
        )

    assert not any(
        "search.embed_model.fallback" in record.message
        or "search.embed_model.mismatch" in record.message
        for record in caplog.records
    )
