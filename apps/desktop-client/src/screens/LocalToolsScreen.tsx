// D-084 "Desktop 로컬 Tool" — 자산 허브 > 로컬 Tool.
//
// 사용자가 직접 고른 .py 파일 하나의 함수를, 실행하지 않고 정적으로
// 분석해(`electron/local-tool-signature.ts`) 입력 Schema를 만들고, 이후
// 사용자가 명시적으로 확인할 때만 그 파일을 로컬에서 직접 실행한다
// (`electron/local-tool-runner.ts`). Hub 자산(D08 설치된 자산)과는 완전히
// 별도의 저장소(`electron/local-tool-store.ts`)이고 화면도 별도다 —
// `electron/__tests__/local-tool-isolation.test.ts`가 이 분리와 D-083
// TOOL_ROUTE/D-080 등록으로부터의 배제를 소스 텍스트 검사로 강제한다.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileCode2, FolderOpen, Play, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import type { LocalTool, LocalToolSignatureResult } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, ConfirmDialog, EmptyState, ErrorBanner, LoadingState, Modal, PageHeader } from "../ui";
import { formatDateTime } from "../format";
import {
  NOT_A_SANDBOX_NOTICE,
  buildExecutionApprovalNotice,
  buildLocalToolArgs,
  describeExecutionApprovalStatus,
  fieldKindForSchemaType,
  formatArgsForConfirm,
  formatInvocationOutcome,
  initialFieldText,
  type InvocationOutcomeDisplay,
} from "./localToolsTypes";

const OUTCOME_TONE_CLASS: Record<InvocationOutcomeDisplay["tone"], string> = {
  success: "border-success/30 bg-success/5 text-success",
  danger: "border-danger/30 bg-danger/5 text-danger",
  warning: "border-warning/30 bg-warning/5 text-warning",
  muted: "border-border bg-slate-50 text-text-secondary",
};

function NotASandboxNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{NOT_A_SANDBOX_NOTICE}</span>
    </div>
  );
}

type AddStep = "closed" | "picking" | "inspecting" | "review" | "adding";

