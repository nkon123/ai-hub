"""stamp-classification CLI (open-decisions.md D-062) — idempotent upgrade of
an existing index-meta.json/bm25 chunk metadata in place, without touching
Chroma (exercised separately/manually against a real Chroma dir; here the
fake `chromadb` import inside stamp_index_classification is allowed to fail
naturally since there is no chroma/ subdirectory in these fixtures, hitting
the documented best-effort except branch).

D-054: bm25.json (plain JSON, no pickle) is now the default fixture format
— this exercises the same code path `stamp-classification` hits against a
freshly-built index. A parallel set of `_legacy_pickle` tests keeps the old
bm25.pkl fallback path covered for an index not yet migrated by
`convert-bm25-format`.
"""

from __future__ import annotations

import json
import pickle

import pytest
from indexing_runtime.stamp_classification import (
    StampClassificationError,
    stamp_index_classification,
)


def _write_fake_index(index_dir, *, classification: str | None = None) -> None:
    """D-054 default: writes bm25.json (the current, non-executable
    format)."""
    index_dir.mkdir(parents=True, exist_ok=True)
    meta = {"knowledge_id": index_dir.name, "chunk_count": 2}
    if classification is not None:
        meta["classification"] = classification
    (index_dir / "index-meta.json").write_text(json.dumps(meta))

    bm25_data = {
        "schema_version": "1.0",
        "tokenizer": "whitespace_split",
        "tokenized_corpus": [["t1"], ["t2"]],
        "chunk_ids": ["c1", "c2"],
        "chunk_texts": ["t1", "t2"],
        "chunk_metadata": [{"title": "a"}, {"title": "b"}],
    }
    (index_dir / "bm25.json").write_text(json.dumps(bm25_data), encoding="utf-8")


def _write_fake_index_legacy_pickle(index_dir, *, classification: str | None = None) -> None:
    """A not-yet-migrated index — only bm25.pkl exists."""
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

    bm25_data = json.loads((index_dir / "bm25.json").read_text())
    assert all(m["classification"] == "INTERNAL" for m in bm25_data["chunk_metadata"])
    # Never touches pickle for the json-format path.
    assert not (index_dir / "bm25.pkl").exists()


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


# --- Legacy bm25.pkl fallback (index not yet migrated) ----------------------


def test_legacy_pickle_index_is_stamped_via_pickle_fallback(tmp_path) -> None:
    index_dir = tmp_path / "idx-legacy-1"
    _write_fake_index_legacy_pickle(index_dir)

    result = stamp_index_classification(index_dir, "INTERNAL")

    assert result["classification"] == "INTERNAL"
    assert result["chunks_updated"] == 2

    with open(index_dir / "bm25.pkl", "rb") as f:
        bm25_data = pickle.load(f)
    assert all(m["classification"] == "INTERNAL" for m in bm25_data["chunk_metadata"])
    # Legacy path never invents a bm25.json — that is convert-bm25-format's job.
    assert not (index_dir / "bm25.json").exists()


def test_legacy_pickle_idempotent_rerun(tmp_path) -> None:
    index_dir = tmp_path / "idx-legacy-2"
    _write_fake_index_legacy_pickle(index_dir)

    stamp_index_classification(index_dir, "CONFIDENTIAL")
    second = stamp_index_classification(index_dir, "CONFIDENTIAL")

    assert second["previous_classification"] == "CONFIDENTIAL"
    assert second["classification"] == "CONFIDENTIAL"


def test_json_preferred_when_both_formats_present(tmp_path) -> None:
    """A directory mid-conversion (bm25.json already written, stale bm25.pkl
    not yet removed — the exact state convert-bm25-format's 'both exist'
    branch cleans up) must be stamped via the JSON path, never pickle."""
    index_dir = tmp_path / "idx-both"
    _write_fake_index(index_dir)
    # Add a stale legacy pickle with a DIFFERENT chunk_metadata shape so a
    # test failure (wrong path taken) is unambiguous.
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"chunk_metadata": [{"title": "STALE"}]}, f)

    result = stamp_index_classification(index_dir, "INTERNAL")

    assert result["chunks_updated"] == 2  # the json file's 2 chunks, not the stale pickle's 1
    bm25_data = json.loads((index_dir / "bm25.json").read_text())
    assert all(m["classification"] == "INTERNAL" for m in bm25_data["chunk_metadata"])
