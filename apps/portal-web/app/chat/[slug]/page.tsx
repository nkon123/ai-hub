"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { MessageCircleQuestion, Send, Sparkles, Square } from "lucide-react";
import { Button, ErrorBanner, LoadingState, inputClass } from "../../_components/ui";

// Fixed Hosted Chat Runtime contract (services/agent-runtime, port 8100, /chat-api/v1/*).
// No Authorization header: agent-runtime has no auth in this PoC (see D-035).
const AGENT_RUNTIME_BASE = process.env.NEXT_PUBLIC_AGENT_RUNTIME_BASE ?? "http://localhost:8100";
const MAX_MESSAGE_LENGTH = 4096;

interface Citation {
  chunk_id: string;
  document_path: string;
  document_title: string;
  page: number;
  section: string;
  excerpt: string;
}

interface ChatbotConfig {
  slug: string;
  name: string;
  welcome_message: string | null;
  suggested_questions: string[];
  citation_display: boolean;
  deployment_revision_id: string;
}

type AssistantStatus = "streaming" | "done" | "insufficient_evidence" | "error" | "cancelled";

interface UserEntry {
  id: string;
  role: "user";
  text: string;
}

interface AssistantEntry {
  id: string;
  role: "assistant";
  status: AssistantStatus;
  text: string;
  citations: Citation[];
  errorMessage?: string;
  errorCode?: string;
  traceId?: string;
}

type ChatEntry = UserEntry | AssistantEntry;

type PageStatus = "loading" | "not_found" | "load_error" | "ready";

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const seen = new Set(existing.map((c) => c.chunk_id));
  const extra = incoming.filter((c) => !seen.has(c.chunk_id));
  return [...existing, ...extra];
}

