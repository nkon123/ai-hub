"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button, FormField, inputClass } from "../../../_components/ui";
import type { ChatbotSettings } from "./types";

const MAX_SUGGESTED_QUESTIONS = 5;

export function StepSettings({
  settings,
  onChange,
  nameError,
}: {
  settings: ChatbotSettings;
  onChange: (next: ChatbotSettings) => void;
  nameError?: string;
}) {
  function updateQuestion(index: number, value: string) {
    const next = [...settings.suggestedQuestions];
    next[index] = value;
    onChange({ ...settings, suggestedQuestions: next });
  }

  function addQuestion() {
    if (settings.suggestedQuestions.length >= MAX_SUGGESTED_QUESTIONS) return;
    onChange({ ...settings, suggestedQuestions: [...settings.suggestedQuestions, ""] });
  }

  function removeQuestion(index: number) {
    onChange({
      ...settings,
      suggestedQuestions: settings.suggestedQuestions.filter((_, i) => i !== index),
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">챗봇 설정</h2>
        <p className="text-body text-text-secondary">
          Preview 대화에서 사용할 챗봇의 기본 정보를 입력하세요. 이 설정은 저장되지 않으며 현재 화면에서만
          사용됩니다.
        </p>
      </div>

      <FormField label="이름" required error={nameError}>
        <input
          value={settings.name}
          onChange={(e) => onChange({ ...settings, name: e.target.value })}
          placeholder="예: HR 정책 안내 챗봇"
          className={inputClass}
        />
      </FormField>

      <FormField label="환영 문구">
        <textarea
          value={settings.welcomeMessage}
          onChange={(e) => onChange({ ...settings, welcomeMessage: e.target.value })}
          rows={2}
          placeholder="예: 안녕하세요! 무엇을 도와드릴까요?"
          className={`${inputClass} resize-y`}
        />
      </FormField>

      <FormField label={`추천 질문 (최대 ${MAX_SUGGESTED_QUESTIONS}개)`}>
        <div className="space-y-2">
          {settings.suggestedQuestions.length === 0 && (
            <p className="text-caption text-text-muted">등록된 추천 질문이 없습니다. 필요하면 추가하세요.</p>
          )}
          {settings.suggestedQuestions.map((q, idx) => (
            <div key={idx} className="flex gap-2">
              <input
                value={q}
                onChange={(e) => updateQuestion(idx, e.target.value)}
                placeholder={`추천 질문 ${idx + 1}`}
                className={inputClass}
              />
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => removeQuestion(idx)}
                aria-label="추천 질문 삭제"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={addQuestion}
              disabled={settings.suggestedQuestions.length >= MAX_SUGGESTED_QUESTIONS}
            >
              <Plus size={14} />
              추가
            </Button>
            {settings.suggestedQuestions.length >= MAX_SUGGESTED_QUESTIONS && (
              <span className="text-caption text-text-muted">
                최대 {MAX_SUGGESTED_QUESTIONS}개까지 추가할 수 있습니다.
              </span>
            )}
          </div>
        </div>
      </FormField>

      <FormField label="Citation 표시">
        <label className="flex items-center gap-2 text-body text-text-secondary">
          <input
            type="checkbox"
            checked={settings.showCitations}
            onChange={(e) => onChange({ ...settings, showCitations: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          답변에 근거 자료(Citation)를 함께 표시합니다.
        </label>
      </FormField>
    </div>
  );
}
