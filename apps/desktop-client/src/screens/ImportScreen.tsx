// D04 Package 가져오기 + D05 설치 사전점검.
//
// One screen covers both D04 and D05: the spec's D04 step list (1~12)
// already interleaves the D05-style per-item pass/warn/fail checklist with
// the install plan and confirmation, and this bundle format only ever
// carries a single root asset, so splitting them into two navigable screens
// would just add a click without adding clarity.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileArchive, FolderOpen, Info, Loader2, RotateCcw } from "lucide-react";
import type { ActivateKnowledgeResult, ConnectMcpToolResult, ImportProgressEvent, ImportResult } from "../../electron/types";
import { STAGE_LABELS } from "../../electron/types";
import { getDesktopBridge, isBridgeMethodMissing } from "../bridge";
import { Button, BridgeUnavailableState, Card, CheckRow, ErrorBanner, PageHeader } from "../ui";
import { assetTypeLabel, formatBytes } from "../format";
import {
  agentRegistrationGuidanceTargets,
  knowledgeActivationTargets,
  mcpToolConnectionTargets,
  noFurtherActionTargets,
} from "./knowledgeActivation";

type Phase = "IDLE" | "RUNNING" | "DONE";

function activationKey(assetId: string, version: string): string {
  return `${assetId}::${version}`;
}

