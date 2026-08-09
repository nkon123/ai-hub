"use client";

import { Plus, X } from "lucide-react";
import { Button, FormField, inputClass } from "../../../_components/ui";
import { CLASSIFICATIONS, CLASSIFICATION_LABEL } from "./types";
import type { BasicInfo } from "./types";

const NAME_MAX = 128;
const DESCRIPTION_MAX = 1024;

export function StepBasicInfo({
  value,
  onChange,
  ownerOrg,
  creatorId,
  nameError,
}: {
  value: BasicInfo;
  onChange: (next: BasicInfo) => void;
  ownerOrg: string;
  creatorId: string;
  nameError?: string;
}) {
  function addTag() {
    onChange({ ...value, tags: [...value.tags, ""] });
  }
  function updateTag(idx: number, v: string) {
    const next = [...value.tags];
    next[idx] = v;
    onChange({ ...value, tags: next });
  }
  function removeTag(idx: number) {
    onChange({ ...value, tags: value.tags.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">기본정보</h2>
        <p className="text-body text-text-secondary">
          이 서비스로 사용자가 어떤 일을 완료하는지 업무 목적 중심으로 작성하세요.
        </p>
      </div>

      <FormField label="서비스 이름" required error={nameError}>
        <input
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value.slice(0, NAME_MAX) })}
          placeholder="예: Nexacro 소스 분석 서비스"
          className={inputClass}
        />
        <p className="mt-1 text-caption text-text-muted">{value.name.length}/{NAME_MAX}자</p>
      </FormField>

      <FormField label="설명 (목적)">
        <textarea
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value.slice(0, DESCRIPTION_MAX) })}
          rows={3}
          placeholder="이 서비스가 어떤 업무 결과를 만들어 내는지 설명하세요."
          className={`${inputClass} resize-y`}
        />
        <p className="mt-1 text-caption text-text-muted">
          {value.description.length}/{DESCRIPTION_MAX}자
        </p>
      </FormField>

      <FormField label="태그">
        <div className="space-y-2">
          {value.tags.length === 0 && (
            <p className="text-caption text-text-muted">태그가 없습니다. 검색을 돕는 키워드를 추가하세요.</p>
          )}
          {value.tags.map((t, idx) => (
            <div key={idx} className="flex gap-2">
              <input
                value={t}
                onChange={(e) => updateTag(idx, e.target.value)}
                placeholder={`태그 ${idx + 1}`}
                className={inputClass}
              />
              <Button variant="secondary" size="sm" type="button" onClick={() => removeTag(idx)} aria-label="태그 삭제">
                <X size={14} />
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" type="button" onClick={addTag}>
            <Plus size={14} />
            태그 추가
          </Button>
        </div>
      </FormField>

      <FormField label="보안등급" required>
        <select
          value={value.classification}
          onChange={(e) => onChange({ ...value, classification: e.target.value as BasicInfo["classification"] })}
          className={`${inputClass} w-auto`}
        >
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {CLASSIFICATION_LABEL[c]}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-caption text-text-secondary">
          이후 단계에서 이 등급보다 높은 보안등급의 Knowledge를 연결하면 안내 문구가 표시됩니다.
        </p>
      </FormField>

      <FormField label="담당 팀 (선택)">
        <input
          value={value.ownerTeam}
          onChange={(e) => onChange({ ...value, ownerTeam: e.target.value })}
          placeholder="예: hr, platform"
          className={inputClass}
        />
      </FormField>

      <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
        소유 조직: <span className="font-medium text-text-primary">{ownerOrg}</span> · 주 담당자:{" "}
        <span className="font-medium text-text-primary">{creatorId}</span> (현재 로그인한 역할 기준, 변경 불가)
      </div>
    </div>
  );
}
