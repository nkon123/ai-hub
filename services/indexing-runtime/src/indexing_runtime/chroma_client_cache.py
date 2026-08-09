"""Process-wide cache of `chromadb.PersistentClient` instances, keyed by
resolved Chroma directory path — one client reused across every indexing
job (and every `stamp-classification` CLI invocation) against that path,
instead of a brand-new client per call.

Why this exists (docs/implementation-spec/open-decisions.md D-067):
`run_pipeline()` constructed a fresh `chromadb.PersistentClient` on every
indexing job, and `stamp_index_classification()`'s best-effort Chroma
metadata update did the same — neither ever closed it. Chroma's Rust
bindings back each *distinct* persist directory with its own `System`
(`chromadb.api.client.SharedSystemClient`), which owns a native thread pool
that never registers with Python's `threading` module — invisible to
`threading.active_count()`, visible only via a real OS thread count (`ps
-M`). Chroma itself already reuses that `System` for repeat opens of the
SAME path within one process (`SharedSystemClient._create_system_if_not_exists`
is a no-op on an already-seen identifier) — measured directly, 200 repeat
opens of one path show zero thread/fd growth. But a long-running
indexing-runtime process handles many DIFFERENT Knowledge indexes over its
uptime, and each distinct path gets its own System forever, because nothing
ever calls `.close()` to release it. Measured
(`scratchpad/repro_chroma_leak.py`, `before_multipath` mode, run against a
scratchpad copy of a real index): ~13 OS threads and ~10 fds leaked per
distinct Knowledge index opened, climbing linearly with no ceiling — this
is what produced the production wedge (`pthread_create`/`EAGAIN`, `os error
35`) after 2 days 7 hours (4095 threads, 3344 fds, `/health` unresponsive).

Disposal — the real supported path, not a pretend one: on eviction this
cache calls the evicted client's own `.close()`. In chromadb 1.5.9,
`Client.close()` decrements `SharedSystemClient`'s per-identifier refcount
and, once it hits zero, pops and calls `System.stop()` on the underlying
System — the only thing that actually tears down the Rust-bindings thread
pool. `SharedSystemClient.clear_system_cache()` was considered and
rejected: reading its source
(`chromadb/api/client.py::SharedSystemClient.clear_system_cache`) shows it
only reassigns the class-level tracking dicts to empty ones — it never
calls `system.stop()` on what it discards. Using it for eviction would make
the leaked System's Python-side handle unreachable while its native thread
pool keeps running: an *unrecoverable* leak, strictly worse than doing
nothing. `.close()` on the specific evicted client is the only path that
genuinely frees the threads/fds, and this module uses that path.

Duplicated in `search_runtime.chroma_client_cache` rather than shared via a
`packages/*` import: CLAUDE.md 원칙 2 forbids M07 (indexing-runtime)
importing M08 (search-runtime) internals or vice versa, and this codebase's
established precedent for chromadb specifically is that each direct
consumer owns its own direct usage (indexing-runtime's `pipeline.py`,
search-runtime's `hybrid.py`, and `packages/knowledge-packager`'s
`index_reader.py`/`relativize.py` each import `chromadb` directly — there
is no existing shared vector-store adapter package). Standing up a new
`packages/*` workspace member purely to host this ~40-line cache is a
bigger structural/contract change than a leak fix warrants (CLAUDE.md: 한
PR은 하나의 기능 또는 하나의 계약 변경으로 제한한다). The two copies are
kept intentionally identical; promote to a shared package if a third
service ever needs the same thing.

Staleness: reusing the client introduces none. Verified empirically — a
long-lived client, when `.get_collection(name)` is re-fetched on every call
(this cache only ever holds the `PersistentClient` itself, never a
`Collection` object), immediately reflects writes committed through a
completely different client/process pointed at the same path (tested: a
second client deleted+recreated+repopulated a collection, and the original
long-lived client's next `get_collection()` call saw the new row count, not
the old one). `run_pipeline()`'s own delete_collection+create_collection
re-indexing flow is exactly this pattern — a cached client used for a
*subsequent* indexing job of the same `knowledge_id` still deletes/recreates
the real, current collection, not a stale in-memory snapshot.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from pathlib import Path

import chromadb
from chromadb.api import ClientAPI

from indexing_runtime.settings import CHROMA_CLIENT_CACHE_MAX_SIZE

_logger = logging.getLogger("indexing_runtime")

_lock = threading.Lock()
_cache: OrderedDict[str, ClientAPI] = OrderedDict()


def get_chroma_client(chroma_dir: str | Path) -> ClientAPI:
    """Return a shared, cached `chromadb.PersistentClient` for `chroma_dir`,
    constructing one on first use and reusing it on every subsequent call
    for the same (resolved) path. Thread-safe: concurrent callers racing to
    open the same never-before-seen path serialize briefly on construction
    rather than each building (and leaking) their own client.
    """
    key = str(Path(chroma_dir).resolve())
    with _lock:
        client = _cache.get(key)
        if client is not None:
            _cache.move_to_end(key)
            return client

        client = chromadb.PersistentClient(path=key)
        _cache[key] = client
        _evict_over_capacity_locked()
        return client


def _evict_over_capacity_locked() -> None:
    """Caller must hold `_lock`. Evicts least-recently-used entries until
    the cache is back at or under `CHROMA_CLIENT_CACHE_MAX_SIZE`, calling
    `.close()` on each evicted client (see module docstring: this is the
    only path that actually releases the underlying thread pool)."""
    while len(_cache) > CHROMA_CLIENT_CACHE_MAX_SIZE:
        evicted_path, evicted_client = _cache.popitem(last=False)
        try:
            evicted_client.close()
        except Exception:
            _logger.warning(
                "chroma_client_cache.evict_close_failed path=%s", evicted_path, exc_info=True
            )


def cache_size() -> int:
    """Current number of cached clients — ops/test introspection."""
    with _lock:
        return len(_cache)


def clear_cache() -> None:
    """Close and drop every cached client. Test-only: production code never
    calls this — the cache is meant to live for the process's lifetime."""
    with _lock:
        while _cache:
            _, client = _cache.popitem()
            try:
                client.close()
            except Exception:
                _logger.warning("chroma_client_cache.clear_close_failed", exc_info=True)
