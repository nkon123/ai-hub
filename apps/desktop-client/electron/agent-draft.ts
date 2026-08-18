// D06 채팅 화면 "대화로 Agent 초안 만들기" — 현재 세션의 라이브(실시간 실행된)
// 메시지만 근거로 Agent+Prompt Manifest 초안을 만드는 순수 로직.
//
// fs/electron/node import가 전혀 없는 순수 모듈이다(모듈 CLAUDE.md "코드
// 배치" 규칙) — 렌더러(`src/screens/AgentDraftDialog.tsx`)가 상대경로로 직접
// import한다. `electron/` 안에 있지만 Main Process 전용이 아니다.
//
// `ChatMessage`(`src/screens/chatTypes.ts`)를 직접 import하지 않는다 — 이
// 저장소의 관례상 `electron/`은 `src/`에 의존하지 않는다(`runStages.ts`가
// 서버 SSE payload를 구조적으로 미러링하고 import하지 않는 것과 같은 이유).
// 대신 아래 `AgentDraftSourceMessage`가 이 파일이 실제로 읽는 필드만 구조적
// 타입으로 선언한다 — 어떤 `ChatMessage[]` 배열이든 별도 변환 없이 그대로
// 인자로 넘길 수 있다(구조적 타이핑).
//
// 핵심 규율(Task Brief) — 능력(capabilities)은 추측하지 않는다:
// - `restored === true`인 메시지(저장된 지난 대화를 복원한 턴)는 근거에서
//   제외한다. `conversation-store.ts`는 question/answer/status/citationCount
//   만 저장하므로 복원된 턴의 citations/stages/toolRoute는 애초에 저장된 적
//   없는 값이고, 그것을 근거로 쓰면 거짓 근거가 된다.
// - 라이브 메시지가 하나도 없으면 "판단 불가"를 정직하게 반환한다(추측해
//   기본값을 지어내지 않는다).

/** `ChatMessage`의 부분집합 — 이 파일이 실제로 읽는 필드만. */
export interface AgentDraftSourceMessage {
  question: string;
  /** true면 저장된 대화에서 복원된 턴 — 아래 모든 도출 함수가 이 메시지를
   * 근거에서 제외한다. */
  restored?: boolean;
  citations: ReadonlyArray<unknown>;
  stages: { tool_call: { state: string } };
  toolRoute: { toolName: string | null } | null;
}

export interface DerivedFlag {
  value: boolean;
  /** 사용자가 검토할 수 있는, 사실 그대로의 한국어 근거 문장. 절대 값을
   * 추측해 지어낸 문구가 아니다 — 실제로 관찰된 사실(citation 건수, Tool
   * 실행 횟수)만 담는다. */
  reason: string;
}

export interface CapabilityDerivation {
  /** false면 이 기능 자체를 쓸 수 없다 — 근거로 쓸 라이브 턴이 없다는 뜻. */
  hasLiveMessages: boolean;
  liveMessageCount: number;
  totalMessageCount: number;
  knowledgeRequired: DerivedFlag;
  mcpAllowed: DerivedFlag;
}

const NO_EVIDENCE_REASON = "이 세션에서 실제로 실행된 턴이 아직 없습니다 — 판단할 근거가 없습니다.";

/** 라이브 메시지만 골라 `citations`/Tool 실행 사실로부터 두 capability
 * 플래그를 도출한다. 근거 문구는 항상 실제 관찰된 숫자를 담는다 — 값이
 * `false`인 것도 "판단 불가"가 아니라 "확인했고 없었다"는 적극적 사실이다. */
