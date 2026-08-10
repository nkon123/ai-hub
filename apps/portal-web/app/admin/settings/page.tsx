"use client";

/**
 * P15 관리자 설정 (01-portal-and-distribution.md §2 P15).
 *
 * Mostly read-only "정책·구성 현황" — this PoC has no `users`/`sites`/`roles`
 * tables, so several of the spec's 8 sub-areas have nothing to edit.
 * Building forms over storage that doesn't exist would look functional
 * while silently doing nothing, so this screen instead renders the
 * *actually effective* configuration straight from `GET
 * /api/v1/admin/settings` (`portal_api.routers.admin`) — every section is
 * either AVAILABLE (sourced live from a real config/policy file, labelled
 * with exactly where) or NOT_IMPLEMENTED (a named reason + open-decisions.md
 * id, never an empty form). See open-decisions.md D-065 for the full
 * rationale.
 *
 * **UPDATE (D-065 UPDATE / D-075): one sub-area now IS editable** — the
 * indexing embedding model (`IndexingEmbeddingModelCard` below). It has
 * real storage (`portal_api.platform_settings`) and is the only card on
 * this page with a Save action. Two warnings are always visible next to it
 * (never collapsed/hidden): changing it only affects newly-indexed
 * Knowledge (existing indexes keep searching with the model recorded in
 * their own index-meta.json — re-indexing is required to move them), and
 * switching model *families* also requires revisiting search-runtime's
 * SEARCH_QUERY_INSTRUCT_PREFIX (D-046/D-075) or the relevance threshold
 * silently stops separating in-scope from out-of-scope questions. A model
 * that `GET /api/v1/admin/embedding-models` doesn't report as
 * `embedding_capable` cannot be selected (disabled option with a reason,
 * not just omitted) and is rejected server-side too if attempted directly.
 * Only ADMIN ever reaches this page (`ADMIN_SETTINGS_READ`), so no separate
 * per-card Permission gate is needed for the Save action itself.
 *
 * Secrets: the server never returns a live credential (redacted at the
 * source — see `security_policy.redact_if_secret`); this screen has no
 * "reveal" affordance for any field, matching the spec's "실제 Secret 값은
 * 화면에서 재표시하지 않는다" rule.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Lock, RefreshCw, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  LoadingState,
  PageHeader,
  inputClass,
} from "../../_components/ui";
import type { BadgeTone } from "../../_components/ui";
import { formatDateTime } from "../../_components/deployment-meta";
import { useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface NotImplementedInfo {
  reason: string;
  decision_id: string;
}

interface RolePermissionRow {
  role: string;
  permissions: string[];
}

interface UserRoleMappingSection {
  status: "AVAILABLE";
  source: string;
  roles: RolePermissionRow[];
  note: string;
}

interface OrganizationSiteSection {
  status: "NOT_IMPLEMENTED";
  not_implemented: NotImplementedInfo;
}

interface ModelAliasSetting {
  alias: string;
  provider: string;
  model_id: string;
  endpoint: string;
  max_context_tokens: number | null;
}

interface McpServerAliasSetting {
  alias: string;
  endpoint: string;
  allowed_tools: string[];
}

interface OfficeProfileSection {
  status: "AVAILABLE";
  source: string;
  name: string;
  version: string;
  org: string;
  sites: string[];
  max_classification_allowed: string | null;
  audit_retention_days: number | null;
}

interface ModelEndpointAliasSection {
  status: "AVAILABLE";
  source: string;
  model_aliases: ModelAliasSetting[];
  mcp_servers: McpServerAliasSetting[];
}

interface AssetSizeExtensionPolicySection {
  status: "AVAILABLE";
  source: string;
  portal_upload_limit_note: string;
  knowledge_package_forbidden_filenames: string[];
  knowledge_package_fail_on_fatal: boolean | null;
  desktop_bundle_max_total_uncompressed_bytes: number | null;
  desktop_bundle_max_single_file_uncompressed_bytes: number | null;
  desktop_bundle_max_compression_ratio: number | null;
  desktop_bundle_forbidden_archive_extensions: string[] | null;
  desktop_bundle_forbidden_executable_extensions: string[] | null;
  parse_error: string | null;
}

interface ApprovalWorkflowSection {
  status: "AVAILABLE";
  source: string;
  stage_chain: string[];
  require_service_version_approval: boolean;
  require_service_version_approval_source: string;
}

interface SecurityClassificationSubsection {
  status: "AVAILABLE";
  source: string;
  classification_levels: string[];
  acl_metadata_fields: string[];
  allow_unknown_classification: boolean;
  allow_unknown_classification_caveat: string;
}

interface RetentionSubsection {
  status: "NOT_IMPLEMENTED";
  not_implemented: NotImplementedInfo;
}

interface SecurityClassificationRetentionSection {
  classification: SecurityClassificationSubsection;
  retention: RetentionSubsection;
}

interface PackageTrustSignatureSection {
  status: "NOT_IMPLEMENTED";
  not_implemented: NotImplementedInfo;
}

// D-065 UPDATE / D-075 — the one editable P15 sub-area.
interface IndexingEmbeddingModelSection {
  status: "AVAILABLE";
  source: string;
  configured_model: string | null;
  updated_at: string | null;
  updated_by: string | null;
  note: string;
}

interface EmbeddingModelInfo {
  name: string;
  embedding_capable: boolean;
  size: number | null;
  modified_at: string | null;
}

interface EmbeddingModelsResponse {
  models: EmbeddingModelInfo[];
  default_embed_model: string;
  source: string;
  trace_id: string;
}

interface AdminSettingsOut {
  generated_at: string;
  trace_id: string;
  user_role_mapping: UserRoleMappingSection;
  organization_site: OrganizationSiteSection;
  office_profile: OfficeProfileSection;
  model_endpoint_alias: ModelEndpointAliasSection;
  asset_size_extension_policy: AssetSizeExtensionPolicySection;
  approval_workflow: ApprovalWorkflowSection;
  security_classification_retention: SecurityClassificationRetentionSection;
  package_trust_signature: PackageTrustSignatureSection;
  indexing_embedding_model: IndexingEmbeddingModelSection;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";

function formatBytes(n: number | null): string {
  if (n === null) return "미기재";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  return `${n}B`;
}

function SectionCard({
  title,
  status,
  children,
}: {
  title: string;
  status: "AVAILABLE" | "NOT_IMPLEMENTED";
  children: React.ReactNode;
}) {
  const tone: BadgeTone = status === "AVAILABLE" ? "success" : "neutral";
  const label = status === "AVAILABLE" ? "실시간 조회" : "미구현";
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-card-title font-semibold text-text-primary">{title}</h2>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {children}
    </Card>
  );
}

function SourceCaption({ source }: { source: string }) {
  return <p className="mb-3 break-all font-mono text-[11px] text-text-muted">출처: {source}</p>;
}

function NotImplementedNote({ info }: { info: NotImplementedInfo }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-slate-50 px-3 py-2.5 text-body text-text-secondary">
      <Lock size={16} className="mt-0.5 shrink-0 text-slate-400" />
      <div>
        <p>{info.reason}</p>
        <p className="mt-1 text-caption text-text-muted">근거: {info.decision_id}</p>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-text-secondary">
      {children}
    </span>
  );
}

/**
 * 인덱싱 임베딩 모델 — P15의 유일한 편집 가능 하위 영역(D-065 UPDATE / D-075).
 * ADMIN만 이 페이지에 진입할 수 있으므로(GET /api/v1/admin/settings 자체가
 * ADMIN_SETTINGS_READ 전용) 별도의 Permission 배지는 필요 없다 — 이 카드가
 * 렌더링된다는 사실 자체가 이미 ADMIN임을 보장한다.
 */
