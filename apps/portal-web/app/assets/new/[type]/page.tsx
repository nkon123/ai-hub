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
  CheckCircle2,
  ChevronRight,
  FileEdit,
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
  PageHeader,
  inputClass,
} from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { ASSET_TYPE_LABEL } from "../../../_components/review-meta";

// Permission.ASSET_CREATE holders (security_policy.roles.ROLE_PERMISSIONS) —
// required for both POST /api/v1/manifests/validate and POST /api/v1/assets.
const ASSET_CREATE_ROLES = new Set(["CREATOR", "ADMIN"]);

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
  { id: 2, label: "Manifest 입력" },
  { id: 3, label: "파일 업로드" },
  { id: 4, label: "검증" },
  { id: 5, label: "제출" },
] as const;

const TYPE_FIELD_HINTS: Record<WizardType, string[]> = {
  agent: [
    "workflow.entry_role — 시작 Role id",
    "workflow.roles[] — Role 목록(각 id/type 필수)",
    "capabilities.knowledge_required — Knowledge 필요 여부",
    "capabilities.mcp_allowed — MCP 호출 허용 여부",
  ],
  prompt: [
    "template.system — System Prompt 본문",
    "template.file — 3단계에서 업로드할 Template 파일명",
    "variables[] — 각 항목은 name/type 필수",
  ],
  mcp_tool: [
    "server_alias — Office Profile에 등록된 MCP 서버 식별자",
    "tool_name — 식별자 형식(예: db_metadata.get_tables)",
    "risk_level — PoC 정책상 \"READ_ONLY\"만 허용",
    "input_schema — Tool 입력 파라미터 JSON Schema",
  ],
};

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
  };
}

type ParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

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
        return manifestText.trim().length > 0;
      case 3:
        return templateFileMatched;
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
        return "Manifest JSON을 입력하세요.";
      case 3:
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
}: {
  type: WizardType;
  manifestText: string;
  onChange: (v: string) => void;
  onReset: () => void;
  parsed: ParseResult;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-card-title font-semibold text-text-primary">Manifest 입력</h2>
          <p className="mt-1 text-body text-text-secondary">
            기본정보에서 입력한 값이 자동으로 채워져 있습니다. 아래 유형별 필드를 채우거나 수정하세요.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onReset}>
          <RotateCcw size={13} />
          기본값으로 재설정
        </Button>
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
        <p className="mb-1 font-medium text-text-primary">이 유형에서 채워야 하는 필드</p>
        <ul className="ml-4 list-disc space-y-0.5">
          {TYPE_FIELD_HINTS[type].map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>

      {manifestText.trim().length === 0 && (
        <EmptyState
          icon={<FileEdit size={32} strokeWidth={1.5} />}
          title="Manifest가 비어 있습니다."
          description="기본값으로 재설정을 눌러 시작하세요."
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

function StepFiles({
  type,
  files,
  onChange,
  expectedTemplateFileName,
  templateFileMatched,
  manifestParsed,
}: {
  type: WizardType;
  files: File[];
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  expectedTemplateFileName: string | null;
  templateFileMatched: boolean;
  manifestParsed: boolean;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-card-title font-semibold text-text-primary">파일 업로드</h2>
      {type === "prompt" ? (
        <p className="text-body text-text-secondary">
          {manifestParsed && expectedTemplateFileName
            ? `Manifest의 template.file에 지정된 "${expectedTemplateFileName}" 이름과 정확히 일치하는 파일을 업로드하세요.`
            : "2단계에서 Manifest JSON을 먼저 확인하면 필요한 Template 파일명이 여기에 표시됩니다."}
        </p>
      ) : (
        <p className="text-body text-text-secondary">
          이 유형은 파일 업로드가 필수가 아닙니다. 참고 자료가 있다면 선택적으로 첨부할 수 있습니다.
        </p>
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