export function LocalToolsScreen() {
  const bridge = getDesktopBridge();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tools, setTools] = useState<LocalTool[]>([]);

  const [addStep, setAddStep] = useState<AddStep>("closed");
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<LocalToolSignatureResult | null>(null);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [removeTarget, setRemoveTarget] = useState<LocalTool | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // D-084 후속 3 ("최초 한번만 승인") — 실행 자동 허용/철회. 둘 다 별도
  // ConfirmDialog로 명시적 확인을 요구한다(루트 CLAUDE.md UI 규칙: 승인·
  // 반려는 확인과 사유를 요구한다). 실제 판정과 저장은 항상 Main Process
  // (`bridge.approveLocalToolExecution`/`revokeLocalToolExecution`)가 한다 —
  // 여기서는 그 결과를 반영할 뿐이다.
  const [approveTarget, setApproveTarget] = useState<LocalTool | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<LocalTool | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [runTarget, setRunTarget] = useState<LocalTool | null>(null);
  const [runFormValues, setRunFormValues] = useState<Record<string, string>>({});
  const [runFieldErrors, setRunFieldErrors] = useState<Record<string, string>>({});
  const [runConfirming, setRunConfirming] = useState(false);
  const [runInvoking, setRunInvoking] = useState(false);
  const [runOutcome, setRunOutcome] = useState<InvocationOutcomeDisplay | null>(null);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setTools(await bridge.listLocalTools());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "로컬 Tool 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  function closeAddFlow() {
    setAddStep("closed");
    setPickedPath(null);
    setInspectResult(null);
    setRiskAcknowledged(false);
    setAddError(null);
  }

  async function startAddFlow() {
    if (!bridge) return;
    setAddStep("picking");
    setAddError(null);
    let filePath: string | null;
    try {
      filePath = await bridge.pickLocalToolFile();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "파일 선택 중 오류가 발생했습니다.");
      setAddStep("closed");
      return;
    }
    // 사용자가 대화상자를 취소함 — 조용한 no-op(Task Brief: Cancellation은
    // 오류가 아니다).
    if (!filePath) {
      setAddStep("closed");
      return;
    }
    setPickedPath(filePath);
    setAddStep("inspecting");
    try {
      const result = await bridge.inspectLocalToolFile(filePath);
      setInspectResult(result);
      setAddStep("review");
    } catch (err) {
      setInspectResult({
        ok: false,
        reason: "file_unreadable",
        message: err instanceof Error ? err.message : "파일을 분석하지 못했습니다.",
      });
      setAddStep("review");
    }
  }

  async function confirmAdd() {
    if (!bridge || !pickedPath || !inspectResult?.ok || !riskAcknowledged) return;
    setAddStep("adding");
    setAddError(null);
    try {
      const result = await bridge.addLocalTool(pickedPath, true);
      if (!result.ok) {
        setAddError(result.error ?? "로컬 Tool을 추가하지 못했습니다.");
        setAddStep("review");
        return;
      }
      closeAddFlow();
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "로컬 Tool을 추가하지 못했습니다.");
      setAddStep("review");
    }
  }

  async function confirmRemove() {
    if (!bridge || !removeTarget) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await bridge.removeLocalTool(removeTarget.id);
      if (!result.ok) {
        setRemoveError(result.error ?? "제거하지 못했습니다.");
        return;
      }
      setRemoveTarget(null);
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "제거하지 못했습니다.");
    } finally {
      setRemoving(false);
    }
  }

  async function confirmApprove() {
    if (!bridge || !approveTarget) return;
    setApproving(true);
    setApproveError(null);
    try {
      const result = await bridge.approveLocalToolExecution(approveTarget.id);
      if (!result.ok) {
        setApproveError(result.error ?? "실행을 허용하지 못했습니다.");
        return;
      }
      setApproveTarget(null);
      await load();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : "실행을 허용하지 못했습니다.");
    } finally {
      setApproving(false);
    }
  }

  async function confirmRevoke() {
    if (!bridge || !revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const result = await bridge.revokeLocalToolExecution(revokeTarget.id);
      if (!result.ok) {
        setRevokeError(result.error ?? "허용을 철회하지 못했습니다.");
        return;
      }
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "허용을 철회하지 못했습니다.");
    } finally {
      setRevoking(false);
    }
  }

  function openRunForm(tool: LocalTool) {
    setRunTarget(tool);
    const initial: Record<string, string> = {};
    for (const param of tool.parameters) initial[param.name] = initialFieldText(param);
    setRunFormValues(initial);
    setRunFieldErrors({});
    setRunConfirming(false);
    setRunOutcome(null);
  }

  function closeRunForm() {
    setRunTarget(null);
    setRunFormValues({});
    setRunFieldErrors({});
    setRunConfirming(false);
    setRunOutcome(null);
  }

  function proceedToConfirm() {
    if (!runTarget) return;
    const built = buildLocalToolArgs(runTarget, runFormValues);
    if (!built.ok) {
      setRunFieldErrors(built.errors ?? {});
      return;
    }
    setRunFieldErrors({});
    setRunConfirming(true);
  }

  async function executeRun() {
    if (!bridge || !runTarget) return;
    const built = buildLocalToolArgs(runTarget, runFormValues);
    if (!built.ok) {
      setRunConfirming(false);
      setRunFieldErrors(built.errors ?? {});
      return;
    }
    setRunInvoking(true);
    try {
      const result = await bridge.invokeLocalTool(runTarget.id, built.args ?? {});
      setRunOutcome(formatInvocationOutcome(result));
      setRunConfirming(false);
    } catch (err) {
      setRunOutcome({
        tone: "danger",
        title: "실행 요청 실패",
        detail: err instanceof Error ? err.message : "알 수 없는 오류입니다.",
      });
      setRunConfirming(false);
    } finally {
      setRunInvoking(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="로컬 Tool" description="내 PC의 Python 파일을 직접 실행 대상으로 등록합니다." />
        <BridgeUnavailableState detail="로컬 Tool은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="로컬 Tool" description="내 PC의 Python 파일을 직접 실행 대상으로 등록합니다." />
        <LoadingState label="로컬 Tool 목록을 불러오는 중..." />
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title="로컬 Tool" description="내 PC의 Python 파일을 직접 실행 대상으로 등록합니다." />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  const runArgsPreview = runTarget ? buildLocalToolArgs(runTarget, runFormValues) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="로컬 Tool"
        description="Hub에서 검토된 자산이 아닙니다 — 내 PC에 있는 Python 함수 하나를 직접 실행 대상으로 등록합니다."
        actions={
          <Button variant="primary" onClick={() => void startAddFlow()} disabled={addStep !== "closed"}>
            <FolderOpen size={14} /> Python 파일 선택
          </Button>
        }
      />

      <NotASandboxNotice />

      {tools.length === 0 ? (
        <EmptyState
          title="등록된 로컬 Tool이 없습니다"
          description="Python 파일 하나(최상위 함수 하나)를 선택하면 실행하지 않고 입력 Schema만 분석합니다. 이후 실행은 항상 인자를 확인하는 단계를 거칩니다."
        />
      ) : (
        <div className="space-y-3">
          {tools.map((tool) => (
            <Card key={tool.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileCode2 size={16} className="shrink-0 text-text-secondary" />
                    <span className="text-body font-semibold text-text-primary">{tool.functionName}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                      로컬 Tool (검토되지 않음)
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        tool.approval !== null
                          ? "bg-success/10 text-success"
                          : "bg-slate-100 text-text-secondary"
                      }`}
                    >
                      {describeExecutionApprovalStatus(tool)}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-caption text-text-muted">{tool.filePath}</p>
                  <p className="mt-1 text-caption text-text-secondary">
                    파라미터 {tool.parameters.length}개 · 추가됨 {formatDateTime(tool.addedAt)}
                    {tool.approval !== null && ` · 실행 허용됨 ${formatDateTime(tool.approval.approvedAt)}`}
                  </p>
                  {tool.parameters.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {tool.parameters.map((p) => (
                        <li
                          key={p.name}
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-text-secondary"
                        >
                          {p.name}: {p.schemaType}
                          {!p.required && " (선택)"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" onClick={() => openRunForm(tool)}>
                    <Play size={14} /> 실행
                  </Button>
                  {tool.approval !== null ? (
                    <Button variant="secondary" onClick={() => setRevokeTarget(tool)}>
                      <ShieldOff size={14} /> 허용 해제
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={() => setApproveTarget(tool)}>
                      <ShieldCheck size={14} /> 실행 허용
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => setRemoveTarget(tool)}>
                    <Trash2 size={14} /> 제거
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* --- 추가 흐름: 파일 선택 -> 정적 분석(투명성 패널) -> 확인 -> 추가 --- */}
      <Modal open={addStep === "inspecting" || addStep === "review" || addStep === "adding"} title="로컬 Tool 추가" onClose={closeAddFlow}>
        {addStep === "inspecting" && <LoadingState label="Python 파일을 분석하는 중..." />}

        {(addStep === "review" || addStep === "adding") && inspectResult && (
          <div className="space-y-3">
            <p className="break-all text-caption text-text-muted">{pickedPath}</p>
            {inspectResult.ok ? (
              <>
                <div>
                  <p className="text-body font-semibold text-text-primary">추출된 함수: {inspectResult.functionName}</p>
                  {inspectResult.parameters.length === 0 ? (
                    <p className="mt-1 text-caption text-text-secondary">파라미터가 없습니다.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {inspectResult.parameters.map((p) => (
                        <li key={p.name} className="rounded-md border border-border px-2 py-1 text-caption text-text-secondary">
                          <span className="font-medium text-text-primary">{p.name}</span>: {p.schemaType}
                          {" · "}
                          {p.required ? "필수" : "선택"}
                          {p.defaultIncluded && " · 기본값 있음"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="text-caption font-semibold text-text-muted">버려진 정보(실행되지 않음)</p>
                  <p className="mt-1 text-caption text-text-secondary">
                    Docstring: {inspectResult.discarded.docstringPresent ? "있음(내용은 저장하지 않음)" : "없음"} · 본문 문장
                    수: {inspectResult.discarded.bodyStatementCount} · 소스 실행: 안 함 · 소스 저장: 안 함
                  </p>
                </div>
                {inspectResult.warnings.length > 0 && (
                  <div>
                    <p className="text-caption font-semibold text-warning">경고</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-caption text-warning">
                      {inspectResult.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <NotASandboxNotice />
                <label className="flex items-start gap-2 text-body text-text-primary">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={riskAcknowledged}
                    onChange={(e) => setRiskAcknowledged(e.target.checked)}
                  />
                  <span>위 내용을 확인했으며, 이 Tool이 격리 없이 제 권한으로 실행된다는 것을 이해했습니다.</span>
                </label>
                {addError && <ErrorBanner message={addError} />}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeAddFlow} disabled={addStep === "adding"}>
                    취소
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void confirmAdd()}
                    disabled={!riskAcknowledged || addStep === "adding"}
                  >
                    {addStep === "adding" ? "추가하는 중..." : "추가"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <ErrorBanner message={inspectResult.message} />
                {inspectResult.candidates && inspectResult.candidates.length > 0 && (
                  <p className="text-caption text-text-secondary">
                    발견된 최상위 함수: {inspectResult.candidates.join(", ")}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button variant="secondary" onClick={closeAddFlow}>
                    닫기
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* --- 제거 확인 --- */}
      <ConfirmDialog
        open={removeTarget !== null}
        title="로컬 Tool 제거"
        description={removeTarget ? `'${removeTarget.functionName}'을(를) 목록에서 제거합니다. 원본 Python 파일은 지워지지 않습니다.` : undefined}
        confirmLabel="제거"
        submitting={removing}
        onConfirm={() => void confirmRemove()}
        onCancel={() => {
          setRemoveTarget(null);
          setRemoveError(null);
        }}
      />
      {removeError && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-full max-w-sm px-4">
          <ErrorBanner message={removeError} />
        </div>
      )}

      {/* --- 실행 허용 확인 (D-084 후속 3) --- */}
      <ConfirmDialog
        open={approveTarget !== null}
        title="로컬 Tool 실행 허용"
        description={approveTarget ? buildExecutionApprovalNotice(approveTarget) : undefined}
        confirmLabel="허용"
        submitting={approving}
        onConfirm={() => void confirmApprove()}
        onCancel={() => {
          setApproveTarget(null);
          setApproveError(null);
        }}
      />
      {approveError && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-full max-w-sm px-4">
          <ErrorBanner message={approveError} />
        </div>
      )}

      {/* --- 허용 철회 확인 (D-084 후속 3) --- */}
      <ConfirmDialog
        open={revokeTarget !== null}
        title="실행 허용 철회"
        description={
          revokeTarget
            ? `'${revokeTarget.functionName}'의 실행 자동 허용을 철회합니다. 다음 실행부터 다시 매번 확인 대화상자가 뜹니다.`
            : undefined
        }
        confirmLabel="철회"
        submitting={revoking}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => {
          setRevokeTarget(null);
          setRevokeError(null);
        }}
      />
      {revokeError && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-full max-w-sm px-4">
          <ErrorBanner message={revokeError} />
        </div>
      )}

      {/* --- 실행 흐름: 인자 입력 -> 확인(경로+인자 표시, not-a-sandbox 재고지) -> 실행 --- */}
      <Modal open={runTarget !== null} title={runTarget ? `실행: ${runTarget.functionName}` : "실행"} onClose={closeRunForm}>
        {runTarget && (
          <div className="space-y-3">
            {!runConfirming && !runOutcome && (
              <>
                {runTarget.parameters.length === 0 ? (
                  <p className="text-caption text-text-secondary">이 Tool은 인자가 없습니다.</p>
                ) : (
                  <div className="space-y-2">
                    {runTarget.parameters.map((param) => {
                      const kind = fieldKindForSchemaType(param.schemaType);
                      return (
                        <div key={param.name}>
                          <label className="mb-1 block text-caption font-semibold text-text-muted" htmlFor={`local-tool-arg-${param.name}`}>
                            {param.name} ({param.schemaType}){param.required && <span className="text-danger"> *</span>}
                          </label>
                          {kind === "boolean" ? (
                            <select
                              id={`local-tool-arg-${param.name}`}
                              value={runFormValues[param.name] ?? "false"}
                              onChange={(e) => setRunFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                              className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : kind === "json" ? (
                            <textarea
                              id={`local-tool-arg-${param.name}`}
                              value={runFormValues[param.name] ?? ""}
                              onChange={(e) => setRunFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                              placeholder="JSON 값 (예: [1, 2, 3])"
                              rows={2}
                              className="w-full rounded-lg border border-border px-3 py-2 text-sm text-text-primary"
                            />
                          ) : (
                            <input
                              id={`local-tool-arg-${param.name}`}
                              type={kind === "number" ? "number" : "text"}
                              value={runFormValues[param.name] ?? ""}
                              onChange={(e) => setRunFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                              className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary"
                            />
                          )}
                          {runFieldErrors[param.name] && (
                            <p className="mt-1 text-caption text-danger">{runFieldErrors[param.name]}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeRunForm}>
                    취소
                  </Button>
                  <Button variant="primary" onClick={proceedToConfirm}>
                    다음: 확인
                  </Button>
                </div>
              </>
            )}

            {runConfirming && !runOutcome && (
              <>
                <p className="text-body text-text-primary">다음 파일을, 다음 인자로 실행합니다:</p>
                <p className="break-all rounded-lg border border-border bg-slate-50 px-3 py-2 font-mono text-caption text-text-primary">
                  {runTarget.filePath}
                </p>
                <pre className="overflow-x-auto rounded-lg border border-border bg-slate-50 px-3 py-2 text-caption text-text-primary">
                  {formatArgsForConfirm(runArgsPreview?.args ?? {})}
                </pre>
                <NotASandboxNotice />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setRunConfirming(false)} disabled={runInvoking}>
                    돌아가기
                  </Button>
                  <Button variant="danger" onClick={() => void executeRun()} disabled={runInvoking}>
                    {runInvoking ? "실행하는 중..." : "실행"}
                  </Button>
                </div>
              </>
            )}

            {runOutcome && (
              <>
                <div className={`rounded-lg border px-3 py-3 ${OUTCOME_TONE_CLASS[runOutcome.tone]}`}>
                  <p className="font-semibold">{runOutcome.title}</p>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-caption">{runOutcome.detail}</pre>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setRunOutcome(null)}>
                    다시 실행
                  </Button>
                  <Button variant="primary" onClick={closeRunForm}>
                    닫기
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
