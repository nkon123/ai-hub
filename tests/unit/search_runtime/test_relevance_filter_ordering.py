"""D-046 후속(2026-08-14): 관련도 필터는 top_k 로 자르기 **전에** 적용된다.

실사용에서 발견된 증상 — 같은 색인·같은 질의인데 `top_k` 에 따라 결과가
뒤집혔다:

    top_k=1 → 0건, top_k=2 → 1건, top_k=3 → 1건, top_k=5 → 0건, top_k=10 → 1건

원인은 순서였다. RRF 는 **순위**로 융합하므로 유사도가 높은 청크가 낮은
융합 순위에 앉을 수 있는데, 예전 코드는 `top_k` 로 먼저 자른 뒤 관련도
임계값을 적용했다. 그래서 임계값에 못 미치는 청크들이 예산을 다 쓰고, 이어진
필터가 그것들을 전부 걷어내 **0건**이 됐다 — 문서에 답이 분명히 있는데도
"근거 없음" 으로 끝났다.

이 파일이 고정하는 것은 그 성질 하나다: **임계값을 넘는 청크는, 그보다 낮은
유사도의 청크가 융합 순위에서 앞선다는 이유로 사라지지 않는다.** 같은 함수의
ACL 필터는 이미 자르기 전에 적용되고 있었다(§3.6) — 두 필터가 같은 위치에
있어야 한다는 것이 D-046 주석이 "알려진 한계" 로 적어 둔 내용이다.
"""

from __future__ import annotations

import pytest
from search_runtime import hybrid

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "22222222-2222-4222-8222-222222222222"

CHUNK_IDS = ["c1", "c2", "c3", "c4"]
CHUNK_TEXTS = ["c1 text", "c2 text", "c3 text", "c4 text"]
CHUNK_METADATA = [
    {"source_path": "doc.md", "title": "Doc", "section": f"s{i}", "page": 1} for i in range(1, 5)
]

# BM25 는 약한 청크들에 높은 점수를 준다 → BM25 순위: c1, c2, c3, c4
BM25_SCORES = [10, 9, 8, 0]
# 벡터는 정답 청크(c4)를 1위로 찾지만, BM25 순위가 낮아 융합 순위는 뒤로 밀린다.
# 유사도: c4=0.9(임계값 통과), c1=0.2 / c2=0.25 / c3=0.3(전부 미달)
VECTOR_IDS = ["c4", "c1", "c2", "c3"]
VECTOR_DISTANCES = [0.1, 0.8, 0.75, 0.7]

THRESHOLD = 0.42


@pytest.fixture
def index(tmp_path, monkeypatch):
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=BM25_SCORES,
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, VECTOR_IDS, VECTOR_DISTANCES)
    patch_embed_query(monkeypatch, hybrid)
    return tmp_path


async def _search(index_base, top_k: int) -> list[dict]:
    return await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=top_k,
        index_base=str(index_base),
        min_relevance_score=THRESHOLD,
    )


@pytest.mark.asyncio
async def test_relevant_chunk_survives_even_when_weaker_chunks_outrank_it(index) -> None:
    """정답 청크(c4, 유사도 0.9)는 융합 순위에서 c1 뒤에 있다. top_k=1 이면
    예전 코드는 c1 만 남긴 뒤 임계값으로 그것마저 걷어내 **0건**을 냈다."""
    citations = await _search(index, top_k=1)

    assert [c["chunk_id"] for c in citations] == ["c4"]
    assert citations[0]["similarity"] == pytest.approx(0.9, abs=1e-6)


@pytest.mark.asyncio
async def test_result_count_never_shrinks_as_top_k_grows(index) -> None:
    """`top_k` 를 늘렸는데 결과가 줄어드는 일은 없어야 한다 — 실사용에서
    사용자가 처음 알아챈 증상이 정확히 이 비단조성이었다."""
    counts = [len(await _search(index, top_k=k)) for k in (1, 2, 3, 4)]

    assert counts == sorted(counts), f"top_k 를 늘렸는데 결과가 줄었다: {counts}"
    assert counts[0] >= 1, "임계값을 넘는 근거가 있는데 top_k=1 에서 0건이 나왔다"


@pytest.mark.asyncio
async def test_threshold_still_excludes_every_chunk_below_it(index) -> None:
    """자르기 전으로 옮긴 것이 필터를 느슨하게 만든 것은 아니다 — 임계값
    미달 청크는 top_k 가 충분히 커도 여전히 나오지 않는다."""
    citations = await _search(index, top_k=4)

    assert [c["chunk_id"] for c in citations] == ["c4"]
    assert all(c["similarity"] >= THRESHOLD for c in citations)


@pytest.mark.asyncio
async def test_filtering_disabled_returns_the_unfiltered_fused_ranking(index) -> None:
    """`min_relevance_score=0` 은 예전과 동일하게 동작한다(필터 없음) —
    이 변경이 임계값을 쓰지 않는 호출자에게는 아무 영향이 없어야 한다."""
    citations = await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        index_base=str(index),
        min_relevance_score=0,
    )

    assert len(citations) == 4
