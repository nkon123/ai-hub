"""Indexing pipeline: load -> chunk -> embed -> store (Chroma + BM25)."""

from __future__ import annotations

import json
import pickle
from pathlib import Path

from rank_bm25 import BM25Okapi
from security_policy import parse_classification

from indexing_runtime.chroma_client_cache import get_chroma_client
from indexing_runtime.chunkers import chunk_documents
from indexing_runtime.chunkers.ids import make_document_id
from indexing_runtime.embedders import embed_batch
from indexing_runtime.loaders import LOADED_SUFFIXES, load_document
from indexing_runtime.profile import resolve_profile
from indexing_runtime.settings import EMBED_MODEL


async def run_pipeline(
    storage_path: str,
    knowledge_id: str,
    index_base: str = "./indexes",
    embed_model: str = EMBED_MODEL,
    profile: dict | None = None,
    classification: str | None = None,
) -> dict:
    """Full indexing pipeline for a Knowledge package.

    `profile` is an optional, possibly-partial Indexing Profile dict (see
    `indexing_runtime.profile.resolve_profile` and
    docs/implementation-spec/open-decisions.md D-053). Every caller today
    omits it, which resolves to `parent_child` chunking at the documented
    defaults — unchanged from before this parameter existed.

    `classification` (04-knowledge-platform.md §2.7, §3.8) is the Knowledge
    asset manifest's `classification` field, forwarded by the caller
    (portal-api's `_trigger_indexing` reads the raw manifest value — not
    `Asset.classification`, which already applies its own unrelated
    "INTERNAL if missing" default at Asset-creation time; see
    open-decisions.md D-062 for why those two defaults are kept separate).
    `None` or any value that is not one of the four real classification
    levels is stamped as `Classification.UNKNOWN` — this function never
    guesses a real level (e.g. INTERNAL) for a missing/bad value, per
    open-decisions.md D-062. What happens to UNKNOWN chunks at search time is
    a separate, explicit search-runtime policy decision
    (`search_runtime.settings.ALLOW_UNKNOWN_CLASSIFICATION`), not this
    function's concern.

    Returns: {chunk_count, parent_count, index_path, status}
    """
    resolved_classification = parse_classification(classification).value
    resolved_profile = resolve_profile(profile)

    src = Path(storage_path)
    index_path = Path(index_base) / knowledge_id
    index_path.mkdir(parents=True, exist_ok=True)

    # 1. Load all documents (sorted path order -> reproducible processing, §2.3)
    documents: list[dict] = []
    for doc_path in sorted(src.rglob("*")):
        if doc_path.is_file() and doc_path.suffix.lower() in LOADED_SUFFIXES:
            relative_path = doc_path.relative_to(src).as_posix()
            document_id = make_document_id(knowledge_id, relative_path)
            documents.append(
                load_document(doc_path, document_id, language=resolved_profile["language"])
            )

    if not documents:
        return {"status": "FAILED", "error": "No indexable documents found", "chunk_count": 0}

    # 2. Chunk per the resolved strategy (recursive / markdown / parent_child)
    parents, children = chunk_documents(documents, knowledge_id, resolved_profile)

    if not children:
        return {"status": "FAILED", "error": "Chunking produced no chunks", "chunk_count": 0}

    # 2b. Stamp classification (§2.7, §3.8) onto every chunk's metadata —
    # applied uniformly after chunking rather than threaded through each of
    # the three chunker modules' signatures, so this is the only place that
    # needs to know about it and none of the existing chunker unit tests
    # (tests/unit/indexing_runtime/test_{recursive,markdown,parent_child}.py)
    # need to change. search-runtime's ACL enforcement reads this field
    # directly off child chunk metadata (services/search-runtime's
    # hybrid.py); parent metadata is stamped too for consistency even though
    # today's ACL filtering only ever inspects a chunk before parent
    # expansion pulls its (already-allowed) parent's text.
    for parent in parents:
        parent["metadata"]["classification"] = resolved_classification
    for child in children:
        child["metadata"]["classification"] = resolved_classification

    # 3. Embed child chunks (smaller, used for retrieval)
    child_texts = [c["text"] for c in children]
    embeddings = await embed_batch(child_texts, model=embed_model)

    # 4. Store in Chroma (child chunks with embeddings)
    chroma_client = get_chroma_client(index_path / "chroma")
    collection_name = f"knowledge_{knowledge_id.replace('-', '_')}"

    # Delete existing collection if re-indexing
    try:
        chroma_client.delete_collection(collection_name)
    except Exception:
        pass

    collection = chroma_client.create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )
    collection.add(
        ids=[c["id"] for c in children],
        embeddings=embeddings,
        documents=child_texts,
        metadatas=[c["metadata"] for c in children],
    )

    # 5. Build BM25 index on child chunks
    tokenized = [text.split() for text in child_texts]
    bm25 = BM25Okapi(tokenized)

    bm25_data = {
        "bm25": bm25,
        "chunk_ids": [c["id"] for c in children],
        "chunk_texts": child_texts,
        "chunk_metadata": [c["metadata"] for c in children],
    }
    with open(index_path / "bm25.pkl", "wb") as f:
        pickle.dump(bm25_data, f)

    # 6. Save parent map for parent expansion (empty for recursive/markdown —
    # those strategies have no Parent Store, see chunkers/recursive.py).
    parent_map = {p["id"]: p for p in parents}
    with open(index_path / "parents.json", "w", encoding="utf-8") as f:
        json.dump(parent_map, f, ensure_ascii=False, indent=2)

    # 7. Save index metadata
    meta = {
        "knowledge_id": knowledge_id,
        "chunk_count": len(children),
        "parent_count": len(parents),
        "document_count": len(documents),
        "collection_name": collection_name,
        "embed_model": embed_model,
        "chunking_strategy": resolved_profile["chunking_strategy"],
        "classification": resolved_classification,
    }
    with open(index_path / "index-meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    return {
        "status": "COMPLETED",
        "chunk_count": len(children),
        "parent_count": len(parents),
        "index_path": str(index_path),
    }
