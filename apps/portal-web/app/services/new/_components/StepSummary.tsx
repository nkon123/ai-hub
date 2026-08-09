"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, Download, Info, XCircle } from "lucide-react";
import { Badge } from "../../../_components/ui";
import type { AgentOption } from "./constants";
import type { ComposerState, ValidationResult } from "./types";
import type { Draft } from "./StepValidate";

function download(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-text-muted">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

export function StepSummary({
  state,
  agent,
  draft,
  validation,
  previewRunCount,
}: {
  state: ComposerState;
  agent: AgentOption;
  draft: Draft;
  validation: ValidationResult | null;
  previewRunCount: number;
}) {
  const [copied, setCopied] = useState(false);
  const manifestJson = JSON.stringify(draft.serviceDefinition, null, 2);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(manifestJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">요약·저장</h2>
        <p className="text-body text-text-secondary">
          저장된 Service Definition은 서버가 반환한 그대로이며(단계 8), 아래 JSON은 실제 저장 내용과 동일합니다.
        </p>
      </div>

      <div className="rounded-card border border-success/30 bg-success/5 p-4">
        <div className="flex items-center gap-2 text-body font-semibold text-success">
          <CheckCircle2 size={16} />
          초안이 저장되었습니다.
        </div>
        <dl className="mt-2 space-y-1 text-body text-text-secondary">
          <SummaryRow label="Service ID" value={<span className="font-mono text-caption">{draft.serviceId}</span>} />
          <SummaryRow label="Version ID" value={<span className="font-mono text-caption">{draft.serviceVersionId}</span>} />
          <SummaryRow label="상태" value={<Badge tone="neutral">{draft.status}</Badge>} />
        </dl>
      </div>

      <div className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h3 className="mb-3 text-card-title font-semibold text-text-primary">구성 요약</h3>
        <dl className="space-y-1.5 text-body text-text-secondary">
          <SummaryRow label="이름" value={state.basicInfo.name} />
          <SummaryRow label="보안등급" value={state.basicInfo.classification} />
          <SummaryRow label="Agent" value={`${agent.name} (v${agent.manifestVersion})`} />
          <SummaryRow
            label="Knowledge"
            value={
              state.knowledgeBindings.length === 0
                ? "없음"
                : state.knowledgeBindings.map((b) => `${b.knowledgeAssetName} v${b.knowledgeVersionLabel}`).join(", ")
            }
          />
          <SummaryRow label="MCP Tool" value="연결 없음 (등록된 MCP Tool 자산 없음)" />
          <SummaryRow label="Prompt" value={agent.prompt.name} />
          <SummaryRow label="모델 Alias" value={state.modelPolicy.modelAlias} />
          <SummaryRow
            label="구성 검증"
            value={
              validation ? (
                <span className={`inline-flex items-center gap-1 ${validation.passed ? "text-success" : "text-danger"}`}>
                  {validation.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {validation.passed ? "통과" : "실패"} ({validation.checks.filter((c) => c.passed).length}/
                  {validation.checks.length})
                </span>
              ) : (
                "검증되지 않음"
              )
            }
          />
          <SummaryRow label="Preview 실행" value={`${previewRunCount}회 완료`} />
        </dl>
      </div>

      <div className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-card-title font-semibold text-text-primary">Service Definition (읽기 전용)</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="text-caption font-medium text-brand-600 hover:underline"
            >
              {copied ? "복사됨" : "복사"}
            </button>
            <button
              type="button"
              onClick={() => download(`${state.basicInfo.name || "service"}.json`, manifestJson, "application/json")}
              className="flex items-center gap-1 text-caption font-medium text-brand-600 hover:underline"
            >
              <Download size={12} />
              JSON 다운로드
            </button>
          </div>
        </div>
        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{manifestJson}</code>
        </pre>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 px-4 py-3 text-body text-info">
        <Info size={15} className="mt-0.5 shrink-0" />
        <span>
          검토 요청(Submit) 및 Hosted URL 게시는 이 릴리스 범위에 포함되지 않습니다 (ServiceVersion 자체의
          검토·승인 Workflow가 아직 구현되지 않음 — open-decisions.md D-041/D-044 참고). Knowledge 챗봇을 바로
          게시하려면 <a href="/chatbots/new" className="underline">챗봇 빠른 만들기</a>를, 기존 게시 현황은{" "}
          <a href="/deployments" className="underline">게시 관리</a>를 확인하세요.
        </span>
      </div>
    </div>
  );
}
