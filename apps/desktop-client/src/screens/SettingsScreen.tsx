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
import type {
  ConnectionStatus,
  DesktopSettingsPublic,
  KnowledgeEmbedModelInfo,
  OllamaModelsResult,
} from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { getBrowserSettingsBridge, isBrowserDesktopPreviewEnabled } from "../browserPreviewBridge";
import { Button, BridgeUnavailableState, Card, CheckRow, ErrorBanner, LabeledInput, LoadingState, PageHeader, ReadOnlyField } from "../ui";
import { formatDateTime } from "../format";
import { getChatModelSelectionIssue, getInstalledChatModels } from "./settingsTypes";

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-card-title font-semibold text-text-primary">{title}</h2>;
}

export function SettingsScreen({ onRunSetupWizard }: { onRunSetupWizard: () => void }) {
  const bridge = getDesktopBridge() ?? getBrowserSettingsBridge();
  const browserPreview = isBrowserDesktopPreviewEnabled();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DesktopSettingsPublic | null>(null);
  const [installRoot, setInstallRoot] = useState<string | null>(null);

  const [clientDisplayName, setClientDisplayName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [ollamaAllowNonLoopback, setOllamaAllowNonLoopback] = useState(false);
  const [chatModelAlias, setChatModelAlias] = useState("");
  const [embedModels, setEmbedModels] = useState<KnowledgeEmbedModelInfo[] | null>(null);
  const [mcpServerAlias, setMcpServerAlias] = useState("");
  const [mcpServerUrl, setMcpServerUrl] = useState("");
  const [searchRuntimeBaseUrl, setSearchRuntimeBaseUrl] = useState("");
  const [agentRuntimeBaseUrl, setAgentRuntimeBaseUrlValue] = useState("");
  const [pythonInterpreterPath, setPythonInterpreterPath] = useState("");

  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<Record<string, string | null>>({});
  const [sectionSavedAt, setSectionSavedAt] = useState<Record<string, string | null>>({});

  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [checkingConnections, setCheckingConnections] = useState(false);
  const [modelsResult, setModelsResult] = useState<OllamaModelsResult | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const applySettings = useCallback((s: DesktopSettingsPublic) => {
    setSettings(s);
    setClientDisplayName(s.clientDisplayName ?? "");
    setSiteId(s.siteId ?? "");
    setOllamaBaseUrl(s.ollamaBaseUrl);
    setOllamaAllowNonLoopback(s.ollamaAllowNonLoopback);
    setChatModelAlias(s.chatModelAlias);
    setMcpServerAlias(s.mcpServerAlias);
    setMcpServerUrl(s.mcpServerUrl);
    setSearchRuntimeBaseUrl(s.searchRuntimeBaseUrl);
    setAgentRuntimeBaseUrlValue(s.agentRuntimeBaseUrl);
    setPythonInterpreterPath(s.pythonInterpreterPath ?? "");
  }, []);

  // 편집값이 아니라 사실 조회라 설정 저장/복원 흐름과 분리한다 — bridge 가
  // 없으면(브라우저 개발 모드) 빈 목록이 정직한 답이다.
  const loadEmbedModels = useCallback(async () => {
    try {
      setEmbedModels((await bridge?.getKnowledgeEmbedModels()) ?? []);
    } catch {
      setEmbedModels([]);
    }
  }, []);

  const loadOllamaModels = useCallback(
    async (baseUrl: string) => {
      if (!bridge) return;
      setLoadingModels(true);
      setModelsResult(null);
      try {
        setModelsResult(await bridge.listOllamaModels(baseUrl));
      } catch (err) {
        setModelsResult({
          ok: false,
          models: [],
          error: err instanceof Error ? err.message : "Ollama 모델 목록을 불러오지 못했습니다.",
        });
      } finally {
        setLoadingModels(false);
      }
    },
    [bridge],
  );

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
      await loadOllamaModels(s.ollamaBaseUrl);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "설정을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge, applySettings, loadOllamaModels]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadEmbedModels();
  }, [loadEmbedModels]);

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
      if (section === "ollama") await loadOllamaModels(result.settings.ollamaBaseUrl);
    } catch (err) {
      setSectionError((prev) => ({
        ...prev,
        [section]: err instanceof Error ? err.message : "설정을 저장하지 못했습니다.",
      }));
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
  const searchStatus = connections?.find((c) => c.id === "search") ?? null;
  const runtimeStatus = connections?.find((c) => c.id === "runtime") ?? null;
  const installedChatModels = getInstalledChatModels(modelsResult);
  const currentChatModelIsInstalled = installedChatModels.includes(chatModelAlias);
  const cannotSaveModelsReason = getChatModelSelectionIssue(loadingModels, modelsResult, chatModelAlias);

  return (
    <div className="space-y-4">
      <PageHeader title="설정" description="Office Profile·모델·경로·로그 정책을 확인·변경합니다." />

      {browserPreview && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-body text-amber-900">
          <strong>브라우저 개발 모드</strong> — 설정은 이 브라우저에만 저장되며 Desktop 설정 파일에는 반영되지
          않습니다. Electron 실행 시 실제 설정을 다시 확인하세요.
        </div>
      )}

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
        <SectionHeader title="지식 검색 임베딩 모델" />
        {/* 편집 필드가 아니다. 질의 임베딩에 실제로 쓰이는 모델은 그 Knowledge
            색인이 만들어질 때 기록된 값이고(D-075), 여기서 다른 값을 고르게
            하면 검색이 조용히 망가진다 — 옛 "기본 Embedding Model Alias" 자유
            입력은 아무 데도 전달되지 않는 값이었다. */}
        <p className="mb-3 text-body text-text-secondary">
          질의는 각 Knowledge가 <strong>색인될 때 사용한 모델</strong>로 임베딩됩니다. 다른 모델로 바꾸려면 그
          Knowledge를 다시 색인해야 하며, 재색인은 Portal에서 수행합니다 — 그래서 여기서는 선택할 수 없고 현재 값을
          보여 드립니다.
        </p>
        {embedModels === null ? (
          <p className="text-caption text-text-muted">확인 중...</p>
        ) : embedModels.length === 0 ? (
          <p className="text-caption text-text-muted">설치된 Knowledge가 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {embedModels.map((info) => (
              <li key={`${info.assetId}@${info.version}`} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-medium text-text-primary">
                    {info.name} v{info.version}
                  </span>
                  {info.state === "RECORDED" ? (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                      {info.embedModel}
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                      {info.state === "ASSUMED_FALLBACK" ? "기록 없음(추정)" : "확인 불가"}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-caption text-text-secondary">{info.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="Ollama 모델" />
        <p className="mb-3 text-body text-text-secondary">
          기본 채팅에서 사용할 실제 Ollama 모델을 선택합니다.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-caption font-medium text-text-secondary" htmlFor="settings-chat-model">
              기본 채팅 모델
            </label>
            <select
              id="settings-chat-model"
              value={chatModelAlias}
              onChange={(event) => setChatModelAlias(event.target.value)}
              disabled={loadingModels || installedChatModels.length === 0}
              className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-body text-text-primary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-text-muted"
            >
              {!currentChatModelIsInstalled && chatModelAlias && (
                <option value={chatModelAlias}>{chatModelAlias} (현재 설정 · 설치 목록에 없음)</option>
              )}
              {installedChatModels.length === 0 && !chatModelAlias && <option value="">설치된 채팅 모델 없음</option>}
              {installedChatModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <p className={`mt-1 text-caption ${cannotSaveModelsReason ? "text-warning" : "text-text-muted"}`}>
              {cannotSaveModelsReason ?? `${installedChatModels.length}개의 채팅 모델을 선택할 수 있습니다.`}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("models", { chatModelAlias })}
            disabled={savingSection === "models" || cannotSaveModelsReason !== null}
            title={cannotSaveModelsReason ?? undefined}
          >
            <Save size={14} /> 저장
          </Button>
          <Button
            variant="secondary"
            onClick={() => void loadOllamaModels(settings.ollamaBaseUrl)}
            disabled={loadingModels}
          >
            <RefreshCw size={14} className={loadingModels ? "animate-spin" : ""} /> 설치 모델 다시 확인
          </Button>
          {sectionSavedAt.models && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.models)} 저장됨</span>}
        </div>
        {sectionError.models && <div className="mt-2"><ErrorBanner message={sectionError.models} /></div>}
        {modelsResult?.ok === false && (
          <div className="mt-2"><ErrorBanner message={modelsResult.error ?? "Ollama 모델 목록을 불러오지 못했습니다."} /></div>
        )}
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
        <SectionHeader title="대화 실행(Local Agent Runtime) 연결" />
        <p className="mb-3 text-body text-text-secondary">
          대화 실행, 연결 상태 표시, 설치된 MCP Tool 연결이 모두 이 주소를 사용합니다. 이 PC에서 실행 중인 Runtime만
          가리킬 수 있습니다(loopback: 127.0.0.1/localhost) — 대화 질문과 설치된 자산 정보가 이 기기 밖으로 나가지
          않도록 하기 위한 제한이며, 저장 시 원격 주소는 항상 거부됩니다.
        </p>
        <LabeledInput
          id="settings-agent-runtime-url"
          label="Local Agent Runtime Base URL"
          value={agentRuntimeBaseUrl}
          onChange={setAgentRuntimeBaseUrlValue}
          placeholder="http://127.0.0.1:8100"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("agentRuntime", { agentRuntimeBaseUrl })}
            disabled={savingSection === "agentRuntime"}
          >
            <Save size={14} /> 저장
          </Button>
          <Button variant="secondary" onClick={() => void runConnectionsCheck()} disabled={checkingConnections}>
            <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 연결 테스트
          </Button>
          {sectionSavedAt.agentRuntime && (
            <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.agentRuntime)} 저장됨</span>
          )}
        </div>
        {sectionError.agentRuntime && <div className="mt-2"><ErrorBanner message={sectionError.agentRuntime} /></div>}
        {runtimeStatus && (
          <div className="mt-3">
            <CheckRow
              label={runtimeStatus.label}
              status={runtimeStatus.ok ? "PASS" : "FAIL"}
              message={runtimeStatus.ok ? runtimeStatus.detail : `${runtimeStatus.detail} — ${runtimeStatus.recoveryHint ?? ""}`}
            />
          </div>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="지식 검색(search-runtime) 연결" />
        <p className="mb-3 text-body text-text-secondary">
          설치된 Knowledge를 활성화(검색 가능하게 등록)할 때 사용하는 주소입니다. 활성화 요청은 이 PC의 로컬 절대
          경로를 그대로 담아 전달하므로, 반드시 이 PC(loopback: 127.0.0.1/localhost)에서 실행 중인 search-runtime을
          가리켜야 합니다 — 원격 주소는 그 경로를 읽을 수 없어 애초에 동작할 수 없고, 저장 시에도 항상 거부됩니다
          (Ollama의 "외부 허용" 같은 예외가 없습니다).
        </p>
        <LabeledInput
          id="settings-search-runtime-url"
          label="search-runtime Base URL"
          value={searchRuntimeBaseUrl}
          onChange={setSearchRuntimeBaseUrl}
          placeholder="http://127.0.0.1:8300"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("search", { searchRuntimeBaseUrl })}
            disabled={savingSection === "search"}
          >
            <Save size={14} /> 저장
          </Button>
          <Button variant="secondary" onClick={() => void runConnectionsCheck()} disabled={checkingConnections}>
            <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 연결 테스트
          </Button>
          {sectionSavedAt.search && <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.search)} 저장됨</span>}
        </div>
        {sectionError.search && <div className="mt-2"><ErrorBanner message={sectionError.search} /></div>}
        {searchStatus && (
          <div className="mt-3">
            <CheckRow
              label={searchStatus.label}
              status={searchStatus.ok ? "PASS" : "FAIL"}
              message={searchStatus.ok ? searchStatus.detail : `${searchStatus.detail} — ${searchStatus.recoveryHint ?? ""}`}
            />
          </div>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="Python 인터프리터 경로" />
        <p className="mb-3 text-body text-text-secondary">
          자산 허브 &gt; 로컬 Tool 실행에 사용할 Python 인터프리터의 절대 경로입니다. 비워 두면 로컬 Tool 실행이
          비활성화됩니다 — <code>python</code>/<code>python3</code> 같은 PATH 이름으로 자동 대체하지 않습니다(어떤
          인터프리터가 사용될지 항상 명시적으로 지정해야 합니다).
        </p>
        <LabeledInput
          id="settings-python-interpreter-path"
          label="Python 인터프리터 경로"
          value={pythonInterpreterPath}
          onChange={setPythonInterpreterPath}
          placeholder="예: /usr/bin/python3"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void saveSection("pythonInterpreter", { pythonInterpreterPath })}
            disabled={savingSection === "pythonInterpreter"}
          >
            <Save size={14} /> 저장
          </Button>
          {sectionSavedAt.pythonInterpreter && (
            <span className="text-caption text-text-muted">{formatDateTime(sectionSavedAt.pythonInterpreter)} 저장됨</span>
          )}
        </div>
        {sectionError.pythonInterpreter && (
          <div className="mt-2">
            <ErrorBanner message={sectionError.pythonInterpreter} />
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
