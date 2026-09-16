"""Indexing pipeline: load -> chunk -> embed -> store (Chroma + BM25)."""

from __future__ import annotations

import json
from pathlib import Path

from security_policy import parse_classification

from indexing_runtime.bm25_store import BM25_JSON_FILENAME, write_bm25_json
from indexing_runtime.chroma_client_cache import get_chroma_client
from indexing_runtime.chunkers import chunk_documents
from indexing_runtime.chunkers.ids import make_document_id
from indexing_runtime.embedders import embed_batch
from indexing_runtime.loaders import LOADED_SUFFIXES, load_document
from indexing_runtime.profile import resolve_profile
from indexing_runtime.settings import EMBED_MODEL


#: Fallback when the Chroma client does not expose its own limit. Chroma's
#: own default is 5461; staying under it is always safe, exceeding it is
#: always fatal, so the fallback is deliberately the conservative side.
_CHROMA_FALLBACK_MAX_BATCH = 5000


def _chroma_max_batch_size(client: object) -> int:
    """How many records this Chroma build accepts in one `add()`.

    `get_max_batch_size()` exists on chromadb 1.5.x clients but is not part of
    any contract this repo controls, and the test fakes
    (tests/unit/indexing_runtime/conftest.py::FakeChromaClient) do not
    implement it — so a missing or unusable method falls back rather than
    breaking either.
    """
    getter = getattr(client, "get_max_batch_size", None)
    if callable(getter):
        try:
            value = int(getter())
        except Exception:  # noqa: BLE001 — a probe, never a reason to fail a job
            return _CHROMA_FALLBACK_MAX_BATCH
        if value > 0:
            return value
    return _CHROMA_FALLBACK_MAX_BATCH


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

    # Chroma refuses a single `add()` larger than its own max batch size
    # (5461 on chromadb 1.5.9) with
    # `InternalError: ValueError: Batch size of N is greater than max batch
    # size of 5461` — the whole job dies AFTER every embedding has already
    # been computed, which is the most expensive possible moment to fail.
    #
    # This went unnoticed because every Knowledge asset in this repo until
    # 2026-09-17 produced a few dozen chunks; the first real document to cross
    # the line (a 21MB reference guide -> 41,954 child chunks) hit it head-on.
    # The limit is read from the client rather than hardcoded here: it is a
    # property of the Chroma build/configuration, and a hardcoded copy would
    # silently become wrong on an upgrade.
    max_batch = _chroma_max_batch_size(chroma_client)
    child_ids = [c["id"] for c in children]
    child_metadatas = [c["metadata"] for c in children]
    for start in range(0, len(children), max_batch):
        stop = start + max_batch
        collection.add(
            ids=child_ids[start:stop],
            embeddings=embeddings[start:stop],
            documents=child_texts[start:stop],
            metadatas=child_metadatas[start:stop],
        )

    # 5. Build the BM25 index artifact on child chunks — a plain JSON file
    # (D-054, see indexing_runtime.bm25_store module docstring), never a
    # pickle. Only the tokenized corpus is persisted; `rank_bm25.BM25Okapi`
    # is rebuilt deterministically at query time by search-runtime, so no
    # executable object is ever written to disk.
    write_bm25_json(
        index_path / BM25_JSON_FILENAME,
        chunk_ids=[c["id"] for c in children],
        chunk_texts=child_texts,
        chunk_metadata=[c["metadata"] for c in children],
    )

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
