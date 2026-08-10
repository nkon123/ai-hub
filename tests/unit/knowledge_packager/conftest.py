"""Shared fixture-index-dir builder for knowledge_packager unit tests.

Builds tiny, deterministic `data/indexes/{knowledge_id}/`-shaped directories
entirely under `tmp_path` — no dependency on the repo's real
`data/indexes/`, Ollama, or any running service (offline, matches
`tests/unit/evaluation_runner/`'s FakeSearchClient precedent applied here to
"fake indexing-runtime output" instead of "fake search-runtime response").
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chromadb
import pytest

_EMBED_DIM = 4


class _FakeBM25:
    """Stand-in for `rank_bm25.BM25Okapi` in `bm25_format="pickle"` test
    fixtures (D-054 legacy path). Never unpickled by production code (see
    `knowledge_packager.bm25_inspect`) — its exact class identity does not
    matter, only that `bm25.pkl` is a normally produced pickle whose
    top-level dict has the expected keys."""

    def __init__(self, corpus_size: int) -> None:
        self.corpus_size = corpus_size


@dataclass(frozen=True)
class FixtureIndex:
    index_dir: Path
    knowledge_id: str
    collection_name: str
    chunk_ids: list[str]
    parent_ids: list[str]
    document_ids: list[str]


def _embedding(seed: int) -> list[float]:
    return [float((seed * 7 + i) % 11) / 10.0 for i in range(_EMBED_DIM)]


def make_index_dir(
    root: Path,
    knowledge_id: str,
    *,
    legacy: bool = False,
    chunking_strategy: str | None = "parent_child",
    num_docs: int = 2,
    parents_per_doc: int = 2,
    embed_model: str = "qwen3-embedding:0.6b",
    absolute_source_path_prefix: str = "/Users/testbuilder/repo/storage/knowledge",
    bm25_format: str = "json",
) -> FixtureIndex:
    """Writes a minimal but structurally realistic parent_child index dir.

    `legacy=True` reproduces the pre-D-053 generation actually seen in
    `data/indexes/a038442d-.../`: `chunk-<16hex>` ids, no `document_id` key
    in metadata, and no `chunking_strategy` key in index-meta.json. This is
    an ID-generation concern, orthogonal to `bm25_format`.

    `bm25_format` (D-054): `"json"` (default — matches what
    `indexing_runtime.pipeline.run_pipeline` writes today, a plain
    non-executable `bm25.json`) or `"pickle"` (the legacy `bm25.pkl` format,
    for tests that specifically exercise the not-yet-migrated fallback
    path knowledge_packager still supports)."""
    index_dir = root / knowledge_id
    index_dir.mkdir(parents=True)
    collection_name = f"knowledge_{knowledge_id.replace('-', '_')}"

    parents: dict[str, dict[str, Any]] = {}
    child_ids: list[str] = []
    child_embeddings: list[list[float]] = []
    child_texts: list[str] = []
    child_metadatas: list[dict[str, Any]] = []
    document_ids: list[str] = []
    seed = 0

    for doc_index in range(num_docs):
        filename = f"doc{doc_index}.md"
        source_path = f"{absolute_source_path_prefix}/{knowledge_id}/1.0.0/{filename}"
        document_id = f"{knowledge_id}:{filename}"
        if not legacy:
            document_ids.append(document_id)

        for parent_index in range(parents_per_doc):
            seed += 1
            if legacy:
                parent_id = f"chunk-{seed:016x}"
                child_id = f"chunk-{seed + 1000:016x}"
            else:
                parent_id = f"{document_id}::p{parent_index:04d}::{seed:012x}"
                child_id = f"{parent_id}::c0000::{seed + 1000:012x}"

            parent_metadata: dict[str, Any] = {
                "knowledge_id": knowledge_id,
                "source_path": source_path,
                "title": filename if legacy else filename.removesuffix(".md"),
                "section": f"section-{parent_index}",
                "title_path": [f"section-{parent_index}"],
                "page": parent_index + 1,
                "chunk_type": "parent",
            }
            if not legacy:
                parent_metadata["document_id"] = document_id

            parents[parent_id] = {
                "id": parent_id,
                "text": f"parent text for {filename} section {parent_index}",
                "metadata": parent_metadata,
            }

            child_metadata: dict[str, Any] = dict(parent_metadata)
            child_metadata["chunk_type"] = "child"
            if chunking_strategy == "parent_child":
                child_metadata["parent_id"] = parent_id

            child_ids.append(child_id)
            child_embeddings.append(_embedding(seed))
            child_texts.append(f"child text for {filename} section {parent_index}")
            child_metadatas.append(child_metadata)

    if not legacy:
        # de-dup preserving order
        document_ids = list(dict.fromkeys(document_ids))

    (index_dir / "parents.json").write_text(
        json.dumps(parents, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    meta: dict[str, Any] = {
        "knowledge_id": knowledge_id,
        "chunk_count": len(child_ids),
        "parent_count": len(parents),
        "document_count": num_docs,
        "collection_name": collection_name,
        "embed_model": embed_model,
    }
    if not legacy and chunking_strategy is not None:
        meta["chunking_strategy"] = chunking_strategy
    (index_dir / "index-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    client = chromadb.PersistentClient(path=str(index_dir / "chroma"))
    collection = client.create_collection(name=collection_name, metadata={"hnsw:space": "cosine"})
    collection.add(
        ids=child_ids, embeddings=child_embeddings, documents=child_texts, metadatas=child_metadatas
    )

    if bm25_format == "json":
        bm25_document = {
            "schema_version": "1.0",
            "tokenizer": "whitespace_split",
            "tokenized_corpus": [t.split() for t in child_texts],
            "chunk_ids": list(child_ids),
            "chunk_texts": list(child_texts),
            "chunk_metadata": list(child_metadatas),
        }
        (index_dir / "bm25.json").write_text(
            json.dumps(bm25_document, ensure_ascii=False), encoding="utf-8"
        )
    elif bm25_format == "pickle":
        bm25_data = {
            "bm25": _FakeBM25(corpus_size=len(child_ids)),
            "chunk_ids": list(child_ids),
            "chunk_texts": list(child_texts),
            "chunk_metadata": list(child_metadatas),
        }
        with (index_dir / "bm25.pkl").open("wb") as f:
            pickle.dump(bm25_data, f)
    else:
        raise ValueError(f"알 수 없는 bm25_format: {bm25_format!r}")

    return FixtureIndex(
        index_dir=index_dir,
        knowledge_id=knowledge_id,
        collection_name=collection_name,
        chunk_ids=child_ids,
        parent_ids=list(parents.keys()),
        document_ids=document_ids,
    )


@pytest.fixture
def index_dir_root(tmp_path: Path) -> Path:
    return tmp_path / "indexes"
