// D06 대화 — 입력창 "+" 메뉴의 순수 로직.
//
// 왜 메뉴가 됐나: 켤 수 있는 것이 늘면서(지식·허브·Tool 자동·MCP 범위·
// 프롬프트·로컬 Tool) 입력창 아래가 버튼 줄로 가득 찼다. 메뉴로 접되 **지금
// 무엇이 켜져 있는지는 접지 않는다** — 켜진 것은 입력창에 칩으로 남는다.
// 접어서 안 보이게 되면 사용자는 켠 줄 모르는 상태로 질문을 보내게 되고,
// 그것이 이 화면에서 가장 비싼 실수다(허브 전송 동의처럼 의미가 큰 것도 이
// 줄에 있다).
//
// 항목이 "왜 비활성인가"는 전부 여기서 정한다 — 화면이 아니라 이 함수가
// 판단해야 vitest(`environment: "node"`)로 고정할 수 있다. 루트 CLAUDE.md UI
// 규칙: 호환되지 않는 선택지는 **이유와 함께** 비활성화한다.

export type ComposerMenuItemKey =
  | "knowledge"
  | "hub"
  | "toolAuto"
  | "mcp"
  | "prompt"
  | "localTool";

export interface ComposerMenuState {
  /** 실행 중이면 무엇도 바꿀 수 없다(이번 턴의 설정은 이미 전송됐다). */
  running: boolean;
  knowledge: {
    on: boolean;
    /** 검색에 실제로 쓸 수 있는 Knowledge 가 하나라도 있는가. */
    usable: boolean;
    /** 아직 설치 목록을 읽는 중인가(= "없다"고 말하면 안 되는 상태). */
    loading: boolean;
    count: number;
  };
  hub: { on: boolean; applicable: boolean };
  toolAuto: { on: boolean; hasCandidates: boolean; applicable: boolean; blockedReason: string | null };
  mcp: { badge: string | null; selectable: boolean; blockedReason: string | null };
  /** Desktop 런타임이 있어야 쓸 수 있는 둘(설치된 자산/로컬 파일에 닿는다). */
  prompt: { available: boolean };
  localTool: { available: boolean };
}

export interface MenuItemAvailability {
  /** 후보가 아예 없어 항목 자체를 그리지 않는 경우(빈 목록을 보여 주는 대신). */
  hidden: boolean;
  disabled: boolean;
  /** 비활성일 때만 채운다 — 정상 상태에 안내 문구를 만들지 않는다. */
  reason: string | null;
}

const RUNNING_REASON = "실행이 끝난 뒤에 바꿀 수 있습니다.";
const DESKTOP_ONLY_REASON = "Desktop 앱에서만 사용할 수 있습니다.";

export function itemAvailability(
  key: ComposerMenuItemKey,
  state: ComposerMenuState,
): MenuItemAvailability {
  if (state.running) return { hidden: false, disabled: true, reason: RUNNING_REASON };

  switch (key) {
    case "knowledge":
      if (state.knowledge.usable) return { hidden: false, disabled: false, reason: null };
      return {
        hidden: false,
        disabled: true,
        reason: state.knowledge.loading
          ? "보유 Knowledge를 확인하는 중입니다."
          : "검색 가능한 Knowledge가 없습니다.",
      };
    case "hub":
      return state.hub.applicable
        ? { hidden: false, disabled: false, reason: null }
        : {
            hidden: false,
            disabled: true,
            reason: "보유 Knowledge에서 찾기를 먼저 켜야 사용할 수 있습니다.",
          };
    case "toolAuto":
      // 후보가 하나도 없으면 항목을 그리지 않는다 — 켤 수 없는 스위치를
      // 보여 주는 것보다 없는 편이 낫다(기존 토글과 같은 규칙).
      if (!state.toolAuto.hasCandidates) return { hidden: true, disabled: true, reason: null };
      return state.toolAuto.applicable
        ? { hidden: false, disabled: false, reason: null }
        : { hidden: false, disabled: true, reason: state.toolAuto.blockedReason };
    case "mcp":
      return state.mcp.selectable
        ? { hidden: false, disabled: false, reason: null }
        : { hidden: false, disabled: true, reason: state.mcp.blockedReason };
    case "prompt":
      return state.prompt.available
        ? { hidden: false, disabled: false, reason: null }
        : { hidden: false, disabled: true, reason: DESKTOP_ONLY_REASON };
    case "localTool":
      return state.localTool.available
        ? { hidden: false, disabled: false, reason: null }
        : { hidden: false, disabled: true, reason: DESKTOP_ONLY_REASON };
  }
}

export interface ComposerChip {
  /** 칩을 끌 때 어느 상태를 되돌릴지 — 호출자가 이 키로 핸들러를 고른다. */
  key: ComposerMenuItemKey;
  label: string;
}

/** 입력창에 상시 보이는 "지금 켜진 것" 목록.
 *
 * 프롬프트/로컬 Tool 은 칩이 없다 — 켜 두는 상태가 아니라 그 자리에서 끝나는
 * 행동이기 때문이다(프롬프트는 입력창 텍스트가 곧 결과이고, 로컬 Tool 실행은
 * 대화에 카드로 남는다). */
export function buildActiveChips(state: ComposerMenuState): ComposerChip[] {
  const chips: ComposerChip[] = [];
  if (state.knowledge.on) {
    chips.push({
      key: "knowledge",
      label: state.knowledge.count > 0 ? `지식 ${state.knowledge.count}개` : "지식",
    });
  }
  if (state.hub.on) chips.push({ key: "hub", label: "허브 검색" });
  if (state.toolAuto.on && state.toolAuto.hasCandidates) {
    chips.push({ key: "toolAuto", label: "Tool 자동" });
  }
  if (state.mcp.badge) chips.push({ key: "mcp", label: `MCP · ${state.mcp.badge}` });
  return chips;
}
