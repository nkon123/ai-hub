// D06 대화 — "MCP 도구" 버튼: 이번 대화에서 AI 가 고를 수 있는 Tool 범위를 정한다.
//
// 프롬프트 버튼(`PromptPickerPanel.tsx`)과 같은 자리·같은 모양이지만 성격이
// 다르다: 저쪽은 입력창 텍스트를 바꾸고, 이쪽은 **런타임 후보 범위**를 바꾼다.
//
// 이 화면이 정하는 것은 범위뿐이다. 실제로 어느 Tool 을 부를지(또는 아무것도
// 부르지 않을지)는 agent-runtime 의 TOOL_ROUTE 가 질문을 보고 정하고, 실행
// 승인은 그 뒤 PEP(확인 정책)가 정한다 — "고르면 반드시 실행"이 아니다. 화면
// 문구도 그렇게 말한다("… 중에서 AI가 고릅니다"), 그러지 않으면 질문과 무관한
// 도구가 왜 안 돌았는지 사용자가 영영 알 수 없다.
//
// 목록은 agent-runtime 에 **실제로 등록된 서버**(`GET /local/v1/mcp-servers`)다.
// 설치만 하고 등록되지 않은 것은 여기 없고, 등록됐지만 `ACTIVE` 가 아닌 것은
// 이유와 함께 비활성으로 보여 준다(부를 수 없는 것을 고르게 하지 않는다 —
// 루트 CLAUDE.md UI 규칙).

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, Wrench } from "lucide-react";
import { Button, ErrorBanner, LoadingState, Modal } from "../ui";
import { listMcpServers } from "../agentRuntime";
import {
  SCOPE_AUTO,
  SCOPE_OFF,
  describeScope,
  isServerSelectable,
  isToolSelected,
  optionFromEntry,
  serverSelectionState,
  toggleServer,
  toggleTool,
  type McpServerOption,
  type McpToolScope,
} from "./mcpToolScopeTypes";
import { describeServerStatus, type McpServerEntry } from "./mcpServersTypes";

