"""indexing-runtime policy settings — env-overridable, never hardcoded inline.

CLAUDE.md 구현 원칙: "수치는 코드에 하드코딩하지 않고 정책 설정으로 관리한다."
This module follows the exact same plain-`os.environ` convention that
`search_runtime.settings` already established for M08 — no new
`pydantic-settings` dependency for a single scalar knob.
"""

from __future__ import annotations

import os

BUILD_VERSION: str = os.environ.get("INDEXING_BUILD_VERSION", "0.1.0")
COMMIT_SHA: str = os.environ.get("INDEXING_COMMIT_SHA", "unknown")
"""Deployment identity, exposed by `/health` and logged once at startup.

Same contract as `portal_api.config.Settings.build_version` /
`distribution_service` (2026-08-12) and `search_runtime.settings`
(2026-08-13), extended here on 2026-08-14 so every long-running service in
this repo can answer "what code are you actually running" the same way.
Declared with this module's plain-`os.environ` convention rather than
pydantic-settings, matching the note at the top of this file.

The incident this closes: a search-runtime process from six days earlier was
still listening, so a route added that week returned 404 while `/health`
cheerfully reported a hardcoded `"0.1.0"` — indistinguishable from a process
started five minutes ago. Release automation injects the real SHA; the
explicit `"unknown"` fallback keeps a dev process honest instead of making
Git metadata a runtime dependency."""

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

EXTRACT_TEXT_EXCERPT_MAX_CHARS: int = int(
    os.environ.get("INDEXING_EXTRACT_TEXT_EXCERPT_MAX_CHARS", "4000")
)
"""Upper bound on the plain-text excerpt `POST /indexing/v1/extract-text`
returns (main.py) — the server-side text-extraction leg of the AI 추천
button's .pdf/.docx path (P12 Knowledge 등록). This endpoint returns a
BOUNDED excerpt, never the whole document (root CLAUDE.md: 정책 수치는
설정으로, 코드에 리터럴로 박지 않는다). Kept at the same default as
agent-runtime's `AgentRuntimeSettings.knowledge_metadata_suggest_excerpt_max_chars`
purely for consistency with the .md/.txt client-side excerpt size portal-web
already sends that endpoint — the two bounds are independent settings on
independent services and may diverge without breaking anything; agent-runtime
re-bounds whatever excerpt it receives regardless of this value."""

EXTRACT_TEXT_MAX_UPLOAD_BYTES: int = int(
    os.environ.get("INDEXING_EXTRACT_TEXT_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024))
)
"""Hard cap on the upload `POST /indexing/v1/extract-text` accepts, enforced
BEFORE extraction (`main.py::_read_bounded_upload` aborts the read once this
many bytes have arrived, regardless of what the caller's `Content-Length`
claims) — an unbounded PDF/DOCX parse is a denial-of-service path (this
task's brief, explicitly). 20MB is a PoC-scale default for a single
document excerpt request, independent of any registration-time upload size
policy elsewhere in the repo."""

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
