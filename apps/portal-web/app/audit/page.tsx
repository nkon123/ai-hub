"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardList, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  ErrorBanner,
  LoadingState,
  PageHeader,
  inputClass,
} from "../_components/ui";
import { formatDateTime } from "../_components/deployment-meta";
import { useRole } from "../_components/role-context";
import type { BadgeTone } from "../_components/ui";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const PAGE_SIZE = 20;

const RESULT_TONE: Record<string, BadgeTone> = {
  SUCCESS: "success",
  DENIED: "danger",
  FAILED: "warning",
};

const RESULT_LABEL: Record<string, string> = {
  SUCCESS: "성공",
  DENIED: "거부됨",
  FAILED: "실패",
};

interface AuditEventItem {
  id: string;
  timestamp: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  resource_version: string | null;
  trace_id: string | null;
  result: string;
  metadata: Record<string, unknown>;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";

export default function AuditLogPage() {
  const { role } = useRole();

  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [actorIdFilter, setActorIdFilter] = useState("");
  const [resourceIdFilter, setResourceIdFilter] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ eventType: "", actorId: "", resourceId: "" });

  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("page_size", String(PAGE_SIZE));
        if (appliedFilters.eventType) params.set("event_type", appliedFilters.eventType);
        if (appliedFilters.actorId) params.set("actor_id", appliedFilters.actorId);
        if (appliedFilters.resourceId) params.set("resource_id", appliedFilters.resourceId);

        const res = await fetch(`${API_BASE}/api/v1/audit-events?${params}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });

        if (res.status === 403) {
          if (!cancelled) setState("forbidden");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setItems(data.items ?? []);
          setTotal(data.total ?? 0);
          setState("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMessage(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [page, appliedFilters, role.token]);

  function applyFilters() {
    setPage(1);
    setAppliedFilters({
      eventType: eventTypeFilter.trim(),
      actorId: actorIdFilter.trim(),
      resourceId: resourceIdFilter.trim(),
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader title="감사 로그" description="주요 요청과 실행 이력을 Trace ID와 함께 조회합니다." />

      {state === "forbidden" ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <ShieldAlert size={40} className="mb-1 text-slate-300" strokeWidth={1.5} />
          <p className="font-medium text-text-primary">이 역할에는 감사 로그 조회 권한이 없습니다.</p>
          <p className="text-body text-text-secondary">
            현재 역할: {role.label}. 상단의 개발용 역할 전환에서 감사자 또는 관리자로 전환해 보세요.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">이벤트 유형</label>
              <input
                value={eventTypeFilter}
                onChange={(e) => setEventTypeFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder="예: DEPLOYMENT_SUSPENDED"
                className={`${inputClass} w-64`}
              />
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">행위자 ID</label>
              <input
                value={actorIdFilter}
                onChange={(e) => setActorIdFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder="예: release-manager@miracom.com"
                className={`${inputClass} w-64`}
              />
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">리소스 ID</label>
              <input
                value={resourceIdFilter}
                onChange={(e) => setResourceIdFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder="자산/배포 ID"
                className={`${inputClass} w-64`}
              />
            </div>
            <Button onClick={applyFilters}>조회</Button>
          </div>

          {state === "loading" && <LoadingState label="감사 로그를 불러오는 중..." />}

          {state === "error" && (
            <ErrorBanner message={`감사 로그를 불러오지 못했습니다: ${errorMessage}`} />
          )}

          {state === "ok" && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
              <ClipboardList size={40} className="mb-1 text-slate-300" strokeWidth={1.5} />
              <p className="font-medium text-text-primary">조건에 맞는 감사 로그가 없습니다.</p>
            </div>
          )}

          {state === "ok" && items.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
                <table className="w-full text-left text-body">
                  <thead>
                    <tr className="border-b border-border text-caption text-text-secondary">
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">시각</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">이벤트 유형</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">결과</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">행위자</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">리소스</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">Trace ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className={`border-b border-border last:border-0 ${
                          item.result === "DENIED" ? "bg-danger/5" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {formatDateTime(item.timestamp)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-primary">
                          {item.event_type}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <Badge tone={RESULT_TONE[item.result] ?? "neutral"}>
                            {RESULT_LABEL[item.result] ?? item.result}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">{item.actor_id}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {item.resource_type} · {item.resource_id}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">
                          {item.trace_id ?? "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-center justify-between text-body text-text-secondary">
                <span>
                  총 {total}건 · {page} / {totalPages} 페이지
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                  >
                    <ChevronLeft size={14} />
                    이전
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                  >
                    다음
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
