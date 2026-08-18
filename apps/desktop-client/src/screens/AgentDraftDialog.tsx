// D06 채팅 화면 "대화로 Agent 초안 만들기" — 현재 세션의 라이브 메시지를
// 재료로 Agent+Prompt Manifest 초안(+ template.md)을 만들어 사용자가 고른
// 로컬 디렉터리에 파일로 내보낸다. 완전히 폐쇄망 완결형이다 — Portal로
// 아무것도 전송하지 않는다(`portal-client.ts`에 새 쓰기 경로를 추가하지
// 않았다), D-086 로컬 Agent 등록으로 직행시키지 않는다(등록 버튼 없음 — 이
// 초안에는 `local_agent_registry.py`가 신뢰의 근거로 삼는 "checksum 검증된
// Bundle에서 왔음"이 없다).
//
// 능력(capabilities) 도출은 이 파일이 아니라 `../../electron/agent-draft.ts`
// (fs/electron import 없는 순수 모듈)가 전담한다 — 이 컴포넌트는 그 결과를
// 보여주고, 사용자가 체크박스로 뒤집을 수 있게 하고, 최종 값으로 Manifest
// 미리보기를 그린다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Sparkles, Upload } from "lucide-react";
import type { ChatMessage } from "./chatTypes";
import {
  buildAgentManifestDraft,
  buildPromptManifestDraft,
  buildSystemPromptDraftRequest,
  deriveCapabilitiesFromMessages,
  resolveAgentDraftOwner,
  suggestCitationRequired,
  type CapabilityDerivation,
} from "../../electron/agent-draft";
import { chatWithOllama, DEFAULT_CHAT_MODEL_ALIAS } from "../../electron/ollama-chat";
import { DEFAULT_OLLAMA_BASE_URL } from "../../electron/connections";
import type { AgentDraftUploadAssetOutcome, AgentDraftUploadResult } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { getBrowserSettingsBridge } from "../browserPreviewBridge";
import { Button, ErrorBanner, LoadingState, Modal } from "../ui";

type GenerationStatus = "idle" | "loading" | "done" | "error" | "cancelled";
type ExportStatus = "idle" | "busy" | "done" | "error";

