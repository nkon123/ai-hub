"""Regression test for D-067 (open-decisions.md) — the Chroma-client-per-call
leak that wedged indexing-runtime in production (4095 OS threads, 3344 fds,
`/health` unresponsive, after 2 days 7 hours). See
`search_runtime.chroma_client_cache` module docstring and
`scratchpad/repro_chroma_leak.py` (session-local, not part of this repo) for
the full measured before/after curves.

Deliberately does NOT assert on absolute thread/fd counts — those are
environment-dependent and would make this test flaky in CI. Instead it
asserts the two properties that actually make the fix correct:
  1. Repeated calls for the same path return the *same* client object
     (no new client, no new leak, per call).
  2. The cache is bounded — it never exceeds its configured max size, and
     an evicted client's underlying resources are genuinely torn down (not
     just forgotten), proven by every method call on it raising afterward.

Runs entirely against real (but tiny, throwaway, tmp_path-scoped)
`chromadb.PersistentClient` directories — no live service, no Ollama, no
network. Part of the default offline suite (no special marker needed).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from search_runtime import chroma_client_cache
from search_runtime.chroma_client_cache import cache_size, clear_cache, get_chroma_client


@pytest.fixture(autouse=True)
def _isolated_cache():
    """The cache is a process-wide module-level singleton by design (that's
    the whole point — one client per path for the process's lifetime). Tests
    must not leak state into each other, so clear it before and after every
    test in this file."""
    clear_cache()
    yield
    clear_cache()


def _chroma_dir(tmp_path: Path, name: str) -> Path:
    d = tmp_path / name / "chroma"
    d.mkdir(parents=True)
    return d


def test_same_path_returns_the_same_client_object_across_many_calls(tmp_path: Path) -> None:
    """The core fix: N calls against one path must reuse one client, not
    construct (and leak) a new one every time."""
    path = _chroma_dir(tmp_path, "asset-1")

    first = get_chroma_client(path)
    for _ in range(50):
        assert get_chroma_client(path) is first
    assert cache_size() == 1


def test_equivalent_path_spellings_resolve_to_the_same_cache_entry(tmp_path: Path) -> None:
    """A relative-looking or non-normalized path pointing at the same
    directory must not silently double the cache (Path.resolve() keys)."""
    path = _chroma_dir(tmp_path, "asset-2")

    first = get_chroma_client(path)
    second = get_chroma_client(str(path) + "/")
    assert second is first
    assert cache_size() == 1


def test_distinct_paths_get_distinct_clients(tmp_path: Path) -> None:
    a = get_chroma_client(_chroma_dir(tmp_path, "asset-a"))
    b = get_chroma_client(_chroma_dir(tmp_path, "asset-b"))
    assert a is not b
    assert cache_size() == 2


def test_cache_never_exceeds_configured_max_size(tmp_path: Path, monkeypatch) -> None:
    """This is the bounded-ness guarantee: an unbounded dict keyed by path
    is itself a slow leak (many Knowledge indexes over a service's
    lifetime) — the LRU must actually cap out, not just document a cap."""
    monkeypatch.setattr(chroma_client_cache, "CHROMA_CLIENT_CACHE_MAX_SIZE", 3)

    paths = [_chroma_dir(tmp_path, f"asset-{i}") for i in range(10)]
    for p in paths:
        get_chroma_client(p)
        assert cache_size() <= 3

    assert cache_size() == 3


def test_eviction_actually_closes_the_client_not_just_forgets_it(
    tmp_path: Path, monkeypatch
) -> None:
    """The disposal claim under test: eviction must call `.close()`, which
    genuinely tears down the client's underlying System (see module
    docstring's rejection of `clear_system_cache()`, which does NOT do
    this). Proof, without touching private attributes: any operation on an
    evicted client raises afterward, because its System has really been
    stopped and released — a client that was merely dropped from a dict
    without `.close()` would still work fine when called directly."""
    monkeypatch.setattr(chroma_client_cache, "CHROMA_CLIENT_CACHE_MAX_SIZE", 1)

    first_path = _chroma_dir(tmp_path, "asset-first")
    evicted_client = get_chroma_client(first_path)

    # Opening a second, distinct path with max size 1 must evict the first.
    second_path = _chroma_dir(tmp_path, "asset-second")
    get_chroma_client(second_path)
    assert cache_size() == 1

    # The evicted client's own resources must actually be gone now.
    with pytest.raises(Exception):  # noqa: B017 — real disposal, exact type is a chromadb internal
        evicted_client.list_collections()


def test_lru_order_evicts_least_recently_used_not_least_recently_inserted(
    tmp_path: Path, monkeypatch
) -> None:
    """Re-accessing a path must count as a "use" for LRU purposes — a cache
    that only tracked insertion order would evict a hot, frequently-queried
    Knowledge index instead of a cold one."""
    monkeypatch.setattr(chroma_client_cache, "CHROMA_CLIENT_CACHE_MAX_SIZE", 2)

    path_a = _chroma_dir(tmp_path, "asset-a")
    path_b = _chroma_dir(tmp_path, "asset-b")
    path_c = _chroma_dir(tmp_path, "asset-c")

    client_a = get_chroma_client(path_a)
    get_chroma_client(path_b)
    # Touch "a" again so "b" becomes the least-recently-used entry.
    get_chroma_client(path_a)
    get_chroma_client(path_c)  # must evict "b", not "a"

    assert cache_size() == 2
    assert get_chroma_client(path_a) is client_a  # "a" survived
