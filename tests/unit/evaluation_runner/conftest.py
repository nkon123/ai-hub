"""Shared fakes for evaluation_runner unit tests — never touches a real
search-runtime, Ollama, or the network (task requirement: fake SearchClient only)."""

from __future__ import annotations

from dataclasses import dataclass, field

from evaluation_runner.search_client import Citation, SearchClient, SearchResponse


def make_citation(
    doc: str,
    *,
    chunk_id: str | None = None,
    excerpt: str = "",
    parent_context: str = "",
    score: float = 1.0,
) -> Citation:
    """Build a Citation whose document_path resolves (via matching.py) to `doc`."""
    return Citation(
        chunk_id=chunk_id or f"chunk-{doc}",
        parent_chunk_id=None,
        document_path=f"/storage/knowledge/whatever/{doc}.md",
        document_title=f"{doc}.md",
        page=1,
        section="section",
        excerpt=excerpt,
        parent_context=parent_context,
        score=score,
    )


@dataclass
class RecordedCall:
    query: str
    knowledge_id: str
    knowledge_version: str
    top_k: int
    alpha: float
    metadata_filters: dict[str, str] | None
    trace_id: str | None
    run_id: str | None


@dataclass
class FakeSearchClient(SearchClient):
    """Returns a canned SearchResponse per query text; records every call it
    receives so tests can assert on trace_id/run_id propagation."""

    responses_by_query: dict[str, SearchResponse] = field(default_factory=dict)
    default_response: SearchResponse = field(default_factory=SearchResponse)
    calls: list[RecordedCall] = field(default_factory=list)

    async def search(
        self,
        *,
        query: str,
        knowledge_id: str,
        knowledge_version: str = "latest",
        top_k: int = 5,
        alpha: float = 0.5,
        metadata_filters: dict[str, str] | None = None,
        trace_id: str | None = None,
        run_id: str | None = None,
    ) -> SearchResponse:
        self.calls.append(
            RecordedCall(
                query=query,
                knowledge_id=knowledge_id,
                knowledge_version=knowledge_version,
                top_k=top_k,
                alpha=alpha,
                metadata_filters=metadata_filters,
                trace_id=trace_id,
                run_id=run_id,
            )
        )
        return self.responses_by_query.get(query, self.default_response)
