"""Regression test for the production indexing failure:

    Expected metadata list value for key 'title_path' to be non empty in add

ChromaDB's `collection.add` rejects an empty *list* metadata value outright
(empty strings/None are fine — see chromadb's `api/types.py::validate_metadata`
/ `_validate_metadata_list_value`). `chunkers/heading.py::parse_heading_sections`
deliberately returns an empty `title_path` for content before the first
heading (or for a document with no headings at all) — every seeded demo
document starts with a `#` heading, so this was never exercised until a real
upload without a leading heading hit it.

This runs `pipeline.run_pipeline` end to end against a REAL (tmp_path-scoped)
`chromadb.PersistentClient` — not the `FakeChromaCollection` from conftest.py,
which has no metadata validation at all and would not have caught this bug.
A unit test on `chunkers/heading.py` or `chunkers/parent_child.py` alone
would similarly not have caught it: the failure only happens inside Chroma's
own `collection.add`, which those unit tests never call.

Only Ollama (`embed_batch`) is faked (no network); Chroma is real.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from indexing_runtime import chroma_client_cache, pipeline

from .conftest import patch_embed_batch

pytestmark = pytest.mark.asyncio

NO_HEADING_CONTENT = (
    "이것은 제목이 전혀 없는 평범한 문서입니다. 첫 문단부터 헤딩 없이 시작합니다. "
    "실제 사용자가 업로드한 문서 중에는 이런 형태가 오히려 흔합니다.\n\n"
    "두 번째 문단도 마찬가지로 헤딩이 없습니다. 문서 전체에 '#', '##', '###' 마크다운 "
    "헤딩이 단 하나도 등장하지 않습니다.\n"
)

PREAMBLE_BEFORE_HEADING_CONTENT = (
    "머리말입니다. 첫 문단은 어떤 제목보다도 앞에 옵니다. 이 문단은 어느 헤딩에도 속하지 "
    "않는 본문입니다.\n\n"
    "# 진짜 제목\n\n"
    "본문 내용입니다.\n\n"
    "## 소제목\n\n"
    "더 많은 본문 내용입니다.\n"
)


@pytest.fixture(autouse=True)
def _isolated_chroma_cache():
    """Real `chromadb.PersistentClient` instances are cached process-wide by
    path (D-067) — clear before/after so this file's tmp_path-scoped clients
    never linger into other tests, matching test_chroma_client_cache.py's
    established convention for tests that use real Chroma."""
    chroma_client_cache.clear_cache()
    yield
    chroma_client_cache.clear_cache()


async def _run_pipeline(tmp_path: Path, monkeypatch, content: str) -> Path:
    src = tmp_path / "source"
    src.mkdir()
    (src / "doc.md").write_text(content, encoding="utf-8")

    patch_embed_batch(monkeypatch, pipeline)  # no Ollama network call

    index_base = tmp_path / "indexes"
    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id="22222222-2222-2222-2222-222222222222",
        index_base=str(index_base),
    )
    # The crux of the regression: this must not raise (or return FAILED) —
    # the original bug surfaced as collection.add() raising a ValueError from
    # real Chroma, which run_pipeline does not catch, so a broken pipeline
    # here would either raise out of this call or (if silently swallowed
    # somewhere) report a non-COMPLETED status.
    assert result["status"] == "COMPLETED", result
    return index_base / "22222222-2222-2222-2222-222222222222"


def _load_bm25_metadata(index_dir: Path) -> list[dict]:
    """D-054: pipeline.run_pipeline now writes bm25.json (plain, non-
    executable JSON), not bm25.pkl."""
    data = json.loads((index_dir / "bm25.json").read_text(encoding="utf-8"))
    return data["chunk_metadata"]


def _load_parent_metadata(index_dir: Path) -> list[dict]:
    parent_map = json.loads((index_dir / "parents.json").read_text())
    return [p["metadata"] for p in parent_map.values()]


def _assert_no_chroma_invalid_values(metadata_records: list[dict]) -> None:
    """Mirrors chromadb's own `validate_metadata`/`_validate_metadata_list_value`
    rules (api/types.py): every value must be a str, int, float, bool, None,
    or a *non-empty* list of one of those types."""
    assert metadata_records, "expected at least one metadata record"
    for record in metadata_records:
        for key, value in record.items():
            if isinstance(value, list):
                assert value, f"key {key!r} has an empty list value: {record}"
            else:
                assert isinstance(value, (str, int, float, bool)) or value is None, (
                    f"key {key!r} has a Chroma-invalid value {value!r}: {record}"
                )


async def test_document_with_no_headings_at_all_indexes_successfully(tmp_path, monkeypatch):
    index_dir = await _run_pipeline(tmp_path, monkeypatch, NO_HEADING_CONTENT)

    child_metadata = _load_bm25_metadata(index_dir)
    parent_metadata = _load_parent_metadata(index_dir)

    _assert_no_chroma_invalid_values(child_metadata)
    _assert_no_chroma_invalid_values(parent_metadata)

    # The whole point of the fix: no chunk carries an empty title_path list;
    # the key is omitted entirely for a document with no headings.
    assert all("title_path" not in m for m in child_metadata)
    assert all("title_path" not in m for m in parent_metadata)
    # section still degrades to the (Chroma-valid) empty string, not omitted.
    assert all(m["section"] == "" for m in child_metadata)


async def test_preamble_before_first_heading_indexes_successfully(tmp_path, monkeypatch):
    index_dir = await _run_pipeline(tmp_path, monkeypatch, PREAMBLE_BEFORE_HEADING_CONTENT)

    child_metadata = _load_bm25_metadata(index_dir)
    parent_metadata = _load_parent_metadata(index_dir)

    _assert_no_chroma_invalid_values(child_metadata)
    _assert_no_chroma_invalid_values(parent_metadata)

    by_section = {m["section"]: m for m in child_metadata}

    # The preamble chunk (before "# 진짜 제목") has no heading -> title_path
    # omitted, section == "".
    assert "" in by_section
    assert "title_path" not in by_section[""]

    # Heading-bearing chunks are unaffected: title_path present and correct.
    assert by_section["진짜 제목"]["title_path"] == ["진짜 제목"]
    assert by_section["소제목"]["title_path"] == ["진짜 제목", "소제목"]
