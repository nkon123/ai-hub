"use client";

import { Info, Lock, MessageSquareText } from "lucide-react";
import { Badge } from "../../../_components/ui";
import type { AgentOption } from "./constants";

export function StepPrompt({ agent }: { agent: AgentOption }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Prompt 연결</h2>
        <p className="text-body text-text-secondary">
          Prompt Registry가 아직 없어(D-034) Agent별 표준 Prompt가 Role에 고정 연결됩니다. Prompt 본문은 이
          화면에서 편집할 수 없습니다 — 수정이 필요하면 새 Prompt 자산 버전을 만들어야 합니다.
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
            <MessageSquareText size={18} strokeWidth={1.75} />
          </span>
          <div className="flex-1">
            <div className="text-body font-semibold text-text-primary">{agent.prompt.name}</div>
            <div className="text-caption text-text-muted">Role: {agent.roleId} · v{agent.prompt.manifestVersion}</div>
          </div>
          <Badge tone="neutral">
            <Lock size={11} className="mr-1" />
            고정
          </Badge>
        </div>
        <p className="text-body text-text-secondary">{agent.prompt.description}</p>

        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-caption font-semibold text-text-secondary">변수 Schema</p>
          <ul className="space-y-1">
            {agent.prompt.variables.map((v) => (
              <li key={v.name} className="flex items-center gap-2 text-caption text-text-secondary">
                <code className="rounded bg-slate-100 px-1.5 py-0.5">{v.name}</code>
                {v.required && <Badge tone="warning">필수</Badge>}
                <span>{v.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-caption text-text-secondary">
        <Info size={12} className="mt-0.5 shrink-0" />
        이 Prompt는 선택한 Agent({agent.name})와 짝지어진 표준 Prompt이며 Agent를 바꾸면 자동으로 교체됩니다.
      </p>
    </div>
  );
}
