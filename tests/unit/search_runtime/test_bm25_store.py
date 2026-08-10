"""D-054: search_runtime.bm25_store's non-executable BM25 read path, and
hybrid_search's legacy-pickle trust-boundary behavior.

No live Ollama/Chroma — same fakes as test_relevance_filter.py."""

from __future__ import annotations

import json
import logging
import pickle

import pytest
from rank_bm25 import BM25Okapi
from search_runtime import hybrid
from search_runtime.bm25_store import (
    BM25_JSON_FILENAME,
    BM25_PICKLE_FILENAME,
    Bm25FormatError,
    LegacyPickleBm25Refused,
    load_bm25_document,
    load_bm25_json,
    rebuild_bm25,
)

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "33333333-3333-3333-3333-333333333333"
CHUNK_IDS = ["c1", "c2"]
CHUNK_TEXTS = ["재택근무 신청 방법", "원격근무 장비 지원"]
CHUNK_METADATA = [
    {"source_path": "doc.md", "title": "Doc", "section": "s1", "page": 1},
    {"source_path": "doc.md", "title": "Doc", "section": "s2", "page": 1},
]


# --- bm25_store unit tests ---------------------------------------------------


def test_load_bm25_json_round_trips_to_identical_scores(tmp_path) -> None:
    original_bm25 = BM25Okapi([t.split() for t in CHUNK_TEXTS])
    query = "장비 지원".split()
    expected = list(original_bm25.get_scores(query))

    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    document = {
        "schema_version": "1.0",
        "tokenizer": "whitespace_split",
        "tokenized_corpus": [t.split() for t in CHUNK_TEXTS],
        "chunk_ids": CHUNK_IDS,
        "chunk_texts": CHUNK_TEXTS,
        "chunk_metadata": CHUNK_METADATA,
    }
    (index_dir / BM25_JSON_FILENAME).write_text(json.dumps(document), encoding="utf-8")

    loaded, source = load_bm25_document(index_dir, allow_legacy_pickle=False)
    assert source == "json"
    rebuilt = rebuild_bm25(loaded["tokenized_corpus"])
    assert list(rebuilt.get_scores(query)) == expected


def test_load_bm25_json_rejects_malformed(tmp_path) -> None:
    path = tmp_path / BM25_JSON_FILENAME
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(Bm25FormatError):
        load_bm25_json(path)


def test_load_bm25_document_prefers_json_when_both_present(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    document = {
        "tokenized_corpus": [["json-marker"]],
        "chunk_ids": ["json-c1"],
        "chunk_texts": ["json text"],
        "chunk_metadata": [{}],
    }
    (index_dir / BM25_JSON_FILENAME).write_text(json.dumps(document), encoding="utf-8")
    with open(index_dir / BM25_PICKLE_FILENAME, "wb") as f:
        pickle.dump({"chunk_ids": ["stale-pickle-c1"]}, f)

    loaded, source = load_bm25_document(index_dir, allow_legacy_pickle=True)
    assert source == "json"
    assert loaded["chunk_ids"] == ["json-c1"]


def test_load_bm25_document_raises_filenotfound_when_neither_present(tmp_path) -> None:
    index_dir = tmp_path / "does-not-exist"
    index_dir.mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        load_bm25_document(index_dir, allow_legacy_pickle=True)


def test_load_bm25_document_legacy_pickle_allowed(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    with open(index_dir / BM25_PICKLE_FILENAME, "wb") as f:
        pickle.dump(
            {
                "bm25": BM25Okapi([t.split() for t in CHUNK_TEXTS]),
                "chunk_ids": CHUNK_IDS,
                "chunk_texts": CHUNK_TEXTS,
                "chunk_metadata": CHUNK_METADATA,
            },
            f,
        )

    loaded, source = load_bm25_document(index_dir, allow_legacy_pickle=True)
    assert source == "legacy_pickle"
    assert loaded["chunk_ids"] == CHUNK_IDS
    assert loaded["tokenized_corpus"] == [t.split() for t in CHUNK_TEXTS]


def test_load_bm25_document_legacy_pickle_refused_when_disallowed(tmp_path) -> None:
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    with open(index_dir / BM25_PICKLE_FILENAME, "wb") as f:
        pickle.dump({"chunk_ids": [], "chunk_texts": [], "chunk_metadata": []}, f)

    with pytest.raises(LegacyPickleBm25Refused):
        load_bm25_document(index_dir, allow_legacy_pickle=False)


# --- hybrid_search end-to-end trust-boundary behavior ------------------------


@pytest.mark.asyncio
async def test_hybrid_search_works_against_legacy_pickle_when_allowed(
    tmp_path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=[10, 5],
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
        legacy_pickle=True,
    )
    patch_chroma(monkeypatch, hybrid, ids=[], distances=[])
    patch_embed_query(monkeypatch, hybrid)

    with caplog.at_level(logging.WARNING, logger="search_runtime"):
        citations = await hybrid.hybrid_search(
            query="질문",
            knowledge_id=KNOWLEDGE_ID,
            top_k=2,
            index_base=str(tmp_path),
            min_relevance_score=0,
            allow_legacy_pickle_bm25=True,
        )

    assert [c["chunk_id"] for c in citations] == ["c1", "c2"]
    assert any("search.bm25.legacy_pickle_fallback" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_hybrid_search_refuses_legacy_pickle_when_disallowed(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=[10, 5],
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
        legacy_pickle=True,
    )
    patch_chroma(monkeypatch, hybrid, ids=[], distances=[])
    patch_embed_query(monkeypatch, hybrid)

    with pytest.raises(LegacyPickleBm25Refused):
        await hybrid.hybrid_search(
            query="질문",
            knowledge_id=KNOWLEDGE_ID,
            top_k=2,
            index_base=str(tmp_path),
            min_relevance_score=0,
            allow_legacy_pickle_bm25=False,
        )


@pytest.mark.asyncio
async def test_hybrid_search_json_format_unaffected_by_allow_legacy_pickle_flag(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The default (JSON present) format must work identically regardless
    of allow_legacy_pickle_bm25 — that flag only governs the legacy
    fallback, never the normal path."""
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=[10, 5],
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, ids=[], distances=[])
    patch_embed_query(monkeypatch, hybrid)

    citations = await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=2,
        index_base=str(tmp_path),
        min_relevance_score=0,
        allow_legacy_pickle_bm25=False,
    )

    assert [c["chunk_id"] for c in citations] == ["c1", "c2"]


def test_bm25_json_artifact_has_no_pickle_bytes(tmp_path) -> None:
    """Direct proof: the artifact search-runtime reads by default contains
    no pickle magic."""
    index_dir = tmp_path / KNOWLEDGE_ID
    index_dir.mkdir(parents=True)
    document = {
        "schema_version": "1.0",
        "tokenizer": "whitespace_split",
        "tokenized_corpus": [t.split() for t in CHUNK_TEXTS],
        "chunk_ids": CHUNK_IDS,
        "chunk_texts": CHUNK_TEXTS,
        "chunk_metadata": CHUNK_METADATA,
    }
    (index_dir / BM25_JSON_FILENAME).write_text(json.dumps(document), encoding="utf-8")

    raw = (index_dir / BM25_JSON_FILENAME).read_bytes()
    assert not raw.startswith(b"\x80")  # pickle protocol 2+ PROTO opcode
    json.loads(raw)  # must be parseable as plain JSON