export function McpToolPickerPanel({
  scope,
  onScopeChange,
  disabled,
  disabledReason,
  badge,
  onServersLoaded,
}: {
  scope: McpToolScope;
  onScopeChange: (next: McpToolScope) => void;
  disabled?: boolean;
  /** 비활성 사유 — 왜 못 쓰는지 버튼 title 로 그대로 보여 준다. */
  disabledReason?: string | null;
  /** 버튼에 붙는 짧은 표시(`describeScopeBadge` 결과). */
  badge: string | null;
  /** 부모(ChatScreen)가 같은 목록으로 표시 문구를 만들 수 있게 올려 준다. */
  onServersLoaded: (servers: McpServerOption[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // entry 를 그대로 들고 있는다 — 선택 로직은 `optionFromEntry` 로 옮긴
  // 모델을 쓰고, 상태 표시는 `describeServerStatus`(기존 화면과 같은 문구)를
  // 그대로 쓴다.
  const [entries, setEntries] = useState<McpServerEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);

  const load = useCallback(async () => {
    setEntries(null);
    setLoadError(null);
    try {
      const response = await listMcpServers();
      setEntries(response.entries);
      onServersLoaded(response.entries.map(optionFromEntry));
    } catch (err) {
      // 오류를 삼키면 "등록된 서버가 없다"와 "runtime 에 못 붙었다"가 같은
      // 화면이 된다 — 전자는 설치하면 되고 후자는 서비스를 띄워야 한다.
      setLoadError(
        err instanceof Error ? err.message : "등록된 MCP 서버 목록을 불러오지 못했습니다.",
      );
      setEntries([]);
    }
  }, [onServersLoaded]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const servers: McpServerOption[] | null = entries === null ? null : entries.map(optionFromEntry);
  const usable = (servers ?? []).filter(isServerSelectable);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={
          disabled
            ? (disabledReason ?? "지금은 사용할 수 없습니다.")
            : "이번 대화에서 AI가 고를 수 있는 MCP 도구 범위를 정합니다."
        }
        aria-label="MCP 도구 고르기"
        className={`flex h-8 items-center justify-center gap-1.5 rounded-full border px-2.5 text-caption font-medium transition-colors disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-muted ${
          badge
            ? "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"
            : "border-transparent bg-slate-100 text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        }`}
      >
        <Wrench size={15} aria-hidden="true" />
        MCP 도구
        {badge && <span className="rounded-full bg-white/70 px-1.5 text-[11px]">{badge}</span>}
      </button>

      <Modal open={open} title="MCP 도구 고르기" onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <p className="text-caption text-text-secondary">
            여기서 정하는 것은 <strong>후보 범위</strong>입니다. 그 안에서 이번 질문에 맞는 도구를
            쓸지, 어느 것을 쓸지는 AI가 정하고 실행 전 승인 절차는 그대로 거칩니다.
          </p>

          {servers === null && !loadError && <LoadingState label="등록된 MCP 서버를 불러오는 중..." />}
          {loadError && <ErrorBanner message={loadError} />}

          {servers !== null && (
            <>
              {/* 첫 줄 — 자동 선택 */}
              <button
                type="button"
                onClick={() => onScopeChange(scope.kind === "auto" ? SCOPE_OFF : SCOPE_AUTO)}
                disabled={usable.length === 0}
                className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  scope.kind === "auto"
                    ? "border-brand-400 bg-brand-50"
                    : "border-border hover:border-brand-300 hover:bg-brand-50"
                }`}
              >
                <Sparkles size={15} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
                <span>
                  <span className="block text-body font-semibold text-text-primary">
                    자동 선택 — 연결된 도구 전체에서 AI가 고릅니다
                  </span>
                  <span className="block text-caption text-text-secondary">
                    {usable.length === 0
                      ? "쓸 수 있는 MCP 서버가 없습니다."
                      : `서버 ${usable.length}개 · 도구 ${usable.reduce((n, s) => n + s.toolNames.length, 0)}개`}
                  </span>
                </span>
              </button>

              {servers.length === 0 && !loadError && (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-caption text-text-secondary">
                  <p>등록된 MCP 서버가 없습니다.</p>
                  <p className="mt-1 text-text-muted">
                    자산 허브 &gt; MCP 서버에서 설치한 서버를 활성화하면 여기에 나타납니다.
                  </p>
                </div>
              )}

              {servers.length > 0 && (
                <ul className="space-y-1.5">
                  {(entries ?? []).map((entry) => {
                    const server = optionFromEntry(entry);
                    const status = describeServerStatus(entry);
                    const selectable = isServerSelectable(server);
                    const selection = serverSelectionState(scope, server);
                    const isOpen = expanded.includes(server.serverAlias);
                    return (
                      <li
                        key={server.serverAlias}
                        className={`rounded-lg border ${
                          selection === "none" ? "border-border" : "border-brand-300 bg-brand-50/40"
                        }`}
                      >
                        <div className="flex items-center gap-1 px-2 py-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setExpanded((prev) =>
                                isOpen
                                  ? prev.filter((alias) => alias !== server.serverAlias)
                                  : [...prev, server.serverAlias],
                              )
                            }
                            aria-label={isOpen ? "도구 접기" : "도구 펼치기"}
                            aria-expanded={isOpen}
                            className="rounded p-1 text-text-muted hover:bg-slate-100 hover:text-text-primary"
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => onScopeChange(toggleServer(scope, server))}
                            disabled={!selectable}
                            title={
                              selectable
                                ? "이 서버의 도구 전체를 후보로 둡니다."
                                : `${status.label} — 지금은 고를 수 없습니다.${status.guidance ? ` ${status.guidance}` : ""}`
                            }
                            className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <span className="flex items-center gap-1.5 text-body font-semibold text-text-primary">
                              {server.serverAlias}
                              {selection === "all" && (
                                <span className="rounded-full bg-brand-100 px-1.5 text-[11px] font-medium text-brand-700">
                                  전체
                                </span>
                              )}
                              {selection === "partial" && (
                                <span className="rounded-full bg-brand-100 px-1.5 text-[11px] font-medium text-brand-700">
                                  일부
                                </span>
                              )}
                            </span>
                            <span className="block text-caption text-text-secondary">
                              도구 {server.toolNames.length}개
                              {!selectable && ` · ${status.label}`}
                            </span>
                          </button>
                        </div>

                        {isOpen && (
                          <ul className="space-y-0.5 border-t border-border/60 px-3 py-1.5">
                            {server.toolNames.length === 0 && (
                              <li className="text-caption text-text-muted">선언된 도구가 없습니다.</li>
                            )}
                            {server.toolNames.map((toolName) => (
                              <li key={toolName}>
                                <label
                                  className={`flex items-center gap-2 py-0.5 text-caption ${
                                    selectable ? "text-text-primary" : "text-text-muted"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isToolSelected(scope, toolName)}
                                    disabled={!selectable}
                                    onChange={() => onScopeChange(toggleTool(scope, toolName))}
                                  />
                                  <span className="truncate">{toolName}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="rounded-lg bg-background px-3 py-2 text-caption text-text-secondary">
                {describeScope(scope, servers)}
              </p>
            </>
          )}

          <div className="flex justify-between gap-2">
            <Button
              variant="secondary"
              onClick={() => onScopeChange(SCOPE_OFF)}
              disabled={scope.kind === "off"}
            >
              선택 해제
            </Button>
            <Button onClick={() => setOpen(false)}>확인</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
