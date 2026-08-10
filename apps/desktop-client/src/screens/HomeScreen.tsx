// D02 홈 / 설치된 자산 목록.
import { useCallback, useEffect, useState } from "react";
import { Info, Package, RefreshCw, Trash2 } from "lucide-react";
import type { InstalledAssetWithStatus } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, EmptyState, ErrorBanner, LoadingState, PageHeader, ReasonConfirmDialog } from "../ui";
import { assetTypeLabel, formatBytes, formatDateTime } from "../format";
import { ASSET_STATUS_LABEL, ASSET_STATUS_TONE } from "./assetStatusLabels";
import type { ServiceDetailTarget } from "./ServiceDetailScreen";

export function HomeScreen({
  onGoToImport,
  onOpenDetail,
}: {
  onGoToImport: () => void;
  /** D03 진입점 — "상세 보기" (§D02 행동 목록). */
  onOpenDetail: (target: ServiceDetailTarget) => void;
}) {
  const bridge = getDesktopBridge();
  // D12/D-068: `listInstalledAssets()` already returns the computed
  // Active/Inactive/Invalid/Revoked status — D02 now shows it (see
  // `open-decisions.md` D-068) instead of only ever listing raw install
  // records with no indication of which version is actually in use.
  const [assets, setAssets] = useState<InstalledAssetWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<InstalledAssetWithStatus | null>(null);
  const [removing, setRemoving] = useState(false);
  const [installRoot, setInstallRoot] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      const list = await bridge.listInstalledAssets();
      setAssets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "설치된 자산 목록을 불러오지 못했습니다.");
      setAssets([]);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void load();
    bridge.getInstallRootPath().then(setInstallRoot).catch(() => setInstallRoot(null));
  }, [bridge, load]);

  async function handleConfirmRemove(reason: string) {
    if (!pendingRemoval || !bridge) return;
    setRemoving(true);
    try {
      const result = await bridge.removeInstalledAsset(
        pendingRemoval.assetType,
        pendingRemoval.assetId,
        pendingRemoval.version,
        reason,
      );
      if (!result.ok) {
        setError(result.error ?? "제거 중 오류가 발생했습니다.");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "제거 중 오류가 발생했습니다.");
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader
          title="홈 / 설치된 자산"
          actions={
            <Button variant="secondary" disabled title="Desktop 런타임이 연결되어 있지 않습니다">
              <RefreshCw size={14} /> 새로고침
            </Button>
          }
        />
        <BridgeUnavailableState detail="설치된 자산 목록 조회와 제거는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="홈 / 설치된 자산"
        description={installRoot ? `설치 위치: ${installRoot}` : undefined}
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

      {assets !== null && assets.length > 0 && (
        <div className="space-y-3">
          {assets.map((asset) => (
            <Card
              key={`${asset.assetType}-${asset.assetId}-${asset.version}`}
              className="flex items-center justify-between px-5 py-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-card-title font-medium text-text-primary">{asset.name}</span>
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                    {assetTypeLabel(asset.assetType)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-text-secondary">
                    v{asset.version}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ASSET_STATUS_TONE[asset.status]}`}>
                    {ASSET_STATUS_LABEL[asset.status]}
                  </span>
                </div>
                <p className="mt-1 text-caption text-text-secondary">
                  설치일 {formatDateTime(asset.installedAt)} · {formatBytes(asset.sizeBytes)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenDetail({ assetType: asset.assetType, assetId: asset.assetId, version: asset.version })}
                >
                  <Info size={14} /> 상세 보기
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setPendingRemoval(asset)}>
                  <Trash2 size={14} /> 제거
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ReasonConfirmDialog
        open={pendingRemoval !== null}
        title="자산을 제거하시겠습니까?"
        description={
          pendingRemoval && (
            <>
              <strong>{pendingRemoval.name}</strong> (v{pendingRemoval.version})를 로컬에서 제거합니다. 이 작업은 되돌릴 수
              없습니다.
            </>
          )
        }
        confirmLabel="제거"
        reasonLabel="제거 사유"
        reasonPlaceholder="예: 더 이상 사용하지 않는 버전 정리"
        submitting={removing}
        onConfirm={(reason) => void handleConfirmRemove(reason)}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}
