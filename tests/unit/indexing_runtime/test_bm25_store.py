"""indexing_runtime.bm25_store — D-054's non-executable BM25 serialization.

Core claim under test: rebuilding a BM25Okapi from a written-then-read-back
tokenized corpus produces IDENTICAL scores to a BM25Okapi built directly
from the same corpus in memory — i.e. the round trip through bm25.json is
lossless for scoring purposes, not just "it loads without raising"."""

from __future__ import annotations

import json

import pytest
from indexing_runtime.bm25_store import (
    BM25_JSON_FILENAME,
    Bm25FormatError,
    build_bm25_document,
    load_bm25_json,
    rebuild_bm25,
    tokenize,
    write_bm25_json,
)
from rank_bm25 import BM25Okapi

CHUNK_IDS = ["c1", "c2", "c3"]
CHUNK_TEXTS = [
    "재택근무 신청은 팀장 승인 후 처리됩니다",
    "원격근무 장비 지원은 모니터와 헤드셋을 포함합니다",
    "사무실 출근 시 주차 등록이 필요합니다",
]
CHUNK_METADATA = [{"title": f"doc{i}"} for i in range(3)]


def test_write_then_read_produces_identical_bm25_scores(tmp_path) -> None:
    original_bm25 = BM25Okapi([tokenize(t) for t in CHUNK_TEXTS])
    query = tokenize("재택근무 장비 지원")
    original_scores = list(original_bm25.get_scores(query))

    path = tmp_path / BM25_JSON_FILENAME
    write_bm25_json(path, CHUNK_IDS, CHUNK_TEXTS, CHUNK_METADATA)

    document = load_bm25_json(path)
    rebuilt_bm25 = rebuild_bm25(document["tokenized_corpus"])
    rebuilt_scores = list(rebuilt_bm25.get_scores(query))

    assert rebuilt_scores == original_scores
    assert document["chunk_ids"] == CHUNK_IDS
    assert document["chunk_texts"] == CHUNK_TEXTS
    assert document["chunk_metadata"] == CHUNK_METADATA


def test_written_file_is_plain_json_not_pickle(tmp_path) -> None:
    """Direct proof the artifact contains no pickle magic/opcodes — plain
    `json.loads` must succeed, and the pickle module must never be needed to
    read it."""
    path = tmp_path / BM25_JSON_FILENAME
    write_bm25_json(path, CHUNK_IDS, CHUNK_TEXTS, CHUNK_METADATA)

    raw = path.read_bytes()
    # A pickle protocol 2+ stream starts with b"\x80" (PROTO opcode) — a
    # bm25.json file must never start that way.
    assert not raw.startswith(b"\x80")
    # Must parse as JSON with json.loads alone (no pickle import needed).
    parsed = json.loads(raw.decode("utf-8"))
    assert parsed["chunk_ids"] == CHUNK_IDS


def test_tokenized_corpus_matches_whitespace_split(tmp_path) -> None:
    path = tmp_path / BM25_JSON_FILENAME
    write_bm25_json(path, CHUNK_IDS, CHUNK_TEXTS, CHUNK_METADATA)

    document = load_bm25_json(path)
    assert document["tokenized_corpus"] == [tokenize(t) for t in CHUNK_TEXTS]


def test_load_rejects_malformed_json(tmp_path) -> None:
    path = tmp_path / BM25_JSON_FILENAME
    path.write_text("{not valid json", encoding="utf-8")

    with pytest.raises(Bm25FormatError):
        load_bm25_json(path)


def test_load_rejects_missing_required_field(tmp_path) -> None:
    path = tmp_path / BM25_JSON_FILENAME
    path.write_text(json.dumps({"chunk_ids": ["a"]}), encoding="utf-8")

    with pytest.raises(Bm25FormatError):
        load_bm25_json(path)


def test_load_rejects_non_dict_top_level(tmp_path) -> None:
    path = tmp_path / BM25_JSON_FILENAME
    path.write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")

    with pytest.raises(Bm25FormatError):
        load_bm25_json(path)


def test_build_bm25_document_shape() -> None:
    document = build_bm25_document(CHUNK_IDS, CHUNK_TEXTS, CHUNK_METADATA)
    assert document["schema_version"] == "1.0"
    assert document["tokenizer"] == "whitespace_split"
    assert document["chunk_ids"] == CHUNK_IDS
    assert document["tokenized_corpus"] == [tokenize(t) for t in CHUNK_TEXTS]
