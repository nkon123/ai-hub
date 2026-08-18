"use client";

/**
 * P05 자산 등록 Wizard (01-portal-and-distribution.md §2 P05) — Agent /
 * Prompt / MCP Tool 전용. Knowledge와 AI Service는 이미 동작하는 전용 화면
 * (`/knowledge/new`, `/services/new`)이 있으므로 이 라우트로 들어오면 그
 * 화면으로 가는 안내만 보여준다(과제 지시사항 — 두 화면은 절대 수정하지
 *않음).
 *
 * ## 스텝 단순화 (services/new의 PLACEHOLDER_STEPS 관례를 따름)
 *
 * 명세(§2 P05)의 공통 8단계를 5개 실행 단계로 압축했다:
 *   1. 기본정보            → 1. 기본정보 (그대로)
 *   2. 지원 환경과 소유권   → 1. 기본정보에 통합 (소유 조직/담당자 필드로 흡수 —
 *                            별도로 "지원 환경"을 표현할 Schema 필드가
 *                            agent/prompt/mcp-tool manifest 어디에도 없음)
 *   3. Manifest 입력/업로드 → 2. Manifest 입력 (텍스트 입력만 지원 — 업로드는
 *                            원본 파일 자체가 아니라 JSON 값이라 별도 파일
 *                            업로드로 의미가 없음)
 *   4. 패키지 파일 업로드   → 3. 파일 업로드 (그대로)
 *   5. 의존성 확인          → PLACEHOLDER (아래 참고)
 *   6. 자동검증 결과        → 4. 검증 (그대로, 실제 서버 호출)
 *   7. 문서·변경이력        → 1. 기본정보의 "변경이력(선택)" 필드로 흡수
 *   8. 초안 저장 또는 검토 요청 → 5. 제출 = "초안 저장"만 수행(POST
 *      /api/v1/assets는 DRAFT를 만든다). "검토 요청"은 이미 존재하는
 *      `/assets/{id}/versions` 화면(P06)의 버튼이 전담하므로 여기서 중복
 *      구현하지 않는다 — 제출 완료 화면에서 그 화면으로 바로 연결한다.
 *
 * "의존성 확인"은 PLACEHOLDER_STEPS와 동일한 패턴으로 스텝 내비게이션에
 * 비활성 상태로 표시한다 — agent/prompt/mcp-tool manifest 스키마
 * (`packages/schemas/manifests/*.json`) 어디에도 다른 자산을 참조하는
 * 필드가 없어(참고: agent는 `capabilities.knowledge_required`/`mcp_allowed`
 * 같은 boolean만 있고 구체적 Knowledge/MCP id를 참조하지 않는다) 실제로
 * "확인"할 의존성 데이터 자체가 없다.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronRight,
  Download,
  FileEdit,
  FileUp,
  Loader2,
  Lock,
  RotateCcw,
  Upload,
  XCircle,
} from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  LoadingState,
  PageHeader,
  inputClass,
} from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { ASSET_TYPE_LABEL } from "../../../_components/review-meta";

// Permission.ASSET_CREATE holders (security_policy.roles.ROLE_PERMISSIONS) —
// required for both POST /api/v1/manifests/validate and POST /api/v1/assets.
const ASSET_CREATE_ROLES = new Set(["CREATOR", "ADMIN"]);
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// GET /api/v1/assets/upload-policy (D-034 실 서비스 검증) — new endpoint, so
// it follows the module's stated convention for new code
// (`NEXT_PUBLIC_API_BASE`, absolute URL) even though the rest of this file's
// existing calls use the relative `/api/*` + next.config.mjs rewrite
// pattern that predates that convention (apps/portal-web/CLAUDE.md "이
// 모듈의 경계"). Not changing the existing calls — out of scope here.
interface UploadPolicy {
  maxSingleFileBytes: number;
  maxTotalRequestBytes: number;
  maxFileCount: number;
  rejectedExtensions: string[];
}

type UploadPolicyState =
  | { status: "loading" }
  | { status: "ok"; policy: UploadPolicy }
  | { status: "unknown"; message: string };

function formatBytesKo(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

/** 파일 선택 "전"에 보여줄 수 있는 정도의 검사 — 편의용일 뿐 최종 판정이
 * 아니다. 서버(`POST /api/v1/assets`)가 최종 판정하며, 이 검사를 통과했다고
 * 서버 오류 처리를 건너뛰지 않는다(아래 handleSubmit은 이 검사와 무관하게
 * 항상 서버 응답을 그대로 해석한다). */
function checkFilesAgainstPolicy(files: File[], policy: UploadPolicy): string[] {
  const problems: string[] = [];
  if (files.length > policy.maxFileCount) {
    problems.push(
      `업로드 파일 개수(${files.length}개)가 허용된 최대치(${policy.maxFileCount}개)를 초과했습니다.`
    );
  }
  let total = 0;
  for (const f of files) {
    total += f.size;
    const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "";
    if (policy.rejectedExtensions.includes(ext)) {
      problems.push(`'${f.name}' 파일의 확장자(${ext || "(없음)"})는 허용되지 않습니다.`);
    }
    if (f.size > policy.maxSingleFileBytes) {
      problems.push(
        `'${f.name}' 파일 크기(${formatBytesKo(f.size)})가 허용된 최대치(${formatBytesKo(policy.maxSingleFileBytes)})를 초과했습니다.`
      );
    }
  }
  if (total > policy.maxTotalRequestBytes) {
    problems.push(
      `전체 파일 크기(${formatBytesKo(total)})가 허용된 최대치(${formatBytesKo(policy.maxTotalRequestBytes)})를 초과했습니다.`
    );
  }
  return problems;
}

function useUploadPolicy(token: string): UploadPolicyState {
  const [state, setState] = useState<UploadPolicyState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`${API_BASE}/api/v1/assets/upload-policy`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // 한도 조회 실패는 업로드를 막지 않는다 — 다만 조용히 넘기지 않고
          // 표시한다("한도를 확인하지 못했습니다"). 최종 판정은 서버가 한다.
          const body = await safeJson(res);
          setState({
            status: "unknown",
            message: body?.error?.message ?? `한도를 확인하지 못했습니다. (HTTP ${res.status})`,
          });
          return;
        }
        const body = await res.json();
        setState({
          status: "ok",
          policy: {
            maxSingleFileBytes: body.max_single_file_bytes,
            maxTotalRequestBytes: body.max_total_request_bytes,
            maxFileCount: body.max_file_count,
            rejectedExtensions: (body.rejected_extensions ?? []).map((e: string) => e.toLowerCase()),
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "unknown", message: "한도를 확인하지 못했습니다. 네트워크 상태를 확인해 주세요." });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return state;
}

// Python 시그니처 파일 선택 — 클라이언트에서 텍스트로 읽어 기존 textarea를
// 채울 뿐, 파일 자체는 업로드/저장/실행하지 않는다. 두 한계 모두 사용자에게
// 이유를 보여주고 거부한다(자르지 않음 — 잘린 코드는 다른 시그니처로
// 변환되어 더 위험하다).
// MAX_SOURCE_CHARS는 apps/portal-api/src/portal_api/python_signature.py의
// 서버 측 상한과 반드시 같은 값을 유지한다.
const MAX_PYTHON_SOURCE_CHARS = 20_000;
const MAX_PYTHON_FILE_BYTES = 200_000; // 텍스트로 읽기 전 1차 크기 방어(대략치)

type WizardType = "agent" | "prompt" | "mcp_tool";

const WIZARD_TYPES: WizardType[] = ["agent", "prompt", "mcp_tool"];

// RESTRICTED exists in every manifest schema's classification enum but is
// intentionally not offered here, mirroring `/knowledge/new`'s own
// classification <select> (PUBLIC_INTERNAL/INTERNAL/CONFIDENTIAL only) so the
// two registration flows read as one consistent design, not two.
const CLASSIFICATIONS = [
  { value: "PUBLIC_INTERNAL", label: "PUBLIC_INTERNAL — 사내 공개" },
  { value: "INTERNAL", label: "INTERNAL — 사내 한정" },
  { value: "CONFIDENTIAL", label: "CONFIDENTIAL — 기밀" },
] as const;

const STEPS = [
  { id: 1, label: "기본정보" },
  { id: 2, label: "동작 설정" },
  { id: 3, label: "파일 업로드" },
  { id: 4, label: "검증" },
  { id: 5, label: "제출" },
] as const;

interface FieldNote {
  field: string;
  desc: string;
}

// 모든 유형 공통 — asset-manifest.schema.json의 공통 Header 필드.
const COMMON_FIELD_NOTES: FieldNote[] = [
  { field: "id", desc: "자산의 영구 식별자(UUID). 예시로 채우면 자동으로 새 값이 들어가므로 직접 만들 필요는 없습니다." },
  { field: "version", desc: "major.minor.patch 형식(예: 1.0.0). 최초 등록은 보통 1.0.0으로 시작합니다." },
  { field: "owner.org / owner.creator_id", desc: "소유 조직과 담당자. 1단계 기본정보 값이 자동으로 채워집니다." },
  { field: "classification", desc: "보안 등급 — PUBLIC_INTERNAL(사내 공개) / INTERNAL(사내 한정) / CONFIDENTIAL(기밀) 중 선택합니다." },
];

