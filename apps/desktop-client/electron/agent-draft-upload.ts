// D06 채팅 화면 "대화로 Agent 초안 만들기" — Desktop Client PR2. Agent 초안을
// Portal에 DRAFT로 등록하는 오케스트레이션.
//
// `store-install.ts`와 같은 이유로 fs/electron import 없이 순수하게
// 작성한다: 테스트가 네트워크 없이 "Portal 미설정" / "부분 성공" / "전체
// 실패" 세 경로를 검증할 수 있도록 `createAsset` 호출을 `AgentDraftUploadDeps`
// 로 주입받는다. 운영 배선(`main.ts`)은 `portal-client.ts`의 실제
// `createAsset`을 그대로 넘긴다.
//
// 절대 원칙(Task Brief PR2):
// - `POST /api/v1/assets`만 호출한다 — 승인/게시로 이어지는 어떤 다른
//   엔드포인트도 호출하지 않는다. 이 규율은 `deps.createAsset`의 실제
//   구현(`portal-client.ts::createAsset`)이 지킨다 — 이 파일은 그 함수를
//   두 번(Agent, Prompt) 호출하는 순서만 조립한다.
// - Agent와 Prompt는 별개 자산이다 — 하나의 실패가 다른 하나의 시도를 막지
//   않는다. 부분 실패를 숨기지 않는다: 성공한 쪽의 자산/버전 식별자를 그대로
//   반환한다(사용자가 Portal에서 직접 정리할 수 있도록 — 롤백 API가 없다).
import type { CreateAssetFile, CreateAssetResult, PortalApiResult } from "./portal-client";
import type { AgentDraftUploadInput, AgentDraftUploadResult } from "./types";

export interface AgentDraftUploadDeps {
  createAsset: (
    baseUrl: string,
    token: string,
    manifest: Record<string, unknown>,
    files: CreateAssetFile[],
    externalSignal?: AbortSignal,
  ) => Promise<PortalApiResult<CreateAssetResult>>;
}

export interface AgentDraftPortalConnection {
  baseUrl: string | null;
  token: string | null;
}

type AssetOutcome = NonNullable<AgentDraftUploadResult["agent"]>;

function toOutcome(result: PortalApiResult<CreateAssetResult>): AssetOutcome {
  if (result.ok) {
    return {
      ok: true,
      assetId: result.data.assetId,
      versionId: result.data.id,
      version: result.data.version,
      errorCode: null,
      errorMessage: null,
      validationErrors: null,
    };
  }
  return {
    ok: false,
    assetId: null,
    versionId: null,
    version: null,
    errorCode: result.code,
    errorMessage: result.message,
    validationErrors:
      result.code === "VALIDATION_ERROR" && Array.isArray(result.details?.errors)
        ? result.details.errors.map((e) => String(e))
        : null,
  };
}

/** Agent 매니페스트(첨부 없음)와 Prompt 매니페스트(+ `templateFileName`으로
 * 첨부하는 template.md)를 순서대로, 그러나 서로 독립적인 결과로 업로드한다.
 * Portal이 설정되지 않았으면(`connection.baseUrl`/`token` 중 하나라도
 * null) 아예 시도하지 않고 `attempted:false`를 반환한다 — 화면은 이
 * 상태에 도달하기 전에 업로드 진입점 자체를 숨겨야 하지만, 이 함수는
 * 방어적으로 다시 검사한다(폐쇄형에서 몰래 전송되지 않도록). */
export async function uploadAgentDraft(
  connection: AgentDraftPortalConnection,
  input: AgentDraftUploadInput,
  templateFileName: string,
  deps: AgentDraftUploadDeps,
  externalSignal?: AbortSignal,
): Promise<AgentDraftUploadResult> {
  if (!connection.baseUrl || !connection.token) {
    return {
      attempted: false,
      notConfiguredReason: "Portal 서버 주소와 식별 Token을 먼저 설정하세요.",
      agent: null,
      prompt: null,
    };
  }

  const agentResult = await deps.createAsset(
    connection.baseUrl,
    connection.token,
    input.agentManifest as Record<string, unknown>,
    [],
    externalSignal,
  );
  const promptResult = await deps.createAsset(
    connection.baseUrl,
    connection.token,
    input.promptManifest as Record<string, unknown>,
    [{ filename: templateFileName, content: input.templateContent }],
    externalSignal,
  );

  return {
    attempted: true,
    notConfiguredReason: null,
    agent: toOutcome(agentResult),
    prompt: toOutcome(promptResult),
  };
}
