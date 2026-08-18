"use client";

/**
 * P19 Service 상세·검증 (docs/implementation-spec/01-portal-and-distribution.md §P19).
 *
 * Route note: the spec table names this route `/services/:serviceId`, but
 * every server-side operation this screen needs — `service_definition`,
 * `/validate`, and the Deployment's `service_version_id` pointer — is keyed
 * by ServiceVersion, not Service (a Service has no definition of its own,
 * only its versions do). `GET /api/v1/services/{service_id}` exists too (for
 * the 버전과 변경이력 tab), but making IT the primary route would force a
 * second round trip just to learn "which version to actually show". This
 * page is therefore addressed by `versionId`; P17's list links straight to
 * each Service's latest version.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Rocket,
  Send,
  ShieldOff,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  FormField,
  LoadingState,
  StatusBadge,
  Tabs,
  inputClass,
  type TabItem,
} from "../../_components/ui";
import {
  ACCESS_POLICY_LABEL,
  ENVIRONMENT_LABEL,
  formatDateTime,
} from "../../_components/deployment-meta";
import { useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// Hand-copied from app/services/new/_components/constants.ts (AGENT_OPTIONS'
// manifestId/name and each option's nested `prompt`). D-034: Agent/Prompt are
// not Portal Registry assets, so there is no `GET /api/v1/assets?type=agent`
// (or `type=prompt`) to resolve agent_ref.id / prompt_bindings[].prompt_id
// into names live — verified live, both return `{items: [], total: 0}`. Not
// imported directly from the Composer's route-private `_components/` folder
// (Next.js's `_`-prefixed convention scopes it to that route) — same
// documented drift-risk tradeoff as `services/agent-runtime/mcp_tools.py`'s
// hand copy of MCP Tool schemas (open-decisions.md D-052).
const AGENT_NAMES: Record<string, string> = {
  "550e8400-e29b-41d4-a716-446655440010": "Standard Knowledge Chat Agent",
  "550e8400-e29b-41d4-a716-446655440011": "Standard Knowledge+DB Chat Agent",
};
const PROMPT_NAMES: Record<string, string> = {
  "550e8400-e29b-41d4-a716-446655440020": "Standard Knowledge Answer Prompt",
  "550e8400-e29b-41d4-a716-446655440021": "Standard Knowledge+DB Answer Prompt",
};

const AUDIT_LEVEL_LABEL: Record<string, string> = {
  minimal: "최소",
  standard: "표준",
  full: "전체",
};

interface ServiceVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

interface ServiceIdentity {
  id: string;
  name: string;
  owner_org: string;
  owner_creator_id: string;
  created_at: string;
}

interface KnowledgeBinding {
  role_id: string;
  knowledge_id: string;
  knowledge_version: string;
  retrieval_profile_ref?: { name: string; version: string };
  context_token_limit?: number;
}

interface McpBinding {
  role_id: string;
  tool_id: string;
  tool_version: string;
  confirmation_policy?: string;
}

interface PromptBinding {
  role_id: string;
  prompt_id: string;
  prompt_version: string;
}

interface ServiceDefinition {
  name: string;
  description?: string;
  classification: string;
  tags?: string[];
  owner: { org: string; team?: string; creator_id: string };
  agent_ref: { id: string; version: string };
  knowledge_bindings?: KnowledgeBinding[];
  mcp_bindings?: McpBinding[];
  prompt_bindings?: PromptBinding[];
  model_policy: { model_alias: string; fallback_allowed?: boolean; max_context_tokens?: number };
  target_users?: { orgs?: string[]; sites?: string[]; roles?: string[] };
  limits?: {
    timeout_seconds?: number;
    max_mcp_calls?: number;
    max_context_tokens?: number;
    max_input_bytes?: number;
    audit_level?: string;
  };
  chatbot_config?: { welcome_message?: string; suggested_questions?: string[]; citation_display?: boolean };
}

interface ServiceVersionDetail {
  id: string;
  service_id: string;
  version: string;
  status: string;
  service_definition: ServiceDefinition;
  created_at: string;
  service: ServiceIdentity | null;
}

interface ServiceDetail extends ServiceIdentity {
  versions: ServiceVersionSummary[];
}

interface KnowledgeAssetVersion {
  id: string;
  version: string;
  status: string;
}

interface KnowledgeAsset {
  id: string;
  name: string;
  classification: string;
  versions: KnowledgeAssetVersion[];
}

interface DeploymentItem {
  id: string;
  service_id: string;
  service_version_id: string;
  slug: string;
  environment: string;
  access_policy: string;
  status: string;
  deployment_url: string;
  created_by: string;
  created_at: string;
}

interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  code?: string | null;
}

interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

type LoadState = "loading" | "ok" | "not_found" | "error";

// D-041 후속(ServiceVersion 자체 검토 체인): mirrors app/assets/[id]/page.tsx's
// SUBMITTABLE_STATUSES — only these two states can transition to IN_REVIEW
// (packages/security-policy ALLOWED_TRANSITIONS, shared by Asset/ServiceVersion).
const SUBMITTABLE_STATUSES = new Set(["DRAFT", "CHANGES_REQUESTED"]);

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-body">
      <span className="w-48 shrink-0 text-text-secondary">{label}</span>
      <span className="min-w-0 flex-1 break-all text-text-primary">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-card-title font-semibold text-text-primary">{title}</h2>
      {children}
    </Card>
  );
}

const TABS: TabItem[] = [
  { id: "overview", label: "서비스 개요" },
  { id: "assets", label: "구성 자산" },
  { id: "io", label: "입력/출력", disabledReason: "Service Definition Schema에 입력/출력 필드가 없어 지원되지 않습니다." },
  { id: "model", label: "모델·환경 정책" },
  { id: "permissions", label: "권한과 Tool" },
  { id: "validation", label: "검증 결과" },
  { id: "history", label: "버전과 변경이력" },
  { id: "deployment", label: "배포·Hosted Deployment" },
  { id: "manifest", label: "Manifest 보기" },
];

export default function ServiceVersionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const versionId = params.versionId as string;
  const { role } = useRole();

  const [state, setState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState<ServiceVersionDetail | null>(null);
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [knowledgeAssets, setKnowledgeAssets] = useState<KnowledgeAsset[]>([]);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // 검증 결과 tab state
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // D-041 후속: 검토 요청 (submit for review) state
  const [submittingReview, setSubmittingReview] = useState(false);
  const [submitReviewError, setSubmitReviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setLoadError(null);
      setValidation(null);
      setValidationError(null);
      try {
        const versionRes = await fetch(`${API_BASE}/api/v1/service-versions/${versionId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (versionRes.status === 404) {
          if (!cancelled) setState("not_found");
          return;
        }
        if (!versionRes.ok) {
          const body = await safeJson(versionRes);
          throw new Error(body?.error?.message ?? `HTTP ${versionRes.status}`);
        }
        const versionData: ServiceVersionDetail = await versionRes.json();
        if (cancelled) return;
        setVersion(versionData);

        const [serviceRes, knowledgeRes, deploymentsRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/services/${versionData.service_id}`, {
            headers: { Authorization: `Bearer ${role.token}` },
          }),
          fetch(`${API_BASE}/api/v1/assets?type=knowledge&page_size=100`, {
            headers: { Authorization: `Bearer ${role.token}` },
          }),
          fetch(`${API_BASE}/api/v1/deployments?page_size=100`, {
            headers: { Authorization: `Bearer ${role.token}` },
          }),
        ]);

        if (!cancelled && serviceRes.ok) setService(await serviceRes.json());
        if (!cancelled && knowledgeRes.ok) {
          const data = await knowledgeRes.json();
          setKnowledgeAssets(data.items ?? []);
        }
        if (!cancelled && deploymentsRes.ok) {
          const data = await deploymentsRes.json();
          setDeployments(data.items ?? []);
        }

        if (!cancelled) setState("ok");
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [versionId, role.token]);

  async function runValidation() {
    setValidating(true);
    setValidationError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/service-versions/${versionId}/validate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setValidationError(body?.error?.message ?? `검증 요청에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setValidation(body as ValidationResult);
    } catch {
      setValidationError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmitReview() {
    setSubmittingReview(true);
    setSubmitReviewError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/service-versions/${versionId}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSubmitReviewError(body?.error?.message ?? `검토 요청에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      // Re-fetch just the version so the status badge / actions reflect
      // IN_REVIEW immediately, without re-running the whole page load.
      const versionRes = await fetch(`${API_BASE}/api/v1/service-versions/${versionId}`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (versionRes.ok) setVersion(await versionRes.json());
    } catch {
      setSubmitReviewError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function handleCopy(url: string, slug: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 1500);
    } catch {
      // best-effort only
    }
  }

  if (state === "loading") return <LoadingState label="Service 상세를 불러오는 중..." />;

  if (state === "not_found") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="font-medium text-text-primary">Service Version을 찾을 수 없습니다.</p>
        <Button variant="secondary" onClick={() => router.push("/services")}>
          목록으로
        </Button>
      </div>
    );
  }

  if (state === "error" || !version) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={loadError ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push("/services")}>
          목록으로
        </Button>
      </div>
    );
  }

  const def = version.service_definition;
  const serviceDeployments = deployments.filter((d) => d.service_id === version.service_id);

  function resolveKnowledge(knowledgeId: string) {
    for (const asset of knowledgeAssets) {
      const ver = asset.versions.find((v) => v.id === knowledgeId);
      if (ver) return { assetName: asset.name, version: ver.version, status: ver.status };
    }
    return null;
  }

  return (
    <div className="max-w-4xl space-y-5">
      <button
        onClick={() => router.push("/services")}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
      >
        <ChevronLeft size={14} />
        AI Service 목록으로
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title font-bold text-text-primary">{def.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="brand">v{version.version}</Badge>
            <StatusBadge status={version.status} />
            <Badge>{def.classification}</Badge>
          </div>
        </div>
      </div>

      {(() => {
        // D-041 후속(ServiceVersion 자체 검토 체인): 검토 요청 action. Always
        // rendered (never hidden) so an ineligible role/state sees *why*, per
        // CLAUDE.md "호환되지 않는 선택지는 이유와 함께 비활성화한다."
        const isSubmittableStatus = SUBMITTABLE_STATUSES.has(version.status);
        const isOwner = role.userId === (version.service?.owner_creator_id ?? def.owner.creator_id);
        const canSubmit = role.code === "ADMIN" || (role.code === "CREATOR" && isOwner);

        let disabledReason: string | null = null;
        if (!isSubmittableStatus) {
          disabledReason = `현재 상태(${version.status})의 버전은 검토를 요청할 수 없습니다.`;
        } else if (!canSubmit) {
          disabledReason =
            role.code === "CREATOR"
              ? "본인이 소유한 서비스만 검토 요청할 수 있습니다."
              : "서비스 제작자(소유자) 또는 관리자만 검토를 요청할 수 있습니다.";
        }

        return (
          <Card className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-body text-text-secondary">
                검토 상태: <StatusBadge status={version.status} />
                {version.status === "DRAFT" && (
                  <span className="ml-2 text-caption text-text-muted">
                    아직 기술·보안·배포 검토를 거치지 않았습니다.
                  </span>
                )}
              </div>
              <Button
                size="sm"
                disabled={submittingReview || !isSubmittableStatus || !canSubmit}
                onClick={handleSubmitReview}
              >
                <Send size={14} />
                {submittingReview ? "요청 중..." : "검토 요청"}
              </Button>
            </div>
            {disabledReason && (
              <p className="flex items-center gap-1 text-caption text-text-secondary">
                <Lock size={12} />
                검토 요청 불가: {disabledReason}
              </p>
            )}
            {submitReviewError && <ErrorBanner message={submitReviewError} />}
          </Card>
        );
      })()}

      <Tabs tabs={TABS} activeId={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" && (
        <Section title="서비스 개요">
          <div className="space-y-2">
            <Row label="이름" value={def.name} />
            <Row label="설명" value={def.description || "-"} />
            <Row label="분류(보안등급)" value={<Badge>{def.classification}</Badge>} />
            <Row
              label="태그"
              value={
                def.tags && def.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {def.tags.map((t) => (
                      <Badge key={t} tone="neutral">
                        {t}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  "-"
                )
              }
            />
            <Row label="소유 조직" value={version.service?.owner_org ?? def.owner.org} />
            <Row label="제작자" value={version.service?.owner_creator_id ?? def.owner.creator_id} />
            <Row label="버전" value={`v${version.version}`} />
            <Row label="버전 상태" value={<StatusBadge status={version.status} />} />
            <Row label="생성일" value={formatDateTime(version.created_at)} />
            <Row label="Service ID" value={<span className="font-mono text-caption">{version.service_id}</span>} />
            <Row label="Service Version ID" value={<span className="font-mono text-caption">{version.id}</span>} />
          </div>
        </Section>
      )}

      {activeTab === "assets" && (
        <div className="space-y-4">
          <Section title="Agent">
            <Row
              label="Agent"
              value={
                <>
                  {AGENT_NAMES[def.agent_ref.id] ?? "알 수 없는 Agent"}{" "}
                  <span className="text-text-muted">
                    (고정 버전 v{def.agent_ref.version}, id: <span className="font-mono">{def.agent_ref.id}</span>)
                  </span>
                </>
              }
            />
          </Section>

          <Section title={`Knowledge 연결 (${def.knowledge_bindings?.length ?? 0})`}>
            {!def.knowledge_bindings || def.knowledge_bindings.length === 0 ? (
              <p className="text-body text-text-muted">연결된 Knowledge가 없습니다.</p>
            ) : (
              <div className="space-y-3">
                {def.knowledge_bindings.map((b, idx) => {
                  const resolved = resolveKnowledge(b.knowledge_id);
                  const versionMismatch = resolved && resolved.version !== b.knowledge_version;
                  return (
                    <div
                      key={`${b.knowledge_id}-${idx}`}
                      className="rounded-lg border border-border bg-slate-50 p-3.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text-primary">
                          {resolved ? resolved.assetName : "해석할 수 없음"}
                        </span>
                        <Badge tone="neutral">Role: {b.role_id}</Badge>
                        {resolved && <StatusBadge status={resolved.status} />}
                      </div>
                      <div className="mt-1.5 space-y-0.5 text-caption text-text-secondary">
                        <div>
                          고정 참조 버전(Service Definition): <span className="font-medium">v{b.knowledge_version}</span>
                        </div>
                        <div>
                          현재 해석된 버전:{" "}
                          {resolved ? (
                            <span className="font-medium">v{resolved.version}</span>
                          ) : (
                            <span className="text-danger">Knowledge 자산 목록에서 찾을 수 없음</span>
                          )}
                          {versionMismatch && (
                            <span className="ml-1.5 text-warning">
                              (고정 버전과 다릅니다 — 자산 버전이 변경되었을 수 있습니다)
                            </span>
                          )}
                        </div>
                        {b.retrieval_profile_ref && (
                          <div>
                            Retrieval Profile: {b.retrieval_profile_ref.name} v{b.retrieval_profile_ref.version}
                          </div>
                        )}
                        {b.context_token_limit !== undefined && (
                          <div>최대 Context Token: {b.context_token_limit.toLocaleString()}</div>
                        )}
                        <div>
                          knowledge_id (AssetVersion): <span className="font-mono">{b.knowledge_id}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title={`Prompt 연결 (${def.prompt_bindings?.length ?? 0})`}>
            {!def.prompt_bindings || def.prompt_bindings.length === 0 ? (
              <p className="text-body text-text-muted">연결된 Prompt가 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {def.prompt_bindings.map((p, idx) => (
                  <Row
                    key={`${p.prompt_id}-${idx}`}
                    label={`Role: ${p.role_id}`}
                    value={
                      <>
                        {PROMPT_NAMES[p.prompt_id] ?? "알 수 없는 Prompt"}{" "}
                        <span className="text-text-muted">
                          (고정 버전 v{p.prompt_version}, id: <span className="font-mono">{p.prompt_id}</span>)
                        </span>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {activeTab === "io" && (
        <Section title="입력/출력">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-slate-50 px-4 py-3 text-body text-text-secondary">
            <Lock size={16} className="mt-0.5 shrink-0 text-text-muted" />
            <span>
              <code>packages/schemas/manifests/service-definition.schema.json</code>에는 입력 Form 필드나 출력
              형식 필드가 없습니다. AI Service Composer(<code>app/services/new/</code>)도 동일한 이유로 이 단계를
              비활성화된 상태로만 표시합니다 — 실제로 저장된 값이 없는데 있는 것처럼 보여주지 않기 위함입니다.
            </span>
          </div>
        </Section>
      )}

      {activeTab === "model" && (
        <div className="space-y-4">
          <Section title="모델 정책">
            <div className="space-y-2">
              <Row label="Model Alias" value={<code className="rounded bg-slate-100 px-1.5 py-0.5 text-caption">{def.model_policy.model_alias}</code>} />
              <Row label="Fallback 허용" value={def.model_policy.fallback_allowed ? "예" : "아니오"} />
              <Row
                label="최대 Context Token"
                value={def.model_policy.max_context_tokens ? def.model_policy.max_context_tokens.toLocaleString() : "-"}
              />
            </div>
          </Section>

          <Section title="실행 제한 (환경 정책)">
            {!def.limits ? (
              <p className="text-body text-text-muted">지정된 제한이 없습니다.</p>
            ) : (
              <div className="space-y-2">
                <Row label="전체 실행 Timeout" value={def.limits.timeout_seconds ? `${def.limits.timeout_seconds}초` : "-"} />
                <Row label="최대 MCP Tool 호출 수" value={def.limits.max_mcp_calls ?? "-"} />
                <Row
                  label="최대 Context Token"
                  value={def.limits.max_context_tokens ? def.limits.max_context_tokens.toLocaleString() : "-"}
                />
                <Row
                  label="최대 입력 크기"
                  value={def.limits.max_input_bytes ? `${(def.limits.max_input_bytes / 1024).toLocaleString()} KB` : "-"}
                />
                <Row
                  label="Audit Level"
                  value={def.limits.audit_level ? AUDIT_LEVEL_LABEL[def.limits.audit_level] ?? def.limits.audit_level : "-"}
                />
              </div>
            )}
          </Section>
        </div>
      )}

      {activeTab === "permissions" && (
        <div className="space-y-4">
          <Section title="대상 사용자 범위">
            {!def.target_users ||
            (!def.target_users.orgs?.length && !def.target_users.sites?.length && !def.target_users.roles?.length) ? (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  <code>target_users</code>가 지정되지 않았습니다. 이것이 "모든 사용자 허용"을 의미하는지는 별도
                  검토가 필요합니다 (제한 없음으로 자동 해석하지 않습니다).
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <Row label="대상 조직" value={def.target_users.orgs?.join(", ") || "-"} />
                <Row label="대상 사업장" value={def.target_users.sites?.join(", ") || "-"} />
                <Row label="대상 역할" value={def.target_users.roles?.join(", ") || "-"} />
              </div>
            )}
          </Section>

          <Section title={`MCP Tool 연결 (${def.mcp_bindings?.length ?? 0})`}>
            {!def.mcp_bindings || def.mcp_bindings.length === 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-slate-50 px-4 py-3 text-body text-text-secondary">
                <ShieldOff size={16} className="mt-0.5 shrink-0 text-text-muted" />
                <span>
                  <code>mcp_bindings</code>가 항상 빈 배열입니다. MCP Tool(office-mcp-server의{" "}
                  <code>db_metadata.get_tables</code> 등)은 아직 Portal 자산 Registry에 등록되지 않은 자산이라
                  (open-decisions.md D-034) Service Composer가 연결 UI 자체를 제공하지 않기 때문입니다 — 빈 값이
                  버그가 아니라 현재 구조의 알려진 한계입니다.
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {def.mcp_bindings.map((m, idx) => (
                  <Row
                    key={`${m.tool_id}-${idx}`}
                    label={`Role: ${m.role_id}`}
                    value={`${m.tool_id} v${m.tool_version} (확인 정책: ${m.confirmation_policy ?? "always"})`}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {activeTab === "validation" && (
        <Section title="검증 결과">
          <p className="mb-3 text-body text-text-secondary">
            <code>POST /api/v1/service-versions/{"{id}"}/validate</code>를 실제로 호출해 Schema·Knowledge 참조·
            인덱싱·승인 상태·모델 정책을 서버에서 다시 확인합니다 (Mock이 아닙니다).
          </p>

          <Button onClick={runValidation} disabled={validating}>
            {validating ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                검증 실행 중...
              </>
            ) : (
              "검증 실행"
            )}
          </Button>

          {validationError && (
            <div className="mt-3">
              <ErrorBanner message={validationError} />
            </div>
          )}

          {validation && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3">
                <span
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-body font-semibold ${
                    validation.passed ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
                  }`}
                >
                  {validation.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  {validation.passed ? "검증 통과" : "검증 실패"}
                </span>
                <span className="text-caption text-text-muted">
                  통과 {validation.checks.filter((c) => c.passed).length} · 실패{" "}
                  {validation.checks.filter((c) => !c.passed).length}
                </span>
              </div>
              <div className="space-y-2">
                {validation.checks.map((check) => (
                  <div
                    key={check.name}
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-body ${
                      check.passed ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"
                    }`}
                  >
                    {check.passed ? (
                      <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
                    ) : (
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
                    )}
                    <div>
                      <div className="font-medium text-text-primary">{check.name}</div>
                      <div className={check.passed ? "text-text-secondary" : "text-danger"}>{check.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {activeTab === "history" && (
        <Section title="버전과 변경이력">
          {!service || service.versions.length === 0 ? (
            <p className="text-body text-text-muted">버전 정보를 불러올 수 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {service.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => v.id !== version.id && router.push(`/services/${v.id}`)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3.5 py-2.5 text-left text-body transition ${
                    v.id === version.id
                      ? "cursor-default border-brand-500 bg-brand-50"
                      : "border-border bg-surface hover:border-brand-300"
                  }`}
                >
                  <div>
                    <span className="font-medium text-text-primary">v{v.version}</span>
                    {v.id === version.id && <span className="ml-2 text-caption text-brand-700">(현재 보는 버전)</span>}
                    <div className="mt-0.5 text-caption text-text-muted">{formatDateTime(v.created_at)}</div>
                  </div>
                  <StatusBadge status={v.status} />
                </button>
              ))}
            </div>
          )}
        </Section>
      )}

      {activeTab === "deployment" && (
        <Section title="배포와 Bundle / Hosted Deployment">
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-slate-50 px-4 py-3 text-body text-text-secondary">
            <Lock size={16} className="mt-0.5 shrink-0 text-text-muted" />
            <span>
              Offline Bundle 요청(<code>POST /api/v1/distributions</code>, <code>root_type=SERVICE_VERSION</code>)은
              백엔드가 지원하지만, <code>/distributions/new</code> 화면은 아직 Service Version을 선택하는 UI가
              없어(현재는 자산(Asset) 유형만 지원) 이 화면에서 Bundle을 바로 요청할 수 없습니다.
            </span>
          </div>

          <PublishPanel
            serviceVersionId={version.id}
            serviceName={def.name}
            token={role.token}
            onPublished={() => router.refresh()}
          />

          {serviceDeployments.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center">
              <Rocket size={32} strokeWidth={1.5} className="text-slate-300" />
              <p className="text-body font-medium text-text-primary">아직 게시된 Hosted Deployment가 없습니다.</p>
              <p className="text-caption text-text-secondary">
                위에서 이 Service Version을 바로 게시할 수 있습니다.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {serviceDeployments.map((d) => (
                <div key={d.id} className="rounded-lg border border-border bg-slate-50 p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">{d.slug}</span>
                    <StatusBadge status={d.status} />
                    <Badge tone="neutral">{ENVIRONMENT_LABEL[d.environment] ?? d.environment}</Badge>
                    <Badge tone="neutral">{ACCESS_POLICY_LABEL[d.access_policy] ?? d.access_policy}</Badge>
                    {d.service_version_id === version.id && <Badge tone="brand">현재 버전 대상</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-text-secondary">
                    <code className="rounded bg-white px-1.5 py-0.5">{d.deployment_url}</code>
                    <button
                      onClick={() => handleCopy(d.deployment_url, d.slug)}
                      className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                    >
                      <Copy size={11} />
                      {copiedSlug === d.slug ? "복사됨" : "복사"}
                    </button>
                    {d.status === "ACTIVE" && (
                      <a
                        href={`/chat/${d.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                      >
                        <ExternalLink size={11} />
                        열기
                      </a>
                    )}
                  </div>
                  <div className="mt-1 text-caption text-text-muted">
                    게시자 {d.created_by} · 게시일 {formatDateTime(d.created_at)}
                  </div>
                  <button
                    onClick={() => router.push(`/deployments/${d.id}`)}
                    className="mt-1.5 text-caption font-medium text-brand-600 hover:underline"
                  >
                    Deployment 상세 보기 →
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {activeTab === "manifest" && (
        <Section title="Manifest 보기 (Service Definition)">
          <pre className="max-h-[32rem] overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
            {JSON.stringify(def, null, 2)}
          </pre>
        </Section>
      )}
    </div>
  );
}

/** P22 게시 — 이 화면에 게시 액션이 없어서 Composer로 만든 Service Version은
 * 실제로 게시할 방법이 없었다("Knowledge 챗봇 빠른 만들기를 통해 게시하세요"만
 * 안내했는데, 그 화면은 표준 Agent를 하드코딩한 Quick Create 전용 흐름이다).
 * D-034로 Registry Agent를 고를 수 있게 된 뒤로는 그 공백이 곧 "등록한 Agent로
 * 만든 서비스는 게시할 수 없다"가 된다.
 *
 * 새 API를 만들지 않고 이미 있는 두 호출을 그대로 쓴다:
 * `POST /deployments` → `POST /deployments/{id}/publish`(Quick Create의
 * StepPublish와 동일한 순서). Slug는 사용자가 임의 주소를 입력하는 것이 아니라
 * 서비스 이름에서 파생한 뒤 서버가 패턴·예약어·유일성을 검증한다(루트 UI 규칙:
 * "플랫폼이 검증된 Slug로 발급"). */
