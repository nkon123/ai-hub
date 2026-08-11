// D03 Service/Agent 상세 (`02-desktop-and-agent-runtime.md` §D03) — a
// drill-down entered from 자산 허브 > 설치된 자산(D08, AssetsScreen)'s "상세
// 보기" button, not a top-level nav tab. (Formerly also entered from
// D02/HomeScreen before the desktop-ia-restructure merged D02 into D08 —
// HomeScreen.tsx no longer exists.) Shows every §D03 field this PoC can honestly
// source locally; fields with no source render "미기재" + a stated reason
// instead of a guess (see `electron/service-detail.ts`'s module docstring
// for exactly which fields those are and why, and open-decisions.md D-076).
//
// The four §D03 actions all reuse existing, already-tested logic rather than
// re-implementing it:
//  - 실행 전 사전점검: `checkConnections()` (D09, same call ConnectionsScreen
//    uses) composed with this asset's own bindings' installed-or-not facts
//    (already returned by `getServiceDetail`) — no second health-check path.
//  - 실행: navigates to D06(대화) — this PoC has no Service Registry
//    (open-decisions.md D-034/D-058), so there is nothing to pre-select with.
//  - 버전 전환: the exact same `activateAssetVersion` call and
//    `updateTypes.ts` helpers D12(UpdateScreen)/D08(AssetsScreen) use,
//    scoped to this one asset's version group.
//  - 제거: the exact same `checkAssetRemoval`/`removeInstalledAsset` calls
//    D08 uses (CLAUDE.md: 확인과 사유 필수).
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, ListChecks, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import type { ConnectionStatus, InstalledAssetWithStatus, ServiceDetailView } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, CheckRow, EmptyState, ErrorBanner, LoadingState, PageHeader, ReasonConfirmDialog } from "../ui";
import { assetTypeLabel, formatBytes, formatDateTime } from "../format";
import { ASSET_STATUS_LABEL, ASSET_STATUS_TONE } from "./assetStatusLabels";
import { activateDisabledReason, activationActionLabel, groupInstalledAssetsByAssetId } from "./updateTypes";

export interface ServiceDetailTarget {
  assetType: string;
  assetId: string;
  version: string;
}

