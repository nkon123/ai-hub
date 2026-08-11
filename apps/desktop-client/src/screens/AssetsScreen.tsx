// D08 로컬 자산 관리(자산 허브 > 설치된 자산) — 설치된 자산의 필터·상세
// Manifest·Checksum 재검사·의존 관계 보기, 그리고 "제거 전 참조 중인
// Service와 진행 중인 Run을 확인한다" 하드 규칙을 실제로 적용하는 화면.
//
// IA 재편(desktop-ia-restructure): 이전 D02(HomeScreen, "홈/설치된 자산")를
// 이 화면으로 통합했다 — HomeScreen은 이 화면의 진짜 부분집합이었다(필터·
// 정렬·상세 Manifest·Checksum 재검사·의존 관계·Active Version 전환이 전부
// 없었고, 목록 표시·상세 보기·제거만 있었다). HomeScreen에만 있던 두 가지는
// 이 화면으로 옮겨왔다: (1) 헤더의 설치 위치(`installRoot`) 표시, (2) 자산이
// *하나도* 없을 때(필터로 걸러진 게 아니라 정말 0개일 때) 빈 상태에 "Package
// 가져오기"로 바로 이동하는 액션 버튼. HomeScreen.tsx는 더 이상 쓰이지
// 않아 삭제했다(App.tsx가 더 이상 참조하지 않음).
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, FileSearch, Info, Network, Package, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type {
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  BindingKind,
  ChecksumVerification,
  InstalledAssetWithStatus,
} from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import {
  Button,
  BridgeUnavailableState,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  Modal,
  PageHeader,
  ReasonConfirmDialog,
} from "../ui";
import { assetTypeLabel, formatBytes, formatDateTime } from "../format";
import { ASSET_STATUS_LABEL as STATUS_LABEL, ASSET_STATUS_TONE as STATUS_TONE } from "./assetStatusLabels";
import {
  ASSET_STATUS_OPTIONS,
  ASSET_TYPE_OPTIONS,
  emptyAssetFilters,
  filterInstalledAssets,
  sortInstalledAssets,
  type AssetFilters,
  type AssetSortKey,
} from "./assetsTypes";
import type { ServiceDetailTarget } from "./ServiceDetailScreen";

const BINDING_LABEL: Record<BindingKind, string> = {
  agent_ref: "Agent 참조",
  knowledge_bindings: "Knowledge 연결",
  mcp_bindings: "MCP Tool 연결",
  prompt_bindings: "Prompt 연결",
};

const SORT_OPTIONS: Array<{ key: AssetSortKey; label: string }> = [
  { key: "installedAt", label: "설치일" },
  { key: "version", label: "버전" },
  { key: "sizeBytes", label: "크기" },
];

