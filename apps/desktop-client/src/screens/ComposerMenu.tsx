// D06 대화 — 입력창의 "+" 메뉴.
//
// 켤 수 있는 것이 늘면서 입력창 아래가 버튼 줄로 가득 찼다(실사용 제보
// 2026-09-18: "메뉴가 많아져서 보기가 힘들다"). 하나로 접되 분류해서 연다:
// 지식 / 프롬프트 / 도구(Tool 자동·MCP·로컬) / 검색(허브).
//
// **켜진 것은 접지 않는다.** 메뉴 옆 칩(`buildActiveChips`)이 상시로 보여
// 준다 — 접어서 안 보이면 켠 줄 모르는 채로 질문을 보내게 되고, 이 줄에는
// 허브 전송 동의처럼 의미가 큰 것도 있다.
//
// 이 컴포넌트는 상태를 갖지 않는다(열림 여부만). 무엇이 비활성이고 왜인지는
// `composerMenuTypes.itemAvailability` 가 정하고, 이 파일은 그리기만 한다 —
// 이 저장소에는 렌더링 테스트가 없어서(vitest `environment: "node"`) 판단을
// 화면에 두면 아무도 고정할 수 없다.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenCheck, FileText, Globe2, Plus, Server, Sparkles, Terminal } from "lucide-react";
import {
  itemAvailability,
  type ComposerMenuItemKey,
  type ComposerMenuState,
} from "./composerMenuTypes";

function MenuRow({
  icon,
  label,
  description,
  detail,
  disabled,
  reason,
  checked,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  /** 오른쪽 끝에 붙는 현재 값(예: 선택된 MCP 범위). */
  detail?: string | null;
  disabled: boolean;
  reason: string | null;
  /** 토글 항목이면 현재 상태, 여는 항목(대화상자)이면 `undefined`. */
  checked?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      title={reason ?? undefined}
      aria-checked={checked}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
    >
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-body font-medium text-text-primary">{label}</span>
          {checked && (
            <span className="rounded-full bg-brand-100 px-1.5 text-[11px] font-medium text-brand-700">
              켜짐
            </span>
          )}
        </span>
        {(reason ?? description) && (
          <span className="block text-caption text-text-secondary">{reason ?? description}</span>
        )}
      </span>
      {detail && <span className="shrink-0 text-caption text-text-muted">{detail}</span>}
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-2 pb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </p>
  );
}

export function ComposerMenu({
  state,
  onToggleKnowledge,
  onToggleHub,
  onToggleToolAuto,
  onOpenPrompt,
  onOpenMcp,
  onOpenLocalTool,
  /** 도구 > MCP 행에 보여줄 현재 범위(없으면 "선택 안 함"). */
  mcpDetail,
  toolAutoDetail,
  knowledgeDetail,
}: {
  state: ComposerMenuState;
  onToggleKnowledge: (next: boolean) => void;
  onToggleHub: (next: boolean) => void;
  onToggleToolAuto: (next: boolean) => void;
  onOpenPrompt: () => void;
  onOpenMcp: () => void;
  onOpenLocalTool: () => void;
  mcpDetail?: string | null;
  toolAutoDetail?: string | null;
  knowledgeDetail?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 바깥을 누르거나 Esc 로 닫는다. 메뉴가 열린 채 대화상자가 뜨면 두 겹이
  // 겹치므로, 항목을 고르는 즉시 닫는다(아래 `choose`).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const availability = (key: ComposerMenuItemKey) => itemAvailability(key, state);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  const toolAuto = availability("toolAuto");

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="대화에 사용할 것 고르기"
        title="지식·프롬프트·도구·허브 검색을 고릅니다."
        className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 ${
          open
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-transparent bg-slate-100 text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        }`}
      >
        <Plus size={16} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="대화에 사용할 것"
          className="absolute bottom-10 left-0 z-40 w-80 rounded-card border border-border bg-surface p-1.5 shadow-xl"
        >
          <SectionLabel>지식</SectionLabel>
          <MenuRow
            icon={<BookOpenCheck size={15} aria-hidden="true" />}
            label="보유 Knowledge에서 찾기"
            description="사내 지식에 근거한 답변이 필요할 때 켭니다."
            detail={knowledgeDetail}
            checked={state.knowledge.on}
            disabled={availability("knowledge").disabled}
            reason={availability("knowledge").reason}
            onSelect={() => choose(() => onToggleKnowledge(!state.knowledge.on))}
          />

          <SectionLabel>프롬프트</SectionLabel>
          <MenuRow
            icon={<FileText size={15} aria-hidden="true" />}
            label="허브 프롬프트 고르기"
            description="받은 프롬프트 본문을 입력창에 넣습니다."
            disabled={availability("prompt").disabled}
            reason={availability("prompt").reason}
            onSelect={() => choose(onOpenPrompt)}
          />

          <SectionLabel>도구</SectionLabel>
          {!toolAuto.hidden && (
            <MenuRow
              icon={<Sparkles size={15} aria-hidden="true" />}
              label="필요하면 Tool 자동 선택"
              description="이 질문에 맞는 Tool을 AI가 후보 중에서 고릅니다."
              detail={toolAutoDetail}
              checked={state.toolAuto.on}
              disabled={toolAuto.disabled}
              reason={toolAuto.reason}
              onSelect={() => choose(() => onToggleToolAuto(!state.toolAuto.on))}
            />
          )}
          <MenuRow
            icon={<Server size={15} aria-hidden="true" />}
            label="MCP 서버·도구 고르기"
            description="서버 전체 또는 필요한 도구만 후보로 둡니다."
            detail={mcpDetail ?? "선택 안 함"}
            disabled={availability("mcp").disabled}
            reason={availability("mcp").reason}
            onSelect={() => choose(onOpenMcp)}
          />
          <MenuRow
            icon={<Terminal size={15} aria-hidden="true" />}
            label="로컬 Tool 실행"
            description="내 PC에 등록해 둔 Python Tool을 직접 고릅니다."
            disabled={availability("localTool").disabled}
            reason={availability("localTool").reason}
            onSelect={() => choose(onOpenLocalTool)}
          />

          <SectionLabel>검색(허브)</SectionLabel>
          <MenuRow
            icon={<Globe2 size={15} aria-hidden="true" />}
            label="허브에도 물어보기"
            description="로컬에서 답을 못 찾은 경우에만 질문 텍스트를 허브로 보냅니다. 로컬 문서 내용은 전송되지 않습니다."
            checked={state.hub.on}
            disabled={availability("hub").disabled}
            reason={availability("hub").reason}
            onSelect={() => choose(() => onToggleHub(!state.hub.on))}
          />
        </div>
      )}
    </div>
  );
}

/** 입력창에 상시 보이는 칩 하나. 누르면 그 항목을 끈다. */
export function ComposerChipButton({
  label,
  onRemove,
  disabled,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      disabled={disabled}
      title={`${label} 끄기`}
      className="flex h-8 items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 text-caption font-medium text-brand-700 transition-colors hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
      <span aria-hidden="true" className="text-[13px] leading-none">
        ×
      </span>
    </button>
  );
}
