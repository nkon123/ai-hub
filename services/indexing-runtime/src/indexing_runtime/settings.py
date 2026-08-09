"""indexing-runtime policy settings — env-overridable, never hardcoded inline.

CLAUDE.md 구현 원칙: "수치는 코드에 하드코딩하지 않고 정책 설정으로 관리한다."
This module follows the exact same plain-`os.environ` convention that
`search_runtime.settings` already established for M08 — no new
`pydantic-settings` dependency for a single scalar knob.
"""

from __future__ import annotations

import os

CHROMA_CLIENT_CACHE_MAX_SIZE: int = int(
    os.environ.get("INDEXING_CHROMA_CLIENT_CACHE_MAX_SIZE", "32")
)
"""D-067 (open-decisions.md): max number of `chromadb.PersistentClient`
instances `indexing_runtime.chroma_client_cache` keeps alive at once, one
per distinct Knowledge index path. See that module's docstring for the full
production incident (indexing-runtime wedged after 2 days 7 hours — 4095 OS
threads / 3344 fds — traced to a brand-new, never-closed Chroma client
constructed on every indexing job in `pipeline.py`, and independently in
`stamp_classification.py`'s best-effort Chroma metadata update). A bounded
LRU, not an unbounded dict, because a deployment that has indexed many
Knowledge assets over the service's lifetime would otherwise turn "one
client per call" into "one client per distinct asset, forever" — smaller in
slope but still unbounded. 32 is a PoC-scale default; raise it for a
deployment that regularly (re-)indexes more distinct Knowledge assets than
that within one process's lifetime, at the cost of proportionally more idle
threads/fds held open. Kept identical to
`search_runtime.settings.CHROMA_CLIENT_CACHE_MAX_SIZE`'s default on purpose
(same workload shape), but is a separate env var/setting per service — see
`indexing_runtime.chroma_client_cache` module docstring for why the cache
itself is duplicated rather than shared across the M07/M08 boundary."""
