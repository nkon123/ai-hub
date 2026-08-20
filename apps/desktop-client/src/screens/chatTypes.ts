// Shared types between D06(ChatScreen)와 D07(RunDetailPanel) — one in-memory
// conversation turn plus everything captured about its Run, so the detail
// panel can be derived purely from client state without a second round trip
// (it does make one: a `getRun` refresh right after the terminal SSE event,
// to record the server's authoritative `completed_at`).
import type { Citation, ConversationTurnInput, PendingConfirmation, RunEventLogItem, RunResponse } from "../agentRuntime";
import type { StageMap } from "../runStages";
import type { ConversationRecord, InstalledAsset, ToolExecutionRecord } from "../../electron/types";

export type ChatMessageStatus =
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "insufficient_evidence"
  | "failed"
  | "cancelled"
  // 실사용 제보(2026-08-20) — 저장소에 복원된 자동 Tool 라우팅 턴 중,
  // 애초에 어떤 Tool도 실행되지 않은 경우(`ConversationTurnStatus`의
  // `"no_action"`을 그대로 옮김). 실패가 아니라 "실행할 것이 없었다"는
  // 별개의 사실이다 — 라이브 세션 중에는 이 값이 만들어지지 않고 복원
  // (`chatMessageFromStoredTurn`)에서만 나타난다(ChatScreen.tsx의 자동
  // 라우팅 핸들러는 이 파일이 정의하는 `messages` 배열에 직접 쓰지 않는다).
  | "no_action";

export interface ChatMessage {
  id: string;
  question: string;
  /** Knowledge id (AssetVersion UUID expected by agent-runtime) used for
   * this specific turn — captured per-message rather than read live off
   * screen state, so switching the Knowledge selector mid-conversation never
   * mislabels an in-flight or historical turn. */
  knowledgeIdUsed: string;
  knowledgeLabelUsed: string;
  serviceId: string;
  /** D-058/D-052: "standard-agent" for every normal D06 turn; only the
   * "개발 확인용" MCP trigger sets "standard-db-agent". Captured per-message
   * (not read live off screen state) for the same reason knowledgeIdUsed is —
   * and so D07 can display what was *actually* used for this turn. */
  agentProfile: "standard-agent" | "standard-db-agent";
  /** D-034 해석 경로 4 — `null`(기본, "표준 Agent")이 아니면 이 턴이 실제로
   * 실행에 쓴 등록된 Local Agent Package의 `agent_asset_id`와 표시 이름.
   * 턴마다 캡처한다(화면의 현재 선택이 바뀌어도 지난 턴의 표시가 바뀌지
   * 않도록, `knowledgeIdUsed`와 같은 이유) — "어떤 Agent가 답했는지 항상
   * 보여야 한다"(Task Brief 제약 D)를 지키는 필드. */
  localAgentIdUsed: string | null;
  localAgentLabelUsed: string | null;
  /** true when this turn bypasses Knowledge search and talks directly to Ollama. */
  ollamaOnly?: boolean;
  /** Actual installed Ollama model selected for this turn. */
  ollamaModel?: string;
  status: ChatMessageStatus;
  answer: string;
  citations: Citation[];
  stages: StageMap;
  eventLog: RunEventLogItem[];
  /** Non-null only while status === "waiting_for_user" — drives the D06
   * confirmation Panel (tool name, safe summary, deadline). */
  pendingConfirmation: PendingConfirmation | null;
  runId: string | null;
  traceId: string | null;
  /** Client-observed wall-clock timestamps — see agentRuntime.ts's
   * `RunEventLogItem.receivedAt` docstring on why these are not claimed to
   * be server-authoritative until `serverRun` is populated. */
  startedAt: string;
  completedAt: string | null;
  errorMessage?: string;
  errorCode?: string;
  /** Authoritative snapshot fetched via `GET /local/v1/runs/{id}` right
   * after a terminal SSE event — D07 prefers these timestamps/status/output
   * over the client-observed ones above whenever present. */
  serverRun: RunResponse | null;
  /** True only for a turn rehydrated from a saved conversation
   * (`chatMessageFromStoredTurn`) — this Run's own eventLog/citations/stages
   * were never persisted (only question+answer text was, see
   * `conversation-store.ts`), so D06/D07 must not offer actions that assume
   * a live Run exists (재시도/취소/상세 실행 보기's event timeline). */
  restored?: boolean;
  /** Only set on a restored turn — the number of citations the original
   * (unpersisted) Run had, shown as a plain count since the citations
   * themselves were not saved. */
  restoredCitationCount?: number;
  /** Every `"hub.query_sent"` SSE event this turn's Run has emitted so far —
   * the after-the-fact visibility guarantee for Stage 2 hub lookup consent,
   * complementing the before-the-fact preview `buildHubQueryPreview` powers
   * while the user is still typing. `query` is guaranteed by agent-runtime's
   * own enforced chokepoint to be built only from text the user typed —
   * never local document content — so it is safe to render verbatim. Always
   * `[]` for a restored turn (not persisted, same as `citations`/`eventLog`). */
  hubQueriesSent: Array<{ query: string; knowledgeIdsSearched: string[] }>;
  /** `knowledge_id -> name`, captured at send time from the exact
   * `knowledge_candidates` this turn sent (empty when this turn didn't send
   * candidates) — used only to resolve human-readable names when the
   * `"knowledge.route.selected"` SSE event arrives (it carries ids only).
   * Never sent anywhere itself; purely a local display aid. */
  knowledgeCandidateNameById: Record<string, string>;
  /** Non-null only once (if ever) a `"knowledge.route.selected"` SSE event
   * has arrived for this turn — i.e. this turn sent `knowledge_candidates`
   * AND KNOWLEDGE_ROUTE actually ran (skipped/fell back/ran). `null` for
   * every turn that searched by plain `knowledgeIds` (no routing stage
   * exists for it) and for a restored turn (not persisted). See
   * `describeKnowledgeRoute`. */
  knowledgeRoute: KnowledgeRouteDisplay | null;
  /** Non-null only once (if ever) a `"mcp.tool_route.selected"` SSE event has
   * arrived for this turn — i.e. this turn sent `tool_route: true` AND
   * TOOL_ROUTE actually ran (D-083, `agent_runtime.tool_router`). `null` for
   * every turn that didn't opt in, and for a restored turn (not persisted).
   * A later `"mcp.tool_route.rejected"` event (preflight refusal of a "ran"
   * proposal) overwrites this to the `"rejected"` display — see
   * `describeToolRouteSelected`/`describeToolRouteRejected`. */
  toolRoute: ToolRouteDisplay | null;
  /** 실사용 제보(2026-08-19) — 이 턴이 실제로 지정한 명시적 MCP Tool 호출
   * (개발 확인용 Tool 트리거, `mcpDevActive`). Tool 이름+인자는 전송
   * 시점에 캡처된다(다른 `*Used` 필드와 같은 이유 — 화면 상태가 바뀌어도
   * 지난 턴 표시가 바뀌지 않도록) — 결과는 이 턴이 종료된 뒤 상태/citation
   * 개수로부터 만들어진다(`buildToolExecutionsForPersist`). `null`이면 이
   * 턴은 명시적 MCP Tool 호출이 아니다. */
  mcpToolCallUsed: { toolName: string; args: Record<string, unknown> } | null;
  /** 저장소에 실제로 기록된(또는 복원된) Tool 실행 목록 — 라이브 세션 중에는
   * `persistTurn`이 계산해 Main Process로 보낼 뿐 이 필드 자체를 채우지
   * 않는다(라이브 화면은 `toolRoute`/로컬 Tool 카드로 이미 보여준다). 복원된
   * 턴(`restored === true`)에서는 저장된 값 그대로 채워져, `ChatTurn`이
   * "Tool 실행 기록"을 다시 그릴 수 있게 한다. */
  toolExecutions: ToolExecutionRecord[];
}

