// D01 최초 설정 Wizard (02-desktop-and-agent-runtime.md §D01).
//
// 7단계: 설치 경로·여유 공간 -> Office Profile(Client 표시명/사업장 ID) ->
// Ollama Endpoint 확인 -> 설치된 Chat/Embedding 모델 확인 -> Office MCP
// Server 연결 확인 -> 기본 로그·보관 정책 확인 -> 전체 진단 결과와 저장.
//
// 이 화면과 D10(SettingsScreen.tsx)은 정확히 같은 저장소
// (electron/desktop-settings.ts, `getDesktopSettings`/`updateDesktopSettings`)를
// 읽고 쓴다 — 서로 다른 두 저장소를 두지 않는다. 3-5단계의 연결 확인은
// `connections.ts`의 `checkAllConnections()`를 그대로 재사용한다(같은 값을
// D09 연결 상태 화면도 보여준다) — 별도 확인 로직을 새로 만들지 않는다.
//
// "Office Profile 가져오기" 자체(파일 Import)는 이 PoC에 아직 없다(정직하게
// 명시) — 2단계는 그 자리에서 Client 표시명/사업장 ID를 직접 입력받는다.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { ConnectionStatus, DesktopSettingsPublic, DiskSpaceInfo, OllamaModelsResult } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { getBrowserSettingsBridge, isBrowserDesktopPreviewEnabled } from "../browserPreviewBridge";
import { Button, BridgeUnavailableState, Card, CheckRow, ErrorBanner, LabeledInput, LoadingState, PageHeader } from "../ui";
import { computeDiskSpaceCheck, computeModelsCheck, computeOverallStatus, WIZARD_STEPS } from "./setupWizardTypes";

