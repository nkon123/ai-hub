"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button, PageHeader } from "../../_components/ui";
import { StepKnowledge } from "./_components/StepKnowledge";
import { StepSettings } from "./_components/StepSettings";
import { StepPreview } from "./_components/StepPreview";
import { StepPublish } from "./_components/StepPublish";
import type { ChatbotSettings, SelectedKnowledge } from "./_components/types";

const STEPS = [
  { id: 1, label: "지식 선택" },
  { id: 2, label: "챗봇 설정" },
  { id: 3, label: "Preview 대화" },
  { id: 4, label: "게시" },
] as const;

const DEFAULT_SETTINGS: ChatbotSettings = {
  name: "",
  welcomeMessage: "",
  suggestedQuestions: [],
  showCitations: true,
};

export default function NewChatbotPage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedKnowledge, setSelectedKnowledge] = useState<SelectedKnowledge | null>(null);
  const [settings, setSettings] = useState<ChatbotSettings>(DEFAULT_SETTINGS);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  // 게시 Gate(spec §6.5): Preview 대화가 1회 이상 완료되어야 게시 단계로 진행할 수 있다.
  const [previewCompletedOnce, setPreviewCompletedOnce] = useState(false);

  function handleNextFromStep1() {
    if (!selectedKnowledge) return;
    setStep(2);
  }

  function handleNextFromStep2() {
    if (!settings.name.trim()) {
      setNameError("챗봇 이름을 입력하세요.");
      return;
    }
    setNameError(undefined);
    setStep(3);
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Knowledge 챗봇 만들기"
        description="등록된 Knowledge로 챗봇을 구성하고 Preview 대화로 답변 품질을 확인합니다. 이 화면은 저장 없이 미리보기만 제공합니다."
      />

      <div className="mb-6 flex items-center gap-2">
        {STEPS.map((s, idx) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                step === s.id
                  ? "bg-brand-600 text-white"
                  : step > s.id
                  ? "bg-brand-100 text-brand-700"
                  : "bg-slate-100 text-text-muted"
              }`}
            >
              {s.id}
            </div>
            <span
              className={`text-body ${step === s.id ? "font-semibold text-text-primary" : "text-text-muted"}`}
            >
              {s.label}
            </span>
            {idx < STEPS.length - 1 && <ChevronRight size={14} className="text-slate-300" />}
          </div>
        ))}
      </div>

      <div className="rounded-card border border-border bg-slate-50/50 p-6">
        {step === 1 && <StepKnowledge selected={selectedKnowledge} onSelect={setSelectedKnowledge} />}

        {step === 2 && (
          <StepSettings settings={settings} onChange={setSettings} nameError={nameError} />
        )}

        {step === 3 && selectedKnowledge && (
          <StepPreview
            selected={selectedKnowledge}
            settings={settings}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            canAdvance={previewCompletedOnce}
            onRunCompleted={() => setPreviewCompletedOnce(true)}
          />
        )}

        {step === 4 && selectedKnowledge && (
          <StepPublish selected={selectedKnowledge} settings={settings} onBack={() => setStep(3)} />
        )}

        {step !== 3 && step !== 4 && (
          <div className="mt-6 flex justify-between border-t border-border pt-5">
            <Button
              variant="secondary"
              onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s))}
              disabled={step === 1}
            >
              이전
            </Button>
            {step === 1 && (
              <Button onClick={handleNextFromStep1} disabled={!selectedKnowledge}>
                다음
              </Button>
            )}
            {step === 2 && <Button onClick={handleNextFromStep2}>다음</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
