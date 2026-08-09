"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button, PageHeader } from "../../_components/ui";
import { useRole } from "../../_components/role-context";
import { StepBasicInfo } from "./_components/StepBasicInfo";
import { StepModelPolicy } from "./_components/StepModelPolicy";
import { StepAgent } from "./_components/StepAgent";
import { StepKnowledge } from "./_components/StepKnowledge";
import { StepMcp } from "./_components/StepMcp";
import { StepPrompt } from "./_components/StepPrompt";
import { StepLimits } from "./_components/StepLimits";
import { StepValidate, type Draft } from "./_components/StepValidate";
import { StepPreview } from "./_components/StepPreview";
import { StepSummary } from "./_components/StepSummary";
import { buildServiceDefinition, agentProfileFromId } from "./_components/buildServiceDefinition";
import { DEFAULT_CLASSIFICATION, MODEL_ALIAS, OFFICE_PROFILE_ORG } from "./_components/constants";
import type { ComposerState, ValidationResult } from "./_components/types";

// Active, navigable steps (mirror docs/implementation-spec/08-service-composer.md §4,
// minus the two schema-less steps — see PLACEHOLDER_STEPS below for why).
const STEPS = [
  { id: 1, label: "기본정보" },
  { id: 2, label: "모델 정책" },
  { id: 3, label: "Agent 선택" },
  { id: 4, label: "Knowledge 연결" },
  { id: 5, label: "MCP Tool 연결" },
  { id: 6, label: "Prompt 연결" },
  { id: 7, label: "제한·보안" },
  { id: 8, label: "구성 검증" },
  { id: 9, label: "Preview 테스트" },
  { id: 10, label: "요약·저장" },
] as const;

// docs/implementation-spec/08-service-composer.md §5 also lists 단계 7 (입력 정의)
// and 단계 8 (출력 정의) between Prompt 연결 and 제한·보안, but
// packages/schemas/manifests/service-definition.schema.json has NO field to store
// either one (no input_schema/output_schema/form definition anywhere in the
// schema). Per instruction, rather than silently drop user input or invent
// schema fields, these are shown — disabled, with the reason — in their spec
// position, exactly like nav-links.tsx's PLANNED_LINKS pattern.
const PLACEHOLDER_STEPS = [
  { label: "입력 정의", reason: "Service Definition Schema에 입력 Form 필드가 없어 지원되지 않습니다." },
  { label: "출력 정의", reason: "Service Definition Schema에 출력 형식 필드가 없어 지원되지 않습니다." },
];

const DEFAULT_STATE: ComposerState = {
  basicInfo: { name: "", description: "", tags: [], classification: DEFAULT_CLASSIFICATION, ownerTeam: "" },
  modelPolicy: { modelAlias: MODEL_ALIAS.alias, fallbackAllowed: false, maxContextTokens: 8192 },
  agentId: null,
  knowledgeBindings: [],
  limits: { timeoutSeconds: 60, maxMcpCalls: 0, maxContextTokens: 8192, maxInputBytes: 1_048_576, auditLevel: "standard" },
  targetUsers: { orgs: [], sites: [], roles: [] },
};

