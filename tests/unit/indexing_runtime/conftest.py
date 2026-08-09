"""Shared fakes for indexing_runtime pipeline-level tests — no Ollama/Chroma
network I/O, mirroring the pattern tests/unit/search_runtime/conftest.py
already established for the search side."""

from __future__ import annotations

from typing import Any


class FakeChromaCollection:
    def __init__(self) -> None:
        self.added: dict[str, Any] = {}

    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        self.added = {
            "ids": ids,
            "embeddings": embeddings,
            "documents": documents,
            "metadatas": metadatas,
        }


class FakeChromaClient:
    """Stand-in for chromadb.PersistentClient — only the two methods
    pipeline.run_pipeline calls are implemented."""

    def __init__(self) -> None:
        self.collection = FakeChromaCollection()

    def delete_collection(self, name: str) -> None:  # noqa: ARG002
        pass

    def create_collection(self, name: str, metadata: dict[str, Any]) -> FakeChromaCollection:  # noqa: ARG002
        return self.collection


def patch_chroma(monkeypatch: Any, pipeline_module: Any) -> FakeChromaClient:
    """Patch `pipeline_module.get_chroma_client` (the D-067 shared-client
    cache helper `run_pipeline` calls), not `chromadb.PersistentClient`
    directly — `pipeline.py` no longer imports `chromadb` itself, it goes
    through `indexing_runtime.chroma_client_cache.get_chroma_client`."""
    fake_client = FakeChromaClient()
    monkeypatch.setattr(pipeline_module, "get_chroma_client", lambda path: fake_client)  # noqa: ARG005
    return fake_client


def patch_embed_batch(monkeypatch: Any, pipeline_module: Any, dim: int = 3) -> None:
    async def fake_embed_batch(texts: list[str], model: str = "") -> list[list[float]]:  # noqa: ARG001
        return [[0.1, 0.2, 0.3][:dim] for _ in texts]

    monkeypatch.setattr(pipeline_module, "embed_batch", fake_embed_batch)
