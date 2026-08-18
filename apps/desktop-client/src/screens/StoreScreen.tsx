// 자산 스토어 — Portal 카탈로그를 VS Code Extension처럼 브라우징하고 한 번의
// 클릭으로 설치한다. 실제 설치 파이프라인은 electron/store-install.ts를 거쳐
// 기존 importBundle()(D04/D05 15단계 검증)을 그대로 재사용한다 — 이 화면은
// 그 결과를 보여줄 뿐, 압축 해제나 검증을 직접 하지 않는다.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  Info,
  RefreshCw,
  Search,
  Settings,
  XCircle,
} from "lucide-react";
import type {
  ActivateKnowledgeResult,
  ConnectMcpToolResult,
  InstalledAssetWithStatus,
  PortalCatalogResult,
  PortalSettingsPublic,
  StoreInstallProgressEvent,
  StoreInstallResult,
} from "../../electron/types";
import { STAGE_LABELS, STORE_SERVER_STAGE_LABELS } from "../../electron/types";
import { getDesktopBridge, isBridgeMethodMissing } from "../bridge";
import {
  Button,
  BridgeUnavailableState,
  Card,
  CheckRow,
  EmptyState,
  ErrorBanner,
  LoadingState,
  Modal,
  PageHeader,
} from "../ui";
import { assetTypeLabel, formatDateTime } from "../format";
import {
  computeCatalogView,
  filterCatalogView,
  type CatalogInstallState,
  type CatalogItemView,
  type StoreAssetTypeFilter,
} from "./storeTypes";
import {
  agentRegistrationGuidanceTargets,
  knowledgeActivationTargets,
  mcpToolConnectionTargets,
  noFurtherActionTargets,
} from "./knowledgeActivation";

function activationKey(assetId: string, version: string): string {
  return `${assetId}::${version}`;
}

const STATE_LABEL: Record<CatalogInstallState, string> = {
  INSTALLED: "설치됨",
  INSTALLABLE: "설치 가능",
  UPDATE_AVAILABLE: "업데이트 있음",
  NOT_INSTALLABLE: "설치 불가",
};

const STATE_TONE: Record<CatalogInstallState, string> = {
  INSTALLED: "bg-success/10 text-success",
  INSTALLABLE: "bg-brand-50 text-brand-700",
  UPDATE_AVAILABLE: "bg-warning/10 text-warning",
  NOT_INSTALLABLE: "bg-slate-100 text-text-muted",
};

function progressRowLabel(stage: StoreInstallProgressEvent["stage"]): string {
  if (stage in STORE_SERVER_STAGE_LABELS) {
    return STORE_SERVER_STAGE_LABELS[stage as keyof typeof STORE_SERVER_STAGE_LABELS];
  }
  return STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage;
}

