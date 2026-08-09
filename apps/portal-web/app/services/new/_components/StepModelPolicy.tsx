"use client";

import { Info, Lock } from "lucide-react";
import { Badge, FormField, inputClass } from "../../../_components/ui";
import { MODEL_ALIAS } from "./constants";
import type { ModelPolicyDraft } from "./types";

export function StepModelPolicy({
  value,
  onChange,
}: {
  value: ModelPolicyDraft;
  onChange: (next: ModelPolicyDraft) => void;
}) {
  const tokenError =
    value.maxContextTokens < 1
      ? "1 이상이어야 합니다."
      : value.maxContextTokens > MODEL_ALIAS.maxContextTokens
      ? `${MODEL_ALIAS.alias}의 최대 Context(${MODEL_ALIAS.maxContextTokens.toLocaleString()} tokens)를 초과할 수 없습니다.`
      : undefined;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">모델 정책</h2>
        <p className="text-body text-text-secondary">
          Service Definition에는 실제 Endpoint나 Secret이 아니라 Office Profile의 모델 Alias만 저장됩니다.
        </p>
      </div>

      <FormField label="Chat Model Alias" required>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-slate-50 px-3 py-2.5">
          <Lock size={14} className="text-text-muted" />
          <span className="text-body font-medium text-text-primary">{MODEL_ALIAS.alias}</span>
          <Badge tone="neutral">{MODEL_ALIAS.provider}</Badge>
          <span className="text-caption text-text-muted">{MODEL_ALIAS.modelId}</span>
        </div>
        <p className="mt-1.5 flex items-start gap-1.5 text-caption text-text-secondary">
          <Info size={12} className="mt-0.5 shrink-0" />
          현재 Office Profile(miracom-default)에 등록된 Chat Model Alias가 1개뿐이라 선택 없이 고정됩니다. 최대
          Context: {MODEL_ALIAS.maxContextTokens.toLocaleString()} tokens.
        </p>
      </FormField>

      <FormField label="모델 Fallback 허용">
        <label className="flex items-center gap-2 text-body text-text-muted">
          <input type="checkbox" checked={false} disabled className="h-4 w-4 rounded border-slate-300" />
          대체 모델로 자동 전환 허용 (비활성화됨)
        </label>
        <p className="mt-1.5 text-caption text-text-secondary">
          대체할 다른 Chat Model Alias가 Office Profile에 없어 Fallback을 켤 대상이 없습니다.
        </p>
      </FormField>

      <FormField label="최대 Context Token" required error={tokenError}>
        <input
          type="number"
          value={value.maxContextTokens}
          onChange={(e) => onChange({ ...value, modelAlias: MODEL_ALIAS.alias, maxContextTokens: Number(e.target.value) })}
          min={1}
          max={MODEL_ALIAS.maxContextTokens}
          className={`${inputClass} w-40`}
        />
        <p className="mt-1.5 text-caption text-text-secondary">
          이 서비스 실행에 사용할 최대 Context Token 수입니다. 단계 7(제한·보안)의 값과 별개로 모델 정책에
          저장됩니다.
        </p>
      </FormField>
    </div>
  );
}