function GapRow({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2.5">
      <p className="text-caption font-semibold text-text-muted">{label}</p>
      <p className="mt-1 flex items-start gap-1.5 text-caption text-text-secondary">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
        미기재 — {reason}
      </p>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-card-title font-semibold text-text-primary">{title}</h2>;
}

const CONFIRMATION_POLICY_LABEL: Record<string, string> = {
  always: "항상 확인",
  never: "확인 없이 자동 실행",
  sensitive_only: "민감 작업만 확인",
};

export function ServiceDetailScreen({
  target,
  onBack,
  onGoToChat,
  onRemoved,
}: {
  target: ServiceDetailTarget;
  onBack: () => void;
  onGoToChat: () => void;
  onRemoved: () => void;
}) {
  const bridge = getDesktopBridge();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceDetailView | null>(null);

  const [allAssets, setAllAssets] = useState<InstalledAssetWithStatus[] | null>(null);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [result, assets] = await Promise.all([
        bridge.getServiceDetail(target.assetType, target.assetId, target.version),
        bridge.listInstalledAssets(),
      ]);
      setAvailable(result.available);
      setUnavailableReason(result.reason);
      setDetail(result.detail);
      setAllAssets(assets);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "상세 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge, target.assetType, target.assetId, target.version]);

  useEffect(() => {
    void load();
  }, [load]);

  // --- 실행 전 사전점검 (D09 checkConnections() 재사용 + 이미 불러온 bindings
  //     설치 여부를 조합 — 새 검사 로직을 만들지 않는다) -----------------------
  const [preflightConnections, setPreflightConnections] = useState<ConnectionStatus[] | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);

  async function runPreflight() {
    if (!bridge) return;
    setPreflightRunning(true);
    try {
      setPreflightConnections(await bridge.checkConnections());
    } finally {
      setPreflightRunning(false);
    }
  }

  // --- 버전 전환 (D12/D08과 동일한 로직 재사용) --------------------------------
  const group = useMemo(() => {
    if (!allAssets) return null;
    return (
      groupInstalledAssetsByAssetId(allAssets).find((g) => g.assetType === target.assetType && g.assetId === target.assetId) ?? null
    );
  }, [allAssets, target.assetType, target.assetId]);

  const [activateTarget, setActivateTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  async function confirmActivate(reason: string) {
    if (!bridge || !activateTarget) return;
    setActivating(true);
    try {
      const result = await bridge.activateAssetVersion(activateTarget.assetType, activateTarget.assetId, activateTarget.version, reason);
      if (!result.ok) {
        setActivateError(result.error ?? "Active Version 전환에 실패했습니다.");
        return;
      }
      setActivateTarget(null);
      await load();
    } finally {
      setActivating(false);
    }
  }

  // --- 제거 (D08과 동일한 로직 재사용) ------------------------------------------
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalChecking, setRemovalChecking] = useState(false);
  const [removalBlocked, setRemovalBlocked] = useState<{ blocked: boolean; note: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function openRemoval() {
    if (!bridge) return;
    setRemovalOpen(true);
    setRemovalBlocked(null);
    setRemoveError(null);
    setRemovalChecking(true);
    try {
      const check = await bridge.checkAssetRemoval(target.assetType, target.assetId, target.version);
      const names = check.referencingServices.map((s) => `${s.name} v${s.version}`).join(", ");
      const note = names
        ? `다음 Service가 이 자산을 참조하고 있어 제거할 수 없습니다: ${names}`
        : check.blockedByActiveVersion
          ? (check.activeVersionNote ?? "이 버전은 현재 Active Version이라 제거할 수 없습니다.")
          : check.runCheckNote;
      setRemovalBlocked({ blocked: check.blocked, note });
    } finally {
      setRemovalChecking(false);
    }
  }

  async function confirmRemoval(reason: string) {
    if (!bridge) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await bridge.removeInstalledAsset(target.assetType, target.assetId, target.version, reason);
      if (!result.ok) {
        setRemoveError(result.error ?? "제거 중 오류가 발생했습니다.");
        return;
      }
      setRemovalOpen(false);
      onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="Service/Agent 상세" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} /> 뒤로</Button>} />
        <BridgeUnavailableState detail="Service/Agent 상세 정보는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Service/Agent 상세" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} /> 뒤로</Button>} />
        <LoadingState label="상세 정보를 불러오는 중..." />
      </div>
    );
  }

  if (loadError || !available || !detail) {
    return (
      <div>
        <PageHeader title="Service/Agent 상세" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} /> 뒤로</Button>} />
        <ErrorBanner message={loadError ?? unavailableReason ?? "상세 정보를 불러오지 못했습니다."} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={detail.name}
        description={`${assetTypeLabel(detail.assetType)} · v${detail.version}`}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onBack}>
              <ArrowLeft size={14} /> 뒤로
            </Button>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw size={14} /> 새로고침
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ASSET_STATUS_TONE[detail.status]}`}>
          {ASSET_STATUS_LABEL[detail.status]}
        </span>
        {detail.checksumVerification && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${detail.checksumVerification.result === "PASS" ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
            Checksum {detail.checksumVerification.result === "PASS" ? "일치" : "불일치"} ({formatDateTime(detail.checksumVerification.checkedAt)})
          </span>
        )}
      </div>

      {/* 업무 목적과 사용 예 */}
      <Card className="p-5">
        <SectionHeader title="업무 목적과 사용 예" />
        <div className="space-y-3">
          {detail.purpose.available ? (
            <div>
              <p className="text-caption font-semibold text-text-muted">업무 목적</p>
              <p className="mt-1 text-body text-text-primary">{detail.purpose.value}</p>
            </div>
          ) : (
            <GapRow label="업무 목적" reason={detail.purpose.reason!} />
          )}
          {detail.usageExamples.available ? (
            <div>
              <p className="text-caption font-semibold text-text-muted">사용 예(추천 질문)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-text-primary">
                {detail.usageExamples.values.map((v, idx) => (
                  <li key={idx}>{v}</li>
                ))}
              </ul>
            </div>
          ) : (
            <GapRow label="사용 예" reason={detail.usageExamples.reason!} />
          )}
        </div>
      </Card>

      {/* 입력 필드와 허용 파일 */}
      <Card className="p-5">
        <SectionHeader title="입력 필드와 허용 파일" />
        <GapRow label="입력 필드/허용 파일" reason={detail.inputFields.reason} />
      </Card>

      {/* 선택된 Agent, Knowledge, MCP Tool, Prompt */}
      <Card className="p-5">
        <SectionHeader title="선택된 Agent, Knowledge, MCP Tool, Prompt" />
        {detail.bindingsNote && (
          <p className="mb-3 flex items-start gap-1.5 text-caption text-text-secondary">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            {detail.bindingsNote}
          </p>
        )}
        {detail.bindings.length === 0 && !detail.bindingsNote && (
          <p className="text-caption text-text-secondary">참조하는 대상이 없습니다.</p>
        )}
        {detail.bindings.length > 0 && (
          <ul className="space-y-2">
            {detail.bindings.map((b, idx) => (
              <li key={idx} className="rounded-lg border border-border px-3 py-2.5 text-caption">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">
                    {b.label} · {b.assetId} v{b.version}
                  </span>
                  <span className={b.installed ? "text-success" : "text-danger"}>{b.installed ? "설치됨" : "미설치"}</span>
                </div>
                {b.indexInfo && (
                  b.indexInfo.available ? (
                    <p className="mt-1 text-text-secondary">
                      Embedding 모델: <strong>{b.indexInfo.embedModel}</strong>
                      {b.indexInfo.chunkingStrategy ? ` · Chunking: ${b.indexInfo.chunkingStrategy}` : ""}
                      <span className="block text-[11px] text-text-muted">출처: {b.indexInfo.source}</span>
                    </p>
                  ) : (
                    <p className="mt-1 flex items-start gap-1.5 text-warning">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> 미기재 — {b.indexInfo.reason}
                    </p>
                  )
                )}
                {b.refType === "mcp_bindings" && (
                  <p className="mt-1 text-text-secondary">
                    확인 정책: {b.confirmationPolicy ? (CONFIRMATION_POLICY_LABEL[b.confirmationPolicy] ?? b.confirmationPolicy) : "미기재(선언되지 않음)"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {detail.bindings.some((b) => b.refType === "mcp_bindings") && (
          <p className="mt-3 rounded-lg bg-background p-2.5 text-caption text-text-secondary">{detail.toolRiskNote}</p>
        )}
      </Card>

      {/* 모델 정책과 현재 해석된 모델 */}
      <Card className="p-5">
        <SectionHeader title="모델 정책과 현재 해석된 모델" />
        {detail.modelPolicy ? (
          <div className="space-y-1 text-body text-text-primary">
            <p>
              선언된 모델 Alias: <strong>{detail.modelPolicy.modelAlias}</strong>
            </p>
            <p className="text-caption text-text-secondary">
              Fallback 허용: {detail.modelPolicy.fallbackAllowed ? "예" : "아니오"}
              {detail.modelPolicy.maxContextTokens != null ? ` · 최대 Context Token: ${detail.modelPolicy.maxContextTokens}` : ""}
            </p>
          </div>
        ) : (
          <GapRow label="모델 정책" reason="이 자산의 Manifest에는 model_policy가 없습니다(Service가 아니거나 Manifest를 읽을 수 없음)." />
        )}
        <p className="mt-3 flex items-start gap-1.5 text-caption text-text-secondary">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
          {detail.resolvedModelNote}
        </p>
      </Card>

      {/* 요구 Runtime과 Client 버전 */}
      <Card className="p-5">
        <SectionHeader title="요구 Runtime과 Client 버전" />
        <GapRow label="요구 Runtime/Client 버전" reason={detail.runtimeRequirements.reason} />
      </Card>

      {/* 설치 용량과 자산 버전 / 검증·승인·Checksum 상태 */}
      <Card className="p-5">
        <SectionHeader title="설치 용량과 자산 버전 · 검증/승인/Checksum 상태" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-caption font-semibold text-text-muted">자산 버전</p>
            <p className="text-body text-text-primary">v{detail.version}</p>
          </div>
          <div>
            <p className="text-caption font-semibold text-text-muted">설치 용량 합계</p>
            <p className="text-body text-text-primary">{formatBytes(detail.installSizeBytes)}</p>
            <p className="text-caption text-text-muted">{detail.installSizeNote}</p>
          </div>
        </div>
        <div className="mt-3">
          <GapRow label="승인(Portal Version Status) 상태" reason={detail.approvalStatus.reason} />
        </div>
      </Card>

      {/* 실행 전 사전점검 */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-card-title font-semibold text-text-primary">실행 전 사전점검</h2>
          <Button variant="secondary" size="sm" onClick={() => void runPreflight()} disabled={preflightRunning}>
            <ListChecks size={14} /> {preflightRunning ? "확인 중..." : "사전점검 실행"}
          </Button>
        </div>
        <p className="mb-2 text-caption text-text-secondary">D09 연결 상태 확인과 동일한 검사를 재사용하고, 위 참조 대상의 설치 여부를 함께 확인합니다.</p>
        {preflightConnections && (
          <div className="space-y-1.5">
            {preflightConnections.map((c) => (
              <CheckRow key={c.id} label={c.label} status={c.ok ? "PASS" : "FAIL"} message={c.ok ? c.detail : `${c.detail} — ${c.recoveryHint ?? ""}`} />
            ))}
            {detail.bindings.map((b, idx) => (
              <CheckRow
                key={`binding-${idx}`}
                label={`${b.label} 설치 여부`}
                status={b.installed ? "PASS" : "FAIL"}
                message={b.installed ? `${b.assetId} v${b.version} 설치됨` : `${b.assetId} v${b.version}가 로컬에 설치되어 있지 않습니다.`}
              />
            ))}
          </div>
        )}
      </Card>

      {/* 행동: 실행 / 버전 전환 / 제거 */}
      <Card className="p-5">
        <SectionHeader title="행동" />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onGoToChat}>
            <MessageSquare size={14} /> 실행(대화로 이동)
          </Button>
          <Button variant="secondary" onClick={() => void openRemoval()}>
            <Trash2 size={14} /> 제거
          </Button>
        </div>

        {group && group.versions.length >= 2 && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 text-caption font-semibold text-text-muted">버전 전환</p>
            <div className="space-y-2">
              {group.versions.map((v) => {
                const disabledReason = activateDisabledReason(v);
                const label = activationActionLabel(group, v.version);
                return (
                  <div key={v.version} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                    <div className="flex items-center gap-2 text-caption">
                      <span className="font-medium text-text-primary">v{v.version}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ASSET_STATUS_TONE[v.status]}`}>{ASSET_STATUS_LABEL[v.status]}</span>
                      <span className="text-text-secondary">설치일 {formatDateTime(v.installedAt)}</span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={disabledReason !== null}
                      title={disabledReason ?? undefined}
                      onClick={() => {
                        setActivateError(null);
                        setActivateTarget(v);
                      }}
                    >
                      <ArrowLeftRight size={13} /> {label}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {group && group.versions.length < 2 && (
          <p className="mt-3 text-caption text-text-muted">이 자산은 현재 버전 1개만 설치되어 있어 전환할 대상이 없습니다.</p>
        )}
      </Card>

      <ReasonConfirmDialog
        open={activateTarget !== null}
        title="Active Version을 전환하시겠습니까?"
        description={activateTarget && <> <strong>{detail.name}</strong>을(를) v{activateTarget.version}으로 전환합니다. </>}
        confirmLabel="전환"
        reasonLabel="전환 사유"
        reasonPlaceholder="예: 새 버전 정상 확인 후 전환"
        danger={false}
        submitting={activating}
        error={activateError}
        onConfirm={(reason) => void confirmActivate(reason)}
        onCancel={() => setActivateTarget(null)}
      />

      <ReasonConfirmDialog
        open={removalOpen}
        title="자산을 제거하시겠습니까?"
        description={
          <div className="space-y-2">
            <p>
              <strong>{detail.name}</strong> (v{detail.version})를 로컬에서 제거합니다. 이 작업은 되돌릴 수 없습니다.
            </p>
            {removalChecking && <LoadingState label="참조 중인 Service와 진행 중인 Run을 확인하는 중..." />}
            {!removalChecking && removalBlocked && (
              <p className={removalBlocked.blocked ? "text-danger" : "text-text-secondary"}>{removalBlocked.note}</p>
            )}
          </div>
        }
        confirmLabel="제거"
        reasonLabel="제거 사유"
        reasonPlaceholder="예: 더 이상 사용하지 않는 버전 정리"
        submitting={removing || removalChecking}
        error={removeError}
        confirmDisabled={removalChecking || (removalBlocked?.blocked ?? false)}
        onConfirm={(reason) => void confirmRemoval(reason)}
        onCancel={() => setRemovalOpen(false)}
      />
    </div>
  );
}