// 유형별 — 각 manifest schema(packages/schemas/manifests/*.schema.json)의
// 필수/핵심 필드만 짧게 설명. 전체 정의는 SCHEMA_DOC_BY_TYPE 참고.
const TYPE_FIELD_NOTES: Record<WizardType, FieldNote[]> = {
  agent: [
    { field: "workflow.entry_role", desc: "실행이 시작되는 Role id. workflow.roles[] 항목 중 하나와 정확히 일치해야 합니다." },
    { field: "workflow.roles[].type", desc: "Role 유형 — planner / retriever / answerer / validator 중 하나." },
    { field: "capabilities.knowledge_required", desc: "이 Agent가 Knowledge 검색을 필요로 하는지 여부." },
    { field: "capabilities.mcp_allowed", desc: "이 Agent가 MCP Tool 호출을 허용받는지 여부." },
  ],
  prompt: [
    { field: "template.system", desc: "System Prompt 본문 텍스트." },
    { field: "template.file", desc: "3단계에서 업로드할 Template 파일명 — 이 이름과 정확히 일치하는 파일을 올려야 합니다(예: template.md)." },
    { field: "variables[]", desc: "Prompt가 사용하는 변수 목록. 각 항목은 name과 type(string/integer/boolean/array)이 필수입니다." },
  ],
  mcp_tool: [
    { field: "server_alias", desc: "Office Profile에 등록된 MCP 서버 식별자." },
    { field: "tool_name", desc: "식별자 형식(점으로 구분한 네임스페이스 허용, 예: db_metadata.get_tables)." },
    { field: "risk_level", desc: "PoC 정책상 \"READ_ONLY\"만 허용됩니다." },
    { field: "input_schema", desc: "Tool 입력 파라미터를 정의하는 JSON Schema 객체." },
  ],
};

/** agent-manifest.schema.json의 `workflow.roles[].type` enum 그대로 —
 * 라벨만 업무 표현으로 덧붙인다(값은 스키마 값을 그대로 쓴다). */
const AGENT_ROLE_TYPES = [
  { value: "answerer", label: "answerer — 답변 생성" },
  { value: "retriever", label: "retriever — 자료 검색" },
  { value: "planner", label: "planner — 작업 계획" },
  { value: "validator", label: "validator — 결과 검증" },
] as const;

const PROMPT_VARIABLE_TYPES = ["string", "integer", "boolean", "array"] as const;

interface PromptVariable {
  name?: string;
  type?: string;
  required?: boolean;
  description?: string;
}

interface AgentRole {
  id?: string;
  type?: string;
  description?: string;
  requires_knowledge?: boolean;
  requires_mcp?: boolean;
  requires_prompt?: boolean;
}

const SCHEMA_DOC_BY_TYPE: Record<WizardType, string> = {
  agent: "packages/schemas/manifests/agent-manifest.schema.json",
  prompt: "packages/schemas/manifests/prompt-manifest.schema.json",
  mcp_tool: "packages/schemas/manifests/mcp-tool-manifest.schema.json",
};

interface WizardExample {
  sourceFixture: string;
  manifest: Record<string, unknown>;
  companionFiles: { name: string; content: string }[];
}

type ExampleState =
  | { status: "loading" }
  | { status: "ok"; data: WizardExample }
  | { status: "error"; message: string };

