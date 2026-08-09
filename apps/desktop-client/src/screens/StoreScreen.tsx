// 자산 스토어 — Portal 카탈로그를 VS Code Extension처럼 브라우징하고 한 번의
// 클릭으로 설치한다. 실제 설치 파이프라인은 electron/store-install.ts를 거쳐
// 기존 importBundle()(D04/D05 15단계 검증)을 그대로 재사용한다 — 이 화면은
// 그 결과를 보여줄 뿐, 압축 해제나 검증을 직접 하지 않는다.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  Settings,
  Store as StoreIcon,
  XCircle,
} from "lucide-react";
import type {
  InstalledAssetWithStatus,
  PortalCatalogResult,
  PortalSettingsPublic,
  StoreInstallProgressEvent,
  StoreInstallResult,
} from "../../electron/types";
import { STAGE_LABELS, STORE_SERVER_STAGE_LABELS } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
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
import { computeCatalogView, type CatalogInstallState, type CatalogItemView } from "./storeTypes";

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

  const [settings, setSettings] = useState<PortalSettingsPublic | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<PortalCatalogResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [installed, setInstalled] = useState<InstalledAssetWithStatus[] | null>(null);

  const [installTarget, setInstallTarget] = useState<CatalogItemView | null>(null);
  const [installEvents, setInstallEvents] = useState<StoreInstallProgressEvent[]>([]);
  const [installResult, setInstallResult] = useState<StoreInstallResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);

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

  const views = useMemo(() => {
    if (!catalog?.ok || !installed) return [];
    return computeCatalogView(catalog.assets, installed);
  }, [catalog, installed]);

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

  function openInstallDialog(view: CatalogItemView) {
    setInstallTarget(view);
    setInstallEvents([]);
    setInstallResult(null);
  }

  async function runInstall() {
    if (!bridge || !installTarget || !installTarget.installableVersion) return;
    setInstallRunning(true);
    setInstallEvents([]);
    setInstallResult(null);
    try {
      const result = await bridge.installFromStore(
        installTarget.asset.type,
        installTarget.asset.id,
        installTarget.installableVersion.id,
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
          title="자산 스토어"
          description="Portal 카탈로그를 조회하고 승인된 버전을 바로 설치합니다."
        />
        <BridgeUnavailableState detail="자산 스토어는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  const portalConfigured = !!settings?.baseUrl && !!settings?.tokenConfigured;

  return (
    <div>
      <PageHeader
        title="자산 스토어"
        description="Portal에 등록된 승인 자산을 조회하고 VS Code 확장처럼 바로 설치합니다."
        actions={
          <Button variant="secondary" onClick={() => void loadCatalog()} disabled={!portalConfigured || catalogLoading}>
            <RefreshCw size={14} /> 카탈로그 새로고침
          </Button>
        }
      />

      <Card className="mb-4 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Settings size={16} className="text-text-muted" />
          <h2 className="text-card-title font-semibold text-text-primary">Portal 연결 설정</h2>
        </div>
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
        <div className="space-y-3">
          {views.map((view) => (
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
                  onClick={() => openInstallDialog(view)}
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
            {!installRunning && !installResult && (
              <div className="space-y-3">
                <p>
                  <strong>{installTarget.asset.name}</strong> v{installTarget.installableVersion?.version}을(를)
                  설치합니다. Portal에서 Bundle을 생성한 뒤 다운로드하여 기존 가져오기와 동일한 검증을 거칩니다.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeInstallDialog}>
                    취소
                  </Button>
                  <Button onClick={() => void runInstall()}>
                    <StoreIcon size={14} /> 설치 시작
                  </Button>
                </div>
              </div>
            )}

            {(installRunning || installResult) && (
              <div className="space-y-2">
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
                {installResult.outcome === "FAILED" && !installResult.cancelled && installResult.retryable && (
                  <div className="mt-2">
                    <Button size="sm" onClick={() => void runInstall()}>
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
