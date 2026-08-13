// D06 대화 — KNOWLEDGE_ROUTE 후보 조립(agentic Knowledge 선택). 순수 함수
// (fs/electron import 없음) — 호출자(`asset-management.ts`)가 이미
// `readAssetManifest`로 읽어 넘긴 `AssetManifestResult`를 받아서만 조립한다.
// `version-diff.ts`가 asset-management.ts에 대해 갖는 관계와 동일한 구조:
// fs 읽기는 Main에서만, 필드 조립은 여기서만.
//
// 이 파일이 만드는 형태는 agent-runtime의 `knowledge_candidates` 입력
// (`packages/schemas/api/local-runtime-api.yaml`의 `KnowledgeCandidateInput`,
// `services/agent-runtime/src/agent_runtime/knowledge_router.py`의
// `KnowledgeCandidate`)과 필드 이름까지 그대로 맞춘다 — Desktop이 만든 값을
// 다른 레이어에서 다시 변환하지 않고 그대로 보낸다(CLAUDE.md 코드 규칙:
// API/Schema Field는 명세의 이름을 그대로 사용한다).
import type { AssetManifestResult, InstalledAsset, KnowledgeCandidate } from "./types";

/** `partitionInstalledKnowledgeByActivation`(chatTypes.ts)이 이미 "검색 가능"
 * 으로 판정한 Knowledge 자산 하나를 KNOWLEDGE_ROUTE 후보로 조립한다.
 *
 * - `asset.assetVersionId`가 없으면 `null` — 검증 가능한 knowledge_id가
 *   없는 자산(D-060 레거시 Bundle)은 애초에 후보가 될 수 없다(발명 금지).
 *   호출자는 이 자산을 후보 목록에서 완전히 빼야 한다.
 * - `name`은 항상 설치 레코드 자체의 값(`InstalledAsset.name`)을 쓴다 —
 *   Manifest가 다른 이름을 담고 있어도 덮어쓰지 않는다(레코드가 이미
 *   설치 시점에 검증된 이름이다).
 * - `manifestResult.available`이 false이거나(손상됨/파일 없음/STANDARD_LOCAL_COPY)
 *   `manifest`가 객체가 아니면, `description`/`tags`/`classification`은
 *   전부 생략한다 — 절대로 지어내지 않고, 그렇다고 자산 자체를 후보에서
 *   빼지도 않는다(요구사항: "missing manifest degrades to just name, never
 *   skip"). 필드가 스키마와 다른 타입이면(예: `tags`가 배열이 아님) 그
 *   필드만 조용히 생략한다 — 나머지 필드는 여전히 채워질 수 있다.
 */
export function buildKnowledgeCandidate(
  asset: Pick<InstalledAsset, "assetVersionId" | "name">,
  manifestResult: AssetManifestResult,
): KnowledgeCandidate | null {
  if (!asset.assetVersionId) return null;

  const candidate: KnowledgeCandidate = { knowledge_id: asset.assetVersionId, name: asset.name };

  if (!manifestResult.available || manifestResult.manifest === null || typeof manifestResult.manifest !== "object") {
    return candidate;
  }
  const manifest = manifestResult.manifest as Record<string, unknown>;

  if (typeof manifest.description === "string" && manifest.description.trim().length > 0) {
    candidate.description = manifest.description;
  }
  if (Array.isArray(manifest.tags)) {
    const tags = manifest.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (tags.length > 0) candidate.tags = tags;
  }
  if (typeof manifest.classification === "string" && manifest.classification.trim().length > 0) {
    candidate.classification = manifest.classification;
  }
  return candidate;
}

/** `buildKnowledgeCandidate`를 목록에 적용해 후보 배열을 만든다 — 하나라도
 * `null`(assetVersionId 없음)이면 그 자산은 조용히 빠진다(호출자가 이미
 * 활성화 파티션으로 "검색 가능"만 넘겼다면 정상적으로는 발생하지 않는다).
 * `manifestByAsset`은 asset과 같은 순서/길이여야 한다 — `asset-management.ts`
 * 쪽 호출자가 각 asset마다 `readAssetManifest`를 호출해 병렬 배열로 넘긴다. */
export function buildKnowledgeCandidates(
  assets: ReadonlyArray<Pick<InstalledAsset, "assetVersionId" | "name">>,
  manifestByAsset: ReadonlyArray<AssetManifestResult>,
): KnowledgeCandidate[] {
  const candidates: KnowledgeCandidate[] = [];
  for (let i = 0; i < assets.length; i += 1) {
    const candidate = buildKnowledgeCandidate(assets[i], manifestByAsset[i]);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
