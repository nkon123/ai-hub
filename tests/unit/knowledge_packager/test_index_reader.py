"""index_reader: read-only access to an index dir's JSON/Chroma artifacts."""

from __future__ import annotations

from pathlib import Path

import pytest
from knowledge_packager.index_reader import IndexReadError, read_index_meta, read_parents

from .conftest import make_index_dir


def test_read_index_meta_new_generation(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-new")
    meta = read_index_meta(fx.index_dir)
    assert meta.knowledge_id == "kid-new"
    assert meta.chunking_strategy == "parent_child"
    assert meta.chunk_count == len(fx.chunk_ids)


def test_read_index_meta_legacy_generation_has_no_chunking_strategy(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-legacy", legacy=True)
    meta = read_index_meta(fx.index_dir)
    assert meta.chunking_strategy is None


def test_read_index_meta_missing_file(tmp_path: Path) -> None:
    empty = tmp_path / "no-such-index"
    empty.mkdir()
    with pytest.raises(IndexReadError):
        read_index_meta(empty)


def test_read_index_meta_malformed_json(tmp_path: Path) -> None:
    bad = tmp_path / "bad-index"
    bad.mkdir()
    (bad / "index-meta.json").write_text("{not valid json", encoding="utf-8")
    with pytest.raises(IndexReadError):
        read_index_meta(bad)


def test_read_index_meta_missing_required_field(tmp_path: Path) -> None:
    bad = tmp_path / "bad-index-2"
    bad.mkdir()
    (bad / "index-meta.json").write_text('{"knowledge_id": "x"}', encoding="utf-8")
    with pytest.raises(IndexReadError):
        read_index_meta(bad)


def test_read_parents_returns_dict(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-parents")
    parents = read_parents(fx.index_dir)
    assert set(parents.keys()) == set(fx.parent_ids)


def test_read_parents_missing_file(tmp_path: Path) -> None:
    empty = tmp_path / "no-parents"
    empty.mkdir()
    (empty / "index-meta.json").write_text("{}", encoding="utf-8")
    with pytest.raises(IndexReadError):
        read_parents(empty)


def test_read_parents_rejects_non_object_top_level(tmp_path: Path) -> None:
    bad = tmp_path / "bad-parents"
    bad.mkdir()
    (bad / "parents.json").write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(IndexReadError):
        read_parents(bad)
