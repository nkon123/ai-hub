"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Square } from "lucide-react";
import { Button, ErrorBanner, FormField, inputClass } from "../../../_components/ui";
import type { AgentProfileId } from "./types";
import type { KnowledgeBindingDraft, PreviewMessage, Citation } from "./types";

// Fixed agent-runtime contract (services/agent-runtime, port 8100), same pattern as
// app/chatbots/new/_components/StepPreview.tsx. No Authorization header: agent-runtime
// has no auth in this PoC, and EventSource cannot send custom headers anyway.
const AGENT_RUNTIME_BASE = process.env.NEXT_PUBLIC_AGENT_RUNTIME_BASE ?? "http://localhost:8100";

interface RunCreatedResponse {
  id: string;
  status: string;
  trace_id: string;
  created_at: string;
}

function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const seen = new Set(existing.map((c) => c.chunk_id));
  const extra = incoming.filter((c) => !seen.has(c.chunk_id));
  return [...existing, ...extra];
}

function CitationCard({ citation }: { citation: Citation }) {
  const excerpt =
    citation.excerpt && citation.excerpt.length > 160 ? `${citation.excerpt.slice(0, 160)}…` : citation.excerpt;
  return (
    <div className="rounded-lg border border-border bg-slate-50 px-3 py-2 text-xs">
      <div className="font-semibold text-text-secondary">
        {citation.document_title || citation.document_path}
        {citation.section && <span className="font-normal text-text-secondary"> · {citation.section}</span>}
        {citation.page > 0 && <span className="font-normal text-text-muted"> · p.{citation.page}</span>}
      </div>
      {excerpt && <p className="mt-1 text-text-secondary">{excerpt}</p>}
    </div>
  );
}

