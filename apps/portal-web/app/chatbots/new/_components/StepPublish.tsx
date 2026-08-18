"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, Lock } from "lucide-react";
import { Button, ErrorBanner, FormField, inputClass } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { AdvancedAgentSection, STANDARD_AGENT_LABEL } from "./AdvancedAgentSection";
import type { AgentChoice, ChatbotSettings, RegistryPromptSelection, SelectedKnowledge } from "./types";

// Fixed portal-api contract (apps/portal-api, port 8000).
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// DEPLOYMENT_PUBLISH permission holders (security_policy.roles.ROLE_PERMISSIONS).
const PUBLISH_ALLOWED_ROLES = new Set(["RELEASE_MANAGER", "ADMIN"]);

// Must match apps/portal-api/src/portal_api/routers/services.py SLUG_PATTERN exactly —
// this is a client-side preview of the same rule, not a replacement for server validation.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/;
const HOSTED_CHAT_BASE_URL = "https://ai.company.local/chat";

type Phase = "idle" | "creating-service" | "creating-deployment" | "publishing" | "done";

interface GeneralError {
  message: string;
  traceId?: string;
  kind: "error" | "permission";
}

interface PublishResult {
  slug: string;
  deploymentUrl: string;
}

/** `agent_ref`/`knowledge_bindings[].role_id`/`prompt_bindings` inputs, resolved
 * from the "응답 Agent 변경 (고급)" section's choice. `null` only when a Registry
 * Agent is selected but its paired Prompt has not been chosen yet — the publish
 * Gate below (see `canPublish`) blocks on that, with a visible reason, rather
 * than silently publishing a half-bound Agent (portal-api's
 * `_resolve_registry_asset_version` treats a half pair as "no Registry match"
 * and falls back to the standard Agent without telling anyone). */
interface ResolvedAgent {
  manifestId: string;
  manifestVersion: string;
  entryRole: string;
  promptManifestId: string;
  promptManifestVersion: string;
  isRegistry: boolean;
  displayName: string;
}

// Byte-for-byte the same ids buildServiceDefinition() has always hardcoded —
// this is not a new decision, just named so the standard/registry paths share
// one resolution function.
const STANDARD_AGENT_MANIFEST_ID = "550e8400-e29b-41d4-a716-446655440010";
const STANDARD_AGENT_MANIFEST_VERSION = "1.0.0";
const STANDARD_PROMPT_MANIFEST_ID = "550e8400-e29b-41d4-a716-446655440020";
const STANDARD_PROMPT_MANIFEST_VERSION = "1.0.0";
const STANDARD_ENTRY_ROLE = "answerer";

function resolveAgent(agentChoice: AgentChoice, registryPrompt: RegistryPromptSelection | null): ResolvedAgent | null {
  if (agentChoice.source === "standard") {
    return {
      manifestId: STANDARD_AGENT_MANIFEST_ID,
      manifestVersion: STANDARD_AGENT_MANIFEST_VERSION,
      entryRole: STANDARD_ENTRY_ROLE,
      promptManifestId: STANDARD_PROMPT_MANIFEST_ID,
      promptManifestVersion: STANDARD_PROMPT_MANIFEST_VERSION,
      isRegistry: false,
      displayName: STANDARD_AGENT_LABEL,
    };
  }
  if (!registryPrompt) return null;
  return {
    manifestId: agentChoice.manifest.id,
    manifestVersion: agentChoice.manifest.version,
    entryRole: agentChoice.manifest.entryRole,
    promptManifestId: registryPrompt.manifest.id,
    promptManifestVersion: registryPrompt.manifest.version,
    isRegistry: true,
    displayName: `${agentChoice.assetName} (v${agentChoice.versionLabel})`,
  };
}

/** Result of the post-publish `GET /api/v1/deployments/by-slug/{slug}` check
 * (root CLAUDE.md: never swallow a silent fallback). Only run when the
 * publisher chose a Registry Agent — the standard Agent path never resolves
 * to a Registry match by design (portal-api's `_resolve_registry_asset_version`
 * doc comment), so checking would only ever report the expected null. */
type ConnectionCheck =
  | { status: "checking" }
  | { status: "connected"; agentName: string }
  | { status: "fallback" }
  | { status: "unknown" };

interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  code?: string | null;
}

const PHASE_LABEL: Record<Exclude<Phase, "idle" | "done">, string> = {
  "creating-service": "서비스 정의 생성 중...",
  "creating-deployment": "배포 등록 중...",
  publishing: "게시 처리 중...",
};

/** lowercase, spaces -> hyphens, strip anything outside [a-z0-9-]; falls back to a random
 * slug when the name strips to (near) nothing, e.g. a Korean-only chatbot name. */
