"""Process-wide cache of rebuilt BM25 artifacts, keyed by the on-disk BM25
file's path + mtime + size — one rebuild reused across every search query
against an unchanged index, instead of a fresh JSON parse + `BM25Okapi`
reconstruction on every single call.

Why this exists (docs/implementation-spec/open-decisions.md D-054, follow-up
(b)): `hybrid_search()` re-reads and re-parses the BM25 artifact
(`bm25.json`, or legacy `bm25.pkl`) and rebuilds a `BM25Okapi` from scratch
on EVERY query — this was already true before D-054's pickle->JSON format
change (queries were never cached at any point), but the format change made
the per-query cost roughly 10x worse at scale relative to the old
`pickle.load()`. Measured on real seeded data (재택근무 정책, 4 chunks; LLM
요약 문서, 64 chunks) the cost is ~4.7ms — negligible next to the ~200-300ms
Ollama embedding call every query already pays. Measured on a synthetic
large corpus, the cost is linear in corpus size and matters:
1,000 chunks = 30ms, 5,000 chunks = 168ms, 20,000 chunks = 697ms (vs. 3ms /
18ms / 68ms for the old `pickle.load()` — see D-054's record for the full
before/after table). That is a real bite against
`packages/evaluation-runner/config/quality-gate.yaml`'s P95 latency
criterion. This module closes the gap, following the exact bounded-LRU
shape `chroma_client_cache.py` established for D-067 (read that module's
docstring for the fuller rationale on *why bounded*, not just cached — the
short version: an unbounded dict keyed by index path is itself a slow leak
once a deployment has many Knowledge assets).

Cache key: `(resolved_file_path, mtime_ns, size)` — NOT the index's
directory path alone. Two reasons, both learned the hard way in this
project's other silent-wrong-answer incidents (D-046's missing relevance
floor, D-062's default-to-visible classification gap):

  1. **Freshness.** `bm25.json` is rewritten in place whenever a Knowledge
     asset is re-indexed (`indexing_runtime.pipeline.run_pipeline`),
     migrated (`convert-bm25-format`), or metadata-stamped
     (`stamp-classification`, D-062). A cache keyed on directory path alone
     would keep serving a superseded BM25 (stale `chunk_ids`/
     `chunk_metadata`, stale scores) after any of those — silently, since a
     stale-but-present file never raises an error. `mtime_ns` (nanosecond
     resolution — plain second-granularity `mtime` is not fine enough for a
     fast rebuild-then-requery in a test or a scripted operator workflow
     run back-to-back) plus `size` (belt-and-suspenders: two genuinely
     different rewrites landing on the exact same mtime_ns AND the exact
     same byte count is not a real-world risk this project needs to accept,
     and checking it costs nothing extra since `stat()` already returns
     both) means any on-disk change to the artifact is a cache miss, not a
     stale hit. No explicit invalidation call is needed anywhere else in
     the codebase — `pipeline.py`, `convert_bm25_format.py`,
     `stamp_classification.py` all need zero changes for this to work,
     because they all replace the file's bytes (and therefore its
     mtime/size) rather than mutating it in place.
  2. **Format transitions.** The key's path component is the *file that was
     actually resolved* (`bm25.json` if present, else `bm25.pkl` — see
     `bm25_store.resolve_bm25_source`), not the index directory.
     `convert-bm25-format` converting an index from `bm25.pkl` to
     `bm25.json` therefore always changes the key (different filename), on
     top of any mtime/size change — a converted index is guaranteed a fresh
     rebuild, never an accidental hit against a stale legacy-pickle-sourced
     cache entry left over from before conversion.

Not keyed on a content checksum: `stat()` is an O(1) syscall, whereas
hashing the whole file requires reading it in full — exactly the cost this
cache exists to avoid paying on every query. mtime+size is the standard
stat-based invalidation signal (make, rsync, and most on-disk caches use
exactly this).

Thread-safe: a single `threading.Lock` serializes both the cache lookup and
the (stat + load + rebuild) sequence on a miss, mirroring
`chroma_client_cache.get_chroma_client` exactly — concurrent requests racing
to query a never-before-cached (or just-changed) index serialize briefly on
one rebuild rather than each independently parsing+rebuilding. Unlike the
Chroma client cache, a redundant rebuild here would not corrupt shared
state (no native resource), but it is still wasted CPU proportional to
corpus size — worth avoiding under lock rather than accepting.

Bounded: `SEARCH_BM25_CACHE_MAX_SIZE` (default 32 — same default and
reasoning as `SEARCH_CHROMA_CLIENT_CACHE_MAX_SIZE`, see
`settings.py::BM25_CACHE_MAX_SIZE`'s docstring).

Disposal: unlike `chroma_client_cache`, eviction here is a plain dict
`popitem` — no `.close()` call. A `BM25Okapi` (and the plain-dict `document`
it was rebuilt from) is ordinary Python/NumPy heap memory with no native
thread pool, socket, or file handle. There is nothing to release beyond
dropping the last reference; normal refcounting/GC reclaims it. (Contrast
`chroma_client_cache`'s eviction, which specifically exists because
Chroma's Rust bindings hold a native thread pool that plain Python
refcounting cannot reach — see that module's docstring for why
`clear_system_cache()` was rejected there. None of that applies here.)

Duplicated, not shared, for the same CLAUDE.md 원칙 2 (모듈 간 내부 폴더 직접
Import 금지) reason `chroma_client_cache.py` and `bm25_store.py` already are
in this service: this module has no `indexing_runtime` twin, because
indexing-runtime never repeatedly re-queries a live BM25 index the way
search-runtime's `hybrid_search` does per request — its own BM25 reads
(`stamp_classification`, `convert_bm25_format`) are each a single, one-shot
CLI invocation with no benefit from caching across calls.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from search_runtime.bm25_store import load_bm25_document, rebuild_bm25, resolve_bm25_source
from search_runtime.settings import BM25_CACHE_MAX_SIZE

_logger = logging.getLogger("search_runtime")

_lock = threading.Lock()
_CacheKey = tuple[str, int, int]
_CacheEntry = tuple[dict[str, Any], str, Any]
_cache: OrderedDict[_CacheKey, _CacheEntry] = OrderedDict()


def get_cached_bm25(index_dir: Path, *, allow_legacy_pickle: bool) -> _CacheEntry:
    """Return `(document, source, bm25)` for `index_dir`'s BM25 artifact —
    `document`/`source` exactly as `bm25_store.load_bm25_document` returns
    them, `bm25` the `BM25Okapi` `bm25_store.rebuild_bm25` reconstructs from
    `document["tokenized_corpus"]`.

    Reads+rebuilds only on a cache miss (first query against this exact
    file content, or the first query after that content actually changed —
    see module docstring for the `(path, mtime_ns, size)` key). Every
    subsequent query against an unchanged file reuses the same in-memory
    `document`/`bm25` objects instead of hitting disk again.

    Raises `FileNotFoundError` (no artifact at all) and
    `bm25_store.LegacyPickleBm25Refused` (gated legacy pickle) exactly as
    `load_bm25_document` does — this wrapper changes caching behavior only,
    never the error contract callers (`hybrid.hybrid_search`) already
    depend on. Callers should keep their existing
    `bm25_json_path.exists() or bm25_pkl_path.exists()` pre-check for the
    common "index not built yet" case, same as before this cache existed.
    """
    file_path, _fmt = resolve_bm25_source(index_dir)
    stat = file_path.stat()
    key: _CacheKey = (str(file_path), stat.st_mtime_ns, stat.st_size)

    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached

        document, source = load_bm25_document(index_dir, allow_legacy_pickle=allow_legacy_pickle)
        bm25 = rebuild_bm25(document["tokenized_corpus"])
        entry: _CacheEntry = (document, source, bm25)
        _cache[key] = entry
        _evict_over_capacity_locked()
        return entry


def _evict_over_capacity_locked() -> None:
    """Caller must hold `_lock`. Evicts least-recently-used entries until
    the cache is back at or under `BM25_CACHE_MAX_SIZE`. No disposal call
    needed on the evicted entry — see module docstring."""
    while len(_cache) > BM25_CACHE_MAX_SIZE:
        _cache.popitem(last=False)


def cache_size() -> int:
    """Current number of cached entries — ops/test introspection."""
    with _lock:
        return len(_cache)


def clear_cache() -> None:
    """Drop every cached entry. Test-only: production code never calls
    this — the cache is meant to live for the process's lifetime."""
    with _lock:
        _cache.clear()