export function StepPreview({
  serviceVersionId,
  agentId,
  knowledgeBindings,
  onRunCompleted,
}: {
  serviceVersionId: string;
  agentId: AgentProfileId;
  knowledgeBindings: KnowledgeBindingDraft[];
  onRunCompleted: () => void;
}) {
  const [targetVersionId, setTargetVersionId] = useState(knowledgeBindings[0]?.knowledgeVersionId ?? "");
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (runIdRef.current) {
        fetch(`${AGENT_RUNTIME_BASE}/local/v1/runs/${runIdRef.current}/cancel`, { method: "POST" }).catch(() => {});
        runIdRef.current = null;
      }
    };
  }, []);

  function updateMessage(id: string, patch: Partial<PreviewMessage>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function finishRun() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    runIdRef.current = null;
    setIsRunning(false);
  }

  function openEventStream(runId: string, messageId: string) {
    const es = new EventSource(`${AGENT_RUNTIME_BASE}/local/v1/runs/${runId}/events`);
    eventSourceRef.current = es;

    es.addEventListener("citation.added", (evt) => {
      try {
        const citation: Citation = JSON.parse((evt as MessageEvent).data);
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, citations: [...m.citations, citation] } : m))
        );
      } catch {
        // ignore malformed event payload
      }
    });

    es.addEventListener("answer.delta", (evt) => {
      try {
        const data: { delta: string } = JSON.parse((evt as MessageEvent).data);
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, answer: m.answer + (data.delta ?? "") } : m))
        );
      } catch {
        // ignore malformed event payload
      }
    });

    es.addEventListener("run.completed", (evt) => {
      try {
        const data: {
          status: "SUCCEEDED" | "INSUFFICIENT_EVIDENCE";
          output?: { answer?: string; citations?: Citation[] };
        } = JSON.parse((evt as MessageEvent).data);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const finalAnswer = m.answer || data.output?.answer || "";
            const mergedCitations = data.output?.citations?.length
              ? mergeCitations(m.citations, data.output.citations)
              : m.citations;
            return {
              ...m,
              status: data.status === "INSUFFICIENT_EVIDENCE" ? "insufficient_evidence" : "succeeded",
              answer: finalAnswer,
              citations: mergedCitations,
            };
          })
        );
        onRunCompleted();
      } catch {
        updateMessage(messageId, { status: "succeeded" });
        onRunCompleted();
      } finally {
        finishRun();
      }
    });

    es.addEventListener("run.failed", (evt) => {
      try {
        const data: { code?: string; message: string; trace_id?: string } = JSON.parse((evt as MessageEvent).data);
        updateMessage(messageId, { status: "failed", errorMessage: data.message, traceId: data.trace_id });
      } catch {
        updateMessage(messageId, { status: "failed", errorMessage: "실행 중 오류가 발생했습니다." });
      } finally {
        finishRun();
      }
    });

    es.addEventListener("run.cancelled", (evt) => {
      try {
        const data: { trace_id?: string } = JSON.parse((evt as MessageEvent).data);
        updateMessage(messageId, { status: "cancelled", traceId: data.trace_id });
      } catch {
        updateMessage(messageId, { status: "cancelled" });
      } finally {
        finishRun();
      }
    });

    es.onerror = () => {
      updateMessage(messageId, { status: "failed", errorMessage: "실시간 연결이 끊어졌습니다. 다시 시도해 주세요." });
      finishRun();
    };
  }

  async function handleSend() {
    const q = question.trim();
    if (!q || isRunning || !targetVersionId) return;

    setQuestion("");
    const messageId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const newMessage: PreviewMessage = { id: messageId, question: q, status: "running", answer: "", citations: [], traceId };
    setMessages((prev) => [...prev, newMessage]);
    setIsRunning(true);

    try {
      const res = await fetch(`${AGENT_RUNTIME_BASE}/local/v1/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: serviceVersionId,
          input: { agent_profile: agentId, knowledge_id: targetVersionId, question: q },
          trace_id: traceId,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created: RunCreatedResponse = await res.json();
      runIdRef.current = created.id;
      updateMessage(messageId, { runId: created.id, traceId: created.trace_id ?? traceId });
      openEventStream(created.id, messageId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateMessage(messageId, { status: "failed", errorMessage: `실행 요청에 실패했습니다: ${msg}` });
      setIsRunning(false);
    }
  }

  async function handleCancel() {
    if (!runIdRef.current) return;
    try {
      await fetch(`${AGENT_RUNTIME_BASE}/local/v1/runs/${runIdRef.current}/cancel`, { method: "POST" });
    } catch {
      // best-effort; the UI updates once the run.cancelled event arrives via SSE
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Preview 테스트</h2>
        <p className="text-body text-text-secondary">
          단계 8에서 저장된 실제 Service Version({serviceVersionId})으로 agent-runtime의 동일한 실행 경로를
          호출합니다. 이 대화는 저장되지 않습니다.
        </p>
      </div>

      {knowledgeBindings.length > 1 && (
        <FormField label="테스트할 Knowledge">
          <select value={targetVersionId} onChange={(e) => setTargetVersionId(e.target.value)} className={`${inputClass} w-auto`}>
            {knowledgeBindings.map((b) => (
              <option key={b.knowledgeVersionId} value={b.knowledgeVersionId}>
                {b.knowledgeAssetName} (v{b.knowledgeVersionLabel})
              </option>
            ))}
          </select>
          <p className="mt-1 text-caption text-text-muted">
            agent-runtime의 Local Preview는 한 번에 하나의 Knowledge만 검색합니다. 실제 게시 후에는 연결된
            Knowledge 전체가 사용됩니다.
          </p>
        </FormField>
      )}

      <div className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div className="mb-2 flex items-center gap-2 text-body font-semibold text-text-primary">
          <Sparkles size={15} className="text-brand-500" />
          Preview 실행 ({agentId})
        </div>
        <p className="text-body text-text-secondary">질문을 입력해 실제 등록된 Knowledge로 답변을 테스트하세요.</p>
      </div>

      <div className="space-y-4">
        {messages.length === 0 && (
          <p className="rounded-card border border-dashed border-border bg-surface px-4 py-8 text-center text-body text-text-muted">
            아직 대화가 없습니다. 질문을 입력해 Preview를 시작하세요.
          </p>
        )}

        {messages.map((m) => (
          <div key={m.id} className="space-y-2">
            <div className="ml-auto max-w-[80%] rounded-xl bg-brand-600 px-4 py-2.5 text-sm text-white">{m.question}</div>

            <div className="max-w-[85%] space-y-2">
              {m.status === "running" && (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-muted">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-400" />
                  답변을 생성하는 중...
                </div>
              )}
              {m.status === "succeeded" && (
                <div className="whitespace-pre-wrap rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-primary">
                  {m.answer || "답변이 없습니다."}
                </div>
              )}
              {m.status === "insufficient_evidence" && (
                <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5 text-body text-warning">
                  등록된 지식에서 근거를 찾지 못했습니다.
                </div>
              )}
              {m.status === "cancelled" && (
                <div className="rounded-xl border border-border bg-slate-50 px-4 py-2.5 text-body text-text-secondary">
                  취소됨{m.traceId ? ` (Trace ID: ${m.traceId})` : ""}
                </div>
              )}
              {m.status === "failed" && (
                <ErrorBanner
                  message={`${m.errorMessage ?? "실행 중 오류가 발생했습니다."}${m.traceId ? ` (Trace ID: ${m.traceId})` : ""}`}
                />
              )}
              {m.citations.length > 0 && (
                <div className="space-y-1.5">
                  {m.citations.map((c, idx) => (
                    <CitationCard key={c.chunk_id || idx} citation={c} />
                  ))}
                </div>
              )}
              {m.status === "running" && (
                <Button variant="secondary" size="sm" onClick={handleCancel}>
                  <Square size={13} />
                  취소
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="질문을 입력하세요..."
          rows={2}
          className={`${inputClass} resize-none`}
          disabled={isRunning}
        />
        <Button onClick={handleSend} disabled={isRunning || !question.trim() || !targetVersionId}>
          <Send size={15} />
          전송
        </Button>
      </div>
    </div>
  );
}