function CitationCard({ citation }: { citation: Citation }) {
  const excerpt =
    citation.excerpt && citation.excerpt.length > 160
      ? `${citation.excerpt.slice(0, 160)}…`
      : citation.excerpt;
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

/** Parses one complete SSE frame (lines joined by \n, frame separator \n\n already stripped). */
function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export default function HostedChatPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [pageStatus, setPageStatus] = useState<PageStatus>("loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState("");
  const [config, setConfig] = useState<ChatbotConfig | null>(null);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  async function loadConfig() {
    setPageStatus("loading");
    try {
      const res = await fetch(`${AGENT_RUNTIME_BASE}/chat-api/v1/chatbots/${slug}`);
      if (res.status === 404) {
        const body = await safeJson(res);
        // Server intentionally returns the identical message for "slug never existed"
        // and "exists but not published/suspended" — do not add distinguishing text here.
        setLoadErrorMessage(
          body?.error?.message ?? "요청하신 챗봇을 찾을 수 없거나 현재 사용할 수 없습니다."
        );
        setPageStatus("not_found");
        return;
      }
      if (!res.ok) {
        const body = await safeJson(res);
        setLoadErrorMessage(body?.error?.message ?? `오류가 발생했습니다. (HTTP ${res.status})`);
        setPageStatus("load_error");
        return;
      }
      const data: ChatbotConfig = await res.json();
      setConfig(data);
      setPageStatus("ready");
    } catch {
      setLoadErrorMessage("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
      setPageStatus("load_error");
    }
  }

  useEffect(() => {
    loadConfig();
    return () => {
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  function updateAssistantEntry(id: string, patch: Partial<AssistantEntry>) {
    setEntries((prev) =>
      prev.map((e) => (e.id === id && e.role === "assistant" ? { ...e, ...patch } : e))
    );
  }

  async function ensureSession(): Promise<string | null> {
    if (sessionIdRef.current) return sessionIdRef.current;
    try {
      const res = await fetch(`${AGENT_RUNTIME_BASE}/chat-api/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setLoadErrorMessage(body?.error?.message ?? "세션을 생성하지 못했습니다.");
        setPageStatus("load_error");
        return null;
      }
      const data = await res.json();
      sessionIdRef.current = data.id;
      return data.id;
    } catch {
      setLoadErrorMessage("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
      setPageStatus("load_error");
      return null;
    }
  }

  function handleNewConversation() {
    abortControllerRef.current?.abort();
    sessionIdRef.current = null;
    setEntries([]);
    setIsStreaming(false);
  }

  function handleCancel() {
    abortControllerRef.current?.abort();
  }

  function processEventFrame(frame: string, assistantId: string) {
    const parsed = parseSseFrame(frame);
    if (!parsed) return;
    let payload: any;
    try {
      payload = JSON.parse(parsed.data);
    } catch {
      return;
    }

    switch (parsed.event) {
      case "answer.delta":
        setEntries((prev) =>
          prev.map((e) =>
            e.id === assistantId && e.role === "assistant"
              ? { ...e, text: e.text + (payload.delta ?? "") }
              : e
          )
        );
        break;
      case "citation.added":
        // Hosted payload for citation.added is the raw citation object itself (plus trace_id).
        setEntries((prev) =>
          prev.map((e) =>
            e.id === assistantId && e.role === "assistant"
              ? { ...e, citations: mergeCitations(e.citations, [payload as Citation]) }
              : e
          )
        );
        break;
      case "run.completed": {
        const status: string = payload.status;
        setEntries((prev) =>
          prev.map((e) => {
            if (e.id !== assistantId || e.role !== "assistant") return e;
            const finalText = e.text || payload.output?.answer || "";
            const mergedCitations = payload.output?.citations?.length
              ? mergeCitations(e.citations, payload.output.citations)
              : e.citations;
            return {
              ...e,
              status: status === "INSUFFICIENT_EVIDENCE" ? "insufficient_evidence" : "done",
              text: finalText,
              citations: mergedCitations,
              traceId: payload.trace_id,
            };
          })
        );
        break;
      }
      case "run.failed":
        updateAssistantEntry(assistantId, {
          status: "error",
          errorMessage: payload.message ?? "실행 중 오류가 발생했습니다.",
          traceId: payload.trace_id,
        });
        break;
      default:
        // run.started / search.completed carry no UI-visible state on this screen.
        break;
    }
  }

  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    const sessionId = await ensureSession();
    if (!sessionId) return;

    setInput("");
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setEntries((prev) => [
      ...prev,
      { id: userId, role: "user", text: trimmed },
      { id: assistantId, role: "assistant", status: "streaming", text: "", citations: [] },
    ]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch(`${AGENT_RUNTIME_BASE}/chat-api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeJson(res);
        const code: string | undefined = body?.error?.code;
        if (code === "CHAT_SESSION_EXPIRED") {
          sessionIdRef.current = null; // force a fresh session on the next attempt
        }
        updateAssistantEntry(assistantId, {
          status: "error",
          errorMessage: body?.error?.message ?? `오류가 발생했습니다. (HTTP ${res.status})`,
          errorCode: code,
          traceId: body?.error?.trace_id,
        });
        return;
      }

      if (!res.body) {
        updateAssistantEntry(assistantId, {
          status: "error",
          errorMessage: "실시간 연결을 열지 못했습니다.",
        });
        return;
      }

      // POST-initiated SSE: EventSource cannot be used here (GET-only), so the wire
      // format is parsed manually from the fetch body stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          processEventFrame(frame, assistantId);
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        updateAssistantEntry(assistantId, { status: "cancelled" });
      } else {
        updateAssistantEntry(assistantId, {
          status: "error",
          errorMessage: "실시간 연결이 끊어졌습니다. 다시 시도해 주세요.",
        });
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  if (pageStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="챗봇 정보를 불러오는 중..." />
      </div>
    );
  }

  if (pageStatus === "not_found") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <MessageCircleQuestion size={40} strokeWidth={1.5} className="text-slate-300" />
          <p className="font-medium text-text-primary">챗봇을 찾을 수 없습니다.</p>
          <p className="text-body text-text-secondary">{loadErrorMessage}</p>
        </div>
      </div>
    );
  }

  if (pageStatus === "load_error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
        <ErrorBanner message={loadErrorMessage} />
        <Button variant="secondary" onClick={loadConfig}>
          다시 시도
        </Button>
      </div>
    );
  }

  if (!config) return null;
  const suggestions = config.suggested_questions.filter((q) => q.trim());

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col px-4 py-6">
      <div className="mb-4 shrink-0 border-b border-border pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-section-title font-bold text-text-primary">
            <Sparkles size={18} className="text-brand-500" />
            {config.name}
          </div>
          <button
            type="button"
            onClick={handleNewConversation}
            className="shrink-0 text-caption font-medium text-text-muted hover:text-text-secondary"
          >
            새 대화
          </button>
        </div>
        {config.welcome_message && <p className="mt-1 text-body text-text-secondary">{config.welcome_message}</p>}
        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((q, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setInput(q)}
                className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs text-brand-700 hover:bg-brand-100"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
        {entries.length === 0 && (
          <p className="rounded-card border border-dashed border-border bg-surface px-4 py-10 text-center text-body text-text-muted">
            아직 대화가 없습니다. 질문을 입력해 시작하세요.
          </p>
        )}

        {entries.map((entry) =>
          entry.role === "user" ? (
            <div
              key={entry.id}
              className="ml-auto max-w-[80%] rounded-xl bg-brand-600 px-4 py-2.5 text-sm text-white"
            >
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} className="max-w-[85%] space-y-2">
              {entry.status === "streaming" &&
                (entry.text ? (
                  <div className="whitespace-pre-wrap rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-primary">
                    {entry.text}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-muted">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-400" />
                    답변을 생성하는 중...
                  </div>
                ))}

              {entry.status === "done" && (
                <div className="whitespace-pre-wrap rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-primary">
                  {entry.text || "답변이 없습니다."}
                </div>
              )}

              {entry.status === "insufficient_evidence" && (
                <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5 text-body text-warning">
                  등록된 지식에서 근거를 찾지 못했습니다.
                </div>
              )}

              {entry.status === "cancelled" && (
                <div className="rounded-xl border border-border bg-slate-50 px-4 py-2.5 text-body text-text-secondary">
                  취소됨
                </div>
              )}

              {entry.status === "error" && (
                <div className="space-y-1.5">
                  <ErrorBanner
                    message={`${entry.errorMessage ?? "오류가 발생했습니다."}${
                      entry.traceId ? ` (Trace ID: ${entry.traceId})` : ""
                    }`}
                  />
                  {entry.errorCode === "CHAT_SESSION_EXPIRED" && (
                    <Button variant="secondary" size="sm" onClick={handleNewConversation}>
                      새 대화 시작
                    </Button>
                  )}
                </div>
              )}

              {config.citation_display && entry.citations.length > 0 && (
                <div className="space-y-1.5">
                  {entry.citations.map((c, idx) => (
                    <CitationCard key={c.chunk_id || idx} citation={c} />
                  ))}
                </div>
              )}

              {entry.status === "streaming" && (
                <Button variant="secondary" size="sm" onClick={handleCancel}>
                  <Square size={13} />
                  취소
                </Button>
              )}
            </div>
          )
        )}
      </div>

      <div className="mt-4 shrink-0 border-t border-border pt-4">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(input);
              }
            }}
            placeholder="질문을 입력하세요..."
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            className={`${inputClass} resize-none`}
            disabled={isStreaming}
          />
          <Button onClick={() => handleSend(input)} disabled={isStreaming || !input.trim()}>
            <Send size={15} />
            전송
          </Button>
        </div>
        <p className="mt-3 text-center text-caption text-text-muted">
          이 서비스는 사내 전용이며, 답변은 등록된 지식 자산을 바탕으로 자동 생성됩니다. 중요한 결정에는
          반드시 원문을 확인하세요.
        </p>
      </div>
    </div>
  );
}
