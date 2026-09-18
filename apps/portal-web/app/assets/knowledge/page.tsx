"use client";

/**
 * 지식 자산 목록 — 좌측 Nav "자산 > 지식".
 *
 * 경로가 `/assets/[id]` 와 같은 단계의 정적 세그먼트다(App Router 는 정적
 * 세그먼트를 동적 세그먼트보다 먼저 매칭한다). 즉 Manifest 에 `id: "knowledge"`
 * 를 적은 자산이 생기면 그 자산의 상세 경로가 이 목록에 가려진다 — 실제로는
 * 자산 id 가 uuid4 로 발급되므로 일어나지 않지만, 여기 세그먼트를 늘릴 때는
 * 같은 제약을 기억한다.
 */

import { AssetTypePage } from "../../_components/asset-type-page";

export default function KnowledgeAssetsPage() {
  return (
    <AssetTypePage
      title="지식"
      description="검색·답변에 사용할 지식 자산 목록입니다. 항목을 선택하면 버전과 품질 지표를 볼 수 있습니다."
      types={["knowledge"]}
      registerHref="/knowledge/new"
      registerLabel="지식 등록"
      emptyTitle="등록된 지식 자산이 없습니다."
      emptyDescription="문서를 올려 첫 지식 자산을 등록하면 챗봇과 AI Service에서 바로 사용할 수 있습니다."
      searchPlaceholder="지식 이름 검색..."
    />
  );
}
