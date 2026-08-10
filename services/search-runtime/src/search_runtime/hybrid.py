"""Hybrid search: Vector (Chroma) + BM25 + RRF fusion."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from search_runtime.bm25_store import (
    BM25_JSON_FILENAME,
    BM25_PICKLE_FILENAME,
    load_bm25_document,
    rebuild_bm25,
)
from search_runtime.chroma_client_cache import get_chroma_client
from search_runtime.settings import (
    ALLOW_LEGACY_PICKLE_BM25,
    DEFAULT_MIN_RELEVANCE_SCORE,
    DEFAULT_QUERY_INSTRUCT_PREFIX,
    EMBED_MODEL,
)

INDEX_BASE = os.environ.get(
    "INDEX_BASE", "/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/data/indexes"
)
OLLAMA_ENDPOINT = "http://127.0.0.1:11434"

_logger = logging.getLogger("search_runtime")


def resolve_embed_model(
    index_base: str, knowledge_id: str, configured_default: str = EMBED_MODEL
) -> tuple[str, str]:
    """Resolve which embedding model to embed a query with for `knowledge_id`'s
    index — the correctness-critical step this module used to skip entirely
    (it embedded every query with its own constant, regardless of what the
    target index was actually built with).

    The index's own recorded `embed_model` (stamped into `index-meta.json` by
    indexing-runtime's `pipeline.run_pipeline` at build time) always wins
    over `configured_default` (search-runtime's `SEARCH_EMBED_MODEL`
    setting). Embeddings from different models are not comparable: querying
    an index with any model other than the one it was built with does not
    raise an error, it silently returns low-relevance/meaningless nearest
    neighbors, because cosine similarity between mismatched embedding spaces
    carries no meaning. Trusting the index's own record, instead of assuming
    this service's configured default always matches, is what prevents that
    silent failure.

    Returns `(model, source)`:
      - `(recorded_model, "index_meta")` — `index-meta.json` exists and has
        a non-empty `embed_model` field. The normal case for every index
        built after this field was introduced.
      - `(configured_default, "fallback_default")` — the index has no
        `index-meta.json`, the file is unreadable, or it omits `embed_model`
        (an index built before indexing-runtime started stamping it). The
        caller MUST log this: silently guessing is exactly the failure mode
        this function exists to close off.

    Never raises: any I/O/parse problem resolves to the fallback rather than
    propagating, so a search against an unindexed/partially-built
    `knowledge_id` degrades the same way it always has (`hybrid_search`'s
    `bm25_path.exists()` check already returns `[]` for that case)."""
    meta_path = Path(index_base) / knowledge_id / "index-meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            meta = None
        if isinstance(meta, dict):
            recorded = meta.get("embed_model")
            if isinstance(recorded, str) and recorded:
                return recorded, "index_meta"
    return configured_default, "fallback_default"


async def embed_query(
    query: str,
    model: str = EMBED_MODEL,
    instruct_prefix: str = DEFAULT_QUERY_INSTRUCT_PREFIX,
) -> list[float]:
    """Embed a query for vector search.

    D-046: the instruct prefix is applied on the query side ONLY. Document
    chunks are embedded raw by indexing-runtime (embedders/__init__.py) and
    that must stay unchanged — Qwen3-Embedding is trained for this exact
    asymmetry (instruction on the query, none on the passage), and mixing
    conventions between the two sides is what would require re-indexing.
    """
    text = f"{instruct_prefix}{query}" if instruct_prefix else query
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{OLLAMA_ENDPOINT}/api/embeddings",
            json={"model": model, "prompt": text},
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


def _rrf_score(rank: int, k: int = 60) -> float:
    return 1.0 / (k + rank)


async def hybrid_search(
    query: str,
    knowledge_id: str,
    top_k: int = 5,
    alpha: float = 0.5,
    index_base: str = INDEX_BASE,
    embed_model: str = EMBED_MODEL,
    min_relevance_score: float = DEFAULT_MIN_RELEVANCE_SCORE,
    query_instruct_prefix: str = DEFAULT_QUERY_INSTRUCT_PREFIX,
    metadata_predicate: Callable[[dict[str, Any]], bool] | None = None,
    allow_legacy_pickle_bm25: bool = ALLOW_LEGACY_PICKLE_BM25,
) -> list[dict]:
    """Hybrid search using RRF fusion of vector + BM25 results.

    alpha: weight for vector scores (0=BM25 only, 1=vector only).
    embed_model: FALLBACK embedding model only — used to embed the query
        exclusively when the target index's own `index-meta.json` has no
        recorded `embed_model` (see `resolve_embed_model`, called
        internally). Does not force a model onto an index that already
        records one; the index's own recorded model always takes priority,
        because embeddings from a different model than the index was built
        with are not comparable (silently meaningless results, no error).
    min_relevance_score: D-046 relevance floor, evaluated on cosine
        similarity (1 - Chroma distance) of each chunk's best vector match,
        AFTER RRF fusion picks the top_k candidates — never on the fused RRF
        score itself, which is rank-based (1/(k+rank)) and carries no
        absolute meaning. 0 disables filtering. A chunk that only BM25
        found (no vector distance available) is dropped whenever filtering
        is enabled: there is no similarity evidence it clears the bar, and
        keeping it would let an exact keyword match slip an off-topic chunk
        past what is meant to be a deterministic out-of-scope block.
    query_instruct_prefix: applied to the query text only, before embedding
        (see embed_query) — never applied to indexed document text.
    metadata_predicate: 04-knowledge-platform.md §3.8 ACL/business filter
        (search_runtime.access_control.chunk_is_visible, built by main.py
        from the request's access_context + filters). Applied to each
        candidate's `chunk_metadata` entry BEFORE the top_k*2 candidate list
        is truncated on both the BM25 and vector sides (§3.6: "ACL/Metadata
        Filter를 검색 전 또는 직후 강제") — filtering only the already-
        truncated final top_k, as min_relevance_score does above, would let
        a forbidden but high-ranked chunk crowd out an allowed lower-ranked
        one. None (the default) reproduces pre-existing behavior exactly —
        every existing caller of this function is unaffected.

        Known PoC limitation, same shape as D-046's: the vector side is
        still capped at `min(top_k*2, collection.count())` raw nearest
        neighbors from Chroma *before* this predicate runs (no `where=`
        push-down into the vector store for business fields — 04-...md §3.5
        says "가능한 경우", not mandatory), so a caller could plausibly
        request a filter that excludes many of the nearest neighbors
        actually stored, yielding a paginated result under top_k even if a
        wider vector scan would have found more. Acceptable for a PoC-scale
        corpus; a real deployment should push the `classification`
        (and any business) filter into Chroma's `where=` clause instead.
    allow_legacy_pickle_bm25: D-054. When the target index has not yet been
        migrated to `bm25.json` (only a legacy `bm25.pkl` exists), this
        controls whether that pickle may be loaded at all. True (the
        default, from `settings.ALLOW_LEGACY_PICKLE_BM25`) preserves prior
        behavior for this codebase's only wired-up deployment shape
        (trusted, locally-built `data/indexes/`). False raises
        `search_runtime.bm25_store.LegacyPickleBm25Refused` instead of
        unpickling — callers (see `main.py`) must not swallow that into an
        empty result, since that would be indistinguishable from "no
        relevant evidence".
    Returns list of citation dicts sorted by fused score. Each citation
    includes a `similarity` field (cosine similarity, or None when no vector
    match exists for that chunk and filtering is disabled).

    Raises `search_runtime.bm25_store.LegacyPickleBm25Refused` — see
    `allow_legacy_pickle_bm25` above.
    """
    index_path = Path(index_base) / knowledge_id
    bm25_json_path = index_path / BM25_JSON_FILENAME
    bm25_pkl_path = index_path / BM25_PICKLE_FILENAME
    parents_path = index_path / "parents.json"

    if not bm25_json_path.exists() and not bm25_pkl_path.exists():
        return []

    # Resolve which model to embed the query with — the index's own recorded
    # `embed_model` always wins over `embed_model` (the fallback default), so
    # a query is never embedded with a model different from the one the
    # target index was actually built with (see resolve_embed_model's
    # docstring for why that silently ruins relevance rather than erroring).
    resolved_embed_model, embed_model_source = resolve_embed_model(
        index_base, knowledge_id, configured_default=embed_model
    )
    if embed_model_source == "fallback_default":
        _logger.warning(
            "search.embed_model.fallback knowledge_id=%s model=%s "
            "reason=index_meta_missing_or_no_embed_model",
            knowledge_id,
            resolved_embed_model,
        )
    elif resolved_embed_model != embed_model:
        _logger.info(
            "search.embed_model.mismatch knowledge_id=%s index_model=%s configured_default=%s",
            knowledge_id,
            resolved_embed_model,
            embed_model,
        )

    # Load BM25 (D-054: bm25.json preferred, non-executable; bm25.pkl is a
    # gated legacy fallback for indexes not yet migrated — see
    # bm25_store.load_bm25_document and allow_legacy_pickle_bm25 above).
    # Let LegacyPickleBm25Refused propagate to the caller — never silently
    # degrade to an empty result, that would hide a real refusal.
    bm25_document, bm25_source = load_bm25_document(
        index_path, allow_legacy_pickle=allow_legacy_pickle_bm25
    )
    if bm25_source == "legacy_pickle":
        _logger.warning(
            "search.bm25.legacy_pickle_fallback knowledge_id=%s reason=bm25_json_missing",
            knowledge_id,
        )
    bm25 = rebuild_bm25(bm25_document["tokenized_corpus"])
    chunk_ids = bm25_document["chunk_ids"]
    chunk_texts = bm25_document["chunk_texts"]
    chunk_metadata = bm25_document["chunk_metadata"]
    id_to_idx = {cid: i for i, cid in enumerate(chunk_ids)}

    def _passes(idx: int) -> bool:
        return metadata_predicate is None or metadata_predicate(chunk_metadata[idx])

    # Load parents for expansion
    parent_map: dict = {}
    if parents_path.exists():
        with open(parents_path) as f:
            parent_map = json.load(f)

    # BM25 search — filter (§3.8) before truncating to top_k*2 candidates,
    # not after, so a forbidden chunk never displaces an allowed one.
    bm25_scores = bm25.get_scores(query.split())
    bm25_ranked_all = sorted(range(len(bm25_scores)), key=lambda i: bm25_scores[i], reverse=True)
    bm25_ranked = [i for i in bm25_ranked_all if _passes(i)][: top_k * 2]

    # Vector search via Chroma
    collection_name = f"knowledge_{knowledge_id.replace('-', '_')}"
    chroma_client = get_chroma_client(index_path / "chroma")
    similarity_map: dict[str, float] = {}
    try:
        collection = chroma_client.get_collection(collection_name)
        query_embedding = await embed_query(query, resolved_embed_model, query_instruct_prefix)
        vector_results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(top_k * 2, collection.count()),
            include=["documents", "metadatas", "distances"],
        )
        raw_vector_ids = vector_results["ids"][0]
        raw_vector_distances = vector_results["distances"][0]
        if metadata_predicate is None:
            vector_ids = raw_vector_ids
            vector_distances = raw_vector_distances
        else:
            filtered_pairs = [
                (cid, dist)
                for cid, dist in zip(raw_vector_ids, raw_vector_distances)
                if cid in id_to_idx and _passes(id_to_idx[cid])
            ]
            vector_ids = [cid for cid, _ in filtered_pairs]
            vector_distances = [dist for _, dist in filtered_pairs]
        similarity_map = {cid: 1.0 - dist for cid, dist in zip(vector_ids, vector_distances)}
    except Exception:
        vector_ids = []
        vector_distances = []

    # Build score map using RRF
    score_map: dict[str, float] = {}

    for rank, idx in enumerate(bm25_ranked):
        cid = chunk_ids[idx]
        score_map[cid] = score_map.get(cid, 0) + (1 - alpha) * _rrf_score(rank)

    for rank, (cid, _dist) in enumerate(zip(vector_ids, vector_distances)):
        score_map[cid] = score_map.get(cid, 0) + alpha * _rrf_score(rank)

    # Sort by fused score and take top_k
    ranked_ids = sorted(score_map, key=lambda x: score_map[x], reverse=True)[:top_k]

    # D-046 relevance filter — see hybrid_search docstring for the
    # BM25-only-chunk rule and why this uses similarity_map, not score_map.
    if min_relevance_score > 0:
        ranked_ids = [
            cid
            for cid in ranked_ids
            if cid in similarity_map and similarity_map[cid] >= min_relevance_score
        ]

    # Build citation dicts with parent expansion (id_to_idx computed earlier)
    citations: list[dict] = []

    for cid in ranked_ids:
        idx = id_to_idx.get(cid)
        if idx is None:
            continue
        meta = chunk_metadata[idx]
        text = chunk_texts[idx]
        parent_id = meta.get("parent_id")
        parent_text = parent_map.get(parent_id, {}).get("text", "") if parent_id else ""
        similarity = similarity_map.get(cid)

        citations.append({
            "chunk_id": cid,
            "parent_chunk_id": parent_id,
            "document_path": meta.get("source_path", ""),
            "document_title": meta.get("title", ""),
            "page": meta.get("page", 1),
            "section": meta.get("section", ""),
            "excerpt": text[:512],
            "parent_context": parent_text[:1024] if parent_text else "",
            "score": round(score_map[cid], 4),
            "similarity": round(similarity, 4) if similarity is not None else None,
        })

    return citations