// D-060: an installed Knowledge from a Bundle built before the fix has no
// AssetVersion id at all — asset_id (what those legacy Bundles carried) is
// the *parent Asset*'s id, and search-runtime/agent-runtime key Knowledge
// search strictly by AssetVersion id. Silently sending asset_id looks like a
// working chat that always returns zero results (INSUFFICIENT_EVIDENCE) —
// exactly the bug this reason string exists to prevent by refusing to guess.
export const LEGACY_BUNDLE_KNOWLEDGE_ID_REASON =
  "이 자산은 이전 형식의 Bundle이며 검증 가능한 Knowledge 식별자가 없습니다 — 최신 ZIP으로 다시 설치해야 대화할 수 있습니다.";

export interface KnowledgeSelection {
  /** Empty string when nothing usable is selected — same "falsy means no
   * selection" convention ChatScreen already used before this field existed. */
  knowledgeId: string;
  /** Non-null only when an asset IS selected but cannot be used as-is (D-060
   * legacy Bundle) — distinct from "nothing selected", which has no reason. */
  disabledReason: string | null;
}

/** Pure decision of what to actually send as `knowledge_id` for a selected
 * installed Knowledge asset — never falls back to `assetId` (see
 * LEGACY_BUNDLE_KNOWLEDGE_ID_REASON). Kept outside ChatScreen so it is
 * unit-testable without rendering React. */
export function resolveKnowledgeSelection(asset: InstalledAsset | null): KnowledgeSelection {
  if (!asset) return { knowledgeId: "", disabledReason: null };
  if (!asset.assetVersionId) {
    return { knowledgeId: "", disabledReason: LEGACY_BUNDLE_KNOWLEDGE_ID_REASON };
  }
  return { knowledgeId: asset.assetVersionId, disabledReason: null };
}

// D-079 이어 붙이기(activation-chat-wiring): "설치됨"과 "활성화됨"은 서로 다른
// 사실이다(electron/types.ts의 `InstalledAsset.activation` 문서 참고). 이전에는
// `resolveInstalledKnowledgeIds`가 assetVersionId만 확인하고 활성화 여부는
// 전혀 보지 않아, 활성화되지 않은(또는 활성화 실패한) Knowledge까지 그대로
// agent-runtime에 `knowledge_id`로 보내 조용히 Citation 0건을 만들었다 —
// D-079가 없애려던 바로 그 실패가 한 단계 위(Desktop 채팅)에서 재발한 것.
// 이 함수는 그 자리를 대신한다: 검색 가능한 것과 제외된 것을 사유와 함께
// 나눈다. 옛 함수는 제거했다 — "활성화 여부와 무관하게 id만" 필요한
// 정당한 호출자가 이제 없다(대화가 실제로 도달 가능한 id만 보내야 한다는
// 게 이 작업의 핵심 요구사항이므로, 남겨 두면 그 자체가 함정이 된다).

/** 채팅에서 실제로 검색 대상이 될 수 있는 Knowledge 하나. `T`를
 * `InstalledAsset`로 고정하지 않고 제네릭으로 둔 이유: 호출자가
 * `InstalledAssetWithStatus`(D08 `status` 필드가 추가된 형태)를 넘기면 그
 * 타입 그대로 돌려받아야, 화면이 다시 캐스팅 없이 `status`를 읽을 수 있다. */
export interface UsableKnowledge<T extends InstalledAsset = InstalledAsset> {
  knowledgeId: string;
  asset: T;
}

/** 채팅 검색 대상에서 제외된 Knowledge 하나와 그 사유(항상 한국어, 화면에
 * 그대로 표시 가능). */
export interface ExcludedKnowledge<T extends InstalledAsset = InstalledAsset> {
  asset: T;
  reason: string;
}

export interface KnowledgeActivationPartition<T extends InstalledAsset = InstalledAsset> {
  usable: UsableKnowledge<T>[];
  excluded: ExcludedKnowledge<T>[];
}

/** `activation` 필드가 없거나(미시도) 명시적으로 `null`(비활성화됨)인 경우
 * 공통으로 쓰는 사유 — `installed-assets-store.ts`의 `updateActivation` 문서가
 * 이미 밝힌 결정을 그대로 따른다: 두 경우 모두 화면에는 "활성화 안 됨"으로
 * 동일하게 보인다(그것이 정확한 사실이며, 굳이 구분해 봐야 사용자가 할 일은
 * 똑같이 "활성화"뿐이다). */
export const KNOWLEDGE_NOT_ACTIVATED_REASON =
  "이 Knowledge는 아직 검색에 활성화되지 않았습니다(활성화를 시도한 적이 없거나 비활성화된 상태입니다). 설치된 자산 화면에서 활성화할 수 있습니다.";

/** 지식 검색 자동화 + D-079 활성화 인지 — 설치된 모든 Knowledge를 실제로
 * 검색 가능한 것(usable)과 그럴 수 없는 것(excluded, 사유 포함)으로 나눈다.
 * `resolveKnowledgeSelection`의 D-060 판단(legacy Bundle)을 먼저 적용하고,
 * 그 다음에만 `activation.state`를 본다 — assetVersionId가 아예 없는
 * 자산은 활성화를 시도할 수조차 없었으므로 활성화 사유보다 D-060 사유가
 * 우선한다(실제로 `activateInstalledKnowledge`도 같은 순서로 거부한다). */