function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length >= 4) return base.slice(0, 64);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `chatbot-${suffix}`;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildServiceDefinition(selected: SelectedKnowledge, settings: ChatbotSettings, agent: ResolvedAgent) {
  const suggestedQuestions = settings.suggestedQuestions.map((q) => q.trim()).filter(Boolean).slice(0, 5);
  return {
    schema_version: "1.0",
    id: crypto.randomUUID(),
    type: "service",
    name: settings.name,
    version: "1.0.0",
    owner: { org: "miracom", team: "hr", creator_id: "dev-user@miracom.com" },
    classification: "INTERNAL",
    description: `${settings.name} — Knowledge 챗봇`,
    tags: ["chatbot", "knowledge"],
    manifest_hash: "0".repeat(64),
    changelog: "Quick Create via Service Composer Wizard",
    created_at: new Date().toISOString(),
    agent_ref: { id: agent.manifestId, version: agent.manifestVersion },
    // CRITICAL: knowledge_id must be the AssetVersion id (versionId), not the Asset id.
    knowledge_bindings: [
      {
        role_id: agent.entryRole,
        knowledge_id: selected.versionId,
        knowledge_version: selected.versionLabel,
        retrieval_profile_ref: { name: "default-korean", version: "1.0.0" },
        context_token_limit: 4096,
      },
    ],
    mcp_bindings: [],
    prompt_bindings: [
      { role_id: agent.entryRole, prompt_id: agent.promptManifestId, prompt_version: agent.promptManifestVersion },
    ],
    model_policy: { model_alias: "default-chat", fallback_allowed: false, max_context_tokens: 8192 },
    target_users: { orgs: ["miracom"], roles: ["USER", "CREATOR"] },
    limits: { timeout_seconds: 60, max_mcp_calls: 0, max_context_tokens: 8192, audit_level: "standard" },
    chatbot_config: {
      welcome_message: settings.welcomeMessage.trim() || "안녕하세요! 등록된 지식을 바탕으로 답변해 드립니다.",
      suggested_questions: suggestedQuestions,
      citation_display: settings.showCitations,
    },
  };
}

