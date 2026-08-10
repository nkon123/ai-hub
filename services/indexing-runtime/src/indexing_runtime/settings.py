"""indexing-runtime policy settings — env-overridable, never hardcoded inline.

CLAUDE.md 구현 원칙: "수치는 코드에 하드코딩하지 않고 정책 설정으로 관리한다."
This module follows the exact same plain-`os.environ` convention that
`search_runtime.settings` already established for M08 — no new
`pydantic-settings` dependency for a single scalar knob.
"""

from __future__ import annotations

import os

EMBED_MODEL: str = os.environ.get("INDEXING_EMBED_MODEL", "qwen3-embedding:0.6b")
"""Ollama embedding model indexing-runtime uses to embed document chunks
(`embedders.embed_batch`, `pipeline.run_pipeline`'s default). Also the value
`run_pipeline` stamps into each freshly-built index's `index-meta.json`
(`embed_model` field) — this is how a later search knows which model an
index was actually built with.

Changing this env var only affects NEW indexing jobs going forward. It does
NOT retroactively change what any existing index was built with, and it does
NOT make search-runtime use a different model — search-runtime never reads
this setting. Instead, `search_runtime.hybrid.resolve_embed_model` reads the
`embed_model` recorded on the specific index being queried
(`search_runtime.settings.EMBED_MODEL` is only its fallback for indexes that
predate that field). This split is deliberate, not an oversight: a single
long-running search-runtime process serves many Knowledge indexes that may
have been built by different indexing-runtime deployments/versions/settings
over time, so "whatever indexing-runtime is configured with right now" is
not a safe assumption for "what any given index was built with".

Mismatch hazard (docs/implementation-spec/open-decisions.md D-075):
embeddings from different models are not comparable — if this were used to
override search's embedding model instead of index-meta.json, an index
built under model A queried with model B would silently return
low-relevance results with no error (cosine similarity between mismatched
embedding spaces carries no meaning). Moving an existing Knowledge asset to
a new model requires re-indexing it (or running `stamp_classification`-style
tooling only if you are also correcting the recorded metadata to match
embeddings that were already rebuilt) — never just flipping this env var and
restarting.

Default `qwen3-embedding:0.6b` matches
`search_runtime.settings.EMBED_MODEL`'s default and
`SEARCH_QUERY_INSTRUCT_PREFIX`'s Qwen3-tuned default (see that module) — all
three must be considered together when switching model families."""

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