export function ImportScreen({ onInstalled }: { onInstalled: () => void }) {
  const bridge = getDesktopBridge();
  // stale preload.js 빌드로 이 구독 메서드 자체가 없으면 `onImportProgress`는
  // 항상 아무 이벤트도 만들지 못하는 no-op으로 대체된다(`src/bridge.ts`) —
  // 그 상태에서 진행률 영역을 빈 채로 두면 "아무 일도 없다"는 거짓 인상을
  // 준다. 대신 실시간 진행 상황을 보여줄 수 없다는 사실을 명시한다.
  const importProgressUnavailable = !!bridge && isBridgeMethodMissing("onImportProgress");
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [liveEvents, setLiveEvents] = useState<ImportProgressEvent[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const lastPickedPath = useRef<string | null>(null);
  // D-079: 설치 성공 뒤 Knowledge 항목을 자동으로 활성화 시도한다 — 결과는
  // 별도로 보여준다("설치는 완료되었지만 검색에 활성화되지 않았습니다" 규칙,
  // 설치 성공 여부와 절대 섞이지 않는다).
  const [activationResults, setActivationResults] = useState<Record<string, ActivateKnowledgeResult>>({});
  const [mcpConnectionResults, setMcpConnectionResults] = useState<Record<string, ConnectMcpToolResult>>({});

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onImportProgress((event) => {
      setLiveEvents((prev) => [...prev.filter((e) => e.stage !== event.stage), event]);
    });
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !result || result.outcome !== "SUCCESS") return;
    const targets = knowledgeActivationTargets(result.installPlan);
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const target of targets) {
        const outcome = await bridge.activateInstalledKnowledge("knowledge", target.assetId, target.version);
        if (!cancelled) {
          setActivationResults((prev) => ({ ...prev, [activationKey(target.assetId, target.version)]: outcome }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `result`(객체 참조)가 바뀔 때만 재실행한다 — importBundle이 새 결과를
    // 만들 때마다 정확히 한 번씩만 활성화를 시도한다.
  }, [bridge, result]);

  useEffect(() => {
    if (!bridge || !result || result.outcome !== "SUCCESS") return;
    const targets = mcpToolConnectionTargets(result.installPlan);
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const target of targets) {
        const outcome = await bridge.connectInstalledMcpTool("mcp_tool", target.assetId, target.version);
        if (!cancelled) {
          setMcpConnectionResults((prev) => ({ ...prev, [activationKey(target.assetId, target.version)]: outcome }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, result]);

  async function runImport(filePath: string) {
    if (!bridge) return;
    lastPickedPath.current = filePath;
    setPickerError(null);
    setLiveEvents([]);
    setResult(null);
    setActivationResults({});
    setMcpConnectionResults({});
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
          title="ZIP 가져오기"
          description="허브에서 받은 설치 ZIP을 선택하면 검증 후 자동으로 설치합니다."
          actions={
            <Button disabled title="Desktop 런타임이 연결되어 있지 않습니다">
              <FolderOpen size={14} /> 파일 선택
            </Button>
          }
        />
        <BridgeUnavailableState detail="ZIP 가져오기와 설치는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="ZIP 가져오기"
        description="허브에서 받은 설치 ZIP을 선택하면 검증 후 자동으로 설치합니다."
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
          <p className="text-card-title font-medium text-text-primary">설치 ZIP을 선택하세요</p>
          <p className="text-body text-text-secondary">
            무결성·승인 상태·Runtime 호환성을 자동으로 확인합니다.
          </p>
        </Card>
      )}

      {phase === "RUNNING" && rows.length === 0 && importProgressUnavailable && (
        <Card className="flex items-start gap-2 border-warning/30 bg-warning/5 p-5 shadow-none">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-body text-warning">
            검증이 진행 중이지만 실행 중인 앱 빌드가 최신이 아니어서 단계별 진행 상황을 실시간으로 표시할 수
            없습니다 — 완료되면 아래에 결과가 표시됩니다. 앱을 재시작하면 실시간 표시가 복구됩니다.
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

              {knowledgeActivationTargets(result.installPlan).length > 0 && (
                <div className="mt-4 space-y-2 border-t border-success/20 pt-3">
                  <p className="text-caption font-semibold text-text-muted">Knowledge 검색 활성화</p>
                  {knowledgeActivationTargets(result.installPlan).map((target) => {
                    const key = activationKey(target.assetId, target.version);
                    const outcome = activationResults[key];
                    return (
                      <div key={key} className="flex items-start gap-1.5 text-caption">
                        {!outcome && (
                          <span className="flex items-center gap-1.5 text-text-secondary">
                            <Loader2 size={13} className="animate-spin" />
                            {target.name ?? target.assetId} 활성화 확인 중...
                          </span>
                        )}
                        {outcome?.activation?.state === "ACTIVE" && (
                          <>
                            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                            <span className="text-success">
                              {target.name ?? target.assetId}: 검색에 활성화되었습니다.
                            </span>
                          </>
                        )}
                        {outcome?.activation?.state === "ALREADY_ACTIVE" && (
                          <>
                            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                            <span className="text-success">
                              {target.name ?? target.assetId}: 이미 검색 가능한 상태입니다(중앙 색인에 등록됨) —
                              별도 활성화가 필요하지 않습니다.
                            </span>
                          </>
                        )}
                        {outcome?.activation?.state === "FAILED" && (
                          <>
                            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                            <span className="text-warning">
                              설치는 완료되었지만 검색에 활성화되지 않았습니다: {outcome.activation.message ?? "알 수 없는 오류"}{" "}
                              — 설치된 자산 화면에서 다시 시도할 수 있습니다.
                            </span>
                          </>
                        )}
                        {outcome && !outcome.activation && (
                          <>
                            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                            <span className="text-warning">
                              설치는 완료되었지만 활성화를 시도하지 못했습니다: {outcome.error ?? "알 수 없는 오류"}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {mcpToolConnectionTargets(result.installPlan).length > 0 && (
                <div className="mt-4 space-y-2 border-t border-success/20 pt-3">
                  <p className="text-caption font-semibold text-text-muted">MCP Tool 연결</p>
                  {mcpToolConnectionTargets(result.installPlan).map((target) => {
                    const key = activationKey(target.assetId, target.version);
                    const outcome = mcpConnectionResults[key];
                    const policyDisabled = outcome?.activation?.reason === "mcp_tool_registration_disabled";
                    return (
                      <div key={key} className="flex items-start gap-1.5 text-caption">
                        {!outcome && <span className="text-text-secondary">{target.name ?? target.assetId} 연결 확인 중...</span>}
                        {outcome?.activation?.state === "ACTIVE" && (
                          <span className="text-success">
                            <CheckCircle2 size={13} className="mr-1 inline-block align-text-bottom" />
                            {target.name ?? target.assetId}: agent-runtime에 연결되었습니다. 실제 호출 권한은 Office Profile이 결정합니다.
                          </span>
                        )}
                        {outcome?.activation?.state === "FAILED" && (
                          <span className="text-warning">
                            <AlertTriangle size={13} className="mr-1 inline-block align-text-bottom" />
                            설치는 완료되었습니다. {policyDisabled ? "운영자가 이 서버 alias의 동적 등록을 허용해야 합니다" : "연결하지 못했습니다"}: {outcome.activation.message ?? "알 수 없는 오류"}
                            {!policyDisabled && " — 설치된 자산 화면에서 다시 시도할 수 있습니다."}
                          </span>
                        )}
                        {outcome && !outcome.activation && (
                          <span className="text-warning">
                            <AlertTriangle size={13} className="mr-1 inline-block align-text-bottom" />
                            설치는 완료되었지만 연결을 시도하지 못했습니다: {outcome.error ?? "알 수 없는 오류"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {agentRegistrationGuidanceTargets(result.installPlan).length > 0 && (
                <div className="mt-4 space-y-1.5 border-t border-success/20 pt-3">
                  <p className="text-caption font-semibold text-text-muted">Local Agent 등록</p>
                  {agentRegistrationGuidanceTargets(result.installPlan).map((target) => (
                    <p key={`agent-${target.assetId}`} className="flex items-start gap-1.5 text-caption text-text-secondary">
                      <Info size={13} className="mt-0.5 shrink-0" />
                      {target.name ?? target.assetId}: 설치는 완료되었지만 대화에서 바로 쓸 수는 없습니다 — 짝이 될 Prompt
                      자산을 골라 등록해야 합니다(설치된 자산 화면에서 "Local Agent로 등록").
                    </p>
                  ))}
                </div>
              )}

              {noFurtherActionTargets(result.installPlan).length > 0 && (
                <div className="mt-4 space-y-1.5 border-t border-success/20 pt-3">
                  {noFurtherActionTargets(result.installPlan).map((target) => (
                    <p key={`${target.assetType}-${target.assetId}`} className="text-caption text-text-secondary">
                      <CheckCircle2 size={13} className="mr-1 inline-block align-text-bottom text-success" />
                      {target.name ?? target.assetId} ({assetTypeLabel(target.assetType)}): 설치 외에 별도로 활성화하거나
                      연결할 절차가 없습니다 — 자산 관리 화면에서 바로 확인할 수 있습니다.
                    </p>
                  ))}
                </div>
              )}
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
