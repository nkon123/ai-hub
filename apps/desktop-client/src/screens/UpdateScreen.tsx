// D12 업데이트/복구 (`02-desktop-and-agent-runtime.md` §D12).
//
// D12가 요구하는 7개 동작과 이 화면이 어떻게 충족하는지:
//  1. 새로운 Offline Bundle 가져오기 — D04(`bundle:import`/`importBundle()`)를
//     그대로 재사용한다(새 설치 파이프라인을 만들지 않음). 설치되면 아래
//     목록이 새로고침되어 새 버전이 나타난다.
//  2. 현재와 새 버전 Diff — `diffAssetVersions`(Manifest/Dependency/Permission
//     3축, `electron/version-diff.ts`).
//  3. 호환성 사전검사 — 방금 가져오기에서 나온 RUNTIME_COMPAT 체크 결과를
//     그대로 보여준다(재구현하지 않음, `bundle-install.ts`가 이미 계산).
//  4. 새 버전 임시 설치 — 설치 레이아웃이 이미 버전별로 나란히 설치하므로
//     "임시 설치"는 그냥 "설치"다(전환 전까지 Active가 되지 않을 뿐).
//     Smoke Test는 정의가 없어 비활성화(D-069, 아래 참고).
//  5. Active Pointer 전환 / 6. 이전 버전 Rollback — 동일한
//     `activateAssetVersion` 호출(`ActiveVersionStore.set`), 대상이 현재보다
//     오래된 버전이면 라벨만 "Rollback"으로 바뀐다(`updateTypes.ts`).
//  7. 실패 설치 정리 — `cleanupOrphanedInstalls`(멱등, Store에 없는 설치
//     디렉터리 제거).
//
// Smoke Test는 이 화면에서도 여전히 비활성화 상태다 — D08과 동일한 이유
// (open-decisions.md D-069: 자산 유형별 절차/결과 계약이 정의되지 않음).
// D12가 Smoke Test에 의존하는 구조라는 사실 자체를 D-069에 기록해 두었다.
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Eye,
  FolderOpen,
  GitCompare,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  AssetVersionDiffResponse,
  ImportProgressEvent,
  ImportResult,
  InstalledAssetWithStatus,
  OrphanedInstallCleanupResult,
} from "../../electron/types";
import { STAGE_LABELS } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import {
  Button,
  BridgeUnavailableState,
  Card,
  CheckRow,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  ReasonConfirmDialog,
} from "../ui";
import { assetTypeLabel, formatBytes, formatDateTime } from "../format";
import { ASSET_STATUS_LABEL, ASSET_STATUS_TONE } from "./assetStatusLabels";
import {
  activateDisabledReason,
  activationActionLabel,
  findActiveVersion,
  groupInstalledAssetsByAssetId,
  switchableGroups,
  type AssetVersionGroup,
} from "./updateTypes";

const AXIS_LABEL: Record<"dependency" | "permission" | "manifest", string> = {
  dependency: "Dependency",
  permission: "Permission",
  manifest: "Manifest",
};

const CHANGE_LABEL: Record<"added" | "removed" | "changed", string> = {
  added: "추가됨",
  removed: "제거됨",
  changed: "변경됨",
};