export function StepPublish({
  selected,
  settings,
  onBack,
}: {
  selected: SelectedKnowledge;
  settings: ChatbotSettings;
  onBack: () => void;
}) {
  const { role } = useRole();
  const [slug, setSlug] = useState(() => slugifyName(settings.name));
  const [serverSlugError, setServerSlugError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [generalError, setGeneralError] = useState<GeneralError | null>(null);
  const [validationChecks, setValidationChecks] = useState<ValidationCheck[] | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [agentChoice, setAgentChoice] = useState<AgentChoice>({ source: "standard" });
  const [registryPrompt, setRegistryPrompt] = useState<RegistryPromptSelection | null>(null);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck | null>(null);

  const resolvedAgent = useMemo(() => resolveAgent(agentChoice, registryPrompt), [agentChoice, registryPrompt]);
  const missingPromptReason =
    agentChoice.source === "registry" && !registryPrompt
      ? "선택한 Agent와 짝지어 응답할 Prompt를 아직 선택하지 않았습니다. 위 '응답 Agent 변경 (고급)'에서 Prompt를 선택해야 게시할 수 있습니다."
      : undefined;

  const canPublish = PUBLISH_ALLOWED_ROLES.has(role.code);
  const trimmedSlug = slug.trim();
  const localSlugError =
    trimmedSlug.length === 0
      ? undefined
      : SLUG_PATTERN.test(trimmedSlug)
      ? undefined
      : "Slug는 소문자 영문, 숫자, 하이픈만 사용해 4자 이상 64자 이하로 입력해야 합니다.";
  const slugFieldError = serverSlugError ?? localSlugError;
  const busy = phase !== "idle" && phase !== "done";

  function handleAgentChoiceChange(next: AgentChoice) {
    setAgentChoice(next);
    // A new Agent invalidates any previously chosen Prompt pairing —
    // publishing with a stale Prompt would silently mismatch the Agent.
    setRegistryPrompt(null);
  }

  function handleSlugChange(value: string) {
    setSlug(value);
    setServerSlugError(undefined);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.deploymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; clipboard access can be denied in some contexts
    }
  }

  async function handlePublish() {
    if (trimmedSlug.length === 0 || localSlugError || !canPublish || !resolvedAgent) return;
    const agent = resolvedAgent;

    setGeneralError(null);
    setValidationChecks(null);
    setServerSlugError(undefined);
    setConnectionCheck(null);
    setPhase("creating-service");

    try {
      const serviceRes = await fetch(`${API_BASE}/api/v1/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          name: settings.name,
          service_definition: buildServiceDefinition(selected, settings, agent),
        }),
      });
      if (!serviceRes.ok) {
        const body = await safeJson(serviceRes);
        setGeneralError({
          message: body?.error?.message ?? `서비스 정의 생성에 실패했습니다. (HTTP ${serviceRes.status})`,
          traceId: body?.error?.trace_id,
          kind: "error",
        });
        setPhase("idle");
        return;
      }
      const serviceData = await serviceRes.json();

      setPhase("creating-deployment");
      const deployRes = await fetch(`${API_BASE}/api/v1/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          service_version_id: serviceData.id,
          slug: trimmedSlug,
          environment: "internal",
          access_policy: "INTERNAL_AUTHENTICATED",
        }),
      });
      if (!deployRes.ok) {
        const body = await safeJson(deployRes);
        if (deployRes.status === 409) {
          setServerSlugError(body?.error?.message ?? "이미 사용 중인 Slug입니다.");
        } else {
          setGeneralError({
            message: body?.error?.message ?? `배포 등록에 실패했습니다. (HTTP ${deployRes.status})`,
            traceId: body?.error?.trace_id,
            kind: "error",
          });
        }
        setPhase("idle");
        return;
      }
      const deployData = await deployRes.json();

      setPhase("publishing");
      const publishRes = await fetch(`${API_BASE}/api/v1/deployments/${deployData.id}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (publishRes.status !== 202) {
        const body = await safeJson(publishRes);
        if (publishRes.status === 400 && body?.error?.code === "DEPLOYMENT_VALIDATION_FAILED") {
          const checks: ValidationCheck[] = body.error.details?.checks ?? [];
          setValidationChecks(checks.filter((c) => !c.passed));
          setGeneralError({
            message: body.error.message ?? "게시 Gate 검증에 실패했습니다.",
            traceId: body.error.trace_id,
            kind: "error",
          });
        } else {
          setGeneralError({
            message:
              body?.error?.message ??
              (publishRes.status === 403
                ? "게시 권한이 없습니다."
                : `게시에 실패했습니다. (HTTP ${publishRes.status})`),
            traceId: body?.error?.trace_id,
            kind: publishRes.status === 403 ? "permission" : "error",
          });
        }
        setPhase("idle");
        return;
      }
      const publishData = await publishRes.json();
      setResult({ slug: trimmedSlug, deploymentUrl: publishData.deployment_url });
      setPhase("done");

      // Registry Agent만 확인한다 — 표준 Agent 경로는 by-slug가 항상
      // registry_agent_version_id: null을 돌려주는 것이 정상이라 확인할
      // 필요가 없다(불필요한 호출 금지).
      if (agent.isRegistry) {
        setConnectionCheck({ status: "checking" });
        try {
          const checkRes = await fetch(`${API_BASE}/api/v1/deployments/by-slug/${trimmedSlug}`);
          if (!checkRes.ok) {
            setConnectionCheck({ status: "unknown" });
          } else {
            const checkData = await checkRes.json();
            setConnectionCheck(
              checkData.registry_agent_version_id
                ? { status: "connected", agentName: agent.displayName }
                : { status: "fallback" }
            );
          }
        } catch {
          setConnectionCheck({ status: "unknown" });
        }
      }
    } catch {
      setGeneralError({
        message: "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.",
        kind: "error",
      });
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">게시</h2>
        <p className="text-body text-text-secondary">
          검증된 구성을 사내 사용자가 접속할 수 있는 고유 URL로 게시합니다. URL은 플랫폼이 검증된 Slug로
          자동 발급하며, 외부 인터넷에는 공개되지 않습니다.
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface p-4 text-body shadow-card">
        <h3 className="mb-2 text-card-title font-semibold text-text-primary">게시 요약</h3>
        <dl className="space-y-1.5 text-text-secondary">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-text-muted">챗봇 이름</dt>
            <dd>{settings.name || "이름 없는 챗봇"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-text-muted">연결 지식</dt>
            <dd>
              {selected.assetName} (v{selected.versionLabel})
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-text-muted">Citation 표시</dt>
            <dd>{settings.showCitations ? "표시함" : "표시 안 함"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-text-muted">응답 Agent</dt>
            <dd>
              {agentChoice.source === "standard"
                ? STANDARD_AGENT_LABEL
                : `${agentChoice.assetName} (v${agentChoice.versionLabel})`}
              {agentChoice.source === "registry" && !registryPrompt && (
                <span className="ml-1.5 text-caption text-warning">(Prompt 미선택 — 게시 불가)</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {!result && (
        <AdvancedAgentSection
          agentChoice={agentChoice}
          onAgentChoiceChange={handleAgentChoiceChange}
          registryPrompt={registryPrompt}
          onRegistryPromptChange={setRegistryPrompt}
          disabled={busy}
        />
      )}

      {!result && (
        <>
          <FormField label="Deployment Slug" required error={slugFieldError}>
            <input
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="예: hr-policy-guide"
              className={inputClass}
              disabled={busy}
            />
            <p className="mt-1.5 rounded-lg bg-slate-50 px-3 py-2 text-caption text-text-secondary">
              발급 URL: {HOSTED_CHAT_BASE_URL}/{trimmedSlug || "…"}
            </p>
          </FormField>

          {!canPublish && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
              <Lock size={15} className="mt-0.5 shrink-0" />
              <span>
                게시하려면 배포 관리자(RELEASE_MANAGER) 또는 관리자 역할이 필요합니다. 현재 역할:{" "}
                {role.label}. 상단의 개발용 역할 전환에서 역할을 변경하세요.
              </span>
            </div>
          )}

          {generalError &&
            (generalError.kind === "permission" ? (
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
                {generalError.message}
                {generalError.traceId && (
                  <p className="mt-1 text-caption text-warning">Trace ID: {generalError.traceId}</p>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <ErrorBanner message={generalError.message} />
                {generalError.traceId && (
                  <p className="text-caption text-text-muted">Trace ID: {generalError.traceId}</p>
                )}
              </div>
            ))}

          {validationChecks && validationChecks.length > 0 && (
            <div className="space-y-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
              <p className="flex items-center gap-1.5 text-body font-semibold text-danger">
                <AlertTriangle size={14} />
                게시 Gate 검증 실패 항목
              </p>
              <ul className="space-y-1 text-body text-danger">
                {validationChecks.map((check) => (
                  <li key={check.name} className="list-disc pl-4">
                    {check.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {missingPromptReason && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{missingPromptReason}</span>
            </div>
          )}

          <Button
            onClick={handlePublish}
            disabled={busy || trimmedSlug.length === 0 || !!localSlugError || !canPublish || !resolvedAgent}
          >
            {busy ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                {PHASE_LABEL[phase as Exclude<Phase, "idle" | "done">]}
              </>
            ) : (
              "게시하기"
            )}
          </Button>
        </>
      )}

      {result && (
        <div className="space-y-3 rounded-card border border-success/30 bg-success/5 p-4">
          <div className="flex items-center gap-2 text-body font-semibold text-success">
            <Check size={16} />
            게시가 완료되었습니다.
          </div>

          <div>
            <p className="mb-1 text-caption font-medium text-success">사내 인증 사용자용 URL (사내망 전용)</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-success/30 bg-surface px-3 py-2 text-body text-text-primary">
                {result.deploymentUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "복사됨" : "복사"}
              </Button>
            </div>
            <p className="mt-1 text-caption text-success">
              인터넷에 공개되지 않으며, 사내 인증을 거친 사용자만 접속할 수 있습니다.
            </p>
          </div>

          <div className="border-t border-success/30 pt-3">
            <Button variant="secondary" size="sm" href={`/chat/${result.slug}`} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />이 환경에서 열기 (데모용)
            </Button>
            <p className="mt-1 text-caption text-success">
              {HOSTED_CHAT_BASE_URL}는 이 개발 환경에서 접속되지 않으므로, 데모 확인용으로 같은 서버의 로컬
              경로를 새 탭으로 엽니다.
            </p>
          </div>

          {connectionCheck && (
            <div className="border-t border-success/30 pt-3">
              {connectionCheck.status === "checking" && (
                <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                  <Loader2 size={13} className="animate-spin" />
                  선택한 Agent가 실제로 연결됐는지 확인하는 중...
                </p>
              )}
              {connectionCheck.status === "connected" && (
                <p className="flex items-center gap-1.5 text-caption text-success">
                  <Check size={13} />이 챗봇은 <strong>{connectionCheck.agentName}</strong>이(가) 응답합니다.
                </p>
              )}
              {connectionCheck.status === "fallback" && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    게시는 완료되었지만 선택한 Agent가 실제로 연결되지 않아 <strong>표준 Agent</strong>가
                    응답합니다. 선택한 Agent 또는 Prompt 버전이 승인(APPROVED) 상태가 아니거나 Manifest id가
                    일치하지 않을 수 있습니다. 등록된 Agent/Prompt의 승인 상태를 확인한 뒤 다시 게시해 주세요.
                  </span>
                </div>
              )}
              {connectionCheck.status === "unknown" && (
                <p className="flex items-center gap-1.5 text-caption text-text-muted">
                  <AlertTriangle size={13} />
                  Agent 연결 여부를 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 배포 상세에서 다시 확인해
                  주세요.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border pt-5">
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          이전
        </Button>
      </div>
    </div>
  );
}