export function deriveCapabilitiesFromMessages(
  messages: readonly AgentDraftSourceMessage[],
): CapabilityDerivation {
  const live = messages.filter((m) => m.restored !== true);
  const liveMessageCount = live.length;
  const totalMessageCount = messages.length;

  if (liveMessageCount === 0) {
    return {
      hasLiveMessages: false,
      liveMessageCount: 0,
      totalMessageCount,
      knowledgeRequired: { value: false, reason: NO_EVIDENCE_REASON },
      mcpAllowed: { value: false, reason: NO_EVIDENCE_REASON },
    };
  }

  const totalCitations = live.reduce((sum, m) => sum + m.citations.length, 0);
  const knowledgeRequired: DerivedFlag =
    totalCitations > 0
      ? { value: true, reason: `이 대화에서 근거 문서가 ${totalCitations}건 사용되었습니다(턴 ${liveMessageCount}개 중).` }
      : { value: false, reason: "이 대화에서 근거 문서가 사용된 턴이 없습니다." };

  const toolRuns = live.filter((m) => m.stages.tool_call.state === "done");
  let mcpAllowed: DerivedFlag;
  if (toolRuns.length === 0) {
    mcpAllowed = { value: false, reason: "이 대화에서 Tool이 실행된 턴이 없습니다." };
  } else {
    const toolNames = Array.from(
      new Set(toolRuns.map((m) => m.toolRoute?.toolName).filter((n): n is string => !!n)),
    );
    const namePart = toolNames.length > 0 ? ` (${toolNames.join(", ")})` : "";
    mcpAllowed = { value: true, reason: `이 대화에서 Tool이 ${toolRuns.length}회 실행되었습니다${namePart}.` };
  }

  return { hasLiveMessages: true, liveMessageCount, totalMessageCount, knowledgeRequired, mcpAllowed };
}

/** `citation_required` 체크박스의 초기 제안값 — `knowledge_required`가
 * `true`일 때만 기본으로 켜서 제안한다. 항상 편집 가능하다(호출자가 그대로
 * state 초깃값으로 쓰고 이후에는 사용자 입력을 따른다). */
export function suggestCitationRequired(knowledgeRequired: boolean): boolean {
  return knowledgeRequired;
}

// ---------------------------------------------------------------------------
// 매니페스트 빌더 — packages/schemas/manifests/agent-manifest.schema.json,
// prompt-manifest.schema.json을 그대로 따른다(additionalProperties:false).
// 전역 상태 없음, 순수 함수. `manifest_hash`는 절대 채우지 않는다(옵션
// 필드이고 가짜 계산을 하지 않는다 — Task Brief).
// ---------------------------------------------------------------------------

export interface AgentDraftOwnerInfo {
  org: string;
  creatorId: string;
}

/** owner.org/owner.creator_id는 필수 문자열이지만 이 PoC의 Desktop에는 로그인
 * 사용자 개념이 없다 — `DesktopSettingsPublic.siteId`/`clientDisplayName`
 * (둘 다 nullable)을 우선 쓰고, 없으면 각각 "local"/"desktop-user"로
 * fallback한다. 이 fallback은 지어낸 값이 아니라 "로그인 개념이 없는 이
 * PoC에서 정직하게 쓸 수 있는 자리표시자"다. */
export function resolveAgentDraftOwner(
  siteId: string | null,
  clientDisplayName: string | null,
): AgentDraftOwnerInfo {
  return {
    org: siteId && siteId.trim() ? siteId.trim() : "local",
    creatorId: clientDisplayName && clientDisplayName.trim() ? clientDisplayName.trim() : "desktop-user",
  };
}

/** 역할은 하나만 만든다 — `entry_role`은 항상 `roles[0].id`와 같아야 하므로
 * (스키마 요구가 아니라 이 기능의 설계 요구), 역할 id 자체를 사용자 입력으로
 *받지 않고 이 상수로 고정한다. */
const AGENT_DRAFT_ROLE_ID = "answerer";

export interface AgentManifestDraftInput {
  agentId: string;
  name: string;
  description: string;
  owner: AgentDraftOwnerInfo;
  knowledgeRequired: boolean;
  mcpAllowed: boolean;
  citationRequired: boolean;
}

/** `packages/schemas/manifests/agent-manifest.schema.json`의 required
 * 필드를 전부 채우고, 그 스키마가 허용하지 않는 필드는 절대 넣지 않는다
 * (additionalProperties:false). `version`은 초안이므로 항상 "0.1.0"으로
 * 고정한다. */