export function partitionInstalledKnowledgeByActivation<T extends InstalledAsset>(
  assets: T[],
): KnowledgeActivationPartition<T> {
  const usable: UsableKnowledge<T>[] = [];
  const excluded: ExcludedKnowledge<T>[] = [];
  for (const asset of assets) {
    if (asset.assetType !== "knowledge") continue;
    const selection = resolveKnowledgeSelection(asset);
    if (!selection.knowledgeId) {
      excluded.push({ asset, reason: selection.disabledReason ?? LEGACY_BUNDLE_KNOWLEDGE_ID_REASON });
      continue;
    }
    // `ALREADY_ACTIVE`(central_index_exists)도 usable — search-runtime의
    // 중앙 INDEX_BASE가 이미 이 knowledge_id를 서빙하고 있어 등록 없이도
    // 검색된다. `ACTIVE`와 다른 점은 "누가 등록했는가"뿐, "검색 가능한가"는
    // 동일한 사실이다(electron/types.ts의 `KnowledgeActivation` 문서 참고).
    if (asset.activation?.state === "ACTIVE" || asset.activation?.state === "ALREADY_ACTIVE") {
      usable.push({ knowledgeId: selection.knowledgeId, asset });
      continue;
    }
    if (asset.activation?.state === "FAILED") {
      excluded.push({ asset, reason: asset.activation.message ?? "활성화에 실패했습니다." });
      continue;
    }
    excluded.push({ asset, reason: KNOWLEDGE_NOT_ACTIVATED_REASON });
  }
  return { usable, excluded };
}

/** D-034 해석 경로 4 / D-087 — "설치됨"과 "등록됨(agent-runtime이 이
 * Agent+Prompt 짝을 알아 대화에 쓸 수 있음)"은 서로 다른 사실이다
 * (`partitionInstalledKnowledgeByActivation`과 같은 원칙, Local Agent
 * 버전). `localAgentRegistration.state === "ACTIVE"`만 후보로 남긴다 —
 * `FAILED`(사유가 `prompt_removed`든, `not_registered_on_server`든,
 * `local_agents_disabled`든)는 전부 자동으로 제외된다. 재조정
 * (`computeLocalAgentRegistrationReconcile`)이 짝 Prompt가 사라진 등록을
 * FAILED로 낮추면, 이 함수를 거치는 모든 화면에서 그 즉시 선택 불가능한
 * 상태로 반영된다 — 별도의 화면별 예외 처리가 필요 없다. 순수 함수로 뽑아
 * 둔 이유: `environment: "node"`인 이 저장소의 vitest 설정에서는
 * `ChatScreen.tsx`를 직접 렌더링해 이 성질을 확인할 수 없으므로
 * (CLAUDE.md), 실제로 화면이 쓰는 이 로직 자체를 테스트 대상으로 뽑아야
 * 회귀를 잡는다. */
export function selectRegisteredLocalAgents<T extends InstalledAsset>(assets: T[]): T[] {
  return assets.filter((a) => a.localAgentRegistration?.state === "ACTIVE");
}

/** `partitionInstalledKnowledgeByActivation`의 usable 목록에서 id만 뽑는다 —
 * agent-runtime `startRun`의 `knowledgeIds` 입력이 필요로 하는 형태. */
export function resolveActivatedKnowledgeIds(assets: InstalledAsset[]): string[] {
  return partitionInstalledKnowledgeByActivation(assets).usable.map((u) => u.knowledgeId);
}

// --- D-080/D-084 혼동 정정(2026-08-17) --------------------------------------
// 실사용 관찰: 자산 스토어에서 MCP Tool(예: "숫자 더하기")을 설치·연결한
// 사용자가 대화창의 "로컬 Tool"(D-084, 내 PC의 .py 파일을 직접 실행하는
// 별개 기능) 버튼을 눌렀다가 "등록된 로컬 Tool이 없습니다"를 보고 방금
// 설치한 Tool이 사라졌다고 오해했다 — 두 기능 다 코드는 정확히 동작했지만
// 연결된 MCP Tool이 화면 어디에도 보이지 않아 그 결론이 사용자 입장에서
// 합리적이었다. 아래 두 함수는 "설치됨"과 "연결됨"을 구분해 보여주는 자리
// (D-083 렌치 토글의 설명, D-084 로컬 Tool 빈 상태)를 계산한다 —
// `partitionInstalledKnowledgeByActivation`과 동일한 "설치됨 ≠ 쓸 수 있음"
// 원칙을 MCP Tool에도 그대로 적용한다. 이름은 업무 목적 이름(`asset.name`,
// 예: "숫자 더하기")을 쓴다 — `tool_name`(예: `calculator.add`)은 이 함수들이
// 다루지 않는다(루트 CLAUDE.md UI 규칙: 기술 명칭보다 업무 목적을 먼저).

export interface McpToolConnectionSummary<T extends InstalledAsset = InstalledAsset> {
  /** 연결까지 완료되어(D-080, `activation.state`가 `ACTIVE`/`ALREADY_ACTIVE`)
   * 실제로 대화에서 쓸 수 있는 MCP Tool 자산. */
  connected: T[];
  /** 설치는 되어 있으나 아직 연결되지 않아 대화에서 쓸 수 없는 MCP Tool
   * 개수. 자산 자체는 노출하지 않는다(이름까지 보여주려면 "연결하라"는
   * 행동 유도가 흐려진다 — Task Brief: 설치됨은 개수+안내로, 연결됨은
   * 이름 목록으로). */
  installedNotConnectedCount: number;
}

/** `mcpTools`는 이미 `assetType === "mcp_tool"`로 걸러진 목록이라고
 * 가정한다(`ChatScreen`의 `installedMcpTools`가 이미 그렇게 필터링해
 * 둔다) — 이 함수가 다시 assetType을 검사하지 않는다. */
export function summarizeMcpToolConnections<T extends InstalledAsset>(
  mcpTools: T[],
): McpToolConnectionSummary<T> {
  const connected = mcpTools.filter(
    (asset) => asset.activation?.state === "ACTIVE" || asset.activation?.state === "ALREADY_ACTIVE",
  );
  return { connected, installedNotConnectedCount: mcpTools.length - connected.length };
}

/** D-083 렌치 토글("필요하면 Tool 자동 제안") 설명 뒤에 덧붙일 문장. 연결된
 * Tool이 없고 설치된 것도 없으면 빈 문자열 — 기존 설명 문구를 그대로 두고
 * 아무것도 새로 그리지 않는다(2026-08-14 "정상 상태 배너 최소화" 원칙,
 * 이 문장은 상시 배너가 아니라 토글의 기존 hover 툴팁 안에 녹는다). */
