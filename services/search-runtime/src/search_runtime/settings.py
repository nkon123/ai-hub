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

EMBED_MODEL: str = os.environ.get("SEARCH_EMBED_MODEL", "qwen3-embedding:0.6b")
"""Fallback query-embedding model — used ONLY when the Knowledge index being
searched has no `embed_model` recorded in its own `index-meta.json` (an
index built before indexing-runtime started stamping that field). See
`search_runtime.hybrid.resolve_embed_model`, which is the actual model
resolution logic and always prefers the index's own recorded model over
this setting.

This is deliberately a fallback, not a forced override, because of a
mismatch hazard this codebase was already bitten by in class (cf. the CORS
setting that existed but was shadowed by a hardcoded literal in
agent-runtime — a setting nobody actually reads is worse than no setting).
Embeddings from different models are not comparable: a Knowledge index built
with model A, queried with model B, does not raise an error — it silently
returns low-relevance/meaningless nearest neighbors, because cosine
similarity between two different embedding spaces carries no meaning. If
this setting disagreed with indexing-runtime's `INDEXING_EMBED_MODEL` and
search-runtime blindly trusted its own configured value instead of asking
the index what it was actually built with, every query against a
differently-built index would silently degrade with no error surfaced
anywhere. `resolve_embed_model` logs the fallback (and any disagreement
between this default and an index's recorded model) precisely so that does
not happen silently — see that function's docstring.

Default `qwen3-embedding:0.6b` matches indexing-runtime's own
`INDEXING_EMBED_MODEL` default (`indexing_runtime.settings.EMBED_MODEL`) so
a freshly-bootstrapped deployment has both sides agreeing out of the box.

Coupling with SEARCH_QUERY_INSTRUCT_PREFIX below: the default prefix is a
Qwen3-Embedding-specific convention (D-046) measured to matter a lot for
that model family's retrieval quality. If you change EMBED_MODEL (here or
via INDEXING_EMBED_MODEL for new indexes) to a non-Qwen3 model, you almost
certainly also need to change or clear SEARCH_QUERY_INSTRUCT_PREFIX — the
two env vars are independent knobs but not independent in effect, and
neither this module nor `hybrid.py` derives one from the other automatically
(docs/implementation-spec/open-decisions.md D-075)."""

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
this convention.

Coupled to EMBED_MODEL above, not derived from it: this default is tuned for
Qwen3-Embedding specifically. Switching EMBED_MODEL to a different model
family without revisiting this value risks silently reintroducing the
overlap D-046 measured (see EMBED_MODEL's docstring, D-075)."""

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

ALLOW_LEGACY_PICKLE_BM25: bool = os.environ.get(
    "SEARCH_ALLOW_LEGACY_PICKLE_BM25", "true"
).strip().lower() in {"1", "true", "yes"}
"""D-054 (open-decisions.md): whether this service may `pickle.load` a
Knowledge index's `bm25.pkl` when that index has not yet been migrated to
`bm25.json` (the non-executable format `indexing_runtime.pipeline` now
writes — see `search_runtime.bm25_store` module docstring). A pickle is
executable content; unpickling one from an untrusted source is arbitrary
code execution.

Defaults to `True` — matching this codebase's only currently-wired-up
deployment shape, where `INDEX_BASE` points at the central `data/indexes/`
tree written exclusively by `services/indexing-runtime` (a trusted local
writer, the same trust boundary `indexing_runtime.stamp_classification`
already documents). This default exists so an index directory not yet
converted by the `convert-bm25-format` operator CLI keeps working exactly
as before, with the fallback itself logged
(`search.bm25.legacy_pickle_fallback`, WARNING) rather than happening
silently forever.

**This must be set to `False`** for any search-runtime instance whose
`INDEX_BASE` could ever point at content that arrived over a distribution
channel rather than being built locally by this deployment's own
indexing-runtime — e.g. an index directory populated by installing a
Desktop Offline Bundle (`services/distribution-service` zips an index
directory's files verbatim into the bundle, unchanged, so an unconverted
`bm25.pkl` travels with it byte-for-byte). When `False`, a query against an
index that only has `bm25.pkl` raises
`search_runtime.bm25_store.LegacyPickleBm25Refused` instead of unpickling
it — `main.py` turns this into a `KNOWLEDGE_INDEX_CORRUPT` error response,
never a silent empty result (which would be indistinguishable from "no
relevant evidence" and hide an actionable, security-relevant refusal).

Honesty note (recorded in D-054): as of this change, no live component in
this codebase actually runs a search-runtime instance against a
Desktop-installed bundle's index directory — Desktop's local
runtime/search wiring is still incomplete (see D-059/D-060). This setting
is the mechanism a future such deployment MUST engage; it cannot itself be
end-to-end verified against a real Desktop-facing search-runtime instance
until that wiring exists."""

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

BM25_CACHE_MAX_SIZE: int = int(os.environ.get("SEARCH_BM25_CACHE_MAX_SIZE", "32"))
"""D-054 follow-up (b) (open-decisions.md): max number of rebuilt
`(document, source, BM25Okapi)` entries `search_runtime.bm25_cache` keeps
alive at once, one per distinct (BM25 file path, mtime, size) key.

`hybrid_search()` re-reads and re-parses the BM25 artifact
(`bm25.json`/legacy `bm25.pkl`) and reconstructs a `BM25Okapi` from scratch
on every single query — true even before D-054's pickle-to-JSON format
change, but that change made the per-query cost ~10x worse at scale versus
the old `pickle.load()` (measured on a synthetic corpus: 1,000 chunks
30ms vs 3ms, 5,000 chunks 168ms vs 18ms, 20,000 chunks 697ms vs 68ms — see
D-054's record). `bm25_cache.get_cached_bm25` closes that gap the same way
`chroma_client_cache.get_chroma_client` closed the D-067 Chroma-client leak:
a bounded, thread-safe, process-wide LRU. See `bm25_cache.py`'s module
docstring for the freshness-key design (why mtime+size, not path alone) and
why disposal here needs no `.close()` call (a `BM25Okapi` holds no native
thread pool or file handle, unlike a Chroma client — plain refcounting is
enough).

Same default (32) and same reasoning as `CHROMA_CLIENT_CACHE_MAX_SIZE`
above: an unbounded dict keyed by index path is itself a slow leak once a
deployment has many Knowledge assets — each entry holds a full rebuilt
`BM25Okapi` plus its source document (`chunk_ids`/`chunk_texts`/
`chunk_metadata`), sized with the corpus, not a small object. Raise it for a
deployment that regularly serves more distinct "hot" indexes than that
within one process's lifetime, at the cost of proportionally more retained
corpus memory."""