function downloadTextFile(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface BasicInfo {
  name: string;
  description: string;
  classification: string;
  ownerOrg: string;
  creatorId: string;
  tagsText: string;
  changelog: string;
}

function buildSkeleton(type: WizardType, id: string, basic: BasicInfo): Record<string, unknown> {
  const tags = basic.tagsText
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const common = {
    schema_version: "1.0",
    id,
    type,
    name: basic.name,
    version: "1.0.0",
    owner: { org: basic.ownerOrg, creator_id: basic.creatorId },
    classification: basic.classification,
    description: basic.description,
    tags,
    ...(basic.changelog.trim() ? { changelog: basic.changelog.trim() } : {}),
  };

  if (type === "agent") {
    return {
      ...common,
      workflow: {
        entry_role: "answerer",
        roles: [
          {
            id: "answerer",
            type: "answerer",
            description: "",
            requires_knowledge: false,
            requires_mcp: false,
            requires_prompt: true,
          },
        ],
      },
      capabilities: {
        knowledge_required: false,
        mcp_allowed: false,
        streaming: true,
        citation_required: false,
      },
    };
  }

  if (type === "prompt") {
    return {
      ...common,
      template: { system: "", file: "template.md", language: "ko" },
      variables: [{ name: "question", type: "string", required: true, description: "사용자 질문" }],
    };
  }

  // mcp_tool
  return {
    ...common,
    server_alias: "",
    tool_name: "",
    risk_level: "READ_ONLY",
    input_schema: { type: "object", properties: {} },
    execution_guards: { timeout_seconds: 10, requires_user_confirmation: false },
  };
}

type ParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

interface PythonSignatureConversion {
  function_name: string;
  input_schema: Record<string, unknown>;
  parameters: Array<{ name: string; schema_type: string; required: boolean; default_included: boolean }>;
  discarded: {
    body_statement_count: number;
    decorator_count: number;
    docstring_present: boolean;
    return_annotation_present: boolean;
    top_level_statement_count: number;
    source_persisted: false;
    source_executed: false;
  };
  warnings: string[];
}

function parseManifestText(text: string): ParseResult {
  if (!text.trim()) return { ok: false, error: "Manifest가 비어 있습니다." };
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "Manifest는 JSON 객체({ ... })여야 합니다." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `JSON 형식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface ServerErrorInfo {
  message: string;
  traceId?: string;
  schemaErrors?: string[];
  permission?: boolean;
}

function extractServerError(status: number, body: any): ServerErrorInfo {
  // create_asset raises a plain FastAPI HTTPException (detail: string) for
  // malformed JSON / unsupported type, but returns the {error:{...}} envelope
  // for schema validation and permission failures — handle both shapes.
  const message: string =
    body?.error?.message ?? body?.detail ?? `요청을 처리하지 못했습니다. (HTTP ${status})`;
  return {
    message,
    traceId: body?.error?.trace_id,
    schemaErrors: body?.error?.details?.errors,
    permission: status === 403,
  };
}

export default function AssetRegistrationWizardPage() {
  const params = useParams<{ type: string }>();
  const rawType = params.type;

  if (rawType === "knowledge") {
    return (
      <RedirectNotice
        title="Knowledge는 전용 등록 화면을 사용합니다."
        description="Knowledge(지식 자산)는 문서 업로드와 자동 인덱싱을 함께 처리하는 별도 화면에서 등록합니다."
        href="/knowledge/new"
        ctaLabel="지식 등록으로 이동"
      />
    );
  }
  if (rawType === "service") {
    return (
      <RedirectNotice
        title="AI Service는 Composer Wizard를 사용합니다."
        description="AI Service는 Asset이 아니라 별도의 Service Definition 모델이며, 승인된 자산을 조합하는 10단계 Composer에서 구성합니다."
        href="/services/new"
        ctaLabel="AI Service Composer로 이동"
      />
    );
  }
  if (!WIZARD_TYPES.includes(rawType as WizardType)) {
    return (
      <div>
        <PageHeader title="자산 등록" />
        <EmptyState
          icon={<XCircle size={40} strokeWidth={1.5} />}
          title="지원하지 않는 자산 유형입니다"
          description={`요청한 유형: ${rawType}`}
          action={<Button href="/assets/new">자산 유형 선택으로 돌아가기</Button>}
        />
      </div>
    );
  }

  return <Wizard type={rawType as WizardType} />;
}

function RedirectNotice({
  title,
  description,
  href,
  ctaLabel,
}: {
  title: string;
  description: string;
  href: string;
  ctaLabel: string;
}) {
  return (
    <div>
      <PageHeader title="자산 등록" />
      <EmptyState
        icon={<FileEdit size={40} strokeWidth={1.5} />}
        title={title}
        description={description}
        action={<Button href={href}>{ctaLabel}</Button>}
      />
    </div>
  );
}

function Wizard({ type }: { type: WizardType }) {
  const { role } = useRole();
  const canCreate = ASSET_CREATE_ROLES.has(role.code);
  const typeLabel = ASSET_TYPE_LABEL[type] ?? type;

  const manifestId = useState(() => crypto.randomUUID())[0];
  const [step, setStep] = useState(1);

  const [basic, setBasic] = useState<BasicInfo>({
    name: "",
    description: "",
    classification: "INTERNAL",
    ownerOrg: "miracom",
    creatorId: role.userId,
    tagsText: "",
    changelog: "",
  });
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  const [manifestText, setManifestText] = useState("");
  const [manifestGenerated, setManifestGenerated] = useState(false);

  const [files, setFiles] = useState<File[]>([]);
  const uploadPolicyState = useUploadPolicy(role.token);
  const fileViolations =
    uploadPolicyState.status === "ok" && files.length > 0
      ? checkFilesAgainstPolicy(files, uploadPolicyState.policy)
      : [];

  // 유형별 예시 Manifest/파일 — GET /assets/new/{type}/examples가
  // fixtures/valid/*를 그대로 서버에서 읽어 돌려준다 (route.ts 참고). 실
  // 사용자 피드백("어떤 파일을 올려야 하는지 모르겠다")에 대한 응답이라
  // Wizard 진입과 함께 미리 불러와 둔다 — 2단계(Manifest)와 3단계(파일
  // 업로드) 양쪽에서 같은 데이터를 쓴다.
  const [example, setExample] = useState<ExampleState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setExample({ status: "loading" });
    fetch(`/assets/new/${type}/examples`)
      .then(async (res) => {
        const body = await safeJson(res);
        if (cancelled) return;
        if (!res.ok || !body?.manifest) {
          setExample({
            status: "error",
            message: body?.error?.message ?? "예시를 불러오지 못했습니다.",
          });
          return;
        }
        setExample({
          status: "ok",
          data: {
            sourceFixture: body.sourceFixture,
            manifest: body.manifest,
            companionFiles: body.companionFiles ?? [],
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setExample({ status: "error", message: "예시를 불러오지 못했습니다. 네트워크 상태를 확인해 주세요." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  const [validateState, setValidateState] = useState<{
    status: "idle" | "loading" | "ok" | "invalid" | "error";
    errors: string[];
    validatedText: string | null;
    error?: ServerErrorInfo;
  }>({ status: "idle", errors: [], validatedText: null });

  const [submitState, setSubmitState] = useState<{
    status: "idle" | "loading" | "success" | "error";
    result?: { assetId: string; versionId: string; version: string; status: string };
    error?: ServerErrorInfo;
  }>({ status: "idle" });

  function regenerateSkeleton() {
    setManifestText(JSON.stringify(buildSkeleton(type, manifestId, basic), null, 2));
    setManifestGenerated(true);
    // A regenerated manifest invalidates any prior validate result.
    setValidateState({ status: "idle", errors: [], validatedText: null });
  }

  // Auto-fill the skeleton exactly once, the first time step 2 is reached —
  // afterwards the user's own edits are never overwritten automatically
  // (only the explicit "기본값으로 재설정" button below does that), same
  // "don't clobber in-progress input" principle as services/new's Draft
  // staleness handling.
  useEffect(() => {
    if (step === 2 && !manifestGenerated) {
      regenerateSkeleton();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const parsed = useMemo(() => parseManifestText(manifestText), [manifestText]);

  // Prompt-only: the file the user must upload, read from the manifest's
  // own template.file field (spec: "template.file에 이름이 명시된 파일을
  // 업로드해야 한다").
  const expectedTemplateFile =
    type === "prompt" && parsed.ok && typeof parsed.value.template === "object" && parsed.value.template !== null
      ? (parsed.value.template as Record<string, unknown>).file
      : undefined;
  const expectedTemplateFileName = typeof expectedTemplateFile === "string" ? expectedTemplateFile : null;
  const templateFileMatched =
    !expectedTemplateFileName || files.some((f) => f.name === expectedTemplateFileName);

  const isValidationStale = validateState.validatedText !== null && validateState.validatedText !== manifestText;
  const validationPassed = validateState.status === "ok" && !isValidationStale;

  function goBack() {
    setStep((s) => Math.max(1, s - 1));
  }

  const canGoNext = (() => {
    switch (step) {
      case 1:
        return basic.name.trim().length > 0;
      case 2:
        if (type !== "mcp_tool") return manifestText.trim().length > 0;
        return (
          parsed.ok &&
          typeof parsed.value.server_alias === "string" &&
          parsed.value.server_alias.trim().length > 0 &&
          typeof parsed.value.tool_name === "string" &&
          parsed.value.tool_name.trim().length > 0
        );
      case 3:
        return templateFileMatched && fileViolations.length === 0;
      case 4:
        return validationPassed;
      default:
        return true;
    }
  })();

  const nextDisabledReason = (() => {
    if (canGoNext) return undefined;
    switch (step) {
      case 1:
        return "자산 이름을 입력하세요.";
      case 2:
        return type === "mcp_tool"
          ? "MCP 서버 연결 이름과 Tool 호출 이름을 입력하세요."
          : "Manifest JSON을 입력하세요.";
      case 3:
        if (fileViolations.length > 0) return fileViolations[0];
        return expectedTemplateFileName
          ? `업로드한 파일 중 "${expectedTemplateFileName}" 이름과 일치하는 파일이 없습니다.`
          : undefined;
      case 4:
        return "검증을 통과해야 다음 단계로 진행할 수 있습니다.";
      default:
        return undefined;
    }
  })();

  function goNext() {
    if (step === 1 && basic.name.trim().length === 0) {
      setNameError("자산 이름을 입력하세요.");
      return;
    }
    setNameError(undefined);
    if (!canGoNext) return;
    setStep((s) => Math.min(STEPS.length, s + 1));
  }

  async function runValidate() {
    if (!canCreate || !parsed.ok) return;
    setValidateState({ status: "loading", errors: [], validatedText: null });
    try {
      // Relative path — Next.js dev server rewrites `/api/*` to portal-api
      // (next.config.mjs), same convention every other screen in this app
      // uses (e.g. `/knowledge/new`). No separate API_BASE env var needed.
      const res = await fetch(`/api/v1/manifests/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ type, manifest: parsed.value }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setValidateState({
          status: "error",
          errors: [],
          validatedText: null,
          error: extractServerError(res.status, body),
        });
        return;
      }
      if (body?.valid) {
        setValidateState({ status: "ok", errors: [], validatedText: manifestText });
      } else {
        setValidateState({
          status: "invalid",
          errors: body?.errors ?? ["Manifest가 스키마를 충족하지 않습니다."],
          validatedText: null,
        });
      }
    } catch {
      setValidateState({
        status: "error",
        errors: [],
        validatedText: null,
        error: { message: "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요." },
      });
    }
  }

  async function handleSubmit() {
    if (!canCreate || !validationPassed) return;
    setSubmitState({ status: "loading" });
    try {
      const formData = new FormData();
      formData.append("manifest", manifestText);
      for (const file of files) {
        formData.append("files", file, file.name);
      }
      const res = await fetch(`/api/v1/assets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
        body: formData,
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSubmitState({ status: "error", error: extractServerError(res.status, body) });
        return;
      }
      setSubmitState({
        status: "success",
        result: {
          assetId: body.asset_id,
          versionId: body.id,
          version: body.version,
          status: body.status,
        },
      });
    } catch {
      setSubmitState({
        status: "error",
        error: { message: "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요." },
      });
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) setFiles(Array.from(e.target.files));
  }

  if (submitState.status === "success" && submitState.result) {
    return (
      <div className="max-w-2xl">
        <PageHeader title={`${typeLabel} 등록`} />
        <div className="rounded-card border border-success/30 bg-success/5 p-5">
          <div className="mb-1.5 flex items-center gap-2 font-semibold text-success">
            <CheckCircle2 size={18} />
            초안 등록 완료
          </div>
          <div className="text-caption text-success">
            Asset ID: {submitState.result.assetId} · Version: {submitState.result.version} · 상태:{" "}
            {submitState.result.status}
          </div>
        </div>
        <p className="mt-4 text-body text-text-secondary">
          방금 만든 것은 DRAFT 초안입니다. 검토를 받으려면 버전 관리 화면에서 "검토 요청"을 눌러야 합니다.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button href={`/assets/${submitState.result.assetId}/versions`}>버전 관리·검토 요청으로 이동</Button>
          <Button href={`/assets/${submitState.result.assetId}`} variant="secondary">
            자산 상세 보기
          </Button>
          <Button href="/my/assets" variant="secondary">
            내 자산으로 이동
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={`${typeLabel} 등록`}
        description="필요한 정보를 단계별로 입력하고, 서버 검증을 통과한 뒤 초안을 등록합니다."
        actions={
          <Button href="/assets/new" variant="secondary" size="sm">
            취소
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2">
        {STEPS.map((s, idx) => (
          <div key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={s.id > step}
              onClick={() => s.id <= step && setStep(s.id)}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                step === s.id
                  ? "bg-brand-600 text-white"
                  : step > s.id
                  ? "bg-brand-100 text-brand-700"
                  : "bg-slate-100 text-text-muted"
              }`}
            >
              {s.id}
            </button>
            <span className={`text-caption ${step === s.id ? "font-semibold text-text-primary" : "text-text-muted"}`}>
              {s.label}
            </span>
            <ChevronRight size={12} className="text-slate-300" />
            {/* 의존성 확인 — spec 위치(파일 업로드 다음, 검증 이전)에 항상
                비활성으로 표시. See file-level docstring for why. */}
            {s.id === 3 && (
              <div
                className="flex items-center gap-2"
                title="Agent/Prompt/MCP Tool Manifest Schema에 의존 자산 참조 필드가 없어 지원되지 않습니다."
              >
                <span className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-full bg-slate-50 text-xs text-slate-300">
                  –
                </span>
                <span className="text-caption text-slate-400">
                  의존성 확인 <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">미지원</span>
                </span>
                <ChevronRight size={12} className="text-slate-300" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-card border border-border bg-slate-50/50 p-6">
        {step === 1 && (
          <StepBasicInfo value={basic} onChange={setBasic} nameError={nameError} typeLabel={typeLabel} />
        )}

        {step === 2 && (
          <StepManifest
            type={type}
            manifestText={manifestText}
            onChange={setManifestText}
            onReset={regenerateSkeleton}
            parsed={parsed}
            example={example}
          />
        )}

        {step === 3 && (
          <StepFiles
            type={type}
            files={files}
            onChange={handleFileChange}
            expectedTemplateFileName={expectedTemplateFileName}
            templateFileMatched={templateFileMatched}
            manifestParsed={parsed.ok}
            example={example}
            uploadPolicyState={uploadPolicyState}
            fileViolations={fileViolations}
          />
        )}

        {step === 4 && (
          <StepValidateManifest
            canCreate={canCreate}
            roleLabel={role.label}
            parsed={parsed}
            state={validateState}
            isStale={isValidationStale}
            onRun={runValidate}
          />
        )}

        {step === 5 && (
          <StepSubmit
            canCreate={canCreate}
            roleLabel={role.label}
            typeLabel={typeLabel}
            basic={basic}
            fileCount={files.length}
            validationPassed={validationPassed}
            submitState={submitState}
            onSubmit={handleSubmit}
          />
        )}

        <div className="mt-6 flex items-end justify-between border-t border-border pt-5">
          <Button variant="secondary" onClick={goBack} disabled={step === 1}>
            이전 단계로
          </Button>
          {step < STEPS.length && (
            <div className="flex flex-col items-end gap-1.5">
              {nextDisabledReason && <span className="text-caption text-text-muted">{nextDisabledReason}</span>}
              <Button onClick={goNext} disabled={!canGoNext}>
                다음
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBasicInfo({
  value,
  onChange,
  nameError,
  typeLabel,
}: {
  value: BasicInfo;
  onChange: (v: BasicInfo) => void;
  nameError?: string;
  typeLabel: string;
}) {
  function set<K extends keyof BasicInfo>(key: K, v: BasicInfo[K]) {
    onChange({ ...value, [key]: v });
  }
  return (
    <div className="space-y-5">
      <h2 className="text-card-title font-semibold text-text-primary">기본정보</h2>
      <FormField label="자산명" required error={nameError}>
        <input
          value={value.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder={`예: 표준 ${typeLabel} 자산`}
          className={inputClass}
        />
      </FormField>
      <FormField label="설명">
        <textarea
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          placeholder="이 자산이 하는 일을 간략히 설명하세요."
          className={`${inputClass} resize-y`}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="보안 등급">
          <select
            value={value.classification}
            onChange={(e) => set("classification", e.target.value)}
            className={inputClass}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="태그 (쉼표로 구분)">
          <input
            value={value.tagsText}
            onChange={(e) => set("tagsText", e.target.value)}
            placeholder="예: standard, chatbot"
            className={inputClass}
          />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="소유 조직">
          <input value={value.ownerOrg} onChange={(e) => set("ownerOrg", e.target.value)} className={inputClass} />
        </FormField>
        <FormField label="주 담당자 (creator_id)">
          <input
            value={value.creatorId}
            onChange={(e) => set("creatorId", e.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>
      <FormField label="변경이력 (선택)">
        <input
          value={value.changelog}
          onChange={(e) => set("changelog", e.target.value)}
          placeholder="예: 최초 등록"
          className={inputClass}
        />
      </FormField>
    </div>
  );
}

function StepManifest({
  type,
  manifestText,
  onChange,
  onReset,
  parsed,
  example,
}: {
  type: WizardType;
  manifestText: string;
  onChange: (v: string) => void;
  onReset: () => void;
  parsed: ParseResult;
  example: ExampleState;
}) {
  // 고급 편집기에서 JSON이 깨진 채로 구조화 폼을 조작하면, 폼이 자기가
  // 읽어낸 빈 객체 위에 patch를 얹어 저장해 사용자가 쓰던 내용을 조용히
  // 지워 버린다. 그래서 그동안은 편집을 막고 이유를 말한다.
  const structuredBlocked = !parsed.ok && manifestText.trim().length > 0;
  const structuredBlockedBanner = (
    <ErrorBanner
      message={`고급 설정의 JSON이 올바르지 않아 아래 항목을 편집할 수 없습니다. 먼저 JSON을 고치거나 "기본값으로 재설정"을 누르세요.${parsed.ok ? "" : ` (${parsed.error})`}`}
    />
  );

  if (type === "agent") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-card-title font-semibold text-text-primary">Agent 구성</h2>
          <p className="mt-1 text-body text-text-secondary">
            이 Agent가 무엇을 할 수 있는지만 고르면 됩니다. 나머지 Manifest 값은 자동으로 채워집니다.
          </p>
        </div>

        {structuredBlocked ? (
          structuredBlockedBanner
        ) : (
          <AgentManifestFields parsed={parsed} onChange={onChange} />
        )}

        <details className="rounded-lg border border-border bg-white">
          <summary className="cursor-pointer px-4 py-3 text-body font-semibold text-text-secondary">
            고급 설정 · Manifest 직접 편집
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <p className="text-caption text-text-secondary">
              위 화면이 다루지 않는 필드가 필요할 때만 수정하세요. 기본 등록에는 펼칠 필요가 없습니다.
            </p>
            <ExamplePanel type={type} example={example} onFill={onChange} />
            <textarea
              value={manifestText}
              onChange={(e) => onChange(e.target.value)}
              rows={18}
              spellCheck={false}
              aria-label="Agent Manifest JSON"
              className={`${inputClass} font-mono text-caption resize-y`}
            />
            {!parsed.ok && manifestText.trim().length > 0 && <ErrorBanner message={parsed.error} />}
          </div>
        </details>
      </div>
    );
  }

  if (type === "prompt") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-card-title font-semibold text-text-primary">Prompt 구성</h2>
          <p className="mt-1 text-body text-text-secondary">
            System Prompt 본문과 이 Prompt가 받는 변수만 정하면 됩니다.
          </p>
        </div>

        {structuredBlocked ? (
          structuredBlockedBanner
        ) : (
          <PromptManifestFields parsed={parsed} onChange={onChange} />
        )}

        <details className="rounded-lg border border-border bg-white">
          <summary className="cursor-pointer px-4 py-3 text-body font-semibold text-text-secondary">
            고급 설정 · Manifest 직접 편집
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <p className="text-caption text-text-secondary">
              위 화면이 다루지 않는 필드가 필요할 때만 수정하세요. 기본 등록에는 펼칠 필요가 없습니다.
            </p>
            <ExamplePanel type={type} example={example} onFill={onChange} />
            <textarea
              value={manifestText}
              onChange={(e) => onChange(e.target.value)}
              rows={18}
              spellCheck={false}
              aria-label="Prompt Manifest JSON"
              className={`${inputClass} font-mono text-caption resize-y`}
            />
            {!parsed.ok && manifestText.trim().length > 0 && <ErrorBanner message={parsed.error} />}
          </div>
        </details>
      </div>
    );
  }

  if (type === "mcp_tool") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-card-title font-semibold text-text-primary">MCP Tool 연결</h2>
          <p className="mt-1 text-body text-text-secondary">
            Desktop에서 사용할 읽기 전용 Tool의 연결 이름과 호출 이름만 입력하세요.
          </p>
        </div>

        {structuredBlocked ? (
          structuredBlockedBanner
        ) : (
          <McpManifestFields parsed={parsed} onChange={onChange} />
        )}

        <details className="rounded-lg border border-border bg-white">
          <summary className="cursor-pointer px-4 py-3 text-body font-semibold text-text-secondary">
            고급 설정 · Manifest 직접 편집
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <p className="text-caption text-text-secondary">
              입력·출력 JSON Schema나 세부 실행 제한이 필요할 때만 수정하세요. 기본 등록에는 펼칠 필요가 없습니다.
            </p>
            <ExamplePanel type={type} example={example} onFill={onChange} />
            <textarea
              value={manifestText}
              onChange={(e) => onChange(e.target.value)}
              rows={18}
              spellCheck={false}
              aria-label="MCP Tool Manifest JSON"
              className={`${inputClass} font-mono text-caption resize-y`}
            />
            {!parsed.ok && manifestText.trim().length > 0 && <ErrorBanner message={parsed.error} />}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-card-title font-semibold text-text-primary">Manifest 입력</h2>
          <p className="mt-1 text-body text-text-secondary">
            기본정보에서 입력한 값이 자동으로 채워져 있습니다. 아래 예시와 필드 설명을 참고해 채우거나 수정하세요.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onReset}>
          <RotateCcw size={13} />
          기본값으로 재설정
        </Button>
      </div>

      <ExamplePanel type={type} example={example} onFill={onChange} />

      <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
        <p className="mb-1.5 font-medium text-text-primary">주요 필드 설명</p>
        <dl className="space-y-1">
          {[...COMMON_FIELD_NOTES, ...TYPE_FIELD_NOTES[type]].map((note) => (
            <div key={note.field} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
              <dt className="shrink-0 font-mono text-[11px] text-brand-700 sm:w-64">{note.field}</dt>
              <dd>{note.desc}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-text-muted">
          전체 필드 정의: <code>{SCHEMA_DOC_BY_TYPE[type]}</code> ·{" "}
          <code>docs/implementation-spec/03-package-standards.md</code>
        </p>
      </div>

      {manifestText.trim().length === 0 && (
        <EmptyState
          icon={<FileEdit size={32} strokeWidth={1.5} />}
          title="Manifest가 비어 있습니다."
          description={'기본값으로 재설정을 누르거나, 위 예시의 "이 예시로 채우기"를 눌러 시작하세요.'}
        />
      )}

      <textarea
        value={manifestText}
        onChange={(e) => onChange(e.target.value)}
        rows={20}
        spellCheck={false}
        className={`${inputClass} font-mono text-caption resize-y`}
      />

      {!parsed.ok && manifestText.trim().length > 0 && <ErrorBanner message={parsed.error} />}
    </div>
  );
}

/** Agent Manifest 구조 입력 — P05의 "쉽게 등록" 절반.
 *
 * 이 화면이 다루는 것은 Agent Manifest 전체가 아니라 **실제로 두 표준 Agent를
 * 구분 짓는 것들**이다. `services/agent-runtime/config/`의 standard-agent와
 * standard-db-agent는 역할이 `answerer` 하나로 똑같고 `capabilities`와 한도만
 * 다르다 — 그래서 기본 화면은 역할 하나를 전제로 하고, 역할 추가는 필요한
 * 사람만 쓰도록 뒤에 둔다. 없는 개념(Preset 이름, 워크플로 그래프 편집기 등)을
 * 새로 만들지 않는다: 이 폼이 쓰는 필드는 전부 agent-manifest.schema.json에
 * 실재하는 것뿐이고, 스키마가 표현하지 못하는 규칙은 차단이 아니라 경고로만
 * 알린다.
 *
 * `entry_role`은 사용자가 직접 입력하지 않는다 — 역할 id와 어긋나면 Manifest가
 * 검증에서 떨어지는데, 그 어긋남은 폼이 구조적으로 막을 수 있는 종류다. */
function AgentManifestFields({
  parsed,
  onChange,
}: {
  parsed: ParseResult;
  onChange: (value: string) => void;
}) {
  const manifest = parsed.ok ? parsed.value : {};
  const workflow =
    typeof manifest.workflow === "object" && manifest.workflow !== null
      ? (manifest.workflow as Record<string, unknown>)
      : {};
  const roles: AgentRole[] = Array.isArray(workflow.roles)
    ? (workflow.roles as AgentRole[]).filter((r) => typeof r === "object" && r !== null)
    : [];
  const capabilities =
    typeof manifest.capabilities === "object" && manifest.capabilities !== null
      ? (manifest.capabilities as Record<string, unknown>)
      : {};
  const limits =
    typeof manifest.limits === "object" && manifest.limits !== null
      ? (manifest.limits as Record<string, unknown>)
      : {};

  function updateManifest(patch: Record<string, unknown>) {
    onChange(JSON.stringify({ ...manifest, ...patch }, null, 2));
  }

  function writeRoles(nextRoles: AgentRole[]) {
    // entry_role은 항상 첫 역할을 따라간다 — 사용자가 역할 이름을 바꾸거나
    // 첫 역할을 지워도 두 값이 어긋난 Manifest가 만들어지지 않는다.
    updateManifest({
      workflow: { entry_role: nextRoles[0]?.id ?? "", roles: nextRoles },
    });
  }

  function updateRole(index: number, patch: Partial<AgentRole>) {
    writeRoles(roles.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  }

  function updateCapability(key: string, value: boolean) {
    updateManifest({
      capabilities: {
        knowledge_required: false,
        mcp_allowed: false,
        ...capabilities,
        [key]: value,
      },
    });
  }

  function updateLimit(key: string, raw: string) {
    const next = { ...limits };
    // 빈 칸은 0이 아니라 "미지정"이다 — timeout 0초짜리 Agent를 조용히
    // 만들어 두지 않는다. 숫자가 아닌 입력("-", "1e" 등)도 마찬가지로
    // 미지정으로 둔다: Number()가 NaN을 만들고 JSON.stringify가 그것을
    // null로 직렬화해, 스키마가 integer를 요구하는 자리에 null이 박힌
    // Manifest가 만들어지기 때문이다.
    const parsedNumber = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsedNumber)) delete next[key];
    else next[key] = parsedNumber;
    updateManifest({ limits: next });
  }

  const knowledgeRequired = capabilities.knowledge_required === true;
  const mcpAllowed = capabilities.mcp_allowed === true;
  const roleNeedsKnowledge = roles.some((r) => r.requires_knowledge === true);
  const roleNeedsMcp = roles.some((r) => r.requires_mcp === true);
  const duplicateRoleId = roles.some((r, i) => roles.findIndex((o) => o.id === r.id) !== i);
  const emptyRoleId = roles.some((r) => !String(r.id ?? "").trim());

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div>
          <h3 className="text-body font-semibold text-text-primary">이 Agent가 할 수 있는 일</h3>
          <p className="text-caption text-text-secondary">
            Service Composer가 이 값으로 호환 여부를 판단합니다.
          </p>
        </div>
        <div className="space-y-2">
          <ToggleRow
            label="지식 검색 사용"
            hint="등록된 Knowledge를 검색해 답변 근거로 씁니다."
            checked={knowledgeRequired}
            onChange={(v) => updateCapability("knowledge_required", v)}
          />
          <ToggleRow
            label="MCP Tool 호출 허용"
            hint="읽기 전용 Tool을 호출할 수 있습니다. 실제 허용 범위는 Office Profile이 정합니다."
            checked={mcpAllowed}
            onChange={(v) => updateCapability("mcp_allowed", v)}
          />
          <ToggleRow
            label="답변 스트리밍"
            hint="답변을 생성되는 대로 화면에 흘려보냅니다."
            checked={capabilities.streaming !== false}
            onChange={(v) => updateCapability("streaming", v)}
          />
          <ToggleRow
            label="근거(Citation) 필수"
            hint="근거 문서를 찾지 못하면 답변하지 않습니다."
            checked={capabilities.citation_required === true}
            onChange={(v) => updateCapability("citation_required", v)}
          />
        </div>
        {knowledgeRequired && !roleNeedsKnowledge && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-caption text-amber-800">
            지식 검색을 쓰도록 했지만 아래 역할 중 지식이 필요하다고 표시된 것이 없습니다. 의도한
            구성이면 그대로 두어도 등록됩니다.
          </p>
        )}
        {mcpAllowed && !roleNeedsMcp && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-caption text-amber-800">
            MCP Tool 호출을 허용했지만 아래 역할 중 Tool이 필요하다고 표시된 것이 없습니다.
          </p>
        )}
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-body font-semibold text-text-primary">역할</h3>
            <p className="text-caption text-text-secondary">
              대부분의 Agent는 답변 역할 하나면 충분합니다. 첫 번째 역할이 실행 시작점
              (<code>entry_role</code>)이 됩니다.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              writeRoles([
                ...roles,
                {
                  id: `role-${roles.length + 1}`,
                  type: "answerer",
                  description: "",
                  requires_knowledge: false,
                  requires_mcp: false,
                  requires_prompt: true,
                },
              ])
            }
          >
            역할 추가
          </Button>
        </div>

        {roles.length === 0 && (
          <ErrorBanner message="역할이 하나도 없습니다. 역할 추가를 눌러 최소 하나를 만드세요." />
        )}

        {roles.map((role, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption font-semibold text-text-secondary">
                역할 {index + 1}
                {index === 0 && <span className="ml-1.5 text-brand-600">· 실행 시작점</span>}
              </span>
              {roles.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => writeRoles(roles.filter((_, i) => i !== index))}
                >
                  삭제
                </Button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="역할 이름" required>
                <input
                  value={String(role.id ?? "")}
                  onChange={(e) => updateRole(index, { id: e.target.value })}
                  placeholder="예: answerer"
                  className={inputClass}
                />
              </FormField>
              <FormField label="역할 유형" required>
                <select
                  value={String(role.type ?? "answerer")}
                  onChange={(e) => updateRole(index, { type: e.target.value })}
                  className={inputClass}
                >
                  {AGENT_ROLE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField label="역할 설명 (선택)">
              <input
                value={String(role.description ?? "")}
                onChange={(e) => updateRole(index, { description: e.target.value })}
                placeholder="예: Knowledge를 검색하고 답변을 생성한다"
                className={inputClass}
              />
            </FormField>
            <div className="space-y-2">
              <ToggleRow
                label="지식 필요"
                checked={role.requires_knowledge === true}
                onChange={(v) => updateRole(index, { requires_knowledge: v })}
              />
              <ToggleRow
                label="MCP Tool 필요"
                checked={role.requires_mcp === true}
                onChange={(v) => updateRole(index, { requires_mcp: v })}
              />
              <ToggleRow
                label="Prompt 필요"
                checked={role.requires_prompt !== false}
                onChange={(v) => updateRole(index, { requires_prompt: v })}
              />
            </div>
          </div>
        ))}

        {emptyRoleId && <ErrorBanner message="역할 이름은 비워 둘 수 없습니다." />}
        {duplicateRoleId && <ErrorBanner message="역할 이름이 중복되었습니다. 서로 다른 이름을 쓰세요." />}
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <div>
          <h3 className="text-body font-semibold text-text-primary">실행 한도 (선택)</h3>
          <p className="text-caption text-text-secondary">
            비워 두면 Runtime 기본값이 적용됩니다.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="최대 Context Token">
            <input
              type="number"
              min={0}
              value={limits.max_context_tokens === undefined ? "" : String(limits.max_context_tokens)}
              onChange={(e) => updateLimit("max_context_tokens", e.target.value)}
              placeholder="예: 8192"
              className={inputClass}
            />
          </FormField>
          <FormField label="Timeout (초)">
            <input
              type="number"
              min={1}
              value={limits.timeout_seconds === undefined ? "" : String(limits.timeout_seconds)}
              onChange={(e) => updateLimit("timeout_seconds", e.target.value)}
              placeholder="예: 60"
              className={inputClass}
            />
          </FormField>
          <FormField label="최대 MCP 호출 수">
            <input
              type="number"
              min={0}
              value={limits.max_mcp_calls === undefined ? "" : String(limits.max_mcp_calls)}
              onChange={(e) => updateLimit("max_mcp_calls", e.target.value)}
              placeholder={mcpAllowed ? "예: 3" : "0"}
              className={inputClass}
            />
          </FormField>
        </div>
      </section>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand-600"
      />
      <span className="min-w-0">
        <span className="block text-body text-text-primary">{label}</span>
        {hint && <span className="block text-caption text-text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Prompt Manifest 구조 입력. `template.file`은 3단계 파일 업로드가 이름을
 * 정확히 대조하는 값이라(스펙: "template.file에 이름이 명시된 파일") 여기서
 * 바꾸면 그 검증 대상도 함께 바뀐다 — 그래서 그 사실을 필드 옆에 적어 둔다. */
function PromptManifestFields({
  parsed,
  onChange,
}: {
  parsed: ParseResult;
  onChange: (value: string) => void;
}) {
  const manifest = parsed.ok ? parsed.value : {};
  const template =
    typeof manifest.template === "object" && manifest.template !== null
      ? (manifest.template as Record<string, unknown>)
      : {};
  const variables: PromptVariable[] = Array.isArray(manifest.variables)
    ? (manifest.variables as PromptVariable[]).filter((v) => typeof v === "object" && v !== null)
    : [];

  function updateManifest(patch: Record<string, unknown>) {
    onChange(JSON.stringify({ ...manifest, ...patch }, null, 2));
  }

  function updateTemplate(key: string, value: string) {
    updateManifest({ template: { system: "", file: "template.md", ...template, [key]: value } });
  }

  function writeVariables(next: PromptVariable[]) {
    updateManifest({ variables: next });
  }

  const duplicateName = variables.some(
    (v, i) => variables.findIndex((o) => o.name === v.name) !== i,
  );
  const emptyName = variables.some((v) => !String(v.name ?? "").trim());

  return (
    <div className="space-y-5">
      <FormField label="System Prompt 본문" required>
        <textarea
          value={String(template.system ?? "")}
          onChange={(e) => updateTemplate("system", e.target.value)}
          rows={6}
          placeholder="예: 당신은 사내 정책을 안내하는 도우미입니다. 근거 문서에 없는 내용은 추측하지 않습니다."
          className={`${inputClass} resize-y`}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Template 파일명" required>
          <input
            value={String(template.file ?? "")}
            onChange={(e) => updateTemplate("file", e.target.value)}
            placeholder="예: template.md"
            className={inputClass}
          />
          <p className="mt-1 text-caption text-text-muted">
            3단계에서 <strong>이 이름과 정확히 같은</strong> 파일을 업로드해야 합니다.
          </p>
        </FormField>
        <FormField label="언어">
          <input
            value={String(template.language ?? "ko")}
            onChange={(e) => updateTemplate("language", e.target.value)}
            placeholder="ko"
            className={inputClass}
          />
        </FormField>
      </div>

      <section className="space-y-3 border-t border-border pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-body font-semibold text-text-primary">변수</h3>
            <p className="text-caption text-text-secondary">
              Template 안에서 채워 넣을 값들입니다.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              writeVariables([
                ...variables,
                { name: "", type: "string", required: true, description: "" },
              ])
            }
          >
            변수 추가
          </Button>
        </div>

        {variables.length === 0 && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-caption text-text-secondary">
            변수가 없습니다. 고정된 문구만 쓰는 Prompt라면 비워 두어도 됩니다.
          </p>
        )}

        {variables.map((variable, index) => (
          <div key={index} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-12">
            <div className="sm:col-span-4">
              <FormField label="이름" required>
                <input
                  value={String(variable.name ?? "")}
                  onChange={(e) =>
                    writeVariables(
                      variables.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)),
                    )
                  }
                  placeholder="예: question"
                  className={inputClass}
                />
              </FormField>
            </div>
            <div className="sm:col-span-3">
              <FormField label="유형" required>
                <select
                  value={String(variable.type ?? "string")}
                  onChange={(e) =>
                    writeVariables(
                      variables.map((v, i) => (i === index ? { ...v, type: e.target.value } : v)),
                    )
                  }
                  className={inputClass}
                >
                  {PROMPT_VARIABLE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="sm:col-span-4">
              <FormField label="설명 (선택)">
                <input
                  value={String(variable.description ?? "")}
                  onChange={(e) =>
                    writeVariables(
                      variables.map((v, i) =>
                        i === index ? { ...v, description: e.target.value } : v,
                      ),
                    )
                  }
                  className={inputClass}
                />
              </FormField>
            </div>
            <div className="flex items-end justify-between gap-2 sm:col-span-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => writeVariables(variables.filter((_, i) => i !== index))}
              >
                삭제
              </Button>
            </div>
            <div className="sm:col-span-12">
              <ToggleRow
                label="필수 변수"
                checked={variable.required !== false}
                onChange={(v) =>
                  writeVariables(
                    variables.map((item, i) => (i === index ? { ...item, required: v } : item)),
                  )
                }
              />
            </div>
          </div>
        ))}

        {emptyName && <ErrorBanner message="변수 이름은 비워 둘 수 없습니다." />}
        {duplicateName && <ErrorBanner message="변수 이름이 중복되었습니다." />}
      </section>
    </div>
  );
}

function McpManifestFields({
  parsed,
  onChange,
}: {
  parsed: ParseResult;
  onChange: (value: string) => void;
}) {
  const { role } = useRole();
  const manifest = parsed.ok ? parsed.value : {};
  const guards =
    typeof manifest.execution_guards === "object" && manifest.execution_guards !== null
      ? (manifest.execution_guards as Record<string, unknown>)
      : {};

  function updateManifest(patch: Record<string, unknown>) {
    onChange(JSON.stringify({ ...manifest, ...patch }, null, 2));
  }

  function updateGuard(key: string, value: unknown) {
    updateManifest({
      execution_guards: {
        timeout_seconds: 10,
        requires_user_confirmation: false,
        ...guards,
        [key]: value,
      },
    });
  }

  const [pythonSource, setPythonSource] = useState("");
  const [conversion, setConversion] = useState<PythonSignatureConversion | null>(null);
  const [conversionState, setConversionState] = useState<"idle" | "loading" | "error">("idle");
  const [conversionError, setConversionError] = useState<ServerErrorInfo | null>(null);
  const [pythonFileName, setPythonFileName] = useState<string | null>(null);
  const [pythonFileError, setPythonFileError] = useState<string | null>(null);

  // 파일을 고르면 client-side에서 텍스트로 읽어 textarea만 채운다 — 파일
  // 자체는 어디에도 업로드/저장/실행되지 않는다. 사용자는 변환을 누르기 전
  // textarea에서 실제로 전송될 내용을 그대로 보고 수정할 수 있다.
  async function handlePythonFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ""; // 같은 파일을 다시 선택해도 onChange가 발생하도록.
    if (!file) return;

    setConversion(null);
    setConversionError(null);
    setConversionState("idle");
    setPythonFileError(null);
    setPythonFileName(null);

    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (extension !== ".py") {
      setPythonFileError(
        `.py 파일만 선택할 수 있습니다. 선택한 파일(${file.name})은 지원하지 않는 형식입니다.`
      );
      return;
    }
    if (file.size > MAX_PYTHON_FILE_BYTES) {
      setPythonFileError(
        `파일이 너무 큽니다. ${(MAX_PYTHON_FILE_BYTES / 1000).toFixed(0)}KB 이하의 .py 파일만 선택할 수 있습니다.`
      );
      return;
    }

    const text = await file.text();
    if (text.length > MAX_PYTHON_SOURCE_CHARS) {
      setPythonFileError(
        `파일 내용이 ${MAX_PYTHON_SOURCE_CHARS.toLocaleString()}자를 초과합니다. 변환할 함수 시그니처만 남겨 다시 선택해 주세요.`
      );
      return;
    }

    setPythonSource(text);
    setPythonFileName(file.name);
  }

  async function convertPythonSignature() {
    if (!pythonSource.trim() || conversionState === "loading") return;
    setConversionState("loading");
    setConversionError(null);
    setConversion(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/manifests/mcp-tool/from-python-signature`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ source: pythonSource }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setConversionState("error");
        setConversionError(extractServerError(res.status, body));
        return;
      }
      const result = body as PythonSignatureConversion;
      setConversion(result);
      setConversionState("idle");
      updateManifest({
        input_schema: result.input_schema,
        ...(typeof manifest.tool_name !== "string" || !manifest.tool_name.trim()
          ? { tool_name: result.function_name }
          : {}),
      });
    } catch {
      setConversionState("error");
      setConversionError({ message: "변환 서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요." });
    }
  }

  return (
    <div className="space-y-4">
      <FormField label="MCP 서버 연결 이름" required>
        <input
          value={typeof manifest.server_alias === "string" ? manifest.server_alias : ""}
          onChange={(e) => updateManifest({ server_alias: e.target.value })}
          placeholder="예: oracle-connector"
          className={inputClass}
        />
        <p className="mt-1 text-caption text-text-muted">Office Profile에 등록된 서버 이름과 같아야 합니다.</p>
      </FormField>

      <FormField label="Tool 호출 이름" required>
        <input
          value={typeof manifest.tool_name === "string" ? manifest.tool_name : ""}
          onChange={(e) => updateManifest({ tool_name: e.target.value })}
          placeholder="예: db_metadata.get_tables"
          className={inputClass}
        />
        <p className="mt-1 text-caption text-text-muted">영문·숫자·밑줄을 사용하고, 그룹은 점(.)으로 구분합니다.</p>
      </FormField>

      <section className="border-y border-border py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-body font-semibold text-text-primary">
              <Braces size={16} className="text-brand-600" />
              Python 함수에서 입력 형식 가져오기
            </div>
            <p className="mt-1 text-caption text-text-secondary">
              함수 시그니처만 정적으로 읽습니다. 코드는 실행·저장하지 않으며 본문과 반환 타입은 Manifest에 포함하지 않습니다.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => document.getElementById("python-signature-file-input")?.click()}>
              <FileUp size={13} />
              .py 파일 선택
            </Button>
            <input
              id="python-signature-file-input"
              type="file"
              accept=".py"
              onChange={(event) => void handlePythonFileChange(event)}
              className="hidden"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!pythonSource.trim() || conversionState === "loading"}
              onClick={() => void convertPythonSignature()}
            >
              {conversionState === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Braces size={13} />}
              {conversionState === "loading" ? "분석 중..." : "입력 형식 추출"}
            </Button>
          </div>
        </div>
        {pythonFileName && (
          <p className="mt-2 text-caption text-text-muted">
            <code>{pythonFileName}</code>에서 불러왔습니다. 아래 내용을 확인·수정한 뒤 변환하세요.
          </p>
        )}
        {pythonFileError && (
          <div className="mt-2">
            <ErrorBanner message={pythonFileError} />
          </div>
        )}
        <textarea
          value={pythonSource}
          onChange={(event) => {
            setPythonSource(event.target.value);
            setConversion(null);
            setConversionError(null);
            setConversionState("idle");
            setPythonFileName(null);
            setPythonFileError(null);
          }}
          rows={7}
          spellCheck={false}
          placeholder={'def get_tables(schema: str, limit: int = 20) -> list[str]:\n    ...'}
          aria-label="Python 함수 시그니처"
          className={`${inputClass} mt-3 resize-y font-mono text-caption`}
        />
        {conversionError && (
          <div className="mt-3">
            <ErrorBanner
              message={`${conversionError.message}${conversionError.traceId ? ` (Trace ID: ${conversionError.traceId})` : ""}`}
            />
          </div>
        )}
        {conversion && (
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <p className="text-caption font-semibold text-success">Manifest에 반영됨</p>
              <p className="mt-1 text-caption text-text-secondary">
                함수 <code>{conversion.function_name}</code> · 파라미터 {conversion.parameters.length}개
              </p>
              <ul className="mt-2 space-y-1 text-caption text-text-primary">
                {conversion.parameters.length === 0 && <li>입력 파라미터 없음</li>}
                {conversion.parameters.map((parameter) => (
                  <li key={parameter.name}>
                    <code>{parameter.name}</code> · {parameter.schema_type} · {parameter.required ? "필수" : "선택"}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-caption font-semibold text-text-muted">실행하지 않고 버림</p>
              <ul className="mt-1 space-y-1 text-caption text-text-secondary">
                <li>함수 본문 {conversion.discarded.body_statement_count}개 문장</li>
                <li>Decorator {conversion.discarded.decorator_count}개</li>
                <li>Docstring {conversion.discarded.docstring_present ? "있음" : "없음"}</li>
                <li>반환 타입 {conversion.discarded.return_annotation_present ? "있음" : "없음"}</li>
                <li>코드 실행 안 함 · 원문 저장 안 함</li>
              </ul>
            </div>
            {conversion.warnings.length > 0 && (
              <div className="sm:col-span-2 text-caption text-warning">
                {conversion.warnings.map((warning) => <p key={warning}>· {warning}</p>)}
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="응답 제한 시간">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={60}
              value={typeof guards.timeout_seconds === "number" ? guards.timeout_seconds : 10}
              onChange={(e) => updateGuard("timeout_seconds", Number(e.target.value))}
              className={inputClass}
            />
            <span className="text-body text-text-muted">초</span>
          </div>
        </FormField>
        <FormField label="사용 전 확인">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-body text-text-primary">
            <input
              type="checkbox"
              checked={guards.requires_user_confirmation === true}
              onChange={(e) => updateGuard("requires_user_confirmation", e.target.checked)}
            />
            실행 전에 사용자에게 확인
          </label>
        </FormField>
      </div>

      <div className="rounded-lg bg-success/5 px-4 py-3 text-body text-success">
        안전 정책에 따라 이 PoC에서는 읽기 전용 Tool만 등록됩니다.
      </div>
    </div>
  );
}

function ExamplePanel({
  type,
  example,
  onFill,
}: {
  type: WizardType;
  example: ExampleState;
  onFill: (manifestText: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (example.status === "loading") {
    return (
      <Card className="p-4">
        <LoadingState label="예시 Manifest 불러오는 중..." />
      </Card>
    );
  }

  if (example.status === "error") {
    return <ErrorBanner message={example.message} />;
  }

  const { data } = example;
  const pretty = JSON.stringify(data.manifest, null, 2);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-body font-semibold text-text-primary">예시 Manifest</p>
          <p className="mt-0.5 text-caption text-text-secondary">
            실제로 검증을 통과하는 fixture(<code>{data.sourceFixture}</code>)를 그대로 가져온 예시입니다. id만
            새로 발급됩니다 — 이름/설명 등 나머지 값은 자산에 맞게 직접 수정하세요.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "예시 접기" : "예시 보기"}
          </Button>
          <Button size="sm" onClick={() => onFill(pretty)}>
            이 예시로 채우기
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadTextFile(`${type}-manifest.example.json`, pretty)}
          >
            <Download size={13} />
            manifest.json
          </Button>
        </div>
      </div>
      {expanded && (
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
          {pretty}
        </pre>
      )}
    </Card>
  );
}

function StepFiles({
  type,
  files,
  onChange,
  expectedTemplateFileName,
  templateFileMatched,
  manifestParsed,
  example,
  uploadPolicyState,
  fileViolations,
}: {
  type: WizardType;
  files: File[];
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  expectedTemplateFileName: string | null;
  templateFileMatched: boolean;
  manifestParsed: boolean;
  example: ExampleState;
  uploadPolicyState: UploadPolicyState;
  fileViolations: string[];
}) {
  const exampleTemplate =
    example.status === "ok"
      ? example.data.companionFiles.find((f) => f.name === expectedTemplateFileName)
      : undefined;

  return (
    <div className="space-y-4">
      <h2 className="text-card-title font-semibold text-text-primary">파일 업로드</h2>

      {/* 파일을 고르기 "전"에 한도를 먼저 보여준다 — 다 올리고 나서 서버가
          거절하는 것을 막지는 못하지만(서버가 최종 판정), 사용자가 미리
          알고 고를 수 있게 한다. */}
      {uploadPolicyState.status === "loading" && (
        <p className="text-caption text-text-muted">업로드 한도를 확인하는 중...</p>
      )}
      {uploadPolicyState.status === "unknown" && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-caption text-warning">
          업로드 한도를 확인하지 못했습니다: {uploadPolicyState.message} 업로드 자체는 계속 진행할 수 있으며,
          최종 판정은 서버가 합니다.
        </div>
      )}
      {uploadPolicyState.status === "ok" && (
        <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
          파일 1개당 최대 {formatBytesKo(uploadPolicyState.policy.maxSingleFileBytes)} · 전체 합계 최대{" "}
          {formatBytesKo(uploadPolicyState.policy.maxTotalRequestBytes)} · 최대{" "}
          {uploadPolicyState.policy.maxFileCount}개
          {uploadPolicyState.policy.rejectedExtensions.length > 0 && (
            <>
              {" "}
              · 허용되지 않는 확장자: {uploadPolicyState.policy.rejectedExtensions.join(", ")}
            </>
          )}
        </div>
      )}

      {type === "prompt" ? (
        <div className="space-y-3">
          <p className="text-body text-text-secondary">
            {manifestParsed && expectedTemplateFileName
              ? `Manifest의 template.file에 지정된 "${expectedTemplateFileName}" 이름과 정확히 일치하는 파일을 업로드하세요.`
              : "2단계에서 Manifest JSON을 먼저 확인하면 필요한 Template 파일명이 여기에 표시됩니다."}
          </p>
          {exampleTemplate && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-white px-3 py-2.5">
              <p className="text-caption text-text-secondary">
                이름 그대로 시작하고 싶다면 예시 Template 파일을 내려받아 편집한 뒤 업로드하세요.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => downloadTextFile(exampleTemplate.name, exampleTemplate.content)}
              >
                <Download size={13} />
                {exampleTemplate.name}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-body font-medium text-success">
            <CheckCircle2 size={16} className="shrink-0" />이 유형은 별도 파일 업로드가 필요 없습니다. 아래는 건너뛰고
            바로 다음(4단계 검증)으로 진행해도 됩니다.
          </div>
          <p className="text-caption text-text-muted">
            참고 자료가 있다면 아래에 선택적으로 첨부할 수 있습니다(필수 아님).
          </p>
        </div>
      )}

      <div
        className="cursor-pointer rounded-card border-2 border-dashed border-border bg-white px-5 py-8 text-center transition-colors hover:border-brand-400"
        onClick={() => document.getElementById("wizard-file-input")?.click()}
      >
        <Upload size={28} className="mx-auto mb-2 text-text-muted" strokeWidth={1.5} />
        <div className="text-body text-text-secondary">파일을 선택하세요 (0개 이상)</div>
        {files.length > 0 && (
          <div className="mt-3 space-y-1">
            {files.map((f) => (
              <div
                key={f.name}
                className={`text-caption ${
                  type === "prompt" && expectedTemplateFileName && f.name === expectedTemplateFileName
                    ? "font-semibold text-success"
                    : "text-brand-600"
                }`}
              >
                ✓ {f.name}
              </div>
            ))}
          </div>
        )}
      </div>
      <input id="wizard-file-input" type="file" multiple onChange={onChange} className="hidden" />

      {type === "prompt" && expectedTemplateFileName && !templateFileMatched && (
        <FormField label="Template 파일" error={`"${expectedTemplateFileName}" 이름의 파일이 업로드되지 않았습니다.`}>
          <div />
        </FormField>
      )}

      {/* 파일을 고른 직후 클라이언트에서 먼저 검사한 결과 — 편의용이며 최종
          판정이 아니다. 통과해도 서버(POST /api/v1/assets)가 다시 검사하며,
          여기 통과가 서버 오류 처리를 대신하지 않는다. */}
      {fileViolations.length > 0 && (
        <div className="space-y-1">
          {fileViolations.map((v, i) => (
            <ErrorBanner key={i} message={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepValidateManifest({
  canCreate,
  roleLabel,
  parsed,
  state,
  isStale,
  onRun,
}: {
  canCreate: boolean;
  roleLabel: string;
  parsed: ParseResult;
  state: {
    status: "idle" | "loading" | "ok" | "invalid" | "error";
    errors: string[];
    validatedText: string | null;
    error?: ServerErrorInfo;
  };
  isStale: boolean;
  onRun: () => void;
}) {
  if (!canCreate) {
    return (
      <EmptyState
        icon={<Lock size={40} strokeWidth={1.5} />}
        title="이 역할에는 자산 등록 검증 권한이 없습니다."
        description={`현재 역할: ${roleLabel}. 자산 제작자(CREATOR) 또는 관리자로 전환해야 검증을 실행할 수 있습니다.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-card-title font-semibold text-text-primary">검증</h2>
      <p className="text-body text-text-secondary">
        <code>POST /api/v1/manifests/validate</code>로 아무 것도 저장하지 않고 Manifest Schema만 점검합니다.
      </p>

      {!parsed.ok && <ErrorBanner message={`검증을 실행할 수 없습니다: ${parsed.error}`} />}

      {isStale && state.validatedText !== null && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-caption text-warning">
          2단계에서 Manifest가 변경되어 이전 검증 결과는 더 이상 유효하지 않습니다. 다시 검증하세요.
        </div>
      )}

      <Button onClick={onRun} disabled={!parsed.ok || state.status === "loading"}>
        {state.status === "loading" && <Loader2 size={15} className="animate-spin" />}
        {state.status === "loading" ? "검증 중..." : "검증 실행"}
      </Button>

      {state.status === "ok" && !isStale && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-body font-semibold text-success">
          <CheckCircle2 size={16} />
          검증 통과
        </div>
      )}

      {state.status === "invalid" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body font-semibold text-danger">
            <XCircle size={16} />
            검증 실패
          </div>
          <ul className="ml-4 list-disc space-y-1 text-caption text-danger">
            {state.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {state.status === "error" && state.error && (
        <div className="space-y-1">
          {state.error.permission ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
              {state.error.message}
            </div>
          ) : (
            <ErrorBanner message={state.error.message} />
          )}
          {state.error.traceId && <p className="text-caption text-text-muted">Trace ID: {state.error.traceId}</p>}
        </div>
      )}
    </div>
  );
}

