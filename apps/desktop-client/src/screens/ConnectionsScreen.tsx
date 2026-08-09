// D09 연결 상태 — Ollama / Local Agent Runtime Health.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import type { ConnectionStatus } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, ErrorBanner, LoadingState, PageHeader } from "../ui";
import { formatDateTime } from "../format";

export function ConnectionsScreen() {
  const bridge = getDesktopBridge();
  const [statuses, setStatuses] = useState<ConnectionStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!bridge) return;
    setChecking(true);
    setError(null);
    try {
      const result = await bridge.checkConnections();
      setStatuses(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "연결 상태를 확인하지 못했습니다.");
    } finally {
      setChecking(false);
    }
  }, [bridge]);

  useEffect(() => {
    void check();
  }, [check]);

  if (!bridge) {
    return (
      <div>
        <PageHeader
          title="연결 상태"
          description="Local Agent Runtime과 Ollama의 연결 상태를 확인합니다. 연결 실패는 앱을 종료시키지 않습니다."
          actions={
            <Button variant="secondary" disabled title="Desktop 런타임이 연결되어 있지 않습니다">
              <RefreshCw size={14} /> 다시 검사
            </Button>
          }
        />
        <BridgeUnavailableState detail="Local Agent Runtime/Ollama 연결 상태 확인은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="연결 상태"
        description="Local Agent Runtime과 Ollama의 연결 상태를 확인합니다. 연결 실패는 앱을 종료시키지 않습니다."
        actions={
          <Button variant="secondary" onClick={() => void check()} disabled={checking}>
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} /> 다시 검사
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {statuses === null && !error && <LoadingState label="연결 상태를 확인하는 중..." />}

      {statuses !== null && (
        <div className="space-y-3">
          {statuses.map((status) => (
            <Card key={status.id} className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  {status.ok ? (
                    <CheckCircle2 size={20} className="mt-0.5 text-success" />
                  ) : (
                    <XCircle size={20} className="mt-0.5 text-danger" />
                  )}
                  <div>
                    <p className="text-card-title font-medium text-text-primary">{status.label}</p>
                    <p className="text-body text-text-secondary">{status.detail}</p>
                    {!status.ok && status.recoveryHint && (
                      <p className="mt-1 text-body text-warning">복구 안내: {status.recoveryHint}</p>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right text-caption text-text-muted">
                  <p>마지막 확인 {formatDateTime(status.checkedAt)}</p>
                  {status.latencyMs !== null && <p>{status.latencyMs}ms</p>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
