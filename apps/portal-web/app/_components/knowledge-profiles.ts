/**
 * Knowledge 색인·검색 전략 Preset — P12 등록 화면(`/knowledge/new`)과 지식 자산
 * 상세의 "새 버전 만들기"(재색인)가 **같은** 선택지·같은 숫자를 쓰도록 하는
 * 단일 출처.
 *
 * 두 화면에 복사해 두면 한쪽 숫자만 바뀌고도 화면에는 같은 이름("문맥 보존")이
 * 남는다 — 그러면 사용자가 고른 전략과 실제로 색인된 전략이 조용히 달라진다.
 * 이 값들은 Manifest에 그대로 박혀 indexing-runtime/search-runtime으로 나간다
 * (D-082의 불변 스냅샷).
 */

// `tech`/`params`는 화면에 그대로 보여 주는 값이다. 업무 목적(label/description)을
// 먼저 두고 기술명을 덧붙인다(루트 CLAUDE.md UI 규칙). 값은 실제 구현에서 확인한
// 것만 적는다 — indexing-runtime `chunkers/{parent_child,markdown,recursive}.py`와
// search-runtime `hybrid.py`("Vector (Chroma) + BM25 + RRF fusion"). 아래 profile
// 숫자를 바꾸면 params 문구도 같이 고친다.
export const INDEXING_PRESETS = {
  parent_child: {
    label: "문맥 보존",
    tech: "Parent-Child Chunking",
    description: "긴 규정·업무 문서에 적합합니다. 작은 검색 조각과 넓은 문맥을 함께 만듭니다.",
    params: "제목(#/##/###) 경계로 먼저 끊고, 문맥 2048자 → 검색 조각 512자 · 겹침 64자",
    ref: "balanced-parent-child",
    profile: { chunking_strategy: "parent_child", chunk_size: 512, chunk_overlap: 64, parent_chunk_size: 2048, minimum_size: 64, language: "ko" },
  },
  markdown: {
    label: "문서 구조 우선",
    tech: "Markdown Header Splitting",
    description: "제목과 절 구성이 중요한 매뉴얼·가이드에 적합합니다.",
    params: "제목(#/##/###)으로 절 분리, 768자를 넘는 절만 재분할 · 겹침 80자",
    ref: "structured-markdown",
    profile: { chunking_strategy: "markdown", chunk_size: 768, chunk_overlap: 80, parent_chunk_size: 2048, minimum_size: 80, language: "ko" },
  },
  recursive: {
    label: "짧은 조각",
    tech: "Recursive Character Splitting",
    description: "형식이 일정하지 않은 메모·텍스트를 촘촘하게 나눕니다.",
    params: "문단 → 줄 → 문장 → 공백 → 문자 순 분할, 384자 · 겹침 48자",
    ref: "compact-recursive",
    profile: { chunking_strategy: "recursive", chunk_size: 384, chunk_overlap: 48, parent_chunk_size: 1536, minimum_size: 48, language: "ko" },
  },
} as const;

// 세 가지 모두 같은 Hybrid 검색이며 Vector와 BM25의 가중치(α)만 다르다.
// hybrid.py 기준 α는 Vector 쪽 가중치다(0이면 BM25만, 1이면 Vector만).
export const RETRIEVAL_PRESETS = {
  balanced_hybrid: {
    label: "균형 검색",
    tech: "Hybrid Search (Vector + BM25, RRF 융합)",
    description: "의미와 키워드를 같은 비중으로 찾습니다.",
    params: "α=0.5 (의미 50 : 키워드 50) · 상위 5건 · 최소 관련도 0.42 · 부모 문맥 확장",
    profile: { strategy: "balanced_hybrid", top_k: 5, hybrid_alpha: 0.5, min_relevance_score: 0.42, enable_parent_expansion: true },
  },
  keyword_priority: {
    label: "키워드 우선",
    tech: "Hybrid Search — BM25 가중",
    description: "제품명·규정 번호처럼 정확한 용어 일치를 더 중시합니다.",
    params: "α=0.25 (의미 25 : 키워드 75) · 상위 8건 · 최소 관련도 0.42 · 부모 문맥 확장",
    profile: { strategy: "keyword_priority", top_k: 8, hybrid_alpha: 0.25, min_relevance_score: 0.42, enable_parent_expansion: true },
  },
  semantic_priority: {
    label: "의미 우선",
    tech: "Hybrid Search — Vector 가중",
    description: "표현이 달라도 의미가 가까운 문장을 더 중시합니다.",
    params: "α=0.8 (의미 80 : 키워드 20) · 상위 5건 · 최소 관련도 0.45 · 부모 문맥 확장",
    profile: { strategy: "semantic_priority", top_k: 5, hybrid_alpha: 0.8, min_relevance_score: 0.45, enable_parent_expansion: true },
  },
} as const;

export type IndexingStrategyKey = keyof typeof INDEXING_PRESETS;
export type RetrievalStrategyKey = keyof typeof RETRIEVAL_PRESETS;

/** Manifest에 박힌 스냅샷에서 그 값을 만든 Preset 키를 되찾는다.

    되찾지 못하면(수동 편집·옛 버전) `null` — 그 경우 화면은 "현재 값을 알 수
    없음"으로 두고 사용자가 고르게 한다. 아무 Preset이나 기본으로 고르면 바꿀
    의도가 없던 전략이 조용히 바뀐다. */
export function indexingStrategyOf(profile: unknown): IndexingStrategyKey | null {
  const strategy = (profile as { chunking_strategy?: string } | null)?.chunking_strategy;
  return strategy && strategy in INDEXING_PRESETS ? (strategy as IndexingStrategyKey) : null;
}

export function retrievalStrategyOf(profile: unknown): RetrievalStrategyKey | null {
  const strategy = (profile as { strategy?: string } | null)?.strategy;
  return strategy && strategy in RETRIEVAL_PRESETS ? (strategy as RetrievalStrategyKey) : null;
}
