"use client";

/** 프롬프트 자산 목록 — 좌측 Nav "자산 > 프롬프트". */

import { AssetTypePage } from "../../_components/asset-type-page";

export default function PromptAssetsPage() {
  return (
    <AssetTypePage
      title="프롬프트"
      description="모델 지침(System Prompt·변수 정의) 자산 목록입니다. 항목을 선택하면 버전과 검토 상태를 볼 수 있습니다."
      types={["prompt"]}
      registerHref="/assets/new/prompt"
      registerLabel="프롬프트 등록"
      emptyTitle="등록된 프롬프트 자산이 없습니다."
      emptyDescription="Template 본문과 변수 정의를 올려 첫 프롬프트를 등록하세요."
      searchPlaceholder="프롬프트 이름 검색..."
    />
  );
}