export function describeToolRouteMcpToolsHint(summary: McpToolConnectionSummary): string {
  if (summary.connected.length > 0) {
    const names = summary.connected.map((a) => a.name).join(", ");
    const extra =
      summary.installedNotConnectedCount > 0
        ? ` 설치했지만 아직 연결하지 않은 Tool ${summary.installedNotConnectedCount}개는 설치된 자산 화면에서 연결하면 함께 제안 대상이 됩니다.`
        : "";
    return ` 지금 연결되어 바로 쓸 수 있는 Tool: ${names}.${extra}`;
  }
  if (summary.installedNotConnectedCount > 0) {
    return ` 설치된 Tool ${summary.installedNotConnectedCount}개가 아직 연결되지 않았습니다. 설치된 자산 화면에서 연결하면 제안 대상이 됩니다.`;
  }
  return "";
}

// D-084 후속 화면(내 PC의 Python 파일을 실행하는 별개 기능)의 빈 상태
// 안내 문구는 의도적으로 이 파일에 두지 않는다 — 구조적 격리(D-084 hard
// requirement 1)를 지키는 다른 모듈이 그 문구를 만든다. 이 파일이 내보내는
// `McpToolConnectionSummary`/`summarizeMcpToolConnections`는 오직 "설치됨
// vs 연결됨"이라는 MCP Tool 쪽 사실만 계산한다 — 그 사실을 저 별개 화면의
// 문구로 바꾸는 책임은 이 파일 밖에 있다.

// --- D-079 이어 붙이기(반복 설명 정리, 2026-08-14) --------------------------
// 실사용 화면 관찰: 활성화 실패 원인이 환경적(search-runtime 프로세스 자체가
// 이 API를 모름, local_indexes 기능 꺼짐 등)이면 설치된 Knowledge가 몇 개든
// 전부 정확히 같은 `reason` 문자열을 받는다(원인이 자산이 아니라 search-runtime
// 쪽에 있으므로). 그런데 화면은 그 문자열을 자산마다 한 번씩 반복해 보여줬고,
// 방금 누른 재시도 결과(`feedback.message`)가 같은 원인이면 또 한 번, 그
// 아래 reconcile 안내가 또 한 번 — 같은 문단이 최대 세 번 찍혔다(정직하지만
// 읽을 수 없음, 루트 CLAUDE.md "기술 명칭보다 업무 목적을 먼저 표시한다"
// 위반). 아래 두 함수가 그 중복 제거를 순수 로직으로 분리한다 — 원인이 실제로
// 서로 다르면(자산별 사유) 여전히 각 줄에 그대로 남는다: 숨기는 게 아니라
// "같은 말을 세 번 하지 않는다"만 한다.

export interface GroupedExcludedKnowledge<T extends InstalledAsset = InstalledAsset> {
  asset: T;
  /** null이면 이 자산의 사유가 `sharedReason`으로 패널 상단에 이미 한 번
   * 표시됐다는 뜻 — 행에서는 다시 찍지 않는다. non-null이면(원인이 자산마다
   * 다름) 이 행이 유일하게 그 사유를 보여주는 자리이므로 그대로 둔다. */
  reason: string | null;
}

export interface GroupedKnowledgeExclusion<T extends InstalledAsset = InstalledAsset> {
  /** 제외된 Knowledge가 하나 이상 있고 전부 동일한 사유일 때만 채워진다
   * (자산이 1개뿐이면 "전부 동일"이 자명하게 참이므로 이때도 채워진다) —
   * 패널 레벨에서 한 번만 보여줄 문구. 사유가 서로 다르면 `null`이고, 각
   * `items[].reason`이 대신 그 정보를 보존한다. */
  sharedReason: string | null;
  items: GroupedExcludedKnowledge<T>[];
}

/** 제외된 Knowledge 목록을 "공유 사유 한 번 + 자산별 고유 사유"로 나눈다.
 * 무엇이 보고되는지는 절대 바꾸지 않는다(자산 목록과 사유 문자열은 입력
 * 그대로 보존) — 어디서 몇 번 찍히는지만 바꾼다. */
export function groupExcludedKnowledgeByReason<T extends InstalledAsset>(
  excluded: ExcludedKnowledge<T>[],
): GroupedKnowledgeExclusion<T> {
  if (excluded.length === 0) return { sharedReason: null, items: [] };
  const firstReason = excluded[0].reason;
  const allSameReason = excluded.every((e) => e.reason === firstReason);
  if (allSameReason) {
    return {
      sharedReason: firstReason,
      items: excluded.map(({ asset }) => ({ asset, reason: null })),
    };
  }
  return {
    sharedReason: null,
    items: excluded.map(({ asset, reason }) => ({ asset, reason })),
  };
}

/** `ExcludedKnowledgeRow`가 실제로 그려야 할 텍스트를 결정한다. 방금 누른
 * 활성화 재시도(`feedback`)가 이미 표시 중인 `reason`(패널이 공유 사유로
 * 뽑아갔다면 null)과 글자 그대로 같으면, 같은 문단을 두 번 찍지 않고
 * `feedback` 쪽만 남긴다(최신 시도 결과이므로) — 재시도가 다른 이유로
 * 실패했거나 성공했으면 그 새 내용을 그대로 보여준다. */
export function resolveExcludedRowText(
  reason: string | null,
  feedback: { ok: boolean; message: string } | null,
): { reasonText: string | null; feedbackText: string | null } {
  if (!feedback) return { reasonText: reason, feedbackText: null };
  const isDuplicate = !feedback.ok && reason !== null && feedback.message.trim() === reason.trim();
  return { reasonText: isDuplicate ? null : reason, feedbackText: feedback.message };
}

/** reconcile 안내(`resolveReconcileNotice`의 결과)가 방금 위에서 이미 전체
 * 문장으로 보여준 사유(공유 사유 또는 자산별 사유)와 글자 그대로 같으면,
 * 그 문단을 또 반복하지 않고 "그 확인 자체가 실패했다"는 새 정보만 짧게
 * 알린다. 원인이 다르면(예: reconcile은 되지만 등록이 사라짐 vs 활성화
 * API 자체가 없음) 원래 전체 문구를 그대로 보여준다 — 서로 다른 사실을
 * 하나로 뭉개지 않는다. */
export const RECONCILE_SAME_CAUSE_NOTICE = "활성화 상태를 다시 확인하지 못했습니다(원인은 위와 같습니다).";