export function UpdateScreen({ onGoToImport }: { onGoToImport: () => void }) {
  const bridge = getDesktopBridge();

  // --- 1. 새 Bundle 가져오기 (D04 재사용) -------------------------------------
  const [importPhase, setImportPhase] = useState<"IDLE" | "RUNNING" | "DONE">("IDLE");
  const [importEvents, setImportEvents] = useState<ImportProgressEvent[]>([]);
  const [lastImportResult, setLastImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onImportProgress((event) => {
      setImportEvents((prev) => [...prev.filter((e) => e.stage !== event.stage), event]);
    });
  }, [bridge]);

  async function handleImport() {
    if (!bridge) return;
    setImportError(null);
    try {
      const filePath = await bridge.pickBundleFile();
      if (!filePath) return;
      setImportPhase("RUNNING");
      setImportEvents([]);
      setLastImportResult(null);
      const result = await bridge.importBundle(filePath);
      setLastImportResult(result);
      if (result.outcome === "SUCCESS") await load();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "가져오기 중 알 수 없는 오류가 발생했습니다.");
    } finally {
      setImportPhase("DONE");
    }
  }

  const runtimeCompatCheck = lastImportResult?.checks.find((c) => c.id === "RUNTIME_COMPAT") ?? null;

  // --- 자산 그룹 목록 ----------------------------------------------------------
  const [assets, setAssets] = useState<InstalledAssetWithStatus[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) return;
    setListError(null);
    try {
      setAssets(await bridge.listInstalledAssets());
    } catch (err) {
      setListError(err instanceof Error ? err.message : "설치된 자산 목록을 불러오지 못했습니다.");
      setAssets([]);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = assets ? groupInstalledAssetsByAssetId(assets) : [];
  const candidateGroups = switchableGroups(groups);

  // --- 2. Diff 대상 선택 -------------------------------------------------------
  const [selectedGroupKey, setSelectedGroupKey] = useState<string>("");
  const selectedGroup: AssetVersionGroup | null =
    candidateGroups.find((g) => `${g.assetType}::${g.assetId}` === selectedGroupKey) ?? null;
  const [fromVersion, setFromVersion] = useState("");
  const [toVersion, setToVersion] = useState("");
  const [diff, setDiff] = useState<AssetVersionDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    // Selecting a new group resets the version pickers to (older active,
    // newer non-active) as a sensible default — never guesses across groups.
    if (!selectedGroup) {
      setFromVersion("");
      setToVersion("");
      setDiff(null);
      return;
    }
    const active = findActiveVersion(selectedGroup);
    const other = selectedGroup.versions.find((v) => v !== active) ?? selectedGroup.versions[0];
    setFromVersion(active?.version ?? selectedGroup.versions[1]?.version ?? "");
    setToVersion(other?.version ?? "");
    setDiff(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupKey]);

  async function runDiff() {
    if (!bridge || !selectedGroup || !fromVersion || !toVersion) return;
    setDiffLoading(true);
    setDiff(null);
    try {
      const result = await bridge.diffAssetVersions(selectedGroup.assetType, selectedGroup.assetId, fromVersion, toVersion);
      setDiff(result);
    } finally {
      setDiffLoading(false);
    }
  }

  // --- 5/6. Active Pointer 전환 / Rollback ------------------------------------
  // CLAUDE.md: 전환/Rollback은 확인과 사유를 요구한다 — 대상 버전을 고르는
  // 즉시 실행하지 않고 confirm+사유 Dialog를 연다(D08 AssetsScreen과 동일한
  // 패턴).
  const [activateTarget, setActivateTarget] = useState<{ group: AssetVersionGroup; version: string } | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  async function confirmActivate(reason: string) {
    if (!bridge || !activateTarget) return;
    setActivating(true);
    try {
      const result = await bridge.activateAssetVersion(
        activateTarget.group.assetType,
        activateTarget.group.assetId,
        activateTarget.version,
        reason,
      );
      if (!result.ok) {
        setActivateError(result.error ?? "Active Pointer 전환에 실패했습니다.");
        return;
      }
      setActivateTarget(null);
      await load();
    } finally {
      setActivating(false);
    }
  }

  // --- 7. 실패 설치 정리 --------------------------------------------------------
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<OrphanedInstallCleanupResult | null>(null);

  async function runCleanup() {
    if (!bridge) return;
    setCleaning(true);
    setCleanupResult(null);
    try {
      const result = await bridge.cleanupOrphanedInstalls();
      setCleanupResult(result);
      if (result.removed.length > 0) await load();
    } finally {
      setCleaning(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="업데이트/복구" description="새 Package 설치, Active 전환, Rollback을 관리합니다." />
        <BridgeUnavailableState detail="업데이트/복구 기능은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="업데이트/복구"
        description="새 Offline Bundle 가져오기, 현재/새 버전 Diff, Active Pointer 전환, Rollback을 한 화면에서 관리합니다."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} /> 새로고침
          </Button>
        }
      />

      {/* 1. 새 Bundle 가져오기 */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-card-title font-semibold text-text-primary">1. 새로운 Offline Bundle 가져오기</h2>
          <Button size="sm" onClick={() => void handleImport()} disabled={importPhase === "RUNNING"}>
            <FolderOpen size={14} /> 파일 선택 및 가져오기
          </Button>
        </div>
        <p className="text-caption text-text-secondary">
          기존 버전은 그대로 유지된 채 새 버전이 나란히 설치됩니다(설치 레이아웃이 버전별로 이미 분리되어 있음) — 아래 2~5단계를
          거쳐야 실제로 Active 버전이 바뀝니다.
        </p>
        {importError && (
          <div className="mt-3">
            <ErrorBanner message={importError} />
          </div>
        )}
        {importEvents.length > 0 && importPhase === "RUNNING" && (
          <div className="mt-3 space-y-1.5">
            {importEvents.map((e) => (
              <CheckRow key={e.stage} label={STAGE_LABELS[e.stage]} status={e.status} message={e.message} />
            ))}
          </div>
        )}
        {lastImportResult && importPhase === "DONE" && (
          <div
            className={`mt-3 rounded-lg border p-3 text-caption ${
              lastImportResult.outcome === "SUCCESS" ? "border-success/30 bg-success/5 text-success" : "border-danger/30 bg-danger/5 text-danger"
            }`}
          >
            {lastImportResult.outcome === "SUCCESS"
              ? `설치 완료 — ${lastImportResult.installPlan.length}개 자산, 총 ${formatBytes(lastImportResult.totalSizeBytes)}.`
              : `설치 실패 — 단계: ${lastImportResult.failedStage ?? "미상"}. 자세한 내용은 '가져오기' 탭에서 확인하세요.`}
          </div>
        )}
      </Card>

      {/* 3. 호환성 사전검사 (재구현 없이 최근 가져오기 결과 재사용) */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">2. 호환성 사전검사</h2>
        {runtimeCompatCheck ? (
          <CheckRow label={runtimeCompatCheck.label} status={runtimeCompatCheck.status} message={runtimeCompatCheck.message} />
        ) : (
          <p className="text-caption text-text-secondary">
            이번 세션에서 아직 가져온 Bundle이 없습니다 — 위 1단계에서 가져오면 이 Bundle의 Runtime/OS 호환성 검사 결과(D04에서
            이미 계산됨)가 여기 표시됩니다.
          </p>
        )}
      </Card>

      {/* 4. Smoke Test — D-069에 따라 비활성화 */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-card-title font-semibold text-text-primary">3. 새 버전 Smoke Test</h2>
          <Button
            variant="secondary"
            size="sm"
            disabled
            title="자산 유형별 Smoke Test 절차와 결과 계약이 아직 정의되지 않았습니다(open-decisions.md D-069). 정의 없이 임의 검사를 돌려 PASS/FAIL을 표시하지 않습니다."
          >
            <Eye size={14} /> Smoke Test
          </Button>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-caption text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Smoke Test는 정의되지 않아 비활성화되어 있습니다(D-069). Active Pointer 전환 전에 새 버전이 정상 동작하는지는 현재
          운영자가 직접 확인해야 합니다.
        </p>
      </Card>

      {/* 2/5/6. Diff + Active Pointer 전환/Rollback */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">4. 버전 비교 및 Active Pointer 전환 / Rollback</h2>

        {assets === null && <LoadingState label="설치된 자산을 확인하는 중..." />}
        {listError && <ErrorBanner message={listError} />}

        {assets !== null && candidateGroups.length === 0 && (
          <EmptyState
            title="전환/Rollback할 수 있는 자산이 없습니다"
            description="같은 자산의 버전이 2개 이상 설치되어 있어야 Diff와 Active Pointer 전환이 가능합니다. 위 1단계에서 새 버전을 먼저 가져오세요."
            action={
              <Button variant="secondary" onClick={onGoToImport}>
                <FolderOpen size={14} /> 가져오기 화면으로 이동
              </Button>
            }
          />
        )}

        {candidateGroups.length > 0 && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-caption font-medium text-text-secondary" htmlFor="update-group-select">
                자산 선택
              </label>
              <select
                id="update-group-select"
                value={selectedGroupKey}
                onChange={(e) => setSelectedGroupKey(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-body text-text-primary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">선택하세요</option>
                {candidateGroups.map((g) => (
                  <option key={`${g.assetType}::${g.assetId}`} value={`${g.assetType}::${g.assetId}`}>
                    {g.name} ({assetTypeLabel(g.assetType)}) — 설치된 버전 {g.versions.length}개
                  </option>
                ))}
              </select>
            </div>

            {selectedGroup && (
              <>
                <div className="space-y-2">
                  {selectedGroup.versions.map((v) => {
                    const disabledReason = activateDisabledReason(v);
                    const label = activationActionLabel(selectedGroup, v.version);
                    return (
                      <div
                        key={v.version}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-body font-medium text-text-primary">v{v.version}</span>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ASSET_STATUS_TONE[v.status]}`}>
                            {ASSET_STATUS_LABEL[v.status]}
                          </span>
                          <span className="text-caption text-text-secondary">
                            설치일 {formatDateTime(v.installedAt)} · {formatBytes(v.sizeBytes)}
                          </span>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={disabledReason !== null}
                          title={disabledReason ?? undefined}
                          onClick={() => {
                            setActivateError(null);
                            setActivateTarget({ group: selectedGroup, version: v.version });
                          }}
                        >
                          <ArrowLeftRight size={14} />
                          {`${label === "Rollback" ? "이전 버전으로 " : "Active로 "}${label}`}
                        </Button>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-border pt-4">
                  <p className="mb-2 text-caption font-semibold text-text-muted">현재와 새 버전 Diff</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={fromVersion}
                      onChange={(e) => setFromVersion(e.target.value)}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-caption text-text-primary"
                    >
                      {selectedGroup.versions.map((v) => (
                        <option key={v.version} value={v.version}>
                          기준: v{v.version}
                        </option>
                      ))}
                    </select>
                    <GitCompare size={14} className="text-text-muted" />
                    <select
                      value={toVersion}
                      onChange={(e) => setToVersion(e.target.value)}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-caption text-text-primary"
                    >
                      {selectedGroup.versions.map((v) => (
                        <option key={v.version} value={v.version}>
                          대상: v{v.version}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={diffLoading || !fromVersion || !toVersion || fromVersion === toVersion}
                      onClick={() => void runDiff()}
                    >
                      {diffLoading ? "비교 중..." : "Diff 보기"}
                    </Button>
                  </div>

                  {diff && !diff.available && (
                    <p className="mt-3 flex items-start gap-1.5 text-caption text-warning">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      {diff.reason}
                    </p>
                  )}
                  {diff && diff.available && diff.diff && !diff.diff.hasChanges && (
                    <p className="mt-3 text-caption text-text-secondary">두 버전 사이에 Manifest 차이가 없습니다.</p>
                  )}
                  {diff && diff.available && diff.diff && diff.diff.hasChanges && (
                    <div className="mt-3 space-y-1.5">
                      {diff.diff.entries.map((entry, idx) => (
                        <div key={idx} className="rounded-lg border border-border px-3 py-2 text-caption">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
                              {AXIS_LABEL[entry.axis]}
                            </span>
                            <span className="font-medium text-text-primary">{entry.field}</span>
                            <span className="text-text-muted">{CHANGE_LABEL[entry.changeType]}</span>
                          </div>
                          <div className="mt-1 grid grid-cols-1 gap-1 text-text-secondary sm:grid-cols-2">
                            <div className="break-all">이전: {entry.oldValue ?? "(없음)"}</div>
                            <div className="break-all">이후: {entry.newValue ?? "(없음)"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      {/* 7. 실패 설치 정리 */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-card-title font-semibold text-text-primary">5. 실패 설치 정리</h2>
          <Button variant="secondary" size="sm" onClick={() => void runCleanup()} disabled={cleaning}>
            <Trash2 size={14} /> {cleaning ? "정리 중..." : "정리 실행"}
          </Button>
        </div>
        <p className="mt-2 text-caption text-text-secondary">
          완결되지 못한 설치(설치 도중 중단되어 자산 목록에 기록되지 않은 디렉터리)를 제거합니다. 언제든 안전하게 다시 실행할 수
          있습니다 — 정리할 것이 없으면 아무 것도 하지 않습니다.
        </p>
        {cleanupResult && (
          <div className="mt-3">
            {cleanupResult.removed.length === 0 ? (
              <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                <Sparkles size={13} /> 정리할 항목이 없습니다.
              </p>
            ) : (
              <ul className="space-y-1 text-caption text-text-secondary">
                {cleanupResult.removed.map((r, idx) => (
                  <li key={idx}>
                    · {assetTypeLabel(r.assetType)} {r.assetId} v{r.version} 제거됨
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <ReasonConfirmDialog
        open={activateTarget !== null}
        title={
          activateTarget && activationActionLabel(activateTarget.group, activateTarget.version) === "Rollback"
            ? "이전 버전으로 Rollback하시겠습니까?"
            : "Active Version을 전환하시겠습니까?"
        }
        description={
          activateTarget && (
            <>
              <strong>{activateTarget.group.name}</strong>을(를) v{activateTarget.version}으로 전환합니다. 이 버전이
              대화·실행에서 새로 사용됩니다.
            </>
          )
        }
        confirmLabel={activateTarget ? activationActionLabel(activateTarget.group, activateTarget.version) : undefined}
        reasonLabel="사유"
        reasonPlaceholder="예: 새 버전 정상 확인 후 전환 / 문제 발생으로 이전 버전 복귀"
        danger={false}
        submitting={activating}
        error={activateError}
        onConfirm={(reason) => void confirmActivate(reason)}
        onCancel={() => setActivateTarget(null)}
      />
    </div>
  );
}
