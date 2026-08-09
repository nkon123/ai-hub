"""search-runtime policy settings — env-overridable, never hardcoded inline.

CLAUDE.md 구현 원칙: "수치는 코드에 하드코딩하지 않고 정책 설정으로 관리한다."
This module intentionally follows `hybrid.py`'s existing plain-`os.environ`
pattern (see `INDEX_BASE`) rather than adding a `pydantic-settings` dependency
that search-runtime's `pyproject.toml` does not yet declare — other services
(`agent_runtime.config`, `distribution_service.config`) use pydantic-settings,
but introducing a new dependency for two scalar knobs is unnecessary scope
for this change.

D-046 (docs/implementation-spec/open-decisions.md): search-runtime had no
relevance threshold, so an out-of-scope question always returned top-k
citations and the D-036 hallucination guard (agent-runtime, 0 citations ->
INSUFFICIENT_EVIDENCE) never fired for it. Measurement against the seeded
재택근무 정책 Knowledge index (cosine space, qwen3-embedding:0.6b), top-1
cosine similarity per query:

    query embedding          in-scope        out-of-scope    separation
    raw text (old default)   0.362-0.661     0.195-0.396     -0.034 (overlap)
    + Qwen3 instruct prefix  0.446-0.709     0.196-0.391     +0.056 (clean)

The instruct prefix is what makes a fixed threshold viable at all — without
it, the in-scope question "장비 지원은 무엇이 있나요?" (0.362) scores below
every out-of-scope question tested. DEFAULT_MIN_RELEVANCE_SCORE sits in the
0.391-0.446 separation gap measured with the prefix applied.
"""

from __future__ import annotations

import os

DEFAULT_MIN_RELEVANCE_SCORE: float = float(
    os.environ.get("SEARCH_MIN_RELEVANCE_SCORE", "0.42")
)
"""Cosine-similarity floor for a citation's best vector match. 0 disables
filtering (backward-compatible: returns top_k regardless of relevance)."""

DEFAULT_QUERY_INSTRUCT_PREFIX: str = os.environ.get(
    "SEARCH_QUERY_INSTRUCT_PREFIX",
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
)
"""Prepended to the query text (query side only) before embedding for vector
search. Indexed document text is never prefixed — no re-indexing required.
Set SEARCH_QUERY_INSTRUCT_PREFIX="" to disable for models that don't use
this convention."""

ALLOW_UNKNOWN_CLASSIFICATION: bool = os.environ.get(
    "SEARCH_ALLOW_UNKNOWN_CLASSIFICATION", "false"
).strip().lower() in {"1", "true", "yes"}
"""D-062 (open-decisions.md), 04-knowledge-platform.md §3.8: whether a chunk
whose `classification` metadata is missing or unrecognized
(`security_policy.Classification.UNKNOWN` — see indexing_runtime.pipeline's
stamping and security_policy.classification.parse_classification) is visible
to *any* caller, regardless of clearance.

Deliberately a deployment-level policy setting, not a per-request field on
SearchRequest (a per-request override would let the request body decide its
own ACL outcome — exactly what §3.8 forbids) and not a hardcoded literal in
access_control.py (the CORS-hardcoding lesson this codebase already learned
once — see agent_runtime.config.AgentRuntimeSettings.mcp_confirmation_timeout_seconds's
comment on the same mistake in that service's main.py).

Defaults to `False` (fail-closed / deny) — a document with no classification
evidence is withheld from everyone rather than guessed into visibility. This
is a real, deliberate behavior change for every index built before this
feature landed (none of them have `classification` metadata, including the
4 published demo chatbots' indexes) — the operator-facing remedy is
`indexing_runtime.stamp_classification` (the `stamp-classification` CLI),
which upgrades an existing index's `index-meta.json`/`bm25.pkl` in place
with a real classification value, without re-embedding. Setting this to
`true` instead is a legitimate, explicit choice for a deployment that has
decided un-stamped legacy content is safe to treat as visible to everyone —
but it must be made here, on purpose, not fallen into by omission.
"""

CHROMA_CLIENT_CACHE_MAX_SIZE: int = int(
    os.environ.get("SEARCH_CHROMA_CLIENT_CACHE_MAX_SIZE", "32")
)
"""D-067 (open-decisions.md): max number of `chromadb.PersistentClient`
instances `search_runtime.chroma_client_cache` keeps alive at once, one per
distinct Knowledge index path. See that module's docstring for the full
production incident (indexing-runtime wedged after 2 days 7 hours — 4095 OS
threads / 3344 fds — from constructing a brand-new, never-closed Chroma
client on every single search query). A bounded LRU, not an unbounded dict,
because a deployment with many Knowledge assets would otherwise turn "one
client per call" into "one client per distinct asset, forever" — smaller
in slope but still unbounded. 32 is a PoC-scale default (a handful of
concurrently "hot" Knowledge indexes); raise it for a deployment that
regularly serves more distinct indexes than that within one process's
lifetime, at the cost of proportionally more idle threads/fds held open."""