export function resolveReconcileCaption(
  reconcileNotice: string | null,
  alreadyShownReasons: ReadonlyArray<string | null>,
): string | null {
  if (!reconcileNotice) return null;
  const normalized = reconcileNotice.trim();
  const matchesShown = alreadyShownReasons.some((r) => r !== null && r.trim() === normalized);
  return matchesShown ? RECONCILE_SAME_CAUSE_NOTICE : reconcileNotice;
}

// D-079 이어 붙이기 — `reconcileKnowledgeActivations()`는 목록을 보여주기
// 전에 로컬 ACTIVE 상태가 search-runtime과 여전히 일치하는지 재확인하는
// "있으면 좋은" 부가 기능이다: 이 호출이 없거나 실패해도 설치된 Knowledge
// 목록 자체는 항상 떠야 한다(CLAUDE.md: Desktop은 Runtime 장애 시 종료되지
// 않고 복구 안내를 제공한다). 실제로 2026-08-13 런타임 버그가 이 규칙을
// 어겼다: `bridge.reconcileKnowledgeActivations()`를 가드 없이 호출해
// `TypeError: bridge.reconcileKnowledgeActivations is not a function`가
// 채팅 화면 전체를 무너뜨렸다 — Main process가 빌드한 `dist/electron/preload.js`가
// 이 메서드가 추가되기 전 버전으로 stale했기 때문이다.
//
// 이 함수는 "메서드가 아예 없음"과 "호출은 됐지만 실패함"을 모두 같은
// 방식으로 다룬다: 조용히 성공한 것처럼 넘어가지 않고, search-runtime에
// 실제로 도달할 수 없을 때와 동일한 "확인 불가" 안내로 degrade한다 — 절대로
// throw하지 않는다.
//
// "메서드가 아예 없음" 분기는 이제 이중 방어(belt-and-braces)다: 이 함수의
// 유일한 실제 호출자인 `ChatScreen.tsx`는 항상 `../bridge`의
// `getDesktopBridge()`가 돌려준 값을 넘기고, 그 함수는 이제 stale
// `preload.js`로 빠진 메서드를 스스로 감지해 던지는 대신 거절(reject)하는
// 안전한 대체 함수로 채워 넣는다(`src/bridge.ts` 참고) — 그 경로로는 아래
// `typeof ... !== "function"` 분기가 더 이상 실행되지 않고, 대신 실제
// 호출이 이루어져 `catch` 블록으로 떨어진다(결과는 동일: "확인 불가" 안내).
// 그래도 이 분기를 지우지 않는 이유: `ReconcileCapableBridge`는 export된
// 구조적 타입이라 `getDesktopBridge()`를 거치지 않고 손으로 만든 객체(이
// 파일의 테스트가 바로 그렇게 한다, `chatTypes.test.ts`의 "bridge has no
// such method at all" 케이스)도 유효한 입력이다 — 그런 입력에서는 여전히
// 유일한 방어선이므로 지우면 실제로 도달 가능한 경로가 가드 없이 남는다.
export const RECONCILE_UNAVAILABLE_NOTICE =
  "search-runtime에 연결할 수 없어 활성화 상태를 확인하지 못했습니다.";

export interface ReconcileCapableBridge {
  reconcileKnowledgeActivations?: () => Promise<{ checked: boolean; error: string | null }>;
}

/** `bridge`가 `reconcileKnowledgeActivations`를 갖고 있지 않거나(오래된
 * preload.js) 호출이 예외를 던져도 이 함수는 절대 throw하지 않는다 — 항상
 * "표시할 안내 문구(또는 안내 없음)"만 돌려준다. 호출자는 이 결과와 무관하게
 * 설치된 Knowledge 목록을 계속 불러와야 한다. */
export async function resolveReconcileNotice(bridge: ReconcileCapableBridge | null): Promise<string | null> {
  if (!bridge || typeof bridge.reconcileKnowledgeActivations !== "function") {
    return RECONCILE_UNAVAILABLE_NOTICE;
  }
  try {
    const result = await bridge.reconcileKnowledgeActivations();
    return result.checked ? null : (result.error ?? RECONCILE_UNAVAILABLE_NOTICE);
  } catch (err) {
    return err instanceof Error ? err.message : RECONCILE_UNAVAILABLE_NOTICE;
  }
}

// --- D06 대화: KNOWLEDGE_ROUTE 표시(agentic Knowledge 선택) -------------------
// 배경: 이전에는 "지식에서 검색"을 켜면 설치+활성화된 Knowledge 전부를
// 검색했다(위 `partitionInstalledKnowledgeByActivation`). 후보(이름/설명/
// 태그/분류 메타데이터만)를 보내면, agent-runtime의 KNOWLEDGE_ROUTE 단계
// (`agent_runtime.knowledge_router`)가 이번 턴 질문과 그 메타데이터만으로
// 검색할 가치가 있는 부분집합을 하나의 선택적 LLM 호출로 고른다 — 문서
// 본문/Citation/이전 답변은 절대 이 호출에 들어가지 않는다(서버 쪽 보장,
// D-078 hub_query.py의 신뢰 경계와 같은 원칙을 다른 목적지에 적용한 것).
//
// 서버가 실제로 보내는 `status` 값은 `"ran"`/`"skipped"`/`"fallback"`
// 셋뿐이다(`agent_runtime.knowledge_router.RouteStatus`) — "ran"만 실제로
// LLM이 골랐다는 뜻이고, 나머지 둘은 절대 선택처럼 보이면 안 된다(요구사항:
// "Never let a fallback look like a successful selection"). `_search_all`
// (서버 쪽)이 skip/fallback일 때 모든 항목에 정확히 같은 한국어 reason
// 문장을 붙이므로, 아래 그룹핑은 그 경우 자연히 "공유 사유 한 번"으로
// 접힌다 — `groupExcludedKnowledgeByReason`이 이미 세운 반복 설명 정리
// 규칙(2026-08-14)을 여기서도 그대로 따른다: 같은 말을 여러 번 하지 않고,
// 무엇이 왜 선택/제외됐는지는 항상 어딘가에 남는다(숨기지 않는다).

/** SSE `"knowledge.route.selected"`의 실제 payload — 서버 필드 이름 그대로
 * (`workflow.py`가 `route_result`를 이 모양으로 직렬화한다). */
export interface KnowledgeRouteEventData {
  status: "ran" | "skipped" | "fallback";
  fallback_reason: string | null;
  selected: Array<{ knowledge_id: string; reason: string }>;
  excluded: Array<{ knowledge_id: string; reason: string }>;
}