function IndexingEmbeddingModelCard({
  section,
  token,
}: {
  section: IndexingEmbeddingModelSection;
  token: string;
}) {
  const [modelsState, setModelsState] = useState<"loading" | "ok" | "error">("loading");
  const [models, setModels] = useState<EmbeddingModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [configuredModel, setConfiguredModel] = useState<string | null>(section.configured_model);
  const [updatedAt, setUpdatedAt] = useState<string | null>(section.updated_at);
  const [updatedBy, setUpdatedBy] = useState<string | null>(section.updated_by);

  const [selected, setSelected] = useState<string>(section.configured_model ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  async function loadModels() {
    setModelsState("loading");
    setModelsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/embedding-models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as EmbeddingModelsResponse;
      setModels(body.models);
      setDefaultModel(body.default_embed_model);
      setModelsState("ok");
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
      setModelsState("error");
    }
  }

  useEffect(() => {
    loadModels();
    // 최초 1회만 — token은 이 페이지 진입 시점에 이미 ADMIN으로 고정됨.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/indexing-embedding-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: selected }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const updated = body as IndexingEmbeddingModelSection;
      setConfiguredModel(updated.configured_model);
      setUpdatedAt(updated.updated_at);
      setUpdatedBy(updated.updated_by);
      setSaveSuccess(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const noUsableModels = modelsState === "ok" && !models.some((m) => m.embedding_capable);

  return (
    <SectionCard title="인덱싱 임베딩 모델" status={section.status}>
      <SourceCaption source={section.source} />

      <div className="mb-4 flex flex-col gap-2">
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-body text-text-secondary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <p>
            이 설정은 <strong>새로 인덱싱되는 Knowledge에만</strong> 적용됩니다. 이미 만들어진
            인덱스는 각자 색인 시점에 기록된 임베딩 모델로만 검색되며 바뀌지 않습니다 — 기존
            Knowledge에 새 모델을 적용하려면 재인덱싱이 필요합니다.
          </p>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-body text-text-secondary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <p>
            모델 계열을 바꾸면(예: Qwen3 → 다른 계열) search-runtime의
            SEARCH_QUERY_INSTRUCT_PREFIX도 함께 재검토해야 합니다 — 그렇지 않으면 관련 있는
            질문과 무관한 질문의 유사도 분포가 겹쳐 관련도 임계값이 더 이상 작동하지 않을 수
            있습니다 (근거: D-046, D-075).
          </p>
        </div>
      </div>

      <dl className="mb-4 grid grid-cols-1 gap-x-4 gap-y-2 text-body sm:grid-cols-3">
        <div>
          <dt className="text-caption text-text-muted">현재 설정된 모델</dt>
          <dd className="font-mono text-text-primary">
            {configuredModel ?? (
              <span className="font-sans text-text-muted">
                미설정{defaultModel ? ` (기본값 ${defaultModel} 사용)` : ""}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-text-muted">마지막 변경</dt>
          <dd className="text-text-secondary">{updatedAt ? formatDateTime(updatedAt) : "-"}</dd>
        </div>
        <div>
          <dt className="text-caption text-text-muted">변경자</dt>
          <dd className="text-text-secondary">{updatedBy ?? "-"}</dd>
        </div>
      </dl>

      {modelsState === "loading" && (
        <LoadingState label="Ollama 설치 모델 목록을 불러오는 중..." />
      )}

      {modelsState === "error" && (
        <div className="mb-3 flex flex-col gap-2">
          <ErrorBanner message={`사용 가능한 모델 목록을 가져오지 못했습니다: ${modelsError}`} />
          <Button variant="secondary" size="sm" onClick={loadModels} className="w-fit">
            <RefreshCw size={14} /> 다시 시도
          </Button>
        </div>
      )}

      {modelsState === "ok" && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <FormField label="새 임베딩 모델">
                <select
                  className={inputClass}
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setSaveSuccess(false);
                  }}
                  disabled={models.length === 0}
                >
                  <option value="" disabled>
                    모델을 선택하세요
                  </option>
                  {models.map((m) => (
                    <option key={m.name} value={m.name} disabled={!m.embedding_capable}>
                      {m.name}
                      {!m.embedding_capable ? " (임베딩 불가 모델로 판별됨)" : ""}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <Button
              onClick={handleSave}
              disabled={saving || !selected || selected === configuredModel || noUsableModels}
              title={
                noUsableModels
                  ? "Ollama에 임베딩 가능 모델로 판별된 모델이 없습니다."
                  : selected === configuredModel
                    ? "이미 적용된 모델입니다."
                    : undefined
              }
            >
              {saving ? "저장 중..." : "저장"}
            </Button>
          </div>

          {noUsableModels && (
            <p className="mt-2 text-caption text-danger">
              Ollama에 설치된 모델 중 임베딩 가능으로 판별된 모델이 없습니다. 임베딩 모델을 먼저
              설치하세요.
            </p>
          )}
        </>
      )}

      {saveError && (
        <div className="mt-3">
          <ErrorBanner message={`저장하지 못했습니다: ${saveError}`} />
        </div>
      )}

      {saveSuccess && (
        <p className="mt-3 text-body text-success">
          저장했습니다. 새로 인덱싱되는 Knowledge부터 적용됩니다.
        </p>
      )}

      <p className="mt-3 text-caption text-text-muted">{section.note}</p>
    </SectionCard>
  );
}

export default function AdminSettingsPage() {
  const { role } = useRole();
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<AdminSettingsOut | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/settings`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (res.status === 403 || res.status === 401) {
          if (!cancelled) setState("forbidden");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as AdminSettingsOut;
        if (!cancelled) {
          setData(body);
          setState("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMessage(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [role.token]);

  return (
    <div>
      <PageHeader
        title="관리자 설정"
        description="플랫폼에 실제 적용 중인 정책·구성 현황입니다. 인덱싱 임베딩 모델을 제외한 나머지 항목은 저장소가 없어 편집 폼 대신 미구현 사유를 표시합니다."
      />

      {state === "loading" && <LoadingState label="설정 현황을 불러오는 중..." />}

      {state === "forbidden" && (
        <EmptyState
          icon={<ShieldAlert size={40} strokeWidth={1.5} />}
          title="이 역할에는 관리자 설정 조회 권한이 없습니다."
          description={`현재 역할: ${role.label}. 상단의 개발용 역할 전환에서 관리자로 전환해 보세요.`}
        />
      )}

      {state === "error" && (
        <ErrorBanner message={`설정 현황을 불러오지 못했습니다: ${errorMessage}`} />
      )}

      {state === "ok" && data && (
        <div className="flex flex-col gap-4">
          <p className="text-caption text-text-muted">
            조회 시각 {formatDateTime(data.generated_at)} · Trace ID {data.trace_id}
          </p>

          <SectionCard title="사용자·역할 매핑" status={data.user_role_mapping.status}>
            <SourceCaption source={data.user_role_mapping.source} />
            <p className="mb-3 text-body text-text-secondary">{data.user_role_mapping.note}</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-body">
                <thead>
                  <tr className="border-b border-border bg-slate-50 text-caption text-text-secondary">
                    <th className="px-3 py-2 font-medium">역할</th>
                    <th className="px-3 py-2 font-medium">권한</th>
                  </tr>
                </thead>
                <tbody>
                  {data.user_role_mapping.roles.map((row) => (
                    <tr key={row.role} className="border-b border-border last:border-0 align-top">
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-text-primary">
                        {row.role}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {row.permissions.map((p) => (
                            <Pill key={p}>{p}</Pill>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard title="조직·사업장" status={data.organization_site.status}>
            <NotImplementedNote info={data.organization_site.not_implemented} />
          </SectionCard>

          <SectionCard title="Office Profile" status={data.office_profile.status}>
            <SourceCaption source={data.office_profile.source} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body sm:grid-cols-4">
              <div>
                <dt className="text-caption text-text-muted">이름</dt>
                <dd className="text-text-primary">{data.office_profile.name}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">버전</dt>
                <dd className="text-text-primary">{data.office_profile.version}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">조직</dt>
                <dd className="text-text-primary">{data.office_profile.org}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">허용 최대 보안등급</dt>
                <dd className="text-text-primary">
                  {data.office_profile.max_classification_allowed ?? "미기재"}
                </dd>
              </div>
              <div className="col-span-2 sm:col-span-4">
                <dt className="text-caption text-text-muted">사업장</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {data.office_profile.sites.map((s) => (
                    <Pill key={s}>{s}</Pill>
                  ))}
                </dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="허용 모델과 Endpoint Alias" status={data.model_endpoint_alias.status}>
            <SourceCaption source={data.model_endpoint_alias.source} />
            <p className="mb-2 text-caption font-semibold text-text-secondary">모델 Alias</p>
            <div className="mb-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-body">
                <thead>
                  <tr className="border-b border-border bg-slate-50 text-caption text-text-secondary">
                    <th className="px-3 py-2 font-medium">Alias</th>
                    <th className="px-3 py-2 font-medium">Provider</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Endpoint</th>
                    <th className="px-3 py-2 font-medium">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {data.model_endpoint_alias.model_aliases.map((m) => (
                    <tr key={m.alias} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-text-primary">
                        {m.alias}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{m.provider}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-secondary">
                        {m.model_id}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-secondary">
                        {m.endpoint}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                        {m.max_context_tokens ?? "미기재"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-2 text-caption font-semibold text-text-secondary">MCP Server Alias</p>
            {data.model_endpoint_alias.mcp_servers.length === 0 ? (
              <p className="text-body text-text-muted">등록된 MCP Server Alias가 없습니다.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-body">
                  <thead>
                    <tr className="border-b border-border bg-slate-50 text-caption text-text-secondary">
                      <th className="px-3 py-2 font-medium">Alias</th>
                      <th className="px-3 py-2 font-medium">Endpoint</th>
                      <th className="px-3 py-2 font-medium">허용 Tool</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.model_endpoint_alias.mcp_servers.map((s) => (
                      <tr key={s.alias} className="border-b border-border last:border-0 align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-text-primary">
                          {s.alias}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-secondary">
                          {s.endpoint}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {s.allowed_tools.map((t) => (
                              <Pill key={t}>{t}</Pill>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="자산 크기·확장자 정책"
            status={data.asset_size_extension_policy.status}
          >
            <SourceCaption source={data.asset_size_extension_policy.source} />
            <p className="mb-3 text-body text-text-secondary">
              {data.asset_size_extension_policy.portal_upload_limit_note}
            </p>
            {data.asset_size_extension_policy.parse_error && (
              <div className="mb-3">
                <ErrorBanner message={data.asset_size_extension_policy.parse_error} />
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-caption font-semibold text-text-secondary">
                  Knowledge Package 빌드 정책 (M09)
                </p>
                <p className="text-body text-text-secondary">
                  FATAL 시 빌드 차단:{" "}
                  {data.asset_size_extension_policy.knowledge_package_fail_on_fatal === null
                    ? "미기재"
                    : data.asset_size_extension_policy.knowledge_package_fail_on_fatal
                    ? "예"
                    : "아니오"}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {data.asset_size_extension_policy.knowledge_package_forbidden_filenames.map(
                    (f) => (
                      <Pill key={f}>{f}</Pill>
                    )
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1 text-caption font-semibold text-text-secondary">
                  Desktop Offline Bundle 설치 정책 (M04)
                </p>
                <ul className="list-disc space-y-0.5 pl-4 text-body text-text-secondary">
                  <li>
                    전체 압축 해제 상한:{" "}
                    {formatBytes(data.asset_size_extension_policy.desktop_bundle_max_total_uncompressed_bytes)}
                  </li>
                  <li>
                    단일 파일 상한:{" "}
                    {formatBytes(
                      data.asset_size_extension_policy.desktop_bundle_max_single_file_uncompressed_bytes
                    )}
                  </li>
                  <li>
                    최대 압축률:{" "}
                    {data.asset_size_extension_policy.desktop_bundle_max_compression_ratio ?? "미기재"}
                  </li>
                </ul>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(data.asset_size_extension_policy.desktop_bundle_forbidden_archive_extensions ?? [])
                    .concat(
                      data.asset_size_extension_policy.desktop_bundle_forbidden_executable_extensions ?? []
                    )
                    .map((ext) => (
                      <Pill key={ext}>{ext}</Pill>
                    ))}
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="승인 Workflow" status={data.approval_workflow.status}>
            <SourceCaption source={data.approval_workflow.source} />
            <div className="mb-3 flex items-center gap-2 text-body text-text-primary">
              {data.approval_workflow.stage_chain.map((stage, idx) => (
                <span key={stage} className="flex items-center gap-2">
                  <Pill>{stage}</Pill>
                  {idx < data.approval_workflow.stage_chain.length - 1 && (
                    <span className="text-text-muted">→</span>
                  )}
                </span>
              ))}
            </div>
            <p className="text-body text-text-secondary">
              ServiceVersion 게시 시 승인 강제:{" "}
              <strong>{data.approval_workflow.require_service_version_approval ? "예" : "아니오"}</strong>
              <span className="ml-2 text-caption text-text-muted">
                ({data.approval_workflow.require_service_version_approval_source})
              </span>
            </p>
          </SectionCard>

          <SectionCard
            title="보안등급과 보관기간"
            status={
              data.security_classification_retention.classification.status === "AVAILABLE"
                ? "AVAILABLE"
                : "NOT_IMPLEMENTED"
            }
          >
            <p className="mb-2 text-caption font-semibold text-text-secondary">보안등급</p>
            <SourceCaption source={data.security_classification_retention.classification.source} />
            <div className="mb-2 flex flex-wrap gap-1">
              {data.security_classification_retention.classification.classification_levels.map((c) => (
                <Pill key={c}>{c}</Pill>
              ))}
            </div>
            <p className="mb-3 text-body text-text-secondary">
              미분류(UNKNOWN) Chunk 전체 허용:{" "}
              <strong>
                {data.security_classification_retention.classification.allow_unknown_classification
                  ? "예"
                  : "아니오(Fail-closed)"}
              </strong>
            </p>
            <p className="mb-4 text-caption text-text-muted">
              {data.security_classification_retention.classification.allow_unknown_classification_caveat}
            </p>
            <p className="mb-2 text-caption font-semibold text-text-secondary">보관기간</p>
            <NotImplementedNote info={data.security_classification_retention.retention.not_implemented} />
          </SectionCard>

          <SectionCard title="Package Trust/Signature 설정" status={data.package_trust_signature.status}>
            <NotImplementedNote info={data.package_trust_signature.not_implemented} />
          </SectionCard>

          <IndexingEmbeddingModelCard
            section={data.indexing_embedding_model}
            token={role.token}
          />
        </div>
      )}
    </div>
  );
}