export function StoreScreen({ onGoToImport, onInstalled }: { onGoToImport: () => void; onInstalled: () => void }) {
  const bridge = getDesktopBridge();
  // stale preload.js 빌드로 `onStoreInstallProgress`가 없으면(2026-08-13
  // 실제 장애 — 이 메서드가 없어 자산 허브 화면 전체가 ErrorBoundary까지
  // 무너졌다) 구독은 no-op으로 대체되어 이벤트가 절대 오지 않는다
  // (`src/bridge.ts`). 설치 Modal의 진행률 영역을 빈 채로 두지 않고 그
  // 사실을 명시한다.
  const storeProgressUnavailable = !!bridge && isBridgeMethodMissing("onStoreInstallProgress");

  const [settings, setSettings] = useState<PortalSettingsPublic | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<PortalCatalogResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [installed, setInstalled] = useState<InstalledAssetWithStatus[] | null>(null);
  const [query, setQuery] = useState("");
  const [assetTypeFilter, setAssetTypeFilter] = useState<StoreAssetTypeFilter>("all");

  const [installTarget, setInstallTarget] = useState<CatalogItemView | null>(null);
  const [installEvents, setInstallEvents] = useState<StoreInstallProgressEvent[]>([]);
  const [installResult, setInstallResult] = useState<StoreInstallResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);
  // D-079: 설치 성공 뒤 Knowledge 항목을 자동으로 활성화 시도한다 — "설치는
  // 완료되었지만 검색에 활성화되지 않았습니다"를 설치 성공/실패와 절대
  // 섞지 않는다(설치 성공은 그대로 유지된다).
  const [activationResults, setActivationResults] = useState<Record<string, ActivateKnowledgeResult>>({});
  const [mcpConnectionResults, setMcpConnectionResults] = useState<Record<string, ConnectMcpToolResult>>({});

  const loadSettings = useCallback(async () => {
    if (!bridge) return;
    const s = await bridge.getPortalSettings();
    setSettings(s);
    setBaseUrlInput(s.baseUrl ?? "");
  }, [bridge]);

  const loadInstalled = useCallback(async () => {
    if (!bridge) return;
    setInstalled(await bridge.listInstalledAssets());
  }, [bridge]);

  const loadCatalog = useCallback(async () => {
    if (!bridge) return;
    setCatalogLoading(true);
    try {
      const result = await bridge.fetchPortalCatalog();
      setCatalog(result);
    } finally {
      setCatalogLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void loadSettings();
    void loadInstalled();
  }, [loadSettings, loadInstalled]);

  useEffect(() => {
    if (settings?.baseUrl && settings.tokenConfigured) {
      void loadCatalog();
    }
  }, [settings?.baseUrl, settings?.tokenConfigured, loadCatalog]);

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onStoreInstallProgress((event) => {
      setInstallEvents((prev) => [...prev.filter((e) => e.stage !== event.stage), event]);
    });
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !installResult || installResult.outcome !== "SUCCESS" || !installResult.importResult) return;
    const targets = knowledgeActivationTargets(installResult.importResult.installPlan);
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
  }, [bridge, installResult]);

  useEffect(() => {
    if (!bridge || !installResult || installResult.outcome !== "SUCCESS" || !installResult.importResult) return;
    const targets = mcpToolConnectionTargets(installResult.importResult.installPlan);
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
  }, [bridge, installResult]);

  const views = useMemo(() => {
    if (!catalog?.ok || !installed) return [];
    return computeCatalogView(catalog.assets, installed);
  }, [catalog, installed]);

  const filteredViews = useMemo(
    () => filterCatalogView(views, { query, assetType: assetTypeFilter }),
    [views, query, assetTypeFilter],
  );

  async function saveBaseUrl() {
    if (!bridge) return;
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const next = await bridge.setPortalBaseUrl(baseUrlInput);
      setSettings(next);
      setSettingsMessage("Portal 서버 주소가 저장되었습니다.");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function saveToken() {
    if (!bridge || !tokenInput.trim()) return;
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const next = await bridge.setPortalToken(tokenInput);
      setSettings(next);
      setTokenInput("");
      setSettingsMessage("Portal 식별 Token이 저장되었습니다.");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function clearToken() {
    if (!bridge) return;
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const next = await bridge.clearPortalToken();
      setSettings(next);
      setSettingsMessage("Portal 식별 Token이 삭제되었습니다.");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function startInstall(view: CatalogItemView) {
    setInstallTarget(view);
    setInstallEvents([]);
    setInstallResult(null);
    await runInstall(view);
  }

  async function runInstall(target: CatalogItemView | null = installTarget) {
    if (!bridge || !target || !target.installableVersion) return;
    setInstallRunning(true);
    setInstallEvents([]);
    setInstallResult(null);
    setActivationResults({});
    setMcpConnectionResults({});
    try {
      const result = await bridge.installFromStore(
        target.asset.type,
        target.asset.id,
        target.installableVersion.id,
      );
      setInstallResult(result);
      if (result.outcome === "SUCCESS") {
        await loadInstalled();
        onInstalled();
      }
    } finally {
      setInstallRunning(false);
    }
  }

  async function cancelInstall() {
    if (!bridge) return;
    await bridge.cancelStoreInstall();
  }

  function closeInstallDialog() {
    if (installRunning) return; // 진행 중에는 닫지 않는다 — 결과를 놓치지 않도록.
    setInstallTarget(null);
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader
          title="자산 찾기"
          description="승인된 Knowledge, Agent, Prompt, MCP Tool은 Desktop 앱에서 바로 설치할 수 있습니다."
        />
        <BridgeUnavailableState detail="자산 스토어는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  const portalConfigured = !!settings?.baseUrl && !!settings?.tokenConfigured;

  return (
    <div>
      <PageHeader
        title="자산 찾기"
        description="승인된 Knowledge, Agent, Prompt, MCP Tool을 찾아 한 번에 설치합니다."
        actions={
          <>
            <Button variant="secondary" onClick={onGoToImport}>
              <FileArchive size={14} /> ZIP 가져오기
            </Button>
            <Button variant="secondary" onClick={() => void loadCatalog()} disabled={!portalConfigured || catalogLoading}>
              <RefreshCw size={14} /> 새로고침
            </Button>
          </>
        }
      />

      <details className="mb-5" open={!portalConfigured}>
        <summary className="cursor-pointer text-caption font-semibold text-text-secondary">
          <span className="inline-flex items-center gap-2">
            <Settings size={14} />
            {portalConfigured ? "Portal 연결됨 · 연결 변경" : "처음 한 번만 Portal 연결 설정"}
          </span>
        </summary>
        <Card className="mt-2 p-5 shadow-none">
          <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="portal-base-url" className="mb-1 block text-caption font-semibold text-text-muted">
              Portal 서버 주소
            </label>
            <div className="flex gap-2">
              <input
                id="portal-base-url"
                type="text"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                placeholder="http://127.0.0.1:8000"
                className="h-10 flex-1 rounded-lg border border-border px-3 text-sm text-text-primary"
              />
              <Button variant="secondary" onClick={() => void saveBaseUrl()} disabled={settingsSaving || !baseUrlInput.trim()}>
                저장
              </Button>
            </div>
          </div>
          <div>
            <label htmlFor="portal-token" className="mb-1 block text-caption font-semibold text-text-muted">
              식별 Token (Bearer)
            </label>
            <div className="flex gap-2">
              <input
                id="portal-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={settings?.tokenConfigured ? "•••••••• (설정됨 — 변경하려면 새 값 입력)" : "dev-user-token"}
                className="h-10 flex-1 rounded-lg border border-border px-3 text-sm text-text-primary"
              />
              <Button variant="secondary" onClick={() => void saveToken()} disabled={settingsSaving || !tokenInput.trim()}>
                저장
              </Button>
            </div>
          </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-caption text-text-secondary">
          <span>
            Token 상태: {settings?.tokenConfigured ? `설정됨 (${formatDateTime(settings.tokenUpdatedAt ?? "")} 갱신)` : "미설정"}
          </span>
          {settings?.tokenConfigured && (
            <button
              onClick={() => void clearToken()}
              disabled={settingsSaving}
              className="text-caption font-semibold text-danger hover:underline disabled:opacity-50"
            >
              Token 삭제
            </button>
          )}
          </div>
          {settingsMessage && <p className="mt-2 text-caption text-success">{settingsMessage}</p>}
          <p className="mt-2 text-caption text-text-secondary">
            Token은 이 기기에만 저장되며 화면에 다시 표시되거나 진단 Bundle에 포함되지 않습니다("설정됨 여부"만 기록됩니다).
          </p>
        </Card>
      </details>

      {!portalConfigured && (
        <EmptyState
          title="Portal 연결 설정이 필요합니다"
          description="폐쇄망에서도 사내 Portal은 대부분 접근 가능합니다 — 서버 주소와 식별 Token을 저장하면 카탈로그를 볼 수 있습니다. 지금 당장 Portal에 접근할 수 없다면 '가져오기' 메뉴에서 Offline Bundle 파일로 직접 설치할 수 있습니다."
          action={
            <Button variant="secondary" onClick={onGoToImport}>
              가져오기로 이동
            </Button>
          }
        />
      )}

      {portalConfigured && catalogLoading && <LoadingState label="Portal 카탈로그를 불러오는 중..." />}

      {portalConfigured && !catalogLoading && catalog && !catalog.ok && (
        <div className="space-y-3">
          <ErrorBanner message={catalog.error ?? "카탈로그를 불러오지 못했습니다."} />
          <EmptyState
            title="Portal에 연결할 수 없습니다"
            description="폐쇄망에서 Portal 서버에 일시적으로 접근할 수 없는 상태일 수 있습니다. 서버 주소/Token을 다시 확인하거나, '가져오기' 메뉴에서 Offline Bundle 파일로 직접 설치하세요."
            action={
              <Button variant="secondary" onClick={onGoToImport}>
                가져오기로 이동
              </Button>
            }
          />
        </div>
      )}

      {portalConfigured && !catalogLoading && catalog?.ok && catalog.assets.length === 0 && (
        <EmptyState title="등록된 자산이 없습니다" description="Portal 카탈로그에 아직 등록된 자산이 없습니다." />
      )}

      {portalConfigured && !catalogLoading && catalog?.ok && views.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1 sm:max-w-sm">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="자산 이름 검색"
                aria-label="자산 이름 검색"
                className="h-10 w-full rounded-lg border border-border bg-white pl-9 pr-3 text-sm text-text-primary"
              />
            </div>
            {([
              ["all", "전체"],
              ["knowledge", "Knowledge"],
              ["agent", "Agent"],
              ["prompt", "Prompt"],
              ["mcp_tool", "MCP Tool"],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={assetTypeFilter === value ? "primary" : "secondary"}
                onClick={() => setAssetTypeFilter(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          {filteredViews.length === 0 && (
            <EmptyState title="조건에 맞는 자산이 없습니다" description="검색어를 지우거나 다른 유형을 선택해 보세요." />
          )}

          {filteredViews.map((view) => (
            <Card key={`${view.asset.type}-${view.asset.id}`} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-card-title font-medium text-text-primary">{view.asset.name}</span>
                    <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                      {assetTypeLabel(view.asset.type)}
                    </span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_TONE[view.state]}`}>
                      {STATE_LABEL[view.state]}
                    </span>
                  </div>
                  <p className="mt-1 text-caption text-text-secondary">
                    {view.installableVersion && `설치 가능 버전 v${view.installableVersion.version}`}
                    {view.installedVersion && ` · 설치된 버전 v${view.installedVersion}`}
                  </p>
                  {view.state === "NOT_INSTALLABLE" && (
                    <p className="mt-1 flex items-start gap-1.5 text-caption text-text-muted">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      {view.reason}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={view.state === "NOT_INSTALLABLE" || view.state === "INSTALLED"}
                  title={view.state === "NOT_INSTALLABLE" ? (view.reason ?? undefined) : undefined}
                  onClick={() => void startInstall(view)}
                >
                  <Download size={14} />
                  {view.state === "UPDATE_AVAILABLE" ? "업데이트 설치" : view.state === "INSTALLED" ? "설치됨" : "설치"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={installTarget !== null}
        title={`${installTarget?.asset.name ?? ""} 설치`}
        onClose={closeInstallDialog}
      >
        {installTarget && (
          <div className="space-y-4">
            {(installRunning || installResult) && (
              <div className="space-y-2">
                {installRunning && installEvents.length === 0 && storeProgressUnavailable && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>
                      설치가 진행 중이지만 실행 중인 앱 빌드가 최신이 아니어서 단계별 진행 상황을 실시간으로 표시할
                      수 없습니다 — 완료되면 아래에 결과가 표시됩니다. 앱을 재시작하면 실시간 표시가 복구됩니다.
                    </span>
                  </div>
                )}
                {installEvents.map((e) => (
                  <CheckRow
                    key={e.stage}
                    label={progressRowLabel(e.stage)}
                    status={e.status}
                    message={e.message}
                  />
                ))}
                {installRunning && (
                  <div className="flex justify-end pt-2">
                    <Button variant="secondary" size="sm" onClick={() => void cancelInstall()}>
                      <XCircle size={14} /> 설치 취소
                    </Button>
                  </div>
                )}
              </div>
            )}

            {installResult && (
              <div
                className={`rounded-lg border p-3 text-body ${
                  installResult.outcome === "SUCCESS"
                    ? "border-success/30 bg-success/5 text-success"
                    : installResult.cancelled
                      ? "border-border bg-background text-text-secondary"
                      : "border-danger/30 bg-danger/5 text-danger"
                }`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {installResult.outcome === "SUCCESS" ? (
                    <CheckCircle2 size={16} />
                  ) : (
                    <AlertTriangle size={16} />
                  )}
                  {installResult.message}
                </div>

                {installResult.outcome === "SUCCESS" &&
                  installResult.importResult &&
                  knowledgeActivationTargets(installResult.importResult.installPlan).length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-success/20 pt-3">
                      <p className="text-caption font-semibold text-text-muted">Knowledge 검색 활성화</p>
                      {knowledgeActivationTargets(installResult.importResult.installPlan).map((target) => {
                        const key = activationKey(target.assetId, target.version);
                        const outcome = activationResults[key];
                        return (
                          <div key={key} className="flex items-start gap-1.5 text-caption">
                            {!outcome && <span className="text-text-secondary">{target.name ?? target.assetId} 활성화 확인 중...</span>}
                            {outcome?.activation?.state === "ACTIVE" && (
                              <span className="text-success">
                                <CheckCircle2 size={13} className="mr-1 inline-block align-text-bottom" />
                                {target.name ?? target.assetId}: 검색에 활성화되었습니다.
                              </span>
                            )}
                            {outcome?.activation?.state === "ALREADY_ACTIVE" && (
                              <span className="text-success">
                                <CheckCircle2 size={13} className="mr-1 inline-block align-text-bottom" />
                                {target.name ?? target.assetId}: 이미 검색 가능한 상태입니다(중앙 색인에 등록됨) —
                                별도 활성화가 필요하지 않습니다.
                              </span>
                            )}
                            {outcome?.activation?.state === "FAILED" && (
                              <span className="text-warning">
                                <AlertTriangle size={13} className="mr-1 inline-block align-text-bottom" />
                                설치는 완료되었지만 검색에 활성화되지 않았습니다: {outcome.activation.message ?? "알 수 없는 오류"}{" "}
                                — 설치된 자산 화면에서 다시 시도할 수 있습니다.
                              </span>
                            )}
                            {outcome && !outcome.activation && (
                              <span className="text-warning">
                                <AlertTriangle size={13} className="mr-1 inline-block align-text-bottom" />
                                설치는 완료되었지만 활성화를 시도하지 못했습니다: {outcome.error ?? "알 수 없는 오류"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                {installResult.outcome === "SUCCESS" &&
                  installResult.importResult &&
                  mcpToolConnectionTargets(installResult.importResult.installPlan).length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-success/20 pt-3">
                      <p className="text-caption font-semibold text-text-muted">MCP Tool 연결</p>
                      {mcpToolConnectionTargets(installResult.importResult.installPlan).map((target) => {
                        const key = activationKey(target.assetId, target.version);
                        const outcome = mcpConnectionResults[key];
                        const policyDisabled = outcome?.activation?.reason === "mcp_tool_registration_disabled";
                        return (
                          <div key={key} className="text-caption">
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
                                설치는 완료되었습니다. {policyDisabled ? "운영자 설정이 필요합니다" : "연결하지 못했습니다"}: {outcome.activation.message ?? "알 수 없는 오류"}
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

                {installResult.outcome === "SUCCESS" &&
                  installResult.importResult &&
                  agentRegistrationGuidanceTargets(installResult.importResult.installPlan).length > 0 && (
                    <div className="mt-3 space-y-1.5 border-t border-success/20 pt-3">
                      <p className="text-caption font-semibold text-text-muted">Local Agent 등록</p>
                      {agentRegistrationGuidanceTargets(installResult.importResult.installPlan).map((target) => (
                        <p key={`agent-${target.assetId}`} className="flex items-start gap-1.5 text-caption text-text-secondary">
                          <Info size={13} className="mt-0.5 shrink-0" />
                          {target.name ?? target.assetId}: 설치는 완료되었지만 대화에서 바로 쓸 수는 없습니다 — 짝이 될
                          Prompt 자산을 골라 등록해야 합니다(설치된 자산 화면에서 "Local Agent로 등록").
                        </p>
                      ))}
                    </div>
                  )}

                {installResult.outcome === "SUCCESS" &&
                  installResult.importResult &&
                  noFurtherActionTargets(installResult.importResult.installPlan).length > 0 && (
                    <div className="mt-3 space-y-1.5 border-t border-success/20 pt-3">
                      {noFurtherActionTargets(installResult.importResult.installPlan).map((target) => (
                        <p key={`${target.assetType}-${target.assetId}`} className="text-caption text-text-secondary">
                          <CheckCircle2 size={13} className="mr-1 inline-block align-text-bottom text-success" />
                          {target.name ?? target.assetId} ({assetTypeLabel(target.assetType)}): 설치 외에 별도로
                          활성화하거나 연결할 절차가 없습니다 — 자산 관리 화면에서 바로 확인할 수 있습니다.
                        </p>
                      ))}
                    </div>
                  )}

                {installResult.outcome === "FAILED" && !installResult.cancelled && installResult.retryable && (
                  <div className="mt-2">
                    <Button size="sm" onClick={() => void runInstall(installTarget)}>
                      다시 시도
                    </Button>
                  </div>
                )}
                <div className="mt-3 flex justify-end">
                  <Button variant="secondary" size="sm" onClick={() => setInstallTarget(null)}>
                    닫기
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