export interface KnowledgeRouteDisplayItem {
  knowledgeId: string;
  /** `nameById`에 없으면(정상적으로는 발생하지 않는다 — 후보 목록과 라우팅
   * 결과는 같은 Run 안에서 나온다) id 자체를 그대로 보여준다. */
  name: string;
  /** null이면 이 항목의 사유가 상단 공유 문구(`sharedReason`)로 이미
   * 표시됐다는 뜻 — `groupExcludedKnowledgeByReason`과 동일한 규칙. */
  reason: string | null;
}

/** `groupExcludedKnowledgeByReason`과 동일한 반복 설명 정리 규칙을
 * `{knowledge_id, reason}` 목록에 적용한다(자산 객체 대신 id/이름만
 * 다룬다는 점만 다르다 — Knowledge 후보는 InstalledAsset이 아니라
 * agent-runtime이 돌려준 순수 id/reason 쌍이므로 그 함수를 그대로 재사용할
 * 수 없다). */
export function groupKnowledgeRouteChoicesByReason(
  choices: Array<{ knowledge_id: string; reason: string }>,
  nameById: Readonly<Record<string, string>>,
): { sharedReason: string | null; items: KnowledgeRouteDisplayItem[] } {
  if (choices.length === 0) return { sharedReason: null, items: [] };
  const firstReason = choices[0].reason;
  const allSameReason = choices.every((c) => c.reason === firstReason);
  return {
    sharedReason: allSameReason ? firstReason : null,
    items: choices.map((c) => ({
      knowledgeId: c.knowledge_id,
      name: nameById[c.knowledge_id] ?? c.knowledge_id,
      reason: allSameReason ? null : c.reason,
    })),
  };
}

export interface KnowledgeRouteDisplay {
  status: "ran" | "skipped" | "fallback";
  /** 사실 그대로의 한 줄 요약 — `status === "ran"`일 때만 실제 선택이
   * 일어났다고 말한다. */
  headline: string;
  selected: KnowledgeRouteDisplayItem[];
  excluded: KnowledgeRouteDisplayItem[];
  sharedSelectedReason: string | null;
  sharedExcludedReason: string | null;
}

/** `KnowledgeRouteEventData`를 화면에 그대로 뿌릴 수 있는 형태로 바꾼다 —
 * 세 `status`를 절대 섞어 말하지 않는다:
 * - `"ran"`: 실제로 자동 선택이 일어났다 — 선택/제외 각각 이유와 함께.
 * - `"skipped"`: 후보가 적어(threshold 이하) 선택 자체가 없었다 — "선택이
 *   이루어진 것은 아니다"를 명시한다(요구사항: skip을 선택처럼 보이지 않게).
 * - `"fallback"`: 자동 선택이 실패해 전체를 검색했다 — 실패 원인을
 *   사용자 언어로 설명한다(서버가 이미 만든 한국어 reason 문장을 그대로
 *   쓴다 — 원인 문구를 이 파일에서 또 만들지 않는다, 서버가 유일한 진실원). */
export function describeKnowledgeRoute(
  event: KnowledgeRouteEventData,
  nameById: Readonly<Record<string, string>>,
): KnowledgeRouteDisplay {
  const selectedGroup = groupKnowledgeRouteChoicesByReason(event.selected, nameById);
  const excludedGroup = groupKnowledgeRouteChoicesByReason(event.excluded, nameById);

  let headline: string;
  if (event.status === "ran") {
    headline = `관련 있는 지식 자산 ${event.selected.length}개를 자동으로 선택해 검색했습니다.`;
  } else if (event.status === "skipped") {
    headline = `설치된 Knowledge가 적어(${event.selected.length}개) 자동 선택 없이 전체를 검색했습니다 — 선택이 이루어진 것은 아닙니다.`;
  } else {
    headline = `자동 선택에 실패해 전체 지식 자산 ${event.selected.length}개를 대신 검색했습니다.`;
  }

  return {
    status: event.status,
    headline,
    selected: selectedGroup.items,
    excluded: excludedGroup.items,
    sharedSelectedReason: selectedGroup.sharedReason,
    sharedExcludedReason: excludedGroup.sharedReason,
  };
}

// --- D06 대화: TOOL_ROUTE 표시(D-083, agentic MCP Tool 선택) -----------------
// 배경: agent-runtime의 TOOL_ROUTE 단계는 사용자가 이번 턴에서
// `tool_route: true`를 명시적으로 보내고(opt-in, 기본 꺼짐), 명시적
// `mcp_tool_request`가 없을 때만 실행된다 — 이번 턴 질문과 후보 Tool의
// 이름/입력 Schema만으로 어떤 Tool을 호출할지(또는 호출하지 않을지)
// LLM 한 번으로 "제안"한다. Fail-closed: 실패/거절/스키마 불일치는 전부
// "아무 Tool도 호출하지 않음"으로 귀결된다(services/agent-runtime/src/
// agent_runtime/tool_router.py). 이 파일은 그 판단을 화면에 정직하게
// 옮기는 순수 함수만 둔다 — "아무 일도 없었다"(라우팅이 아무것도 고르지
// 않음, `status: "no_tool"`)와 "무언가 제안됐지만 실행 전에 막혔다"
// (`mcp.tool_route.rejected`)가 화면에서 절대 같아 보이면 안 된다(요구
// 사항).

/** SSE `"mcp.tool_route.selected"`의 실제 payload — 서버 필드 이름 그대로
 * (`workflow.py`가 `tool_route_result`를 이 모양으로 직렬화한다). `reason`은
 * 서버 내부 코드(`"declined_by_model"`/`"unparseable"`/`"unknown_tool_name"`/
 * `"error_or_timeout"`/`"no_candidate_tools"`/
 * `"candidate_count_at_or_below_threshold"`)이지 한국어 문장이 아니다 —
 * `knowledge.route.selected`의 `fallback_reason`과 같은 성격(영문 코드).
 * 이 파일은 이 코드를 화면에 그대로 찍지 않고, `status`만으로 뜻을 옮긴
 * 한국어 문장을 만든다(아래 `describeToolRouteSelected`). */
export interface ToolRouteSelectedEventData {
  status: "ran" | "skipped" | "no_tool";
  reason: string | null;
  tool_name: string | null;
}

/** SSE `"mcp.tool_route.rejected"`의 실제 payload — TOOL_ROUTE가 제안한
 * (`status: "ran"`) Tool 호출이 그 다음 단계의 스키마 검증 체크포인트에서
 * 거절된 경우에만 발생한다(`tool_router.py`의 one-shot 규칙: 재시도하지
 * 않고 Tool 없이 진행). `code`는 `"MCP_TOOL_NOT_FOUND"` 또는
 * `"MCP_INPUT_INVALID"` 둘뿐이다(workflow.py의
 * `_TOOL_ROUTE_PREFLIGHT_REJECTION_CODES`). 이 이벤트에는 서버가 만든
 * 한국어 message가 없다(`_fail()`의 message는 이 경로에서 절대 전송되지
 * 않는다) — 아래 `TOOL_ROUTE_REJECTED_MESSAGE`가 code별로 이 화면이 보여줄
 * 문장을 정의한다. */
