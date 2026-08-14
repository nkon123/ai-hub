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

// D-079: "설치됨"과 "활성화됨"은 서로 다른 사실이다 — `activation` 필드가
// 없는 것(미시도)과 `state: "FAILED"`(시도했으나 실패)를 절대 같은 배지로
// 뭉개지 않는다(electron/types.ts의 `KnowledgeActivation` 문서 참고).
//
// `ALREADY_ACTIVE`(central-index-exists-not-a-failure, 2026-08-13 실사용
// 진단): search-runtime의 중앙 색인 경로에 이미 있는 Knowledge는 로컬 등록이
// 거부되지만, 그 자체로 이미 검색 가능하다 — "실패"가 아니다. `FAILED`와
// 같은 빨간 배지를 쓰면 멀쩡히 검색되는 자산에 거짓 알람을 띄우게 되므로
// `ACTIVE`와 같은 톤(성공)에 다른 라벨로 구분한다.
type ActivationDisplayState = "ACTIVE" | "ALREADY_ACTIVE" | "FAILED" | "NONE";

const ACTIVATION_LABEL: Record<ActivationDisplayState, string> = {
  ACTIVE: "활성화됨",
  ALREADY_ACTIVE: "이미 검색 가능(중앙 색인)",
  FAILED: "활성화 실패",
  NONE: "활성화 안 됨(미시도)",
};

const ACTIVATION_TONE: Record<ActivationDisplayState, string> = {
  ACTIVE: "bg-success/10 text-success",
  ALREADY_ACTIVE: "bg-success/10 text-success",
  FAILED: "bg-danger/10 text-danger",
  NONE: "bg-slate-100 text-text-muted",
};

function activationDisplayState(asset: InstalledAssetWithStatus): ActivationDisplayState {
  return asset.activation?.state ?? "NONE";
}

/** D-079 범위 경계 — Knowledge만 이번 작업 대상이다. MCP Tool 활성화
 * (agent-runtime/Office Profile 실행 레지스트리 연결)는 D-079의 나머지
 * 절반이며 아직 구현되지 않았다 — "설치됨"을 "곧바로 쓸 수 있음"으로
 * 오해하지 않도록 이유를 함께 보여준다(CLAUDE.md: 호환되지 않는 선택지는
 * 이유와 함께 비활성화한다). `null`이면 활성화 대상(Knowledge)이다. */
const MCP_REGISTRATION_DISABLED = "mcp_tool_registration_disabled";

type McpConnectionDisplayState = "CONNECTED" | "POLICY_DISABLED" | "FAILED" | "NONE";

function mcpConnectionDisplayState(asset: InstalledAssetWithStatus): McpConnectionDisplayState {
  if (asset.activation?.state === "ACTIVE") return "CONNECTED";
  if (asset.activation?.state === "FAILED" && asset.activation.reason === MCP_REGISTRATION_DISABLED) {
    return "POLICY_DISABLED";
  }
  if (asset.activation?.state === "FAILED") return "FAILED";
  return "NONE";
}

const MCP_CONNECTION_LABEL: Record<McpConnectionDisplayState, string> = {
  CONNECTED: "연결됨",
  POLICY_DISABLED: "운영자 설정 필요",
  FAILED: "연결 실패",
  NONE: "연결 안 됨",
};

