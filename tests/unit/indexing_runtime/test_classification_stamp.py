"""Classification stamping (04-knowledge-platform.md §2.7, §3.8) —
pipeline.run_pipeline must write `classification` into both index-meta.json
and every chunk's metadata record, and must never guess a real level for a
missing/unrecognized value (open-decisions.md D-062).

No Ollama/Chroma/live service is used — embed_batch and chromadb are faked
(see conftest.py), matching tests/unit/search_runtime's established pattern.
"""

from __future__ import annotations

import json
import pickle

import pytest
from indexing_runtime import pipeline

from .conftest import patch_chroma, patch_embed_batch

pytestmark = pytest.mark.asyncio


async def _run(tmp_path, monkeypatch, *, classification: str | None) -> dict:
    src = tmp_path / "source"
    src.mkdir()
    (src / "doc.md").write_text("# 제목\n\n본문 내용입니다.\n\n## 소제목\n\n더 많은 본문입니다.\n")

    patch_chroma(monkeypatch, pipeline)
    patch_embed_batch(monkeypatch, pipeline)

    index_base = tmp_path / "indexes"
    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id="11111111-1111-1111-1111-111111111111",
        index_base=str(index_base),
        classification=classification,
    )
    assert result["status"] == "COMPLETED", result
    return index_base / "11111111-1111-1111-1111-111111111111"


def _load_bm25_metadata(index_dir) -> list[dict]:
    with open(index_dir / "bm25.pkl", "rb") as f:
        data = pickle.load(f)
    return data["chunk_metadata"]


def _load_index_meta(index_dir) -> dict:
    return json.loads((index_dir / "index-meta.json").read_text())


async def test_valid_classification_is_stamped_on_index_meta_and_chunks(
    tmp_path, monkeypatch
) -> None:
    index_dir = await _run(tmp_path, monkeypatch, classification="CONFIDENTIAL")

    assert _load_index_meta(index_dir)["classification"] == "CONFIDENTIAL"

    chunk_metadata = _load_bm25_metadata(index_dir)
    assert len(chunk_metadata) > 0
    assert all(m["classification"] == "CONFIDENTIAL" for m in chunk_metadata)


async def test_missing_classification_is_stamped_unknown_not_guessed(tmp_path, monkeypatch) -> None:
    """The core D-062 guarantee: omitting classification must never fall
    back to a real level like INTERNAL."""
    index_dir = await _run(tmp_path, monkeypatch, classification=None)

    assert _load_index_meta(index_dir)["classification"] == "UNKNOWN"
    chunk_metadata = _load_bm25_metadata(index_dir)
    assert all(m["classification"] == "UNKNOWN" for m in chunk_metadata)


async def test_unrecognized_classification_value_is_stamped_unknown(tmp_path, monkeypatch) -> None:
    """A garbage/foreign value (e.g. from a manifest schema drift) is treated
    the same as missing — UNKNOWN, never coerced into a real level."""
    index_dir = await _run(tmp_path, monkeypatch, classification="TOP_SECRET")

    assert _load_index_meta(index_dir)["classification"] == "UNKNOWN"
    chunk_metadata = _load_bm25_metadata(index_dir)
    assert all(m["classification"] == "UNKNOWN" for m in chunk_metadata)


async def test_parent_metadata_is_also_stamped(tmp_path, monkeypatch) -> None:
    """Default profile is parent_child, so parents.json must exist and carry
    the same classification as its children."""
    index_dir = await _run(tmp_path, monkeypatch, classification="INTERNAL")

    parent_map = json.loads((index_dir / "parents.json").read_text())
    assert len(parent_map) > 0
    assert all(p["metadata"]["classification"] == "INTERNAL" for p in parent_map.values())