function PublishPanel({
  serviceVersionId,
  serviceName,
  token,
  onPublished,
}: {
  serviceVersionId: string;
  serviceName: string;
  token: string;
  onPublished: () => void;
}) {
  const [slug, setSlug] = useState(() => slugifyServiceName(serviceName));
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Array<{ name: string; passed: boolean; message: string }>>([]);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    setChecks([]);
    try {
      const created = await fetch(`${API_BASE}/api/v1/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          service_version_id: serviceVersionId,
          slug: slug.trim(),
          environment: "internal",
          access_policy: "INTERNAL_AUTHENTICATED",
        }),
      });
      const createdBody = await safeJson(created);
      if (!created.ok) {
        setError(createdBody?.error?.message ?? `게시 준비에 실패했습니다. (HTTP ${created.status})`);
        return;
      }

      const deploymentId = createdBody.id;
      const published = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const publishedBody = await safeJson(published);
      if (!published.ok) {
        // 게시 Gate 실패는 실패 항목까지 보여준다 — "실패했습니다"만으로는
        // 무엇을 고쳐야 할지 알 수 없다.
        if (publishedBody?.error?.details?.checks) {
          setChecks(
            (publishedBody.error.details.checks as Array<{ name: string; passed: boolean; message: string }>)
              .filter((c) => !c.passed)
          );
        }
        setError(publishedBody?.error?.message ?? `게시에 실패했습니다. (HTTP ${published.status})`);
        return;
      }
      setPublishedUrl(publishedBody.deployment_url ?? null);
      onPublished();
    } catch {
      setError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setPublishing(false);
    }
  }

  if (publishedUrl) {
    return (
      <Card className="mb-4 border-success/30 bg-success/5 p-5">
        <p className="flex items-center gap-1.5 text-body font-semibold text-success">
          <CheckCircle2 size={15} />
          게시되었습니다.
        </p>
        <p className="mt-2 break-all text-body text-text-primary">{publishedUrl}</p>
      </Card>
    );
  }

  return (
    <Card className="mb-4 p-5">
      <h3 className="mb-1 text-body font-semibold text-text-primary">내부 URL로 게시</h3>
      <p className="mb-3 text-caption text-text-secondary">
        이 Service Version을 그대로 Hosted 챗봇으로 게시합니다. 주소는 아래 이름으로 발급되며, 서버가 형식과
        중복을 검증합니다.
      </p>
      <FormField label="게시 주소(Slug)" required>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} className={inputClass} />
      </FormField>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => void handlePublish()} disabled={publishing || !slug.trim()}>
          {publishing && <Loader2 size={14} className="animate-spin" />}
          게시
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {checks.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
          {checks.map((c) => (
            <li key={c.name} className="list-disc pl-4">
              {c.message}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Quick Create(`StepPublish.tsx`)와 동일한 규칙 — 한국어만 있는 이름처럼
 * 남는 글자가 거의 없을 때는 임의 접미사로 대체한다. */
function slugifyServiceName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length >= 4) return base.slice(0, 64);
  return `service-${Math.random().toString(36).slice(2, 8)}`;
}
