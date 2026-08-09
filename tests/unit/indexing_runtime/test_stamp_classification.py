"""stamp-classification CLI (open-decisions.md D-062) — idempotent upgrade of
an existing index-meta.json/bm25.pkl in place, without touching Chroma
(exercised separately/manually against a real Chroma dir; here the fake
`chromadb` import inside stamp_index_classification is allowed to fail
naturally since there is no chroma/ subdirectory in these fixtures, hitting
the documented best-effort except branch)."""

from __future__ import annotations

import json
import pickle

import pytest
from indexing_runtime.stamp_classification import (
    StampClassificationError,
    stamp_index_classification,
)


def _write_fake_index(index_dir, *, classification: str | None = None) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    meta = {"knowledge_id": index_dir.name, "chunk_count": 2}
    if classification is not None:
        meta["classification"] = classification
    (index_dir / "index-meta.json").write_text(json.dumps(meta))

    bm25_data = {
        "chunk_ids": ["c1", "c2"],
        "chunk_texts": ["t1", "t2"],
        "chunk_metadata": [{"title": "a"}, {"title": "b"}],
    }
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump(bm25_data, f)


def test_stamps_index_meta_and_chunk_metadata(tmp_path) -> None:
    index_dir = tmp_path / "idx-1"
    _write_fake_index(index_dir)

    result = stamp_index_classification(index_dir, "INTERNAL")

    assert result["classification"] == "INTERNAL"
    assert result["chunks_updated"] == 2
    assert result["previous_classification"] is None

    meta = json.loads((index_dir / "index-meta.json").read_text())
    assert meta["classification"] == "INTERNAL"

    with open(index_dir / "bm25.pkl", "rb") as f:
        bm25_data = pickle.load(f)
    assert all(m["classification"] == "INTERNAL" for m in bm25_data["chunk_metadata"])


def test_idempotent_rerun_with_same_value_is_a_noop_in_effect(tmp_path) -> None:
    index_dir = tmp_path / "idx-2"
    _write_fake_index(index_dir)

    stamp_index_classification(index_dir, "CONFIDENTIAL")
    second = stamp_index_classification(index_dir, "CONFIDENTIAL")

    assert second["previous_classification"] == "CONFIDENTIAL"
    assert second["classification"] == "CONFIDENTIAL"
    meta = json.loads((index_dir / "index-meta.json").read_text())
    assert meta["classification"] == "CONFIDENTIAL"


def test_rerun_with_different_value_overwrites(tmp_path) -> None:
    index_dir = tmp_path / "idx-3"
    _write_fake_index(index_dir, classification="INTERNAL")

    result = stamp_index_classification(index_dir, "RESTRICTED")

    assert result["previous_classification"] == "INTERNAL"
    assert result["classification"] == "RESTRICTED"


def test_unknown_is_rejected_as_a_target_value(tmp_path) -> None:
    index_dir = tmp_path / "idx-4"
    _write_fake_index(index_dir)

    with pytest.raises(StampClassificationError):
        stamp_index_classification(index_dir, "UNKNOWN")


def test_garbage_value_is_rejected(tmp_path) -> None:
    index_dir = tmp_path / "idx-5"
    _write_fake_index(index_dir)

    with pytest.raises(StampClassificationError):
        stamp_index_classification(index_dir, "TOP_SECRET")


def test_missing_index_files_is_rejected(tmp_path) -> None:
    index_dir = tmp_path / "not-an-index"
    index_dir.mkdir()

    with pytest.raises(StampClassificationError):
        stamp_index_classification(index_dir, "INTERNAL")
