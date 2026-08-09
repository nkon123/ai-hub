"use client";

import { Bot, Check, Clock, Layers, ShieldCheck, Wrench } from "lucide-react";
import { Badge, Card } from "../../../_components/ui";
import { AGENT_OPTIONS } from "./constants";
import type { AgentProfileId } from "./types";

export function StepAgent({
  value,
  onChange,
}: {
  value: AgentProfileId | null;
  onChange: (next: AgentProfileId) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Agent 선택</h2>
        <p className="text-body text-text-secondary">
          이 PoC는 Agent/Prompt Registry가 아직 없어(open-decisions.md D-034), 등록된 두 개의 표준 Agent 중
          하나를 선택합니다. 한 Service에는 주 Agent 1개만 허용됩니다.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {AGENT_OPTIONS.map((agent) => {
          const selected = value === agent.id;
          return (
            <Card
              key={agent.id}
              onClick={() => onChange(agent.id)}
              className={`flex flex-col gap-3 px-4 py-4 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Bot size={18} strokeWidth={1.75} />
                  </span>
                  <div>
                    <div className="text-body font-semibold text-text-primary">{agent.name}</div>
                    <div className="text-caption text-text-muted">v{agent.manifestVersion}</div>
                  </div>
                </div>
                {selected && <Badge tone="success"><Check size={11} className="mr-0.5" />선택됨</Badge>}
              </div>

              <p className="text-body text-text-secondary">{agent.description}</p>

              <div className="flex flex-wrap gap-1.5">
                <Badge tone={agent.knowledgeRequired ? "brand" : "neutral"}>
                  <Layers size={11} className="mr-1" />
                  Knowledge {agent.knowledgeRequired ? "필수" : "선택"}
                </Badge>
                <Badge tone={agent.mcpAllowed ? "brand" : "neutral"}>
                  <Wrench size={11} className="mr-1" />
                  MCP Tool {agent.mcpAllowed ? "허용" : "미지원"}
                </Badge>
                <Badge tone="neutral">
                  <Clock size={11} className="mr-1" />
                  Timeout {agent.timeoutSeconds}s
                </Badge>
                <Badge tone="neutral">
                  <ShieldCheck size={11} className="mr-1" />
                  최대 MCP 호출 {agent.maxMcpCalls}회
                </Badge>
              </div>

              <div className="rounded-lg bg-slate-50 px-3 py-2 text-caption text-text-secondary">
                연결될 표준 Prompt: <span className="font-medium text-text-primary">{agent.prompt.name}</span>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