function StepSubmit({
  canCreate,
  roleLabel,
  typeLabel,
  basic,
  fileCount,
  validationPassed,
  submitState,
  onSubmit,
}: {
  canCreate: boolean;
  roleLabel: string;
  typeLabel: string;
  basic: BasicInfo;
  fileCount: number;
  validationPassed: boolean;
  submitState: {
    status: "idle" | "loading" | "success" | "error";
    result?: { assetId: string; versionId: string; version: string; status: string };
    error?: ServerErrorInfo;
  };
  onSubmit: () => void;
}) {
  if (!canCreate) {
    return (
      <EmptyState
        icon={<Lock size={40} strokeWidth={1.5} />}
        title="이 역할에는 자산 등록 권한이 없습니다."
        description={`현재 역할: ${roleLabel}. 자산 제작자(CREATOR) 또는 관리자로 전환해야 제출할 수 있습니다.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-card-title font-semibold text-text-primary">제출</h2>
      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-body">
          <dt className="text-text-secondary">유형</dt>
          <dd className="text-text-primary">{typeLabel}</dd>
          <dt className="text-text-secondary">이름</dt>
          <dd className="text-text-primary">{basic.name}</dd>
          <dt className="text-text-secondary">보안 등급</dt>
          <dd className="text-text-primary">{basic.classification}</dd>
          <dt className="text-text-secondary">첨부 파일</dt>
          <dd className="text-text-primary">{fileCount}개</dd>
        </dl>
      </Card>

      {!validationPassed && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          4단계 검증을 먼저 통과해야 제출할 수 있습니다.
        </div>
      )}

      <Button onClick={onSubmit} disabled={!validationPassed || submitState.status === "loading"} size="lg">
        {submitState.status === "loading" && <Loader2 size={16} className="animate-spin" />}
        {submitState.status === "loading" ? "제출 중..." : "초안으로 등록"}
      </Button>

      {submitState.status === "error" && submitState.error && (
        <div className="space-y-1">
          {submitState.error.permission ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
              {submitState.error.message}
            </div>
          ) : (
            <ErrorBanner message={submitState.error.message} />
          )}
          {submitState.error.schemaErrors && submitState.error.schemaErrors.length > 0 && (
            <ul className="ml-4 list-disc text-caption text-danger">
              {submitState.error.schemaErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {submitState.error.traceId && (
            <p className="text-caption text-text-muted">Trace ID: {submitState.error.traceId}</p>
          )}
        </div>
      )}
    </div>
  );
}