function TogglePill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
        active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-border bg-white text-text-secondary hover:bg-background"
      }`}
    >
      {children}
    </button>
  );
}

function assetKey(a: { assetType: string; assetId: string; version: string }): string {
  return `${a.assetType}::${a.assetId}::${a.version}`;
}

/** D12/D-068 — mirrors the guard `electron/asset-management.ts::activateAssetVersion`
 * already enforces server-side (defense in depth: the button itself never
 * offers a choice the backend would reject anyway, but the backend re-checks
 * regardless of what the UI disables). `null` = activation is allowed. */
function activateVersionDisabledReason(asset: InstalledAssetWithStatus): string | null {
  if (asset.status === "ACTIVE") return "이미 Active 버전입니다.";
  if (asset.status === "REVOKED") return "회수(Revoked)된 버전은 Active로 전환할 수 없습니다.";
  if (asset.status === "INVALID") return "Checksum 재검사에 실패한(Invalid) 버전은 Active로 전환할 수 없습니다. 다시 반입하세요.";
  return null;
}

export function AssetsScreen({
  onOpenDetail,
  onGoToImport,
}: {
  onOpenDetail: (target: ServiceDetailTarget) => void;
  /** HomeScreen(D02)에서 옮겨온 빈 상태 빠른 진입 — 반입된 자산이 하나도
   * 없을 때 "Package 가져오기"로 바로 이동한다. */
  onGoToImport: () => void;
}) {
  const bridge = getDesktopBridge();
  const [assets, setAssets] = useState<InstalledAssetWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AssetFilters>(emptyAssetFilters());
  const [sortKey, setSortKey] = useState<AssetSortKey>("installedAt");
  // HomeScreen(D02)에서 옮겨온 설치 위치 표시.
  const [installRoot, setInstallRoot] = useState<string | null>(null);

  const [manifestTarget, setManifestTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [manifestResult, setManifestResult] = useState<AssetManifestResult | null>(null);

  const [dependencyTarget, setDependencyTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [dependencyView, setDependencyView] = useState<AssetDependencyView | null>(null);

  const [checksumBusy, setChecksumBusy] = useState<Set<string>>(new Set());
  const [checksumMessage, setChecksumMessage] = useState<Record<string, ChecksumVerification>>({});

  const [removalTarget, setRemovalTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [removalCheck, setRemovalCheck] = useState<AssetRemovalCheck | null>(null);
  const [removalChecking, setRemovalChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // CLAUDE.md: 제거는 확인과 사유를 요구한다 — 이 Modal은 참조/Run 정보를
  // 함께 보여줘야 해서 `ReasonConfirmDialog`를 그대로 쓰지 않고 자체 Modal에
  // 같은 필수-사유 규칙만 이식했다.
  const [removeReason, setRemoveReason] = useState("");

  // D12/D-068: "Active Version 전환" — now that an Active Pointer exists,
  // this button actually flips it (previously permanently disabled with a
  // reason; see open-decisions.md D-068). CLAUDE.md requires confirm+사유 for
  // this (같은 원칙을 제거와 동일하게 적용), so clicking it opens a dialog
  // rather than acting immediately.
  const [activateTarget, setActivateTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      setAssets(await bridge.listInstalledAssets());
    } catch (err) {
      setError(err instanceof Error ? err.message : "설치된 자산 목록을 불러오지 못했습니다.");
      setAssets([]);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!bridge) return;
    bridge.getInstallRootPath().then(setInstallRoot).catch(() => setInstallRoot(null));
  }, [bridge]);

  const visibleAssets = useMemo(() => {
    if (!assets) return [];
    return sortInstalledAssets(filterInstalledAssets(assets, filters), sortKey);
  }, [assets, filters, sortKey]);

  function toggleFilter<K extends "assetTypes" | "statuses">(key: K, value: string) {
    setFilters((prev) => {
      const next = new Set(prev[key] as Set<string>);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  }

  async function openManifest(asset: InstalledAssetWithStatus) {
    setManifestTarget(asset);
    setManifestResult(null);
    if (!bridge) return;
    const result = await bridge.getAssetManifest(asset.assetType, asset.assetId, asset.version);
    setManifestResult(result);
  }

  async function openDependencies(asset: InstalledAssetWithStatus) {
    setDependencyTarget(asset);
    setDependencyView(null);
    if (!bridge) return;
    const view = await bridge.getAssetDependencies(asset.assetType, asset.assetId, asset.version);
    setDependencyView(view);
  }

  async function runChecksumReverify(asset: InstalledAssetWithStatus) {
    if (!bridge) return;
    const key = assetKey(asset);
    setChecksumBusy((prev) => new Set(prev).add(key));
    try {
      const outcome = await bridge.reverifyAssetChecksum(asset.assetType, asset.assetId, asset.version);
      if (outcome.available && outcome.result) {
        setChecksumMessage((prev) => ({ ...prev, [key]: outcome.result! }));
        await load(); // status(REVOKED는 아니지만 INVALID)가 바뀔 수 있으므로 새로고침
      } else {
        setError(outcome.reason ?? "Checksum 재검사를 실행할 수 없습니다.");
      }
    } finally {
      setChecksumBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function confirmActivate(reason: string) {
    if (!activateTarget || !bridge) return;
    setActivating(true);
    try {
      const result = await bridge.activateAssetVersion(
        activateTarget.assetType,
        activateTarget.assetId,
        activateTarget.version,
        reason,
      );
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

  async function openRemovalDialog(asset: InstalledAssetWithStatus) {
    setRemovalTarget(asset);
    setRemovalCheck(null);
    setRemoveError(null);
    setRemoveReason("");
    if (!bridge) return;
    setRemovalChecking(true);
    try {
      const check = await bridge.checkAssetRemoval(asset.assetType, asset.assetId, asset.version);
      setRemovalCheck(check);
    } finally {
      setRemovalChecking(false);
    }
  }

  async function confirmRemoval() {
    if (!removalTarget || !bridge || !removeReason.trim()) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await bridge.removeInstalledAsset(
        removalTarget.assetType,
        removalTarget.assetId,
        removalTarget.version,
        removeReason.trim(),
      );
      if (!result.ok) {
        setRemoveError(result.error ?? "제거 중 오류가 발생했습니다.");
        return;
      }
      setRemovalTarget(null);
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "제거 중 오류가 발생했습니다.");
    } finally {
      setRemoving(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="설치된 자산" />
        <BridgeUnavailableState detail="설치된 자산의 상세 관리(Manifest 보기, Checksum 재검사, 제거)는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="설치된 자산"
        description={
          installRoot
            ? `설치된 Service/Agent/Knowledge/Prompt/MCP 설정을 확인하고 관리합니다. 설치 위치: ${installRoot}`
            : "설치된 Service/Agent/Knowledge/Prompt/MCP 설정을 확인하고 관리합니다."
        }
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} /> 새로고침
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {assets !== null && (
        <Card className="mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-semibold text-text-muted">자산 유형</span>
            {ASSET_TYPE_OPTIONS.map((t) => (
              <TogglePill key={t} active={filters.assetTypes.has(t)} onClick={() => toggleFilter("assetTypes", t)}>
                {assetTypeLabel(t)}
              </TogglePill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-semibold text-text-muted">상태</span>
            {ASSET_STATUS_OPTIONS.map((s) => (
              <TogglePill key={s} active={filters.statuses.has(s)} onClick={() => toggleFilter("statuses", s)}>
                {STATUS_LABEL[s]}
              </TogglePill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-semibold text-text-muted">정렬</span>
            {SORT_OPTIONS.map((opt) => (
              <TogglePill key={opt.key} active={sortKey === opt.key} onClick={() => setSortKey(opt.key)}>
                {opt.label}
              </TogglePill>
            ))}
          </div>
        </Card>
      )}

      {assets === null && <LoadingState label="설치된 자산을 확인하는 중..." />}

      {assets !== null && assets.length === 0 && (
        <EmptyState
          title="반입된 자산이 없습니다"
          description="Offline Bundle을 반입하면 이곳에 표시됩니다."
          action={
            <Button onClick={onGoToImport}>
              <Package size={14} /> Package 가져오기
            </Button>
          }
        />
      )}

      {assets !== null && assets.length > 0 && visibleAssets.length === 0 && (
        <EmptyState title="조건에 맞는 자산이 없습니다" description="필터를 초기화하거나 다른 조건을 선택해 보세요." />
      )}

      {visibleAssets.length > 0 && (
        <div className="space-y-3">
          {visibleAssets.map((asset) => {
            const key = assetKey(asset);
            const busy = checksumBusy.has(key);
            const lastCheck = checksumMessage[key] ?? asset.checksumVerification ?? null;
            const canReverify = !!asset.fileChecksums && Object.keys(asset.fileChecksums).length > 0;
            return (
              <Card key={key} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-card-title font-medium text-text-primary">{asset.name}</span>
                      <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                        {assetTypeLabel(asset.assetType)}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-text-secondary">
                        v{asset.version}
                      </span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[asset.status]}`}>
                        {STATUS_LABEL[asset.status]}
                      </span>
                    </div>
                    <p className="mt-1 text-caption text-text-secondary">
                      설치일 {formatDateTime(asset.installedAt)} · {formatBytes(asset.sizeBytes)}
                    </p>
                    {lastCheck && (
                      <p
                        className={`mt-1 text-caption ${lastCheck.result === "PASS" ? "text-success" : "text-danger"}`}
                      >
                        마지막 Checksum 재검사: {lastCheck.result === "PASS" ? "일치" : "불일치"} (
                        {formatDateTime(lastCheck.checkedAt)})
                        {lastCheck.result === "FAIL" && lastCheck.mismatched.length > 0
                          ? ` — 변조/손상 의심 파일: ${lastCheck.mismatched.slice(0, 3).join(", ")}`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenDetail({ assetType: asset.assetType, assetId: asset.assetId, version: asset.version })}
                  >
                    <Info size={14} /> 상세 보기
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void openManifest(asset)}>
                    <FileSearch size={14} /> 상세 Manifest
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canReverify || busy}
                    title={canReverify ? undefined : "설치 당시 Checksum 정보가 없어 재검사를 실행할 수 없습니다(다시 반입 필요)."}
                    onClick={() => void runChecksumReverify(asset)}
                  >
                    <ShieldCheck size={14} /> {busy ? "재검사 중..." : "Checksum 재검사"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled
                    title="자산 유형별 Smoke Test 절차가 아직 정의되지 않았습니다(open-decisions.md D-069)."
                  >
                    <Eye size={14} /> Smoke Test
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={activateVersionDisabledReason(asset) !== null}
                    title={activateVersionDisabledReason(asset) ?? undefined}
                    onClick={() => {
                      setActivateError(null);
                      setActivateTarget(asset);
                    }}
                  >
                    Active Version 전환
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void openDependencies(asset)}>
                    <Network size={14} /> 의존 관계
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void openRemovalDialog(asset)}>
                    <Trash2 size={14} /> 제거
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={manifestTarget !== null} title={`상세 Manifest — ${manifestTarget?.name ?? ""}`} onClose={() => setManifestTarget(null)}>
        {manifestResult === null && <LoadingState label="Manifest를 불러오는 중..." />}
        {manifestResult !== null && !manifestResult.available && (
          <div className="flex items-start gap-2 text-body text-text-secondary">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <span>{manifestResult.reason}</span>
          </div>
        )}
        {manifestResult !== null && manifestResult.available && (
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-background p-3 text-xs text-text-primary">
            {JSON.stringify(manifestResult.manifest, null, 2)}
          </pre>
        )}
      </Modal>

      <Modal
        open={dependencyTarget !== null}
        title={`의존 관계 — ${dependencyTarget?.name ?? ""}`}
        onClose={() => setDependencyTarget(null)}
      >
        {dependencyView === null && <LoadingState label="의존 관계를 불러오는 중..." />}
        {dependencyView !== null && (
          <div className="space-y-4">
            <div>
              <h4 className="mb-1.5 text-caption font-semibold text-text-muted">이 자산이 참조하는 대상</h4>
              {dependencyView.forwardNote && (
                <p className="mb-2 flex items-start gap-2 text-caption text-text-secondary">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                  {dependencyView.forwardNote}
                </p>
              )}
              {dependencyView.forward.length === 0 && !dependencyView.forwardNote && (
                <p className="text-caption text-text-secondary">참조하는 대상이 없습니다.</p>
              )}
              {dependencyView.forward.length > 0 && (
                <ul className="space-y-1.5">
                  {dependencyView.forward.map((d, idx) => (
                    <li key={idx} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-caption">
                      <span>
                        {d.label} · {d.assetId} v{d.version}
                      </span>
                      <span className={d.installed ? "text-success" : "text-danger"}>{d.installed ? "설치됨" : "미설치"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="mb-1.5 text-caption font-semibold text-text-muted">이 자산을 참조하는 Service</h4>
              {dependencyView.referencedBy.length === 0 && (
                <p className="text-caption text-text-secondary">참조하는 Service가 없습니다.</p>
              )}
              {dependencyView.referencedBy.length > 0 && (
                <ul className="space-y-1.5">
                  {dependencyView.referencedBy.map((s, idx) => (
                    <li key={idx} className="rounded-lg border border-border px-3 py-2 text-caption">
                      {s.name} v{s.version} ({BINDING_LABEL[s.via]})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={removalTarget !== null} title="자산을 제거하시겠습니까?" onClose={() => (!removing ? setRemovalTarget(null) : undefined)}>
        {removalTarget && (
          <div className="space-y-3">
            <p>
              <strong>{removalTarget.name}</strong> (v{removalTarget.version})를 로컬에서 제거합니다. 이 작업은 되돌릴 수 없습니다.
            </p>

            {removalChecking && <LoadingState label="참조 중인 Service와 진행 중인 Run을 확인하는 중..." />}

            {!removalChecking && removalCheck && (
              <div className="space-y-2">
                {removalCheck.referencingServices.length > 0 && (
                  <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-caption text-danger">
                    <p className="font-semibold">다음 Service가 이 자산을 참조하고 있어 제거할 수 없습니다:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {removalCheck.referencingServices.map((s, idx) => (
                        <li key={idx}>
                          {s.name} v{s.version} ({BINDING_LABEL[s.via]})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {removalCheck.activeVersionNote && (
                  <div
                    className={`rounded-lg border p-3 text-caption ${
                      removalCheck.blockedByActiveVersion
                        ? "border-danger/30 bg-danger/5 text-danger"
                        : "border-border text-text-secondary"
                    }`}
                  >
                    {removalCheck.activeVersionNote}
                  </div>
                )}
                <div
                  className={`rounded-lg border p-3 text-caption ${
                    removalCheck.runCheckAvailable ? "border-border text-text-secondary" : "border-warning/30 bg-warning/5 text-warning"
                  }`}
                >
                  {removalCheck.runCheckNote}
                </div>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-caption font-medium text-text-secondary" htmlFor="removal-reason-input">
                제거 사유 <span className="text-danger">*</span>
              </label>
              <textarea
                id="removal-reason-input"
                value={removeReason}
                onChange={(e) => setRemoveReason(e.target.value)}
                placeholder="예: 더 이상 사용하지 않는 버전 정리"
                rows={2}
                disabled={removing}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-body text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
              />
            </div>

            {removeError && <ErrorBanner message={removeError} />}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setRemovalTarget(null)} disabled={removing}>
                취소
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmRemoval()}
                disabled={removing || removalChecking || !removeReason.trim() || (removalCheck?.blocked ?? false)}
              >
                {removing ? "제거 중..." : "제거"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ReasonConfirmDialog
        open={activateTarget !== null}
        title="Active Version을 전환하시겠습니까?"
        description={
          activateTarget && (
            <>
              <strong>{activateTarget.name}</strong>을(를) v{activateTarget.version}으로 전환합니다. 이 버전이 대화·실행에서
              새로 사용됩니다.
            </>
          )
        }
        confirmLabel="전환"
        reasonLabel="전환 사유"
        reasonPlaceholder="예: 새 버전 정상 확인 후 전환"
        danger={false}
        submitting={activating}
        error={activateError}
        onConfirm={(reason) => void confirmActivate(reason)}
        onCancel={() => setActivateTarget(null)}
      />
    </div>
  );
}