export interface ToolRouteRejectedEventData {
  tool_name: string | null;
  code: string;
}

export type ToolRouteStatus = "ran" | "skipped" | "no_tool" | "rejected";

export interface ToolRouteDisplay {
  status: ToolRouteStatus;
  /** 사실 그대로의 한 줄 요약. `"no_tool"`은 실패가 아니라 설계된 정상
   * 동작이라는 점을 분명히 한다(요구사항: 재시도를 유도하지 않는다). */
  headline: string;
  toolName: string | null;
}

/** `mcp.tool_route.rejected`의 `code`별 화면 문구 — 서버의 `_fail()` 경로가
 * 같은 code에 쓰는 문구(workflow.py 381/385/389행)와 뜻을 맞췄다(그 경로는
 * 명시적 `mcp_tool_request`가 잘못됐을 때이고, 이 경로는 AI가 제안한 값이
 * 잘못됐을 때라는 차이만 있다 — 그래서 "AI가 제안한"을 앞에 붙인다). 알 수
 * 없는 code가 오면(서버가 새 code를 추가한 경우) 추측해 문구를 만들지 않고
 * code를 그대로 보여준다(fail closed: 모르는 것을 아는 것처럼 말하지
 * 않는다). */
const TOOL_ROUTE_REJECTED_MESSAGE: Record<string, string> = {
  MCP_TOOL_NOT_FOUND: "AI가 제안한 Tool을 찾을 수 없어 실행하지 않았습니다.",
  MCP_INPUT_INVALID: "AI가 제안한 입력값이 Tool의 입력 형식과 맞지 않아 실행하지 않았습니다.",
};

/** `TOOL_ROUTE`가 실제로 무엇을 결정했는지를 화면 문구로 바꾼다. 세 상태를
 * 절대 섞어 말하지 않는다:
 * - `"ran"`: Tool 하나가 실제로 제안됐다 — 이어서 확인 Panel(승인 필요)이
 *   뜨거나, 정책상 확인 없이 곧바로 실행된다(그 다음 이벤트들이 결정).
 * - `"skipped"`: 후보 Tool이 없어 LLM을 부르지도 않았다 — 선택이 아니라
 *   "고를 것이 없었다"이다.
 * - `"no_tool"`: LLM이 실제로 판단해 이번 질문에는 Tool이 필요 없다고
 *   답했다 — 이것이 가장 흔하고 정상적인 결과이며 오류가 아니다(요구사항:
 *   fail-closed가 고장으로 읽히면 안 된다). */
export function describeToolRouteSelected(event: ToolRouteSelectedEventData): ToolRouteDisplay {
  if (event.status === "ran" && event.tool_name) {
    return {
      status: "ran",
      headline: `AI가 이번 질문에 맞는 Tool로 '${event.tool_name}'을(를) 제안했습니다.`,
      toolName: event.tool_name,
    };
  }
  if (event.status === "skipped") {
    return {
      status: "skipped",
      headline: "호출할 수 있는 Tool 후보가 없어 자동 선택을 건너뛰었습니다.",
      toolName: null,
    };
  }
  return {
    status: "no_tool",
    headline: "이번 질문에는 Tool 호출이 필요하지 않다고 판단해 아무 Tool도 선택하지 않았습니다.",
    toolName: null,
  };
}

/** `"ran"`으로 제안된 Tool 호출이 스키마 검증을 통과하지 못해 실제로는
 * 실행되지 않은 경우 — 위 `describeToolRouteSelected("ran")` 결과를
 * 대체한다. 실패가 아니라 안전장치가 정상 동작한 것이므로("아무 Tool도
 * 호출하지 않는다"는 결과 자체는 `"no_tool"`과 동일), 재시도를 유도하는
 * 문구를 넣지 않는다 — 서버가 이 제안을 다시 시도하지 않기 때문이다
 * (tool_router.py one-shot 규칙). */
export function describeToolRouteRejected(event: ToolRouteRejectedEventData): ToolRouteDisplay {
  return {
    status: "rejected",
    headline: TOOL_ROUTE_REJECTED_MESSAGE[event.code] ?? `AI가 제안한 Tool 호출이 거부되어(${event.code}) 실행하지 않았습니다.`,
    toolName: event.tool_name,
  };
}

// --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) ------------------------------

/** Builds the `history` sent to agent-runtime (`input.history`, additive/
 * optional — 04-knowledge-platform.md §3.4) from this screen's in-memory
 * turns. Only turns with status "succeeded" AND non-empty answer text count
 * as usable conversational context — a failed/cancelled/insufficient-
 * evidence turn has no real answer a follow-up could sensibly build on, and
 * including it would only add noise (or, worse, an explicit "근거를 찾지
 * 못했습니다" line) to what the model sees as prior context. Growth is
 * bounded server-side regardless of how many turns are sent (agent-runtime's
 * `AgentRuntimeSettings.max_history_turns`/`max_history_chars`) — this
 * function deliberately does not also cap it client-side, to keep the
 * bounding policy in exactly one place.
 */
export function buildHistoryFromMessages(messages: ChatMessage[]): ConversationTurnInput[] {
  return messages
    .filter((m) => m.status === "succeeded" && m.answer.trim().length > 0)
    .map((m) => ({ question: m.question, answer: m.answer }));
}

/** Pure TS mirror of agent-runtime's `build_hub_query`
 * (services/agent-runtime/src/agent_runtime/hub_query.py) — powers the
 * consent-preview UI (허브로 전송될 질의 미리보기) so the user can see exactly
 * what would be sent to the hub BEFORE it goes, matching the after-the-fact
 * `"hub.query_sent"` SSE event's guarantee byte-for-byte.
 *
 * SECURITY (product requirement — "로컬에서 조회하는 데이터를 허브에 넘기면
 * 안 돼"): reads only every prior turn's `.question` text, NEVER `.answer` —
 * an answer may echo back local document content Stage 1 search retrieved,
 * which must never reach the hub. This is the same exclusion
 * `build_hub_query` enforces server-side; both sides must never drift. */
export function buildHubQueryPreview(question: string, messages: ChatMessage[]): string {
  const priorQuestions = messages.map((m) => m.question.trim()).filter((q) => q.length > 0);
  const draft = question.trim();
  const parts = draft.length > 0 ? [...priorQuestions, draft] : priorQuestions;
  return parts.join("\n");
}

