// D-094 "MCP 서버" — 설치된 MCP 서버의 연결 상태를 보고 해제한다.
//
// 이 화면이 판단하는 것은 없다. 상태 문구·조치 안내·정렬은 전부
// `mcpServersTypes.ts` 의 순수 함수가 만든다(vitest 가 `environment: "node"` 라
// 컴포넌트를 렌더링할 수 없어서, 판정이 JSX 안에 있으면 테스트할 수 없다).
//
// **등록 버튼이 없는 것은 의도다.** 등록은 자산을 설치할 때 일어난다 —
// 여기서 임의의 서버를 손으로 붙일 수 있게 하면 승인된 자산만 활성화된다는
// 전제가 무너진다. 이 화면은 "무엇이 연결됐고 무엇이 왜 안 됐는가"를 보여 주고
// 해제만 할 수 있다.
import React, { useCallback, useEffect, useState } from "react";

import { deregisterMcpServer, listMcpServers } from "../agentRuntime";
import { Button, Card, EmptyState, ErrorBanner, LoadingState } from "../ui";
import {
  describeEmptyState,
  describeProvenance,
  describeServerStatus,
  describeStdioSupport,
  sortForDisplay,
  summarizeTools,
  type McpServerEntry,
  type McpServersListResponse,
  type StatusTone,
} from "./mcpServersTypes";

// Desktop 의 `ui.tsx` 에는 Badge 프리미티브가 없다(portal-web 과 다르다).
// 새 공용 컴포넌트를 만들 만큼 쓰이는 곳이 많지 않아 이 화면 안에 둔다.
const TONE_CLASS: Record<StatusTone | "neutral", string> = {
  success: "bg-success/10 text-success",
  danger: "bg-danger/10 text-danger",
  warning: "bg-warning/10 text-warning",
  muted: "bg-slate-100 text-text-secondary",
  neutral: "bg-slate-100 text-text-secondary",
};

function StatusChip({ tone, children }: { tone: StatusTone | "neutral"; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; response: McpServersListResponse }
  | { kind: "error"; message: string };

export function McpServersScreen() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busyAlias, setBusyAlias] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", response: await listMcpServers() });
    } catch (e) {
      // 런타임 장애로 화면이 죽지 않는다 — 복구 안내를 보여 준다
      // (M04 규칙: Desktop 은 Runtime 장애 시 종료되지 않는다).
      setState({
        kind: "error",
        message:
          e instanceof Error
            ? e.message
            : "로컬 런타임에 연결하지 못했습니다. 설정 > 연결 상태에서 확인해 주세요.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDeregister(entry: McpServerEntry) {
    setBusyAlias(entry.server_alias);
    setActionError(null);
    try {
      await deregisterMcpServer(entry.server_alias);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "연결 해제에 실패했습니다.");
    } finally {
      setBusyAlias(null);
    }
  }

  if (state.kind === "loading") return <LoadingState label="MCP 서버를 확인하는 중..." />;

  if (state.kind === "error") {
    return (
      <div className="space-y-3">
        <ErrorBanner message={state.message} />
        <Button onClick={() => void load()}>다시 확인</Button>
      </div>
    );
  }

  const { response } = state;
  const stdioNotice = describeStdioSupport(response);
  const entries = sortForDisplay(response.entries);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body text-text-secondary">
          설치된 MCP 서버의 연결 상태입니다. 연결은 자산을 설치할 때 자동으로 이뤄집니다.
        </p>
        <Button variant="secondary" onClick={() => void load()}>
          새로고침
        </Button>
      </div>

      {stdioNotice && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-caption text-warning">
          {stdioNotice}
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}

      {entries.length === 0 ? (
        <EmptyState title="연결된 MCP 서버 없음" description={describeEmptyState(response)} />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const status = describeServerStatus(entry);
            const provenance = describeProvenance(entry);
            return (
              <Card key={entry.server_alias}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text-primary">{entry.server_alias}</span>
                      <StatusChip tone={status.tone}>{status.label}</StatusChip>
                      {provenance && <StatusChip tone="neutral">{provenance}</StatusChip>}
                    </div>
                    <div className="mt-1 text-caption text-text-secondary">
                      {summarizeTools(entry)}
                    </div>
                    {status.guidance && (
                      <p className="mt-2 text-caption text-text-secondary">{status.guidance}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    {/* 다시 시도해도 같은 결과인 실패에는 버튼을 보여 주지
                        않는다 — 헛수고를 권하는 셈이 된다. */}
                    {status.retryable && (
                      <Button
                        variant="secondary"
                        onClick={() => void load()}
                        disabled={busyAlias !== null}
                      >
                        다시 확인
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      onClick={() => void handleDeregister(entry)}
                      disabled={busyAlias !== null}
                    >
                      {busyAlias === entry.server_alias ? "해제 중..." : "연결 해제"}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
