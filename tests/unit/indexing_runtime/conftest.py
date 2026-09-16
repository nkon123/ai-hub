"""Shared fakes for indexing_runtime pipeline-level tests — no Ollama/Chroma
network I/O, mirroring the pattern tests/unit/search_runtime/conftest.py
already established for the search side."""

from __future__ import annotations

from typing import Any


class FakeChromaCollection:
    """Records every `add()` call separately AND the merged result.

    Real Chroma rejects a single `add()` larger than its max batch size
    (5461 on chromadb 1.5.9), so `run_pipeline` splits large indexes across
    several calls. `added` is the concatenation — what "what ended up in the
    index" assertions want — while `add_calls` preserves the split, which is
    the only way to test the batching itself.
    """

    def __init__(self) -> None:
        self.added: dict[str, Any] = {}
        self.add_calls: list[dict[str, Any]] = []

    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        call = {
            "ids": ids,
            "embeddings": embeddings,
            "documents": documents,
            "metadatas": metadatas,
        }
        self.add_calls.append(call)
        for key, value in call.items():
            self.added.setdefault(key, [])
            self.added[key] = self.added[key] + list(value)


class FakeChromaClient:
    """Stand-in for chromadb.PersistentClient — only the methods
    pipeline.run_pipeline calls are implemented.

    `max_batch_size` is settable so a test can force the batching path with a
    handful of chunks instead of the 5461+ a real Chroma limit would need.
    `None` means "this client does not expose the limit", which exercises
    `pipeline._chroma_max_batch_size`'s fallback.
    """

    def __init__(self, max_batch_size: int | None = None) -> None:
        self.collection = FakeChromaCollection()
        self._max_batch_size = max_batch_size

    def delete_collection(self, name: str) -> None:  # noqa: ARG002
        pass

    def create_collection(self, name: str, metadata: dict[str, Any]) -> FakeChromaCollection:  # noqa: ARG002
        return self.collection

    def get_max_batch_size(self) -> int:
        if self._max_batch_size is None:
            raise AttributeError("this fake client does not expose a max batch size")
        return self._max_batch_size


def patch_chroma(
    monkeypatch: Any, pipeline_module: Any, max_batch_size: int | None = None
) -> FakeChromaClient:
    """Patch `pipeline_module.get_chroma_client` (the D-067 shared-client
    cache helper `run_pipeline` calls), not `chromadb.PersistentClient`
    directly — `pipeline.py` no longer imports `chromadb` itself, it goes
    through `indexing_runtime.chroma_client_cache.get_chroma_client`."""
    fake_client = FakeChromaClient(max_batch_size=max_batch_size)
    monkeypatch.setattr(pipeline_module, "get_chroma_client", lambda path: fake_client)  # noqa: ARG005
    return fake_client


def patch_embed_batch(monkeypatch: Any, pipeline_module: Any, dim: int = 3) -> list[dict[str, Any]]:
    """Fake `embed_batch` so no Ollama call happens, and record every call's
    arguments (currently just `model`) so a test can assert on which model
    `run_pipeline` actually passed through — e.g. that it honors the
    `EMBED_MODEL` setting/`INDEXING_EMBED_MODEL` env var end to end instead
    of a hardcoded literal. Callers that don't need the calls list (most
    existing tests) can simply ignore the return value."""
    calls: list[dict[str, Any]] = []

    async def fake_embed_batch(texts: list[str], model: str = "") -> list[list[float]]:
        calls.append({"model": model, "text_count": len(texts)})
        return [[0.1, 0.2, 0.3][:dim] for _ in texts]

    monkeypatch.setattr(pipeline_module, "embed_batch", fake_embed_batch)
    return calls