export function buildAgentManifestDraft(input: AgentManifestDraftInput): Record<string, unknown> {
  return {
    schema_version: "1.0",
    id: input.agentId,
    type: "agent",
    name: input.name,
    version: "0.1.0",
    owner: { org: input.owner.org, creator_id: input.owner.creatorId },
    classification: "PUBLIC_INTERNAL",
    description: input.description,
    workflow: {
      entry_role: AGENT_DRAFT_ROLE_ID,
      roles: [
        {
          id: AGENT_DRAFT_ROLE_ID,
          type: "answerer",
          description: "이 대화 내용을 근거로 만든 초안 역할입니다.",
          requires_knowledge: input.knowledgeRequired,
          requires_mcp: input.mcpAllowed,
          requires_prompt: true,
        },
      ],
    },
    capabilities: {
      knowledge_required: input.knowledgeRequired,
      mcp_allowed: input.mcpAllowed,
      streaming: true,
      citation_required: input.citationRequired,
    },
  };
}

/** Prompt Manifest의 `template.file`은 항상 이 상수로 고정한다 — 사용자
 * 입력으로 파일명을 만들지 않는다(루트 CLAUDE.md 코드 규칙). Export 시
 * Main Process가 실제로 이 이름으로 파일을 쓴다. */
export const AGENT_DRAFT_TEMPLATE_FILE_NAME = "template.md";

export interface PromptManifestDraftInput {
  promptId: string;
  name: string;
  description: string;
  owner: AgentDraftOwnerInfo;
  systemPrompt: string;
  citationRequired: boolean;
}

/** `packages/schemas/manifests/prompt-manifest.schema.json`의 required
 * 필드를 전부 채운다. `variables`에는 최소 `question`(string, required)을
 * 넣는다. */
export function buildPromptManifestDraft(input: PromptManifestDraftInput): Record<string, unknown> {
  return {
    schema_version: "1.0",
    id: input.promptId,
    type: "prompt",
    name: input.name,
    version: "0.1.0",
    owner: { org: input.owner.org, creator_id: input.owner.creatorId },
    classification: "PUBLIC_INTERNAL",
    description: input.description,
    template: {
      system: input.systemPrompt,
      file: AGENT_DRAFT_TEMPLATE_FILE_NAME,
      language: "ko",
    },
    variables: [{ name: "question", type: "string", required: true, description: "사용자 질문" }],
    output_schema: {
      format: "markdown",
      citation_required: input.citationRequired,
    },
  };
}

// ---------------------------------------------------------------------------
// 시스템 프롬프트 초안 생성 — Ollama 메타 프롬프트 조립.
// ---------------------------------------------------------------------------

/** `chatWithOllama`(`electron/ollama-chat.ts`)의 `OllamaChatInput` 형태로
 * 반환한다(그 함수를 그대로 재사용한다 — 새 HTTP 클라이언트를 만들지
 * 않는다). `liveQuestions`에는 **질문 텍스트만** 넣는다 — 답변 본문/Citation
 * 발췌는 절대 넣지 않는다(답변에는 사내 문서 내용이 들어 있을 수 있다). */
export function buildSystemPromptDraftRequest(
  liveQuestions: readonly string[],
): { question: string; history: Array<{ question: string; answer: string }> } {
  const list =
    liveQuestions.length > 0
      ? liveQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(질문이 없습니다.)";
  const question = [
    "아래는 한 업무용 챗봇이 실제로 받은 질문들의 목록이다. 이 챗봇이 어떤 역할로, 어떤 말투와 범위로, 어떤 경우 답변을 거절해야 하는지를 3~6문장의 시스템 프롬프트로 작성하라. 특정 질문에 대한 구체적 답변이나 문서 내용을 그대로 옮기지 말고, 오직 '어떻게 답할 것인가'(역할·말투·범위·거절 조건)만 기술하라.",
    "",
    "질문 목록:",
    list,
  ].join("\n");
  return { question, history: [] };
}
