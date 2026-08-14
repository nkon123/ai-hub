// D10 설정 — 설치된 Knowledge마다 "실제로 검색에 쓰일 임베딩 모델"을 판정하는
// 순수 함수(fs/electron import 없음). fs 읽기는 `asset-management.ts`(Main
// 전용)에서만 하고, 이 파일은 그 결과를 화면에 보여줄 상태/문구로 바꾸는
// 판정만 한다 — `asset-management.ts`가 `knowledge-candidates.ts`에 대해
// 갖는 관계(fs 읽기 vs 조립 규칙)와 동일한 구조.
//
// 배경(2026-08-14 지시, 실측 재확인): search-runtime은 질의를 임베딩할 때
// "설정으로 고를 수 있는 값"이 아니라 그 Knowledge 색인 자신의
// `index/index-meta.json`에 기록된 `embed_model`을 최우선으로 쓴다
// (`services/search-runtime/src/search_runtime/hybrid.py::resolve_embed_model`,
// open-decisions.md D-075) — 색인을 만들 때 쓴 모델과 다른 모델로 질의를
// 임베딩하면 오류 없이 그저 관련 없는 결과가 조용히 반환된다(서로 다른
// Embedding 공간의 cosine 유사도는 무의미하다). 기록이 없을 때만
// search-runtime 자신의 `SEARCH_EMBED_MODEL` 설정값으로 대체한다("추정"이지
// "기록된 사실"이 아니다). 이 파일은 그 사실을 있는 그대로 보여주기 위한
// 판정 로직이며, Desktop이 이 값을 사용자에게 입력받아 어딘가로 보내는 UI는
// 만들지 않는다(반영될 곳이 없다 — 옛 `embeddingModelAlias` 자유 입력 필드가
// 바로 그런 사례였다, `desktop-settings.ts` 참고).
import type { KnowledgeEmbedModelInfo } from "./types";

export type KnowledgeIndexMetaReadStatus = "OK" | "MISSING" | "UNREADABLE";

/** `asset-management.ts`가 `index/index-meta.json`을 읽은 결과 — 성공/실패
 * 원인을 구분해 넘긴다("파일이 없음"과 "있지만 손상됨"은 사용자에게 보여줄
 * 문구가 다르다). IPC 경계를 넘지 않는 내부 전달용 타입이라(`RevocationEntry`
 * 등과 동일한 관례) `types.ts`가 아니라 이 파일에 둔다. */
export interface KnowledgeIndexMetaReadResult {
  status: KnowledgeIndexMetaReadStatus;
  /** `status === "OK"`일 때만 채워진다 — `JSON.parse`한 원본 그대로(아직
   * `embed_model` 필드를 뽑아내지 않은 상태). */
  raw?: unknown;
}

function extractRecordedEmbedModel(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).embed_model;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 설치된 Knowledge 하나의 색인 메타데이터 읽기 결과를 화면에 표시할 판정으로
 * 바꾼다. 세 가지 상태를 절대 섞지 않는다:
 * - `RECORDED`: `index-meta.json`에 `embed_model`이 실제로 기록되어 있다 —
 *   이것이 검색이 실제로 쓰는 모델이라고 그대로 말할 수 있다.
 * - `ASSUMED_FALLBACK`: 파일은 읽었지만 `embed_model` 기록이 없다(구버전
 *   색인) — search-runtime이 자신의 기본 설정으로 대체하지만, 그 기본값이
 *   무엇인지 Desktop은 모른다(운영 환경변수). **모델 이름을 지어내 보여주지
 *   않는다** — "추정"이라는 사실만 정직하게 보여준다.
 * - `UNREADABLE`: 디렉터리/파일이 없거나 손상되어 확인 자체가 불가능하다. */
export function resolveKnowledgeEmbedModelInfo(
  asset: { assetId: string; name: string; version: string },
  metaRead: KnowledgeIndexMetaReadResult,
): KnowledgeEmbedModelInfo {
  if (metaRead.status === "MISSING") {
    return {
      ...asset,
      state: "UNREADABLE",
      embedModel: null,
      detail: "이 Knowledge의 색인 메타데이터(index/index-meta.json)를 찾을 수 없어 실제 사용 모델을 확인할 수 없습니다.",
    };
  }
  if (metaRead.status === "UNREADABLE") {
    return {
      ...asset,
      state: "UNREADABLE",
      embedModel: null,
      detail: "이 Knowledge의 색인 메타데이터가 손상되어 있거나 읽을 수 없어 실제 사용 모델을 확인할 수 없습니다.",
    };
  }

  const embedModel = extractRecordedEmbedModel(metaRead.raw);
  if (embedModel) {
    return {
      ...asset,
      state: "RECORDED",
      embedModel,
      detail: `"${embedModel}" 모델로 색인되었습니다 — 검색 질의도 이 모델로 임베딩됩니다.`,
    };
  }
  return {
    ...asset,
    state: "ASSUMED_FALLBACK",
    embedModel: null,
    detail: "이 색인에는 사용된 임베딩 모델이 기록되어 있지 않습니다. 검색 시 search-runtime의 기본 설정을 임베딩 모델로 가정해 사용합니다 — 기록된 사실이 아니라 추정입니다.",
  };
}