export function AgentDraftDialog({ messages, onClose }: { messages: ChatMessage[]; onClose: () => void }) {
  const bridge = getDesktopBridge();
  const browserSettingsBridge = getBrowserSettingsBridge();

  // `deriveCapabilitiesFromMessages`는 `ChatMessage[]`의 구조적 부분집합만
  // 요구한다(agent-draft.ts의 `AgentDraftSourceMessage`) — 별도 변환 없이
  // 그대로 넘길 수 있다.
  const derivation: CapabilityDerivation = useMemo(() => deriveCapabilitiesFromMessages(messages), [messages]);
  const liveQuestions = useMemo(
    () => messages.filter((m) => m.restored !== true).map((m) => m.question),
    [messages],
  );

  // --- 1. 도출된 capabilities — 체크박스로 전부 편집 가능(뒤집으면 "판단을
  //        재정의했습니다"만 덧붙이고, 근거 문구 자체는 거짓으로 바꾸지 않는다).
  const [knowledgeRequiredOverride, setKnowledgeRequiredOverride] = useState<boolean | null>(null);
  const [mcpAllowedOverride, setMcpAllowedOverride] = useState<boolean | null>(null);
  const knowledgeRequired = knowledgeRequiredOverride ?? derivation.knowledgeRequired.value;
  const mcpAllowed = mcpAllowedOverride ?? derivation.mcpAllowed.value;

  const [citationRequired, setCitationRequired] = useState(() => suggestCitationRequired(derivation.knowledgeRequired.value));
  // knowledge_required가 재정의로 바뀌면 citation_required 제안도 다시
  // 계산한다 — 단, 사용자가 이미 citation_required 자체를 손댔다면 그 선택을
  // 덮어쓰지 않는다.
  const citationTouchedRef = useRef(false);
  useEffect(() => {
    if (!citationTouchedRef.current) setCitationRequired(suggestCitationRequired(knowledgeRequired));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeRequired]);

  // --- 2. Agent 이름/설명 -----------------------------------------------------
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameTrimmed = name.trim();
  const [nameTouched, setNameTouched] = useState(false);
  const nameError = nameTouched && nameTrimmed.length === 0 ? "Agent 이름을 입력하세요." : null;

  // --- 3. 시스템 프롬프트 초안 생성(Ollama, Main Process IPC 경유) ------------
  const [systemPrompt, setSystemPrompt] = useState("");
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>("idle");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const browserAbortRef = useRef<AbortController | null>(null);

  async function handleGenerate(): Promise<void> {
    cancelledRef.current = false;
    setGenerationStatus("loading");
    setGenerationError(null);
    try {
      let result: { answer: string; model: string };
      if (bridge) {
        result = await bridge.generateAgentDraftSystemPrompt(liveQuestions);
      } else {
        // 브라우저 개발 모드 — `ChatScreen`의 Ollama 일반 대화와 동일한
        // 패턴: IPC 브릿지 없이도 loopback Ollama에 직접 fetch한다.
        const settings = browserSettingsBridge ? await browserSettingsBridge.getDesktopSettings() : null;
        const request = buildSystemPromptDraftRequest(liveQuestions);
        const controller = new AbortController();
        browserAbortRef.current = controller;
        result = await chatWithOllama(
          settings?.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
          settings?.chatModelAlias ?? DEFAULT_CHAT_MODEL_ALIAS,
          request,
          controller.signal,
        );
      }
      if (cancelledRef.current) {
        setGenerationStatus("cancelled");
        return;
      }
      setSystemPrompt(result.answer);
      setGenerationStatus("done");
    } catch (err) {
      if (cancelledRef.current) {
        setGenerationStatus("cancelled");
        return;
      }
      setGenerationStatus("error");
      // 실패를 조용히 넘기지 않는다 — 지어낸 기본 프롬프트를 채우지 않고
      // textarea는 비워 둔 채(직접 작성 가능) 에러만 보여준다.
      setGenerationError(err instanceof Error ? err.message : "시스템 프롬프트 생성에 실패했습니다.");
    } finally {
      browserAbortRef.current = null;
    }
  }

  async function handleCancelGenerate(): Promise<void> {
    cancelledRef.current = true;
    if (bridge) {
      await bridge.cancelAgentDraftSystemPromptGeneration();
    } else {
      browserAbortRef.current?.abort();
    }
  }

  // --- owner.org/owner.creator_id — 로그인 개념이 없는 이 PoC Desktop에서는
  //     desktop-settings.json의 siteId/clientDisplayName을 정직한 자리표시자로
  //     쓴다(agent-draft.ts의 `resolveAgentDraftOwner` 문서 참고).
  const [ownerSource, setOwnerSource] = useState<{ siteId: string | null; clientDisplayName: string | null }>({
    siteId: null,
    clientDisplayName: null,
  });
  useEffect(() => {
    let cancelled = false;
    const settingsBridge = bridge ?? browserSettingsBridge;
    if (!settingsBridge) return;
    settingsBridge
      .getDesktopSettings()
      .then((settings) => {
        if (!cancelled) setOwnerSource({ siteId: settings.siteId, clientDisplayName: settings.clientDisplayName });
      })
      .catch(() => {
        // 조회 실패해도 정직한 fallback("local"/"desktop-user")으로 계속
        // 진행한다 — 이 조회 하나 때문에 초안 작성 전체를 막지 않는다.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const owner = resolveAgentDraftOwner(ownerSource.siteId, ownerSource.clientDisplayName);

  // --- 4. 매니페스트 미리보기 — 필드가 바뀔 때마다 실시간 반영 -----------------
  const [agentId] = useState(() => crypto.randomUUID());
  const [promptId] = useState(() => crypto.randomUUID());

  const agentManifest = useMemo(
    () =>
      buildAgentManifestDraft({
        agentId,
        name: nameTrimmed,
        description: description.trim(),
        owner,
        knowledgeRequired,
        mcpAllowed,
        citationRequired,
      }),
    [agentId, nameTrimmed, description, owner, knowledgeRequired, mcpAllowed, citationRequired],
  );
  const promptManifest = useMemo(
    () =>
      buildPromptManifestDraft({
        promptId,
        name: nameTrimmed ? `${nameTrimmed} 프롬프트` : "",
        description: description.trim(),
        owner,
        systemPrompt,
        citationRequired,
      }),
    [promptId, nameTrimmed, description, owner, systemPrompt, citationRequired],
  );

  // --- 5. 디렉터리 선택 후 내보내기 -------------------------------------------
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const canExport = derivation.hasLiveMessages && nameTrimmed.length > 0 && exportStatus !== "busy";

  async function handleExport(): Promise<void> {
    if (!nameTrimmed) {
      setNameTouched(true);
      return;
    }
    if (!bridge) {
      // Permission 상태 — Electron 브릿지 자체가 없는 브라우저 개발 모드.
      setExportStatus("error");
      setExportError("Desktop 앱에서 실행해야 파일로 내보낼 수 있습니다.");
      return;
    }
    setExportError(null);
    const directory = await bridge.pickAgentDraftExportDirectory();
    if (!directory) {
      // 취소 — 조용히 다이얼로그로 돌아간다(오류 아님).
      return;
    }
    setExportStatus("busy");
    try {
      const result = await bridge.exportAgentDraft({
        directory,
        agentManifest,
        promptManifest,
        templateContent: systemPrompt || "(시스템 프롬프트가 아직 작성되지 않았습니다.)",
      });
      if (result.ok) {
        setSavedPath(result.savedPath);
        setExportStatus("done");
      } else {
        setExportStatus("error");
        setExportError(result.error ?? "파일을 저장하지 못했습니다.");
      }
    } catch (err) {
      setExportStatus("error");
      setExportError(err instanceof Error ? err.message : "파일을 저장하지 못했습니다.");
    }
  }

  // --- 6. Portal에 DRAFT로 등록(선택 — Portal이 설정된 배포에서만) -----------
  // 파일 내보내기(위)와는 완전히 독립적이다: Portal 미설정이면 이 진입점
  // 자체를 숨긴다(폐쇄형 신호, 새 설정 항목을 만들지 않는다 — `portal-
  // settings.ts`의 `baseUrl`/`token` 미설정을 그대로 신호로 쓴다). 자동
  // 전송은 없다 — 사용자가 "확인하고 등록"을 눌러야만 나간다.
  const [portalConfigured, setPortalConfigured] = useState(false);
  useEffect(() => {
    if (!bridge) return; // 브라우저 개발 모드: Portal 업로드 진입점 자체를 보여주지 않는다.
    let cancelled = false;
    bridge
      .getPortalSettings()
      .then((settings) => {
        if (!cancelled) setPortalConfigured(!!settings.baseUrl && settings.tokenConfigured);
      })
      .catch(() => {
        // 조회 실패는 "미설정"과 동일하게 다룬다 — 불확실하면 닫힌 쪽으로
        // 실패한다(루트 CLAUDE.md).
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const [uploadConfirmOpen, setUploadConfirmOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "busy" | "done" | "cancelled">("idle");
  const [uploadResult, setUploadResult] = useState<AgentDraftUploadResult | null>(null);
  const uploadCancelledRef = useRef(false);

  async function handleConfirmUpload(): Promise<void> {
    if (!bridge) return;
    uploadCancelledRef.current = false;
    setUploadConfirmOpen(false);
    setUploadStatus("busy");
    try {
      const result = await bridge.uploadAgentDraft({
        agentManifest,
        promptManifest,
        templateContent: systemPrompt || "(시스템 프롬프트가 아직 작성되지 않았습니다.)",
      });
      setUploadResult(result);
      setUploadStatus(uploadCancelledRef.current ? "cancelled" : "done");
    } catch (err) {
      // 부분 실패는 이미 `uploadAgentDraft`가 resolve로 알려준다 — 이
      // catch는 IPC 자체가 끊긴 것과 같은 예상 밖 실패만 다룬다.
      setUploadResult({
        attempted: true,
        notConfiguredReason: null,
        agent: {
          ok: false,
          assetId: null,
          versionId: null,
          version: null,
          errorCode: "UNKNOWN",
          errorMessage: err instanceof Error ? err.message : "Portal 등록에 실패했습니다.",
          validationErrors: null,
        },
        prompt: null,
      });
      setUploadStatus(uploadCancelledRef.current ? "cancelled" : "done");
    }
  }

  async function handleCancelUpload(): Promise<void> {
    uploadCancelledRef.current = true;
    if (bridge) await bridge.cancelAgentDraftUpload();
  }

  function renderPortalUploadSection() {
    if (!portalConfigured) return null;
    return (
      <section className="rounded-lg border border-border p-3">
        <h4 className="mb-2 text-caption font-semibold text-text-primary">Portal에 DRAFT로 등록</h4>

        {uploadStatus === "idle" && !uploadConfirmOpen && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-caption text-text-muted">
              위 두 매니페스트를 Portal에 DRAFT 상태로 등록합니다(승인·게시는 별도로 진행됩니다).
            </p>
            <Button variant="secondary" size="sm" onClick={() => setUploadConfirmOpen(true)}>
              <Upload size={13} /> Portal에 등록
            </Button>
          </div>
        )}

        {uploadConfirmOpen && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3">
            <p className="text-body text-text-primary">아래 내용을 전송합니다 — 확인 후에만 나갑니다.</p>
            <ul className="list-disc space-y-1 pl-5 text-caption text-text-secondary">
              <li>Agent 자산 1건, Prompt 자산 1건(첨부: template.md) — 위 미리보기에 표시된 매니페스트 원문 그대로.</li>
              <li>상태: 두 자산 모두 <strong>DRAFT</strong>로 생성됩니다(승인·게시는 이 Desktop에서 진행하지 않습니다).</li>
              <li>등록 후에는 Portal에서 검토·승인을 거쳐야 합니다.</li>
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setUploadConfirmOpen(false)}>
                취소
              </Button>
              <Button size="sm" onClick={() => void handleConfirmUpload()}>
                확인하고 등록
              </Button>
            </div>
          </div>
        )}

        {uploadStatus === "busy" && (
          <div className="flex items-center justify-between gap-3">
            <LoadingState label="Portal에 등록하는 중..." />
            <Button variant="secondary" size="sm" onClick={() => void handleCancelUpload()}>
              취소
            </Button>
          </div>
        )}

        {(uploadStatus === "done" || uploadStatus === "cancelled") && uploadResult && (
          <div className="space-y-2">
            {uploadStatus === "cancelled" && (
              <p className="text-caption text-warning">
                취소를 요청했습니다 — 아래는 취소 시점까지 실제로 서버에 반영된 결과입니다. 이미 등록된 자산은 이
                Desktop에서 되돌릴 수 없으니 Portal에서 직접 정리하세요.
              </p>
            )}
            {!uploadResult.attempted && (
              <ErrorBanner message={uploadResult.notConfiguredReason ?? "Portal에 등록할 수 없습니다."} />
            )}
            {uploadResult.attempted && (
              <>
                <UploadOutcomeRow label="Agent" outcome={uploadResult.agent} />
                <UploadOutcomeRow label="Prompt" outcome={uploadResult.prompt} />
              </>
            )}
            <div className="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setUploadStatus("idle");
                  setUploadResult(null);
                }}
              >
                닫기
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <Modal open title="대화로 Agent 초안 만들기" onClose={onClose}>
      <div className="space-y-5">
        {!derivation.hasLiveMessages && (
          <ErrorBanner message="이 세션에서 실제로 실행된 턴이 아직 없습니다 — 근거로 쓸 대화가 없어 초안을 만들 수 없습니다." />
        )}

        {derivation.hasLiveMessages && exportStatus !== "done" && (
          <>
            {/* --- 1. 도출된 capabilities와 근거 --------------------------- */}
            <section>
              <h4 className="mb-2 text-caption font-semibold text-text-primary">도출된 능력(capabilities)</h4>
              <div className="space-y-2">
                <label className="flex items-start gap-2 rounded-lg border border-border p-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={knowledgeRequired}
                    onChange={(e) => setKnowledgeRequiredOverride(e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-text-primary">Knowledge 필요(knowledge_required)</span>
                    <span className="block text-caption text-text-muted">{derivation.knowledgeRequired.reason}</span>
                    {knowledgeRequiredOverride !== null && knowledgeRequiredOverride !== derivation.knowledgeRequired.value && (
                      <span className="block text-caption text-warning">판단을 재정의했습니다.</span>
                    )}
                  </span>
                </label>

                <label className="flex items-start gap-2 rounded-lg border border-border p-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={mcpAllowed}
                    onChange={(e) => setMcpAllowedOverride(e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-text-primary">Tool 호출 허용(mcp_allowed)</span>
                    <span className="block text-caption text-text-muted">{derivation.mcpAllowed.reason}</span>
                    {mcpAllowedOverride !== null && mcpAllowedOverride !== derivation.mcpAllowed.value && (
                      <span className="block text-caption text-warning">판단을 재정의했습니다.</span>
                    )}
                  </span>
                </label>

                <label className="flex items-start gap-2 rounded-lg border border-border p-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={citationRequired}
                    onChange={(e) => {
                      citationTouchedRef.current = true;
                      setCitationRequired(e.target.checked);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-text-primary">근거 표시 필수(citation_required)</span>
                    <span className="block text-caption text-text-muted">
                      {knowledgeRequired
                        ? "Knowledge가 필요한 Agent이므로 기본으로 켜서 제안합니다."
                        : "Knowledge가 필요하지 않은 Agent라 기본으로 켜서 제안하지 않습니다."}
                    </span>
                  </span>
                </label>
              </div>
            </section>

            {/* --- 2. Agent 이름/설명 --------------------------------------- */}
            <section className="space-y-3">
              <div>
                <label htmlFor="agent-draft-name" className="mb-1 block text-caption font-semibold text-text-muted">
                  Agent 이름 <span className="text-danger">*</span>
                </label>
                <input
                  id="agent-draft-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  placeholder="예: 인사 정책 안내 챗봇"
                  className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary"
                />
                {nameError && <p className="mt-1 text-caption text-danger">{nameError}</p>}
              </div>
              <div>
                <label htmlFor="agent-draft-description" className="mb-1 block text-caption font-semibold text-text-muted">
                  설명
                </label>
                <textarea
                  id="agent-draft-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="이 Agent가 무엇을 하는지 간단히 설명하세요."
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm text-text-primary"
                />
              </div>
            </section>

            {/* --- 3. 시스템 프롬프트 초안 생성 ------------------------------ */}
            <section>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="agent-draft-system-prompt" className="text-caption font-semibold text-text-muted">
                  시스템 프롬프트
                </label>
                {generationStatus === "loading" ? (
                  <Button variant="secondary" size="sm" onClick={() => void handleCancelGenerate()}>
                    <Loader2 size={13} className="animate-spin" /> 취소
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void handleGenerate()}>
                    <Sparkles size={13} /> 초안 생성(Ollama)
                  </Button>
                )}
              </div>
              {generationStatus === "loading" && <LoadingState label="질문 목록만으로 시스템 프롬프트를 작성하는 중..." />}
              {generationStatus === "cancelled" && (
                <p className="mb-1.5 text-caption text-text-muted">생성을 취소했습니다 — 아래에 직접 작성할 수 있습니다.</p>
              )}
              {generationStatus === "error" && generationError && <ErrorBanner message={generationError} />}
              <textarea
                id="agent-draft-system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                placeholder="Ollama로 초안을 생성하거나 직접 작성하세요."
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm text-text-primary"
              />
              <p className="mt-1 text-caption text-text-muted">
                생성 시 이번 대화의 질문 텍스트만 사용합니다(답변 본문·근거 문서 내용은 전달하지 않습니다).
              </p>
            </section>

            {/* --- 4. 매니페스트 JSON 전체 미리보기 -------------------------- */}
            <section>
              <h4 className="mb-1.5 text-caption font-semibold text-text-primary">저장될 파일 미리보기</h4>
              <p className="mb-2 text-caption text-text-muted">agent-manifest.json</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] text-text-secondary">
                {JSON.stringify(agentManifest, null, 2)}
              </pre>
              <p className="mt-3 mb-2 text-caption text-text-muted">prompt-manifest.json</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] text-text-secondary">
                {JSON.stringify(promptManifest, null, 2)}
              </pre>
            </section>

            {renderPortalUploadSection()}

            {exportStatus === "error" && exportError && <ErrorBanner message={exportError} />}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                닫기
              </Button>
              <Button onClick={() => void handleExport()} disabled={!canExport}>
                {exportStatus === "busy" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> 저장 중...
                  </>
                ) : (
                  <>
                    <Download size={14} /> 디렉터리 선택 후 내보내기
                  </>
                )}
              </Button>
            </div>
          </>
        )}

        {exportStatus === "done" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-body text-text-primary">
              <p className="font-medium">Agent 초안을 저장했습니다.</p>
              <p className="mt-1 text-caption text-text-secondary">
                저장 위치: <code className="rounded bg-slate-100 px-1 py-0.5">{savedPath}</code>
              </p>
              <p className="mt-1 text-caption text-text-secondary">
                저장된 파일: agent-manifest.json, prompt-manifest.json, template.md
              </p>
              <p className="mt-2 text-caption text-text-muted">
                {portalConfigured
                  ? "Portal이 설정되어 있습니다 — 아래에서 이 두 Manifest를 Portal에 DRAFT로 등록할 수도 있습니다(파일 저장과는 별개의 선택입니다)."
                  : "Portal이 설정되지 않은 환경입니다 — 방금 저장한 파일을 P05 자산 등록 화면에 직접 올려 사용하세요(이 Desktop은 아무것도 Portal로 전송하지 않았습니다)."}
              </p>
            </div>

            {renderPortalUploadSection()}

            <div className="flex justify-end">
              <Button variant="secondary" onClick={onClose}>
                닫기
              </Button>
            </div>
          </div>
        )}

        {!derivation.hasLiveMessages && (
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              닫기
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Agent 또는 Prompt 하나의 Portal 등록 결과를 그대로 보여준다 — 서버가
 * 돌려준 오류코드/메시지를 뭉개지 않는다(브리프 E항). `PERMISSION_DENIED`와
 * `VALIDATION_ERROR`만 별도로 안내를 덧붙이고, 나머지(업로드 상한 4종 포함)
 * 는 서버 메시지를 코드와 함께 그대로 노출한다 — 코드별로 메시지가 이미
 * 다르므로 이것만으로 서로 구분된다. */
function UploadOutcomeRow({ label, outcome }: { label: string; outcome: AgentDraftUploadAssetOutcome | null }) {
  if (!outcome) {
    return <p className="text-caption text-text-muted">{label}: 시도되지 않았습니다.</p>;
  }
  if (outcome.ok) {
    return (
      <p className="text-caption text-success">
        {label}: 등록 성공 — 자산 ID <code className="rounded bg-slate-100 px-1 py-0.5">{outcome.assetId}</code>,
        버전 {outcome.version}(DRAFT). Portal에서 검토·승인을 진행하세요.
      </p>
    );
  }
  if (outcome.errorCode === "PERMISSION_DENIED") {
    return (
      <div className="text-caption text-danger">
        <p>{label}: 등록 실패 — 이 작업을 수행할 권한이 없습니다.</p>
        <p className="text-text-secondary">ASSET_CREATE 권한이 있는 Portal 토큰이 필요합니다 — 설정에서 토큰을 확인하세요.</p>
      </div>
    );
  }
  return (
    <div className="text-caption text-danger">
      <p>
        {label}: 등록 실패 ({outcome.errorCode})
      </p>
      <p className="text-text-secondary">{outcome.errorMessage}</p>
      {outcome.validationErrors && outcome.validationErrors.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-secondary">
          {outcome.validationErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