export default function NewServicePage() {
  const { role } = useRole();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<ComposerState>(DEFAULT_STATE);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [previewRunCount, setPreviewRunCount] = useState(0);

  const agent = state.agentId ? agentProfileFromId(state.agentId) : null;

  // Recomputed on every render from current wizard state — this is the
  // Service Definition that WOULD be saved right now. StepValidate compares
  // its JSON against the last-saved draft's snapshot to detect staleness
  // (spec §4: "필수 선행정보가 바뀌면 이후 단계의 영향을 표시하고 재검증한다").
  const currentDefinition = useMemo(() => {
    if (!agent) return null;
    try {
      return buildServiceDefinition(state, OFFICE_PROFILE_ORG, role.userId);
    } catch {
      return null;
    }
  }, [state, agent, role.userId]);

  const currentDefinitionJson = currentDefinition ? JSON.stringify(currentDefinition) : null;
  const validationIsCurrent =
    validation !== null && draft !== null && draft.definitionSnapshot === currentDefinitionJson;

  function updateState<K extends keyof ComposerState>(key: K, value: ComposerState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function goNext() {
    if (step === 1) {
      if (!state.basicInfo.name.trim()) {
        setNameError("서비스 이름을 입력하세요.");
        return;
      }
      setNameError(undefined);
    }
    setStep((s) => Math.min(s + 1, STEPS.length));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  const canGoNext = (() => {
    switch (step) {
      case 1:
        return state.basicInfo.name.trim().length > 0;
      case 2:
        return state.modelPolicy.maxContextTokens >= 1 && state.modelPolicy.maxContextTokens <= MODEL_ALIAS.maxContextTokens;
      case 3:
        return state.agentId !== null;
      case 4:
        return state.knowledgeBindings.length >= 1;
      case 7:
        return state.limits.timeoutSeconds >= 1;
      case 8:
        return validationIsCurrent && (validation?.passed ?? false);
      default:
        return true;
    }
  })();

  const nextDisabledReason = (() => {
    if (canGoNext) return undefined;
    switch (step) {
      case 1:
        return "서비스 이름을 입력하세요.";
      case 2:
        return "최대 Context Token 값을 확인하세요.";
      case 3:
        return "Agent를 선택하세요.";
      case 4:
        return "Knowledge를 1개 이상 연결하세요.";
      case 7:
        return "Timeout은 1초 이상이어야 합니다.";
      case 8:
        return "구성 검증을 통과해야 다음 단계로 진행할 수 있습니다.";
      default:
        return undefined;
    }
  })();

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="AI Service Composer"
        description="승인된 자산을 단계별로 선택해 실행 가능한 AI Service를 구성합니다. Canvas나 코드 편집 없이 Form으로만 구성합니다."
      />

      <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5 text-caption text-warning">
        이 마법사는 단계별 자동 저장(Draft Autosave)을 지원하지 않습니다. 새로고침하거나 페이지를 벗어나면
        입력한 내용이 사라집니다 — 구성 검증(단계 8)에서 서버에 저장한 이후부터는 그 시점의 내용이 서버에
        남습니다.
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2">
        {STEPS.map((s, idx) => (
          <div key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={s.id > step}
              onClick={() => s.id <= step && setStep(s.id)}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                step === s.id ? "bg-brand-600 text-white" : step > s.id ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-text-muted"
              }`}
            >
              {s.id}
            </button>
            <span className={`text-caption ${step === s.id ? "font-semibold text-text-primary" : "text-text-muted"}`}>
              {s.label}
            </span>
            <ChevronRight size={12} className="text-slate-300" />
            {/* 입력 정의/출력 정의 render inline right after Prompt 연결 (spec position),
                permanently disabled — see PLACEHOLDER_STEPS docstring above. */}
            {s.id === 6 &&
              PLACEHOLDER_STEPS.map((p) => (
                <div key={p.label} className="flex items-center gap-2" title={p.reason}>
                  <span className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-full bg-slate-50 text-xs text-slate-300">
                    –
                  </span>
                  <span className="text-caption text-slate-400">
                    {p.label} <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">미지원</span>
                  </span>
                  {idx < STEPS.length - 1 && <ChevronRight size={12} className="text-slate-300" />}
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="rounded-card border border-border bg-slate-50/50 p-6">
        {step === 1 && (
          <StepBasicInfo
            value={state.basicInfo}
            onChange={(v) => updateState("basicInfo", v)}
            ownerOrg={OFFICE_PROFILE_ORG}
            creatorId={role.userId}
            nameError={nameError}
          />
        )}

        {step === 2 && <StepModelPolicy value={state.modelPolicy} onChange={(v) => updateState("modelPolicy", v)} />}

        {step === 3 && <StepAgent value={state.agentId} onChange={(v) => updateState("agentId", v)} />}

        {step === 4 && agent && (
          <StepKnowledge
            serviceClassification={state.basicInfo.classification}
            bindings={state.knowledgeBindings}
            onChange={(v) => updateState("knowledgeBindings", v)}
          />
        )}

        {step === 5 && agent && <StepMcp agent={agent} />}

        {step === 6 && agent && <StepPrompt agent={agent} />}

        {step === 7 && agent && (
          <StepLimits
            limits={state.limits}
            onLimitsChange={(v) => updateState("limits", v)}
            targetUsers={state.targetUsers}
            onTargetUsersChange={(v) => updateState("targetUsers", v)}
            agentMaxMcpCalls={agent.maxMcpCalls}
          />
        )}

        {step === 8 && currentDefinition && (
          <StepValidate
            serviceName={state.basicInfo.name}
            definition={currentDefinition}
            draft={draft}
            validation={validationIsCurrent ? validation : null}
            onDraftChange={setDraft}
            onValidationChange={setValidation}
          />
        )}

        {step === 9 && draft && agent && (
          <StepPreview
            serviceVersionId={draft.serviceVersionId}
            agentId={agent.id}
            knowledgeBindings={state.knowledgeBindings}
            onRunCompleted={() => setPreviewRunCount((c) => c + 1)}
          />
        )}

        {step === 10 && draft && agent && (
          <StepSummary state={state} agent={agent} draft={draft} validation={validation} previewRunCount={previewRunCount} />
        )}

        <div className="mt-6 flex items-end justify-between border-t border-border pt-5">
          <Button variant="secondary" onClick={goBack} disabled={step === 1}>
            이전
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
