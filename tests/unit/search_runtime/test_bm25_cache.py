"""D-054 follow-up (b) (open-decisions.md): the rebuilt-BM25 cache that
closes the "hybrid_search() re-reads and re-rebuilds bm25.json on every
single query" gap the pickle->JSON format change made ~10x more expensive
at scale. See `search_runtime.bm25_cache` module docstring for the full
measured before/after numbers and the freshness-key design.

Mirrors `test_chroma_client_cache.py`'s structure and the properties it
proved for the D-067 Chroma-client cache (same-object reuse, bounded size,
LRU eviction order) — plus the property that matters most for THIS cache
and has no Chroma-cache analogue: a changed `bm25.json` on disk must be a
guaranteed cache miss, never a stale hit. That is the one this task calls
"the important one" — asserted here on actual returned BM25 scores/content,
not on internal hit/miss counters, so a bug that silently returns the
CORRECT-looking but STALE object would still be caught.

No live Ollama/Chroma/service — real (but tiny, tmp_path-scoped) bm25.json
files and a real `rank_bm25.BM25Okapi` rebuild. Part of the default offline
suite (no special marker needed)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest
from search_runtime import bm25_cache
from search_runtime.bm25_cache import cache_size, clear_cache, get_cached_bm25
from search_runtime.bm25_store import BM25_JSON_FILENAME, BM25_PICKLE_FILENAME, load_bm25_document


@pytest.fixture(autouse=True)
def _isolated_cache():
    """The cache is a process-wide module-level singleton by design (that's
    the whole point — one rebuild per (path, mtime, size) for the process's
    lifetime). Tests must not leak state into each other or count entries
    left behind by other test files in the same pytest session, so clear it
    before and after every test in this file."""
    clear_cache()
    yield
    clear_cache()


def _write_json_index(
    index_dir: Path,
    *,
    chunk_ids: list[str],
    chunk_texts: list[str],
    chunk_metadata: list[dict[str, Any]] | None = None,
) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    document = {
        "schema_version": "1.0",
        "tokenizer": "whitespace_split",
        "tokenized_corpus": [t.split() for t in chunk_texts],
        "chunk_ids": chunk_ids,
        "chunk_texts": chunk_texts,
        "chunk_metadata": chunk_metadata or [{} for _ in chunk_ids],
    }
    (index_dir / BM25_JSON_FILENAME).write_text(
        json.dumps(document, ensure_ascii=False), encoding="utf-8"
    )


def _write_pickle_index(index_dir: Path, *, chunk_ids: list[str], chunk_texts: list[str]) -> None:
    import pickle

    from rank_bm25 import BM25Okapi

    index_dir.mkdir(parents=True, exist_ok=True)
    with open(index_dir / BM25_PICKLE_FILENAME, "wb") as f:
        pickle.dump(
            {
                "bm25": BM25Okapi([t.split() for t in chunk_texts]),
                "chunk_ids": chunk_ids,
                "chunk_texts": chunk_texts,
                "chunk_metadata": [{} for _ in chunk_ids],
            },
            f,
        )


# --- cache hit / same-object reuse ------------------------------------------


def test_same_index_returns_the_same_rebuilt_object_on_repeated_calls(tmp_path: Path) -> None:
    """The core fix: N calls against an unchanged file must reuse one
    rebuilt (document, bm25) pair, not re-read+re-rebuild every time."""
    index_dir = tmp_path / "knowledge-1"
    _write_json_index(index_dir, chunk_ids=["c1", "c2"], chunk_texts=["재택근무 신청", "장비 지원"])

    document_first, source_first, bm25_first = get_cached_bm25(index_dir, allow_legacy_pickle=True)
    for _ in range(20):
        document, source, bm25 = get_cached_bm25(index_dir, allow_legacy_pickle=True)
        assert document is document_first
        assert bm25 is bm25_first
        assert source == source_first == "json"
    assert cache_size() == 1


def test_artifact_is_read_from_disk_only_once_across_repeated_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Direct proof the cache actually avoids disk I/O on a hit, not just
    that it happens to return an equal-looking object: count real calls to
    load_bm25_document (the disk-reading step) across repeated
    get_cached_bm25 calls against the same unchanged file."""
    index_dir = tmp_path / "knowledge-1"
    _write_json_index(index_dir, chunk_ids=["c1"], chunk_texts=["문서 내용"])

    call_count = 0
    real_load = load_bm25_document

    def counting_load(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_count
        call_count += 1
        return real_load(*args, **kwargs)

    monkeypatch.setattr(bm25_cache, "load_bm25_document", counting_load)

    for _ in range(10):
        get_cached_bm25(index_dir, allow_legacy_pickle=True)

    assert call_count == 1


# --- invalidation on real on-disk change (the important one) ---------------


def test_modifying_bm25_json_invalidates_the_cache(tmp_path: Path) -> None:
    """The important one: a query after bm25.json changes on disk (as it
    does after re-indexing, convert-bm25-format, or stamp-classification)
    must reflect the NEW content, not silently keep serving the old cached
    object. Asserted on actual returned chunk_ids/chunk_texts/scores, not
    on internal hit/miss counters — a bug that returns a stale-but-
    plausible-looking object would still be caught this way."""
    index_dir = tmp_path / "knowledge-1"
    _write_json_index(index_dir, chunk_ids=["old-c1"], chunk_texts=["옛날 문서 내용"])

    document_old, _source, bm25_old = get_cached_bm25(index_dir, allow_legacy_pickle=True)
    assert document_old["chunk_ids"] == ["old-c1"]
    old_scores = list(bm25_old.get_scores(["문서"]))

    # A real on-disk change: different content, and (defensively, in case
    # the filesystem's mtime clock is coarse) force the mtime forward so
    # this is never mistaken for a same-instant no-op rewrite.
    time.sleep(0.01)
    _write_json_index(
        index_dir,
        chunk_ids=["new-c1", "new-c2"],
        chunk_texts=["완전히 새로운 내용", "재택근무 정책 갱신"],
    )
    new_mtime = time.time() + 1
    os.utime(index_dir / BM25_JSON_FILENAME, (new_mtime, new_mtime))

    document_new, _source2, bm25_new = get_cached_bm25(index_dir, allow_legacy_pickle=True)

    assert document_new["chunk_ids"] == ["new-c1", "new-c2"]
    assert document_new is not document_old
    assert bm25_new is not bm25_old
    new_scores = list(bm25_new.get_scores(["문서"]))
    assert new_scores != old_scores  # different corpus -> different BM25 statistics


def test_format_conversion_from_pickle_to_json_invalidates_the_cache(tmp_path: Path) -> None:
    """convert-bm25-format replaces bm25.pkl with bm25.json for the SAME
    index directory. The resolved source file's path changes (different
    filename), which must be reflected as a cache miss, not an accidental
    hit against the pre-conversion legacy-pickle-sourced entry."""
    index_dir = tmp_path / "knowledge-1"
    _write_pickle_index(index_dir, chunk_ids=["legacy-c1"], chunk_texts=["레거시 pickle 문서"])

    document_legacy, source_legacy, _bm25 = get_cached_bm25(index_dir, allow_legacy_pickle=True)
    assert source_legacy == "legacy_pickle"
    assert document_legacy["chunk_ids"] == ["legacy-c1"]

    # Simulate convert-bm25-format: write bm25.json, remove bm25.pkl.
    _write_json_index(index_dir, chunk_ids=["converted-c1"], chunk_texts=["변환된 JSON 문서"])
    (index_dir / BM25_PICKLE_FILENAME).unlink()

    document_converted, source_converted, _bm25c = get_cached_bm25(
        index_dir, allow_legacy_pickle=True
    )
    assert source_converted == "json"
    assert document_converted["chunk_ids"] == ["converted-c1"]
    assert cache_size() == 2  # both keys (different file paths) coexist


# --- bounded size / eviction -------------------------------------------------


def test_cache_never_exceeds_configured_max_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unbounded dict keyed by index path is itself a slow leak — the
    LRU must actually cap out, not just document a cap."""
    monkeypatch.setattr(bm25_cache, "BM25_CACHE_MAX_SIZE", 3)

    for i in range(10):
        index_dir = tmp_path / f"knowledge-{i}"
        _write_json_index(index_dir, chunk_ids=[f"c{i}"], chunk_texts=[f"문서 {i}"])
        get_cached_bm25(index_dir, allow_legacy_pickle=True)
        assert cache_size() <= 3

    assert cache_size() == 3


def test_lru_order_evicts_least_recently_used_not_least_recently_inserted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-accessing an index must count as a "use" for LRU purposes — a
    cache that only tracked insertion order would evict a hot, frequently-
    queried Knowledge index instead of a cold one."""
    monkeypatch.setattr(bm25_cache, "BM25_CACHE_MAX_SIZE", 2)

    dir_a = tmp_path / "knowledge-a"
    dir_b = tmp_path / "knowledge-b"
    dir_c = tmp_path / "knowledge-c"
    _write_json_index(dir_a, chunk_ids=["a1"], chunk_texts=["a 문서"])
    _write_json_index(dir_b, chunk_ids=["b1"], chunk_texts=["b 문서"])
    _write_json_index(dir_c, chunk_ids=["c1"], chunk_texts=["c 문서"])

    document_a, _, _ = get_cached_bm25(dir_a, allow_legacy_pickle=True)
    get_cached_bm25(dir_b, allow_legacy_pickle=True)
    # Touch "a" again so "b" becomes the least-recently-used entry.
    get_cached_bm25(dir_a, allow_legacy_pickle=True)
    get_cached_bm25(dir_c, allow_legacy_pickle=True)  # must evict "b", not "a"

    assert cache_size() == 2
    document_a_again, _, _ = get_cached_bm25(dir_a, allow_legacy_pickle=True)
    assert document_a_again is document_a  # "a" survived (still a hit)


# --- score identity vs. the uncached path -----------------------------------


def test_cached_scores_are_identical_to_the_uncached_path(tmp_path: Path) -> None:
    """The task's non-negotiable: caching must not change scores. Compare
    get_cached_bm25's rebuilt BM25Okapi against one built directly via
    bm25_store (bypassing the cache entirely) from the same document."""
    index_dir = tmp_path / "knowledge-1"
    chunk_texts = ["재택근무 신청 방법 안내", "원격근무 장비 지원 정책", "생성형 AI 활용 가이드"]
    _write_json_index(index_dir, chunk_ids=["c1", "c2", "c3"], chunk_texts=chunk_texts)

    from search_runtime.bm25_store import rebuild_bm25

    uncached_document, _ = load_bm25_document(index_dir, allow_legacy_pickle=True)
    uncached_bm25 = rebuild_bm25(uncached_document["tokenized_corpus"])

    _cached_document, _source, cached_bm25 = get_cached_bm25(index_dir, allow_legacy_pickle=True)

    for query in [["재택근무"], ["장비", "지원"], ["생성형", "AI"], ["무관한", "질문"]]:
        assert list(cached_bm25.get_scores(query)) == list(uncached_bm25.get_scores(query))


# --- legacy pickle path is cached on the same terms -------------------------


def test_legacy_pickle_refusal_is_not_cached_as_a_false_success(tmp_path: Path) -> None:
    """allow_legacy_pickle=False must keep raising every call — a cache
    must never turn a refusal into a silently-cached success, and must
    never cache the refusal itself as if it were a valid entry either
    (there is nothing valid to cache when the load raised)."""
    from search_runtime.bm25_store import LegacyPickleBm25Refused

    index_dir = tmp_path / "knowledge-1"
    _write_pickle_index(index_dir, chunk_ids=["c1"], chunk_texts=["문서"])

    with pytest.raises(LegacyPickleBm25Refused):
        get_cached_bm25(index_dir, allow_legacy_pickle=False)
    with pytest.raises(LegacyPickleBm25Refused):
        get_cached_bm25(index_dir, allow_legacy_pickle=False)

    assert cache_size() == 0


def test_legacy_pickle_is_cached_when_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-054's legacy .pkl fallback must be cached on the same terms as the
    normal bm25.json path — same object reused, disk read only once."""
    index_dir = tmp_path / "knowledge-1"
    _write_pickle_index(index_dir, chunk_ids=["c1", "c2"], chunk_texts=["문서 하나", "문서 둘"])

    call_count = 0
    real_load = load_bm25_document

    def counting_load(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_count
        call_count += 1
        return real_load(*args, **kwargs)

    monkeypatch.setattr(bm25_cache, "load_bm25_document", counting_load)

    document_first, source_first, bm25_first = get_cached_bm25(index_dir, allow_legacy_pickle=True)
    for _ in range(5):
        document, source, bm25 = get_cached_bm25(index_dir, allow_legacy_pickle=True)
        assert document is document_first
        assert bm25 is bm25_first
        assert source == source_first == "legacy_pickle"

    assert call_count == 1
