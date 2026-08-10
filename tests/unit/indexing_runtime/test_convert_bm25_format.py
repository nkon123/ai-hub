"""convert-bm25-format CLI (D-054) — upgrades an existing index's bm25.pkl
to bm25.json in place, without re-embedding. Idempotent, and never deletes
bm25.pkl unless verification against the ORIGINAL pickled BM25Okapi's scores
passes both immediately after extraction and again after a write-then-read
round trip."""

from __future__ import annotations

import json
import pickle

import pytest
from indexing_runtime.bm25_store import tokenize
from indexing_runtime.convert_bm25_format import (
    ConvertBm25FormatError,
    convert_index_bm25_format,
)
from rank_bm25 import BM25Okapi

CHUNK_IDS = ["c1", "c2", "c3"]
CHUNK_TEXTS = [
    "재택근무 신청은 팀장 승인 후 처리됩니다",
    "원격근무 장비 지원은 모니터와 헤드셋을 포함합니다",
    "사무실 출근 시 주차 등록이 필요합니다",
]
CHUNK_METADATA = [{"title": f"doc{i}"} for i in range(3)]


def _write_legacy_pickle_index(index_dir) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    bm25 = BM25Okapi([tokenize(t) for t in CHUNK_TEXTS])
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump(
            {
                "bm25": bm25,
                "chunk_ids": CHUNK_IDS,
                "chunk_texts": CHUNK_TEXTS,
                "chunk_metadata": CHUNK_METADATA,
            },
            f,
        )


def test_converts_legacy_pickle_to_json_and_removes_pickle(tmp_path) -> None:
    index_dir = tmp_path / "idx-1"
    _write_legacy_pickle_index(index_dir)

    result = convert_index_bm25_format(index_dir)

    assert result.action == "converted"
    assert result.chunk_count == 3
    assert result.legacy_pickle_removed is True
    assert not (index_dir / "bm25.pkl").exists()
    assert (index_dir / "bm25.json").exists()


def test_converted_json_preserves_chunk_ids_and_metadata_exactly(tmp_path) -> None:
    index_dir = tmp_path / "idx-2"
    _write_legacy_pickle_index(index_dir)

    convert_index_bm25_format(index_dir)

    document = json.loads((index_dir / "bm25.json").read_text(encoding="utf-8"))
    assert document["chunk_ids"] == CHUNK_IDS
    assert document["chunk_texts"] == CHUNK_TEXTS
    assert document["chunk_metadata"] == CHUNK_METADATA


def test_converted_bm25_scores_identical_to_original_pickle(tmp_path) -> None:
    """The core claim: BM25 scores after conversion must be IDENTICAL to
    the original pickle-based implementation on the same corpus — not just
    'it loads'."""
    index_dir = tmp_path / "idx-3"
    original_bm25 = BM25Okapi([tokenize(t) for t in CHUNK_TEXTS])
    index_dir.mkdir(parents=True, exist_ok=True)
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump(
            {
                "bm25": original_bm25,
                "chunk_ids": CHUNK_IDS,
                "chunk_texts": CHUNK_TEXTS,
                "chunk_metadata": CHUNK_METADATA,
            },
            f,
        )

    convert_index_bm25_format(index_dir)

    from indexing_runtime.bm25_store import load_bm25_json, rebuild_bm25

    document = load_bm25_json(index_dir / "bm25.json")
    rebuilt_bm25 = rebuild_bm25(document["tokenized_corpus"])

    for query_text in ["재택근무 장비 지원", "주차 등록 방법", "완전히 무관한 질문"]:
        query = tokenize(query_text)
        assert list(rebuilt_bm25.get_scores(query)) == list(original_bm25.get_scores(query))


def test_idempotent_when_already_converted(tmp_path) -> None:
    index_dir = tmp_path / "idx-4"
    _write_legacy_pickle_index(index_dir)

    first = convert_index_bm25_format(index_dir)
    assert first.action == "converted"

    second = convert_index_bm25_format(index_dir)
    assert second.action == "already_converted"
    assert second.chunk_count == 3
    assert second.legacy_pickle_removed is False


def test_cleans_up_stale_pickle_when_both_formats_present(tmp_path) -> None:
    """Simulates a run interrupted after the JSON write but before the
    pickle removal — the JSON is authoritative, so this must clean up the
    stale pickle without re-extracting anything."""
    index_dir = tmp_path / "idx-5"
    _write_legacy_pickle_index(index_dir)
    convert_index_bm25_format(index_dir)  # produces bm25.json, removes bm25.pkl
    # Re-introduce a stale (deliberately different) pickle to simulate the
    # interrupted-run state.
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"chunk_metadata": ["STALE"]}, f)

    result = convert_index_bm25_format(index_dir)

    assert result.action == "cleaned_stale_pickle"
    assert not (index_dir / "bm25.pkl").exists()
    document = json.loads((index_dir / "bm25.json").read_text(encoding="utf-8"))
    assert document["chunk_metadata"] == CHUNK_METADATA  # untouched, still the real data


def test_missing_both_formats_raises(tmp_path) -> None:
    index_dir = tmp_path / "idx-6"
    index_dir.mkdir(parents=True)

    with pytest.raises(ConvertBm25FormatError):
        convert_index_bm25_format(index_dir)


def test_malformed_legacy_pickle_shape_does_not_delete_pickle(tmp_path) -> None:
    index_dir = tmp_path / "idx-7"
    index_dir.mkdir(parents=True)
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"unexpected": True}, f)

    with pytest.raises(ConvertBm25FormatError):
        convert_index_bm25_format(index_dir)

    # Original must survive a failed conversion.
    assert (index_dir / "bm25.pkl").exists()
    assert not (index_dir / "bm25.json").exists()
