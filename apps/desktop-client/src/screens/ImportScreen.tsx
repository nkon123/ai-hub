// D04 Package 가져오기 + D05 설치 사전점검.
//
// One screen covers both D04 and D05: the spec's D04 step list (1~12)
// already interleaves the D05-style per-item pass/warn/fail checklist with
// the install plan and confirmation, and this bundle format only ever
// carries a single root asset, so splitting them into two navigable screens
// would just add a click without adding clarity.
import { useEffect, useRef, useState } from "react";
import { FileArchive, FolderOpen, RotateCcw } from "lucide-react";
import type { ImportProgressEvent, ImportResult } from "../../electron/types";
import { STAGE_LABELS } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, CheckRow, ErrorBanner, PageHeader } from "../ui";
import { assetTypeLabel, formatBytes } from "../format";

type Phase = "IDLE" | "RUNNING" | "DONE";

export function ImportScreen({ onInstalled }: { onInstalled: () => void }) {
  const bridge = getDesktopBridge();
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [liveEvents, setLiveEvents] = useState<ImportProgressEvent[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const lastPickedPath = useRef<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onImportProgress((event) => {
      setLiveEvents((prev) => [...prev.filter((e) => e.stage !== event.stage), event]);
    });
    return unsubscribe;
  }, [bridge]);

  async function runImport(filePath: string) {
    if (!bridge) return;
    lastPickedPath.current = filePath;
    setPickerError(null);
    setLiveEvents([]);
    setResult(null);
    setPhase("RUNNING");
    try {
      const importResult = await bridge.importBundle(filePath);
      setResult(importResult);
      if (importResult.outcome === "SUCCESS") {
        onInstalled();
      }
    } catch (err) {
      setResult({
        outcome: "FAILED",
        checks: [],
        failedStage: null,
        retryable: true,
        manifest: null,
        installPlan: [],
        totalSizeBytes: 0,
      });
      setPickerError(err instanceof Error ? err.message : "가져오기 중 알 수 없는 오류가 발생했습니다.");
    } finally {
      setPhase("DONE");
    }
  }

  async function handlePickFile() {
    if (!bridge) return;
    setPickerError(null);
    try {
      const filePath = await bridge.pickBundleFile();
      if (!filePath) return;
      await runImport(filePath);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : "파일 선택 중 오류가 발생했습니다.");
    }
  }

  function handleRetry() {
    if (!lastPickedPath.current) return;
    void runImport(lastPickedPath.current);
  }

  const rows =
    phase === "RUNNING"
      ? liveEvents.map((e) => ({ id: e.stage, label: STAGE_LABELS[e.stage], status: e.status, message: e.message }))
      : (result?.checks ?? []);

  if (!bridge) {
    return (
      <div>
        <PageHeader
          title="Package 가져오기"
          description="폐쇄망에서 반입한 Offline Bundle(.zip)을 검증하고 설치합니다."
          actions={
            <Button disabled title="Desktop 런타임이 연결되어 있지 않습니다">
              <FolderOpen size={14} /> 파일 선택
            </Button>
          }
        />
        <BridgeUnavailableState detail="Offline Bundle 가져오기 및 설치는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Package 가져오기"
        description="폐쇄망에서 반입한 Offline Bundle(.zip)을 검증하고 설치합니다."
        actions={
          <Button onClick={() => void handlePickFile()} disabled={phase === "RUNNING"}>
            <FolderOpen size={14} /> 파일 선택
          </Button>
        }
      />

      {pickerError && (
        <div className="mb-4">
          <ErrorBanner message={pickerError} />
        </div>
      )}

      {phase === "IDLE" && rows.length === 0 && (
        <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-16 text-center shadow-none">
          <FileArchive size={28} className="text-slate-300" />
          <p className="text-card-title font-medium text-text-primary">가져올 Offline Bundle을 선택하세요</p>
          <p className="text-body text-text-secondary">
            ZIP 구조, Checksum, Manifest, Revocation, Runtime 호환성을 자동으로 검증합니다.
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 text-card-title font-semibold text-text-primary">검증 결과</h2>
          <div className="space-y-2">
            {rows.map((row) => (
              <CheckRow key={row.id} label={row.label} status={row.status} message={row.message} />
            ))}
          </div>
        </Card>
      )}

      {phase === "DONE" && result && (
        <div className="mt-4">
          {result.outcome === "SUCCESS" ? (
            <Card className="border-success/30 bg-success/5 p-5">
              <p className="text-card-title font-semibold text-success">설치가 완료되었습니다.</p>
              <p className="mt-1 text-body text-text-secondary">
                총 {formatBytes(result.totalSizeBytes)} · {result.installPlan.length}개 자산
              </p>
              <div className="mt-3 space-y-1">
                {result.installPlan.map((item) => (
                  <div key={`${item.asset_type}-${item.asset_id}`} className="text-body text-text-primary">
                    · {item.name ?? item.asset_id} ({assetTypeLabel(item.asset_type)} v{item.version}) —{" "}
                    {formatBytes(item.size_bytes)}
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="border-danger/30 bg-danger/5 p-5">
              <p className="text-card-title font-semibold text-danger">설치를 완료하지 못했습니다.</p>
              {result.failedStage && (
                <p className="mt-1 text-body text-text-secondary">
                  실패 단계: {STAGE_LABELS[result.failedStage as keyof typeof STAGE_LABELS] ?? result.failedStage}
                </p>
              )}
              <p className="mt-1 text-body text-text-secondary">
                {result.retryable ? "동일한 파일로 다시 시도할 수 있습니다." : "이 Bundle로는 재시도해도 동일하게 실패합니다. 새 Bundle을 요청하세요."}
              </p>
              {result.retryable && lastPickedPath.current && (
                <div className="mt-3">
                  <Button variant="secondary" size="sm" onClick={handleRetry}>
                    <RotateCcw size={14} /> 다시 시도
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