/** Reconstructs a read-only, terminal `ChatMessage` from a persisted
 * conversation turn (`ConversationStore`'s on-disk shape) — used to restore
 * a saved conversation into this screen's `messages` state on selection.
 * Deliberately minimal: citations/eventLog/stages are NOT persisted (see
 * `conversation-store.ts`'s module docstring for why — only question+answer
 * text is kept), so a restored turn shows its answer text but not its
 * original citation list or step timeline; `citationCount` is shown as a
 * plain count instead. `knowledgeIdUsed`/`agentProfile` are filled from the
 * conversation's own record, since a restored turn is never re-sent as-is. */
const RESTORED_STAGES: StageMap = {
  ready: { state: "done" },
  analyze: { state: "done" },
  knowledge_search: { state: "done" },
  tool_call: { state: "skipped" },
  answer_generate: { state: "done" },
};

export function chatMessageFromStoredTurn(
  turn: ConversationRecord["turns"][number],
  conversation: Pick<ConversationRecord, "knowledgeId" | "knowledgeLabel">,
): ChatMessage {
  return {
    id: turn.id,
    question: turn.question,
    knowledgeIdUsed: conversation.knowledgeId,
    knowledgeLabelUsed: conversation.knowledgeLabel,
    serviceId: "",
    agentProfile: "standard-agent",
    // 복원된 턴은 어떤 Local Agent가 실제로 답했는지 저장되어 있지 않다
    // (conversation-store.ts는 question/answer 텍스트만 보존한다) — 지어내지
    // 않고 "모름"이 아니라 표준 Agent였다고 정직하게 표시한다(복원 이전
    // 데이터는 전부 D-034 이전이므로 실제로도 표준 Agent였다).
    localAgentIdUsed: null,
    localAgentLabelUsed: null,
    status: turn.status,
    answer: turn.answer,
    citations: [],
    stages: RESTORED_STAGES,
    eventLog: [],
    pendingConfirmation: null,
    runId: null,
    traceId: null,
    startedAt: turn.createdAt,
    completedAt: turn.createdAt,
    serverRun: null,
    restored: true,
    restoredCitationCount: turn.citationCount,
    hubQueriesSent: [],
    knowledgeCandidateNameById: {},
    knowledgeRoute: null,
    toolRoute: null,
    mcpToolCallUsed: null,
    // 저장된 그대로 복원한다 — 이 필드가 없는 과거 대화 파일은
    // `conversation-store.ts`의 `readAll()`이 이미 빈 배열로 정규화해
    // 넘겨주므로 여기서 다시 `?? []`할 필요가 없다(정규화는 한 곳에서만).
    toolExecutions: turn.toolExecutions,
  };
}

/** 라이브 턴이 실제로 수행한 Tool 실행을 저장용 레코드로 만든다 —
 * `persistTurn`(ChatScreen.tsx)이 턴이 터미널 상태가 된 시점에 호출한다.
 * "실행되지 않음"(아무 Tool도 선택되지 않음/거절됨)은 기록하지 않는다 —
 * 실행 사실이 없으므로 남길 기록도 없다(빈 배열을 그대로 반환).
 *  - TOOL_ROUTE(`toolRoute`)는 `status === "ran"`일 때만 기록한다 —
 *    `"skipped"`/`"no_tool"`은 애초에 아무것도 고르지 않았고, `"rejected"`는
 *    고른 것이 스키마 검증에서 막혀 실제로는 실행되지 않았다. 서버 계약이
 *    호출 인자를 렌더러에 넘기지 않으므로(`ToolRouteSelectedEventData`에
 *    `tool_name`만 있다) `args`는 `null`이다 — 모르는 것을 지어내지 않는다.
 *  - 명시적 MCP Tool 호출(`mcpToolCallUsed`)은 턴이 취소된 경우를 제외하고
 *    항상 기록한다(성공/실패 모두 "무슨 일이 있었는지"가 유용한 사실이다).
 *    거절/취소는 별도 결과 표현이 없어 상태의 errorMessage를 그대로 쓴다. */
export function buildToolExecutionsForPersist(m: ChatMessage): ToolExecutionRecord[] {
  const records: ToolExecutionRecord[] = [];
  if (m.toolRoute?.status === "ran" && m.toolRoute.toolName) {
    records.push({
      toolName: m.toolRoute.toolName,
      args: null,
      resultSummary: m.status === "succeeded" || m.status === "insufficient_evidence" ? m.toolRoute.headline : null,
      failureReason: m.status === "failed" ? (m.errorMessage ?? m.toolRoute.headline) : null,
      route: "ai_auto_selected",
    });
  }
  if (m.mcpToolCallUsed && m.status !== "cancelled") {
    const succeeded = m.status === "succeeded" || m.status === "insufficient_evidence";
    records.push({
      toolName: m.mcpToolCallUsed.toolName,
      args: m.mcpToolCallUsed.args,
      resultSummary: succeeded
        ? `Citation ${m.citations.length}건을 포함해 응답이 완료됨`
        : null,
      failureReason: succeeded ? null : (m.errorMessage ?? "Tool 호출이 실패했습니다."),
      route: "mcp_tool",
    });
  }
  return records;
}

export function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const seen = new Set(existing.map((c) => c.chunk_id));
  const extra = incoming.filter((c) => !seen.has(c.chunk_id));
  return [...existing, ...extra];
}

/** D06 "경고" — a citation whose vector similarity (D-046) is present but
 * below the mid-confidence line, or absent entirely (a BM25-only match with
 * relevance filtering off). Derived only from data the search already
 * returned — not a fabricated confidence score. */
export function hasLowConfidenceCitation(citations: Citation[]): boolean {
  return citations.some((c) => c.similarity !== null && c.similarity < 0.5);
}

export function buildMarkdown(message: ChatMessage): string {
  const lines: string[] = [];
  lines.push(`# 질문`, "", message.question, "");
  lines.push(`# 답변`, "", message.answer || "_(답변 없음)_", "");
  if (message.citations.length > 0) {
    lines.push(`# 출처`, "");
    message.citations.forEach((c, idx) => {
      const title = c.document_title || c.document_path || "제목 없음";
      const section = c.section ? ` · ${c.section}` : "";
      lines.push(`${idx + 1}. ${title}${section}`);
      if (c.excerpt) lines.push(`   > ${c.excerpt.replace(/\n/g, " ")}`);
    });
    lines.push("");
  }
  lines.push(`---`, `Run ID: ${message.runId ?? "미기재"}`, `Trace ID: ${message.traceId ?? "미기재"}`);
  return lines.join("\n");
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