export function SetupWizardScreen({ onCompleted }: { onCompleted: () => void }) {
  const bridge = getDesktopBridge() ?? getBrowserSettingsBridge();
  const browserPreview = isBrowserDesktopPreviewEnabled();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  // 폼 필드 — DesktopSettingsPublic에서 초기화된다.
  const [clientDisplayName, setClientDisplayName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [ollamaAllowNonLoopback, setOllamaAllowNonLoopback] = useState(false);
  const [chatModelAlias, setChatModelAlias] = useState("");
  const [mcpServerAlias, setMcpServerAlias] = useState("");
  const [mcpServerUrl, setMcpServerUrl] = useState("");

  const [maxConcurrentRunsReason, setMaxConcurrentRunsReason] = useState<string | null>(null);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null);
  const [diskSpaceError, setDiskSpaceError] = useState<string | null>(null);

  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [checkingConnections, setCheckingConnections] = useState(false);

  const [modelsResult, setModelsResult] = useState<OllamaModelsResult | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);

  const [finished, setFinished] = useState(false);

  const applySettings = useCallback((s: DesktopSettingsPublic) => {
    setClientDisplayName(s.clientDisplayName ?? "");
    setSiteId(s.siteId ?? "");
    setOllamaBaseUrl(s.ollamaBaseUrl);
    setOllamaAllowNonLoopback(s.ollamaAllowNonLoopback);
    setChatModelAlias(s.chatModelAlias);
    setMcpServerAlias(s.mcpServerAlias);
    setMcpServerUrl(s.mcpServerUrl);
    setMaxConcurrentRunsReason(s.maxConcurrentRuns.reason);
  }, []);

  useEffect(() => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [settings, disk] = await Promise.all([bridge.getDesktopSettings(), bridge.getDiskSpace()]);
        if (cancelled) return;
        applySettings(settings);
        setDiskSpace(disk);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "설정을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, applySettings]);

  async function saveAndAdvance(patch: Record<string, unknown>) {
    if (!bridge) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await bridge.updateDesktopSettings(patch);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      applySettings(result.settings);
      setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
    } finally {
      setSaving(false);
    }
  }

  function goBack() {
    setSaveError(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function skipToNext() {
    setSaveError(null);
    setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
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

  async function runModelsCheck() {
    if (!bridge) return;
    setCheckingModels(true);
    try {
      setModelsResult(await bridge.listOllamaModels(ollamaBaseUrl));
    } finally {
      setCheckingModels(false);
    }
  }

  async function finishWizard() {
    if (!bridge) return;
    setSaving(true);
    try {
      await bridge.markSetupCompleted();
      setFinished(true);
    } finally {
      setSaving(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="최초 설정" description="Ollama·모델·MCP·자산 경로를 설정합니다." />
        <BridgeUnavailableState detail="최초 설정 Wizard는 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="최초 설정" description="Ollama·모델·MCP·자산 경로를 설정합니다." />
        <LoadingState label="설정을 불러오는 중..." />
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title="최초 설정" description="Ollama·모델·MCP·자산 경로를 설정합니다." />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  if (finished) {
    return (
      <div>
        <PageHeader title="최초 설정" description="Ollama·모델·MCP·자산 경로를 설정합니다." />
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <CheckCircle2 size={32} className="text-success" />
          <p className="text-card-title font-semibold text-text-primary">최초 설정이 저장되었습니다.</p>
          <p className="text-body text-text-secondary">설정은 언제든 D10 설정 화면에서 다시 변경할 수 있습니다.</p>
          <Button onClick={onCompleted}>홈으로 이동</Button>
        </Card>
      </div>
    );
  }

  const step = WIZARD_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === WIZARD_STEPS.length - 1;

  const diskCheck = computeDiskSpaceCheck(diskSpace, diskSpaceError);
  const modelsCheck = computeModelsCheck(modelsResult);
  const ollamaStatus = connections?.find((c) => c.id === "ollama") ?? null;
  const mcpStatus = connections?.find((c) => c.id === "mcp") ?? null;

  return (
    <div>
      <PageHeader title="최초 설정" description="Ollama·모델·MCP·자산 경로를 확인하고 저장합니다." />

      {browserPreview && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-body text-amber-900">
          <strong>브라우저 개발 모드</strong> — 이 마법사의 설정은 현재 브라우저에만 저장됩니다. 파일·디스크 관련
          단계는 Electron에서 최종 확인하세요.
        </div>
      )}

      {/* 진행 단계 표시 */}
      <div className="mb-6 flex items-center gap-2">
        {WIZARD_STEPS.map((s, idx) => (
          <div key={s.id} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                idx < stepIndex
                  ? "bg-success text-white"
                  : idx === stepIndex
                    ? "bg-brand-500 text-white"
                    : "bg-slate-100 text-text-muted"
              }`}
            >
              {idx + 1}
            </div>
            <span className={`text-caption ${idx === stepIndex ? "font-semibold text-text-primary" : "text-text-muted"}`}>
              {s.title}
            </span>
            {idx < WIZARD_STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      {saveError && (
        <div className="mb-4">
          <ErrorBanner message={saveError} />
        </div>
      )}

      <Card className="p-6">
        {step.id === "install-path" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">1. 설치 경로와 여유 공간</h2>
            <p className="text-body text-text-secondary">
              자산·설정·로그가 저장될 경로입니다. 사용자가 임의 경로를 지정하지 않고, Electron이 이 PC 계정의 표준
              애플리케이션 데이터 위치를 사용합니다.
            </p>
            <CheckRow label="설치 경로 여유 공간" status={diskCheck.status} message={diskCheck.message} />
          </div>
        )}

        {step.id === "office-profile" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">2. Office Profile 가져오기 또는 선택</h2>
            <p className="text-body text-text-secondary">
              이 PoC는 별도 Office Profile 파일 가져오기를 아직 지원하지 않습니다. 아래 정보를 직접 입력하면 이 Client의
              로컬 설정으로 저장됩니다.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <LabeledInput id="wizard-client-name" label="Client 표시명" value={clientDisplayName} onChange={setClientDisplayName} placeholder="예: 본사 1층 안내 PC" />
              <LabeledInput id="wizard-site-id" label="사업장 ID" value={siteId} onChange={setSiteId} placeholder="예: headquarters" />
            </div>
          </div>
        )}

        {step.id === "ollama" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">3. Ollama Endpoint 확인</h2>
            <p className="text-body text-text-secondary">
              기본적으로 loopback 주소(127.0.0.1/localhost)만 허용됩니다. 원격 Ollama가 필요하면 아래 허용 체크를
              명시적으로 켜야 합니다 — 보안 규칙이며 임의로 우회되지 않습니다.
            </p>
            <LabeledInput id="wizard-ollama-url" label="Ollama Base URL" value={ollamaBaseUrl} onChange={setOllamaBaseUrl} placeholder="http://127.0.0.1:11434" />
            <label className="flex items-center gap-2 text-body text-text-secondary">
              <input type="checkbox" checked={ollamaAllowNonLoopback} onChange={(e) => setOllamaAllowNonLoopback(e.target.checked)} />
              외부(원격) Ollama 허용 — 사내 보안 정책상 권장하지 않습니다.
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (async () => {
                    if (!bridge) return;
                    setSaving(true);
                    setSaveError(null);
                    try {
                      const result = await bridge.updateDesktopSettings({ ollamaBaseUrl, ollamaAllowNonLoopback });
                      if (!result.ok) {
                        setSaveError(result.error);
                        return;
                      }
                      applySettings(result.settings);
                      await runConnectionsCheck();
                    } finally {
                      setSaving(false);
                    }
                  })()
                }
                disabled={saving || checkingConnections}
              >
                <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 저장 및 연결 테스트
              </Button>
            </div>
            {ollamaStatus && <CheckRow label={ollamaStatus.label} status={ollamaStatus.ok ? "PASS" : "FAIL"} message={ollamaStatus.ok ? ollamaStatus.detail : `${ollamaStatus.detail} — ${ollamaStatus.recoveryHint ?? ""}`} />}
          </div>
        )}

        {step.id === "models" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">4. 설치된 Chat/Embedding 모델 확인</h2>
            <p className="text-body text-text-secondary">
              Desktop은 Alias와 실제 Ollama 모델 이름의 대응 관계를 알지 못합니다(Office Profile 가져오기 기능이
              아직 없음). 아래는 Ollama에 실제 설치된 모델 목록입니다 — 입력한 Alias가 이 중 하나를 가리키는지 직접
              확인하세요.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <LabeledInput id="wizard-chat-alias" label="기본 Chat Model Alias" value={chatModelAlias} onChange={setChatModelAlias} placeholder="default-chat" />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (async () => {
                    if (!bridge) return;
                    setSaving(true);
                    setSaveError(null);
                    try {
                      const result = await bridge.updateDesktopSettings({ chatModelAlias });
                      if (!result.ok) {
                        setSaveError(result.error);
                        return;
                      }
                      applySettings(result.settings);
                      await runModelsCheck();
                    } finally {
                      setSaving(false);
                    }
                  })()
                }
                disabled={saving || checkingModels}
              >
                <RefreshCw size={14} className={checkingModels ? "animate-spin" : ""} /> 저장 및 모델 목록 확인
              </Button>
            </div>
            <CheckRow label="Ollama 설치된 모델" status={modelsCheck.status} message={modelsCheck.message} />
          </div>
        )}

        {step.id === "mcp" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">5. Office MCP Server 연결 확인</h2>
            <p className="text-body text-text-secondary">
              등록된 Office Profile에 허용된 MCP Server만 사용합니다. PoC 기본값은 사내 Mock/승인된 Oracle Read-only
              Connector입니다.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <LabeledInput id="wizard-mcp-alias" label="MCP Server Alias" value={mcpServerAlias} onChange={setMcpServerAlias} placeholder="oracle-connector" />
              <LabeledInput id="wizard-mcp-url" label="MCP Server URL" value={mcpServerUrl} onChange={setMcpServerUrl} placeholder="http://127.0.0.1:8500" />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (async () => {
                    if (!bridge) return;
                    setSaving(true);
                    setSaveError(null);
                    try {
                      const result = await bridge.updateDesktopSettings({ mcpServerAlias, mcpServerUrl });
                      if (!result.ok) {
                        setSaveError(result.error);
                        return;
                      }
                      applySettings(result.settings);
                      await runConnectionsCheck();
                    } finally {
                      setSaving(false);
                    }
                  })()
                }
                disabled={saving || checkingConnections}
              >
                <RefreshCw size={14} className={checkingConnections ? "animate-spin" : ""} /> 저장 및 연결 테스트
              </Button>
            </div>
            {mcpStatus && <CheckRow label={mcpStatus.label} status={mcpStatus.ok ? "PASS" : "FAIL"} message={mcpStatus.ok ? mcpStatus.detail : `${mcpStatus.detail} — ${mcpStatus.recoveryHint ?? ""}`} />}
          </div>
        )}

        {step.id === "log-policy" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">6. 기본 로그·보관 정책 확인</h2>
            <CheckRow
              status="WARN"
              label="로그 보관 기간"
              message="현재 로컬 로그는 자동 삭제되지 않고 계속 누적됩니다(보관 기간 정책 미구현, open-decisions.md D-074). 필요 시 D11 로그/진단 화면에서 직접 확인·정리하세요."
            />
            <CheckRow
              status="PASS"
              label="진단 Bundle 개인정보 정책"
              message="D11 진단 Bundle 생성 시 Prompt 원문·문서 전체·DB 조회 결과·Secret은 항상 자동 제외됩니다."
            />
            <CheckRow status="PASS" label="Proxy" message="폐쇄망 기본 정책에 따라 비활성 상태입니다(변경 불가)." />
          </div>
        )}

        {step.id === "summary" && (
          <div className="space-y-4">
            <h2 className="text-card-title font-semibold text-text-primary">7. 전체 진단 결과와 저장</h2>
            <CheckRow
              label="종합 판정"
              status={computeOverallStatus([
                diskCheck.status,
                ollamaStatus ? (ollamaStatus.ok ? "PASS" : "FAIL") : "SKIP",
                modelsCheck.status,
                mcpStatus ? (mcpStatus.ok ? "PASS" : "FAIL") : "SKIP",
              ])}
              message="아래 각 항목의 가장 나쁜 상태를 반영합니다. WARN/FAIL이 있어도 저장은 가능하지만, 실제 사용 전 해당 단계로 돌아가 확인하는 것을 권장합니다."
            />
            <CheckRow label="설치 경로 여유 공간" status={diskCheck.status} message={diskCheck.message} />
            <CheckRow
              label="Client 정보"
              status={clientDisplayName.trim() ? "PASS" : "WARN"}
              message={clientDisplayName.trim() ? `${clientDisplayName} / ${siteId || "사업장 미지정"}` : "Client 표시명이 비어 있습니다. 2단계에서 입력할 수 있습니다."}
            />
            {ollamaStatus ? (
              <CheckRow label={ollamaStatus.label} status={ollamaStatus.ok ? "PASS" : "FAIL"} message={ollamaStatus.detail} />
            ) : (
              <CheckRow label="Ollama" status="SKIP" message="3단계에서 연결 테스트를 실행하지 않았습니다." />
            )}
            <CheckRow label="Ollama 설치된 모델" status={modelsCheck.status} message={modelsCheck.message} />
            {mcpStatus ? (
              <CheckRow label={mcpStatus.label} status={mcpStatus.ok ? "PASS" : "FAIL"} message={mcpStatus.detail} />
            ) : (
              <CheckRow label="Office MCP Server" status="SKIP" message="5단계에서 연결 테스트를 실행하지 않았습니다." />
            )}
            <CheckRow
              label="최대 동시 Run 수"
              status="WARN"
              message={maxConcurrentRunsReason ?? "현재 강제되지 않습니다."}
            />
            <div className="pt-2">
              <Button onClick={() => void finishWizard()} disabled={saving}>
                {saving && <Loader2 size={14} className="animate-spin" />}
                최초 설정 완료 및 저장
              </Button>
            </div>
          </div>
        )}
      </Card>

      <div className="mt-4 flex justify-between">
        <Button variant="secondary" onClick={goBack} disabled={isFirst || saving}>
          <ArrowLeft size={14} /> 이전
        </Button>
        {step.id === "install-path" || step.id === "log-policy" ? (
          <Button onClick={skipToNext} disabled={saving}>
            다음 <ArrowRight size={14} />
          </Button>
        ) : step.id === "office-profile" ? (
          <Button onClick={() => void saveAndAdvance({ clientDisplayName, siteId })} disabled={saving}>
            {saving && <Loader2 size={14} className="animate-spin" />} 다음 <ArrowRight size={14} />
          </Button>
        ) : !isLast ? (
          <Button onClick={skipToNext} disabled={saving}>
            다음 <ArrowRight size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
