// D10 설정 (02-desktop-and-agent-runtime.md §D10).
//
// D01 최초 설정 Wizard와 정확히 같은 저장소(electron/desktop-settings.ts)를
// 읽고 쓴다 — 이 화면은 그 값을 Section별로 다시 편집할 수 있게 할 뿐이다.
// "정책으로 고정된 값은 읽기 전용으로 표시하고 출처 정책명을 보여준다"(스펙
// §D10)에 따라 Asset/Log 경로, 최대 동시 실행, Proxy, 진단 Bundle 정책은
// 편집 불가로 표시한다 — 그중 "최대 동시 실행"은 오늘 Desktop이 실제로
// 강제할 방법이 없어서 그런 것이고(open-decisions.md D-074), 나머지는 이
// PoC의 폐쇄망 기본 정책 자체가 그렇게 고정했기 때문이다.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, Save, Sparkles } from "lucide-react";
import type { ConnectionStatus, DesktopSettingsPublic } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, CheckRow, ErrorBanner, LabeledInput, LoadingState, PageHeader, ReadOnlyField } from "../ui";
import { formatDateTime } from "../format";

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-card-title font-semibold text-text-primary">{title}</h2>;
}

export function SettingsScreen({ onRunSetupWizard }: { onRunSetupWizard: () => void }) {
  const bridge = getDesktopBridge();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DesktopSettingsPublic | null>(null);
  const [installRoot, setInstallRoot] = useState<string | null>(null);

  const [clientDisplayName, setClientDisplayName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [ollamaAllowNonLoopback, setOllamaAllowNonLoopback] = useState(false);
  const [chatModelAlias, setChatModelAlias] = useState("");
  const [embeddingModelAlias, setEmbeddingModelAlias] = useState("");
  const [mcpServerAlias, setMcpServerAlias] = useState("");
  const [mcpServerUrl, setMcpServerUrl] = useState("");

  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<Record<string, string | null>>({});
  const [sectionSavedAt, setSectionSavedAt] = useState<Record<string, string | null>>({});

  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [checkingConnections, setCheckingConnections] = useState(false);

  const applySettings = useCallback((s: DesktopSettingsPublic) => {
    setSettings(s);
    setClientDisplayName(s.clientDisplayName ?? "");
    setSiteId(s.siteId ?? "");
    setOllamaBaseUrl(s.ollamaBaseUrl);
    setOllamaAllowNonLoopback(s.ollamaAllowNonLoopback);
    setChatModelAlias(s.chatModelAlias);
    setEmbeddingModelAlias(s.embeddingModelAlias);
    setMcpServerAlias(s.mcpServerAlias);
    setMcpServerUrl(s.mcpServerUrl);
  }, []);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [s, root] = await Promise.all([bridge.getDesktopSettings(), bridge.getInstallRootPath()]);
      applySettings(s);
      setInstallRoot(root);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "설정을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge, applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSection(section: string, patch: Record<string, unknown>) {
    if (!bridge) return;
    setSavingSection(section);
    setSectionError((prev) => ({ ...prev, [section]: null }));
    try {
      const result = await bridge.updateDesktopSettings(patch);
      if (!result.ok) {
        setSectionError((prev) => ({ ...prev, [section]: result.error }));
        return;
      }
      applySettings(result.settings);
      setSectionSavedAt((prev) => ({ ...prev, [section]: new Date().toISOString() }));
    } finally {
      setSavingSection(null);
    }
  }

  async function runConnectionsCheck() {
    if (!bridge) return;
    setCheckingConnections(true);
    try {
      setConnections(await bridge.checkConnections());
    } finally {
      setCheckingConnections(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="설정" description="Office Profile·모델·경로·로그 정책을 확인·변경합니다." />
        <BridgeUnavailableState detail="설정 화면은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="설정" description="Office Profile·모델·경로·로그 정책을 확인·변경합니다." />
        <LoadingState label="설정을 불러오는 중..." />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div>
        <PageHeader title="설정" description="Office Profile·모델·경로·로그 정책을 확인·변경합니다." />
        <ErrorBanner message={loadError ?? "설정을 불러오지 못했습니다."} />
      </div>
    );
  }

  const ollamaStatus = connections?.find((c) => c.id === "ollama") ?? null;
  const mcpStatus = connections?.find((c) => c.id === "mcp") ?? null;

  return (
    <div className="space-y-4">
      <PageHeader title="설정" description="Office Profile·모델·경로·로그 정책을 확인·변경합니다." />

      {/* IA 재편: 최초 설정 Wizard(D01)는 더 이상 사이드바 탭이 아니다 —
          여기서만 다시 실행할 수 있다. */}
      <Card className="p-6">
        <SectionHeader title="최초 설정" />
        <p className="mb-3 text-body text-text-secondary">
          Office Profile·Ollama·MCP·자산 경로를 처음부터 다시 안내받아 설정합니다.
        </p>
        <Button variant="secondary" onClick={onRunSetupWizard}>
          <Sparkles size={14} /> 최초 설정 다시 실행
        </Button>
      </Card>

      <Card className="p-6">
        <SectionHeader title="Client 정보" />
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput id="settings-client-name" label="Client 표시명" value={clientDisplayName} onChange={setClientDisplayName} placeholder="예: 본사 1층 안내 PC" />
          <LabeledInput id="settings-site-id" label="사업장 ID" value={siteId} onChange={setSiteId} placeholder="예: headquarters" />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("client", { clientDisplayName, siteId })}
            disabled={savingSection === "client"}
          >
            <Save size={14} /> 저장
          </Button>
          {sectionSavedAt.client && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.client)} 저장됨</span>}
        </div>
        {sectionError.client && <div className="mt-2"><ErrorBanner message={sectionError.client} /></div>}
      </Card>

      <Card className="p-6">
        <SectionHeader title="Ollama 연결" />
        <p className="mb-3 text-body text-text-secondary">
          기본적으로 loopback 주소(127.0.0.1/localhost)만 허용됩니다 — 보안 규칙이며 아래 허용 체크 없이는 저장되지
          않습니다.
        </p>
        <LabeledInput id="settings-ollama-url" label="Ollama Base URL" value={ollamaBaseUrl} onChange={setOllamaBaseUrl} placeholder="http://127.0.0.1:11434" />
        <label className="mt-2 flex items-center gap-2 text-body text-text-secondary">
          <input type="checkbox" checked={ollamaAllowNonLoopback} onChange={(e) => setOllamaAllowNonLoopback(e.target.checked)} />
          외부(원격) Ollama 허용 — 사내 보안 정책상 권장하지 않습니다.
        </label>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("ollama", { ollamaBaseUrl, ollamaAllowNonLoopback })}
            disabled={savingSection === "ollama"}
          >
            <Save size={14} /> 저장
          </Button>
          <Button variant="secondary" onClick={() => void runConnectionsCheck()} disabled={checkingConnections}>
            <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 연결 테스트
          </Button>
          {sectionSavedAt.ollama && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.ollama)} 저장됨</span>}
        </div>
        {sectionError.ollama && <div className="mt-2"><ErrorBanner message={sectionError.ollama} /></div>}
        {ollamaStatus && (
          <div className="mt-3">
            <CheckRow label={ollamaStatus.label} status={ollamaStatus.ok ? "PASS" : "FAIL"} message={ollamaStatus.ok ? ollamaStatus.detail : `${ollamaStatus.detail} — ${ollamaStatus.recoveryHint ?? ""}`} />
          </div>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="모델 Alias" />
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput id="settings-chat-alias" label="기본 Chat Model Alias" value={chatModelAlias} onChange={setChatModelAlias} placeholder="default-chat" />
          <LabeledInput id="settings-embedding-alias" label="기본 Embedding Model Alias" value={embeddingModelAlias} onChange={setEmbeddingModelAlias} placeholder="default-embedding" />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("models", { chatModelAlias, embeddingModelAlias })}
            disabled={savingSection === "models"}
          >
            <Save size={14} /> 저장
          </Button>
          {sectionSavedAt.models && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.models)} 저장됨</span>}
        </div>
        {sectionError.models && <div className="mt-2"><ErrorBanner message={sectionError.models} /></div>}
      </Card>

      <Card className="p-6">
        <SectionHeader title="MCP Server Alias" />
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput id="settings-mcp-alias" label="MCP Server Alias" value={mcpServerAlias} onChange={setMcpServerAlias} placeholder="oracle-connector" />
          <LabeledInput id="settings-mcp-url" label="MCP Server URL" value={mcpServerUrl} onChange={setMcpServerUrl} placeholder="http://127.0.0.1:8500" />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("mcp", { mcpServerAlias, mcpServerUrl })}
            disabled={savingSection === "mcp"}
          >
            <Save size={14} /> 저장
          </Button>
          <Button variant="secondary" onClick={() => void runConnectionsCheck()} disabled={checkingConnections}>
            <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 연결 테스트
          </Button>
          {sectionSavedAt.mcp && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.mcp)} 저장됨</span>}
        </div>
        {sectionError.mcp && <div className="mt-2"><ErrorBanner message={sectionError.mcp} /></div>}
        {mcpStatus && (
          <div className="mt-3">
            <CheckRow label={mcpStatus.label} status={mcpStatus.ok ? "PASS" : "FAIL"} message={mcpStatus.ok ? mcpStatus.detail : `${mcpStatus.detail} — ${mcpStatus.recoveryHint ?? ""}`} />
          </div>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="Asset/Log 경로" />
        <div className="grid gap-3 sm:grid-cols-2">
          <ReadOnlyField label="Asset Root Directory" value={installRoot ?? "확인 불가"} policyNote="정책: OS 표준 애플리케이션 데이터 경로 고정(사용자 임의 경로 지정 불가)." />
          <ReadOnlyField label="로그 위치" value={installRoot ? `${installRoot}/state/logs` : "확인 불가"} />
        </div>
      </Card>

      <Card className="p-6">
        <SectionHeader title="최대 동시 실행" />
        <ReadOnlyField
          label="최대 동시 Run 수"
          value={String(settings.maxConcurrentRuns.value)}
          policyNote={settings.maxConcurrentRuns.reason}
        />
      </Card>

      <Card className="p-6">
        <SectionHeader title="로그 Level과 보관기간" />
        <CheckRow
          status="WARN"
          label="로그 보관 기간"
          message="현재 로컬 로그는 자동 삭제되지 않고 계속 누적됩니다(보관 기간 정책 미구현, open-decisions.md D-074). 필요 시 D11 로그/진단 화면에서 직접 확인하세요."
        />
      </Card>

      <Card className="p-6">
        <SectionHeader title="Proxy" />
        <ReadOnlyField label="Proxy 사용" value="비활성" policyNote="정책: 폐쇄망 기본 정책(변경 불가)." />
      </Card>

      <Card className="p-6">
        <SectionHeader title="개인정보 표시 · 진단 Bundle 정책" />
        <div className="flex items-start gap-2 text-body text-text-secondary">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
          <span>D11 진단 Bundle 생성 시 Prompt 원문·문서 전체·DB 조회 결과·Secret은 항상 자동 제외됩니다(정책 고정, 변경 불가).</span>
        </div>
      </Card>
    </div>
  );
}