const MCP_CONNECTION_TONE: Record<McpConnectionDisplayState, string> = {
  CONNECTED: "bg-success/10 text-success",
  POLICY_DISABLED: "bg-warning/10 text-warning",
  FAILED: "bg-danger/10 text-danger",
  NONE: "bg-slate-100 text-text-muted",
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

  // D-079 Knowledge 활성화/비활성화 — 결과(성공/실패)는 서버 응답을 통해
  // `installations.json`에 이미 영속화되므로 `load()`가 새로고침한
  // `asset.activation`이 진짜 출처다. 이 두 상태는 그 사이의 즉각적인
  // 피드백(진행 중 표시, 대상을 찾을 수 없음 같은 로컬 전용 오류, 원격
  // 등록 해제 실패 경고)만 담는다.
  const [activationBusy, setActivationBusy] = useState<Set<string>>(new Set());
  const [activationNote, setActivationNote] = useState<Record<string, string>>({});
  const [mcpReconcileNotice, setMcpReconcileNotice] = useState<string | null>(null);

  const [removalTarget, setRemovalTarget] = useState<InstalledAssetWithStatus | null>(null);
  const [removalCheck, setRemovalCheck] = useState<AssetRemovalCheck | null>(null);
  const [removalChecking, setRemovalChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // D-079 이어 붙이기: 제거 자체는 성공했지만 search-runtime 등록 해제가
  // 실패/불가했을 때의 정보성 경고(제거를 막지 않는다) — Modal이 닫힌
  // 뒤에도 사용자가 볼 수 있어야 하므로 별도 상태로 남긴다.
  const [removeWarning, setRemoveWarning] = useState<string | null>(null);
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
      try {
        const reconciled = await bridge.reconcileMcpToolConnections();
        setMcpReconcileNotice(reconciled.checked ? null : reconciled.error);
      } catch (reconcileError) {
        // 목록 자체는 로컬 기능이므로 agent-runtime/구버전 preload 문제로
        // 막지 않는다. 다만 연결 상태를 확인하지 못했다는 사실은 알린다.
        setMcpReconcileNotice(
          reconcileError instanceof Error ? reconcileError.message : "MCP Tool 연결 상태를 재확인하지 못했습니다.",
        );
      }
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

  async function runActivateKnowledge(asset: InstalledAssetWithStatus) {
    if (!bridge) return;
    const key = assetKey(asset);
    setActivationBusy((prev) => new Set(prev).add(key));
    setActivationNote((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await bridge.activateInstalledKnowledge(asset.assetType, asset.assetId, asset.version);
      // `error`(대상을 찾을 수 없음/유형이 아님)는 정상 흐름에서는 나오지 않는다
      // (이 버튼 자체가 Knowledge에만 노출된다) — 그래도 조용히 삼키지 않는다.
      if (!result.activation && result.error) {
        setActivationNote((prev) => ({ ...prev, [key]: result.error! }));
      }
      await load();
    } catch (err) {
      setActivationNote((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : "활성화 중 알 수 없는 오류가 발생했습니다.",
      }));
    } finally {
      setActivationBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function runDeactivateKnowledge(asset: InstalledAssetWithStatus) {
    if (!bridge) return;
    const key = assetKey(asset);
    setActivationBusy((prev) => new Set(prev).add(key));
    setActivationNote((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await bridge.deactivateInstalledKnowledge(asset.assetType, asset.assetId, asset.version);
      if (!result.ok && result.error) {
        setActivationNote((prev) => ({ ...prev, [key]: result.error! }));
      } else if (result.remoteWarning) {
        // 로컬 상태는 정리되었지만 search-runtime에 정말 등록 해제됐는지는
        // 확인하지 못했다 — 조용히 성공으로 보여주지 않는다.
        setActivationNote((prev) => ({ ...prev, [key]: result.remoteWarning! }));
      }
      await load();
    } catch (err) {
      setActivationNote((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : "비활성화 중 알 수 없는 오류가 발생했습니다.",
      }));
    } finally {
      setActivationBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function runConnectMcpTool(asset: InstalledAssetWithStatus) {
    if (!bridge) return;
    const key = assetKey(asset);
    setActivationBusy((prev) => new Set(prev).add(key));
    setActivationNote((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await bridge.connectInstalledMcpTool(asset.assetType, asset.assetId, asset.version);
      if (!result.activation && result.error) {
        setActivationNote((prev) => ({ ...prev, [key]: result.error! }));
      }
      await load();
    } catch (err) {
      setActivationNote((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : "MCP Tool 연결 중 알 수 없는 오류가 발생했습니다.",
      }));
    } finally {
      setActivationBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function runDisconnectMcpTool(asset: InstalledAssetWithStatus) {
    if (!bridge) return;
    const key = assetKey(asset);
    setActivationBusy((prev) => new Set(prev).add(key));
    setActivationNote((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await bridge.disconnectInstalledMcpTool(asset.assetType, asset.assetId, asset.version);
      if (!result.ok && result.error) {
        setActivationNote((prev) => ({ ...prev, [key]: result.error! }));
      } else if (result.remoteWarning) {
        setActivationNote((prev) => ({ ...prev, [key]: result.remoteWarning! }));
      }
      await load();
    } catch (err) {
      setActivationNote((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : "MCP Tool 연결 해제 중 알 수 없는 오류가 발생했습니다.",
      }));
    } finally {
      setActivationBusy((prev) => {
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
      // 제거 자체는 성공했지만 search-runtime 등록 해제를 확인하지 못했을 때
      // — 조용히 삼키지 않는다(CLAUDE.md).
      setRemoveWarning(result.warning ?? null);
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

      {removeWarning && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            {removeWarning}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setRemoveWarning(null)}>
            확인
          </Button>
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

      {mcpReconcileNotice && assets?.some((asset) => asset.assetType === "mcp_tool") && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-caption text-warning">
          agent-runtime에서 MCP Tool 연결 상태를 확인하지 못했습니다. 마지막 로컬 상태를 표시합니다: {mcpReconcileNotice}
        </div>
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
                      {asset.assetType === "knowledge" && (
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ACTIVATION_TONE[activationDisplayState(asset)]}`}
                        >
                          {ACTIVATION_LABEL[activationDisplayState(asset)]}
                        </span>
                      )}
                      {asset.assetType === "mcp_tool" && (
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${MCP_CONNECTION_TONE[mcpConnectionDisplayState(asset)]}`}
                        >
                          {MCP_CONNECTION_LABEL[mcpConnectionDisplayState(asset)]}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-caption text-text-secondary">
                      설치일 {formatDateTime(asset.installedAt)} · {formatBytes(asset.sizeBytes)}
                    </p>
                    {asset.assetType === "knowledge" && asset.activation?.state === "FAILED" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-danger">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        검색에 활성화되지 않았습니다: {asset.activation.message ?? "알 수 없는 오류"}
                      </p>
                    )}
                    {asset.assetType === "knowledge" && asset.activation?.state === "ALREADY_ACTIVE" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-success">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        {asset.activation.message ?? "이미 검색 가능한 상태입니다."}
                      </p>
                    )}
                    {asset.assetType === "mcp_tool" && mcpConnectionDisplayState(asset) === "CONNECTED" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-text-muted">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        agent-runtime이 이 Tool의 계약을 알고 있습니다. 실제 호출 권한은 Office Profile의 allowed_tools가 결정합니다.
                      </p>
                    )}
                    {asset.assetType === "mcp_tool" && mcpConnectionDisplayState(asset) === "POLICY_DISABLED" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-warning">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        자산 고장이 아닙니다. 운영자가 이 서버 alias를 동적 등록 허용 목록에 추가해야 합니다: {asset.activation?.message}
                      </p>
                    )}
                    {asset.assetType === "mcp_tool" && mcpConnectionDisplayState(asset) === "FAILED" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-danger">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        연결하지 못했습니다: {asset.activation?.message ?? "알 수 없는 오류"}
                      </p>
                    )}
                    {asset.assetType === "mcp_tool" && mcpConnectionDisplayState(asset) === "NONE" && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-text-muted">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        설치는 완료되었지만 agent-runtime에는 아직 연결하지 않았습니다.
                      </p>
                    )}
                    {activationNote[key] && (
                      <p className="mt-1 flex items-start gap-1.5 text-caption text-warning">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        {activationNote[key]}
                      </p>
                    )}
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
                  {asset.assetType === "knowledge" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={activationBusy.has(key) || activationDisplayState(asset) === "ALREADY_ACTIVE"}
                      title={
                        activationDisplayState(asset) === "ALREADY_ACTIVE"
                          ? "이미 search-runtime의 중앙 색인 경로에 등록되어 있어 별도의 활성화/비활성화가 필요하지 않습니다."
                          : undefined
                      }
                      onClick={() =>
                        void (activationDisplayState(asset) === "ACTIVE"
                          ? runDeactivateKnowledge(asset)
                          : runActivateKnowledge(asset))
                      }
                    >
                      {activationBusy.has(key)
                        ? "처리 중..."
                        : activationDisplayState(asset) === "ACTIVE"
                          ? "비활성화"
                          : activationDisplayState(asset) === "ALREADY_ACTIVE"
                            ? "활성화 불필요"
                            : activationDisplayState(asset) === "FAILED"
                              ? "다시 활성화"
                              : "활성화"}
                    </Button>
                  )}
                  {asset.assetType === "mcp_tool" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={activationBusy.has(key) || mcpConnectionDisplayState(asset) === "POLICY_DISABLED"}
                      title={
                        mcpConnectionDisplayState(asset) === "POLICY_DISABLED"
                          ? "운영자가 agent-runtime의 MCP Tool 동적 등록 허용 목록을 변경해야 합니다."
                          : undefined
                      }
                      onClick={() =>
                        void (mcpConnectionDisplayState(asset) === "CONNECTED"
                          ? runDisconnectMcpTool(asset)
                          : runConnectMcpTool(asset))
                      }
                    >
                      {activationBusy.has(key)
                        ? "처리 중..."
                        : mcpConnectionDisplayState(asset) === "CONNECTED"
                          ? "연결 해제"
                          : mcpConnectionDisplayState(asset) === "POLICY_DISABLED"
                            ? "운영자 설정 필요"
                            : mcpConnectionDisplayState(asset) === "FAILED"
                              ? "다시 연결"
                              : "연결"}
                    </Button>
                  )}
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
