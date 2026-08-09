"use client";

/**
 * P13 다운로드 이력 (01-portal-and-distribution.md §2 P13).
 *
 * Merges two server-side sources into one read-only table without
 * duplicating either into the other — "Bundle 요청" rows
 * (DistributionRequest, one per POST /distributions) and "다운로드" rows
 * (AuditEvent — success/failure/거부 attempts against
 * GET /distributions/{id}/download). See `routers/distributions.py::
 * list_download_history` for exactly how they're joined.
 *
 * Scoping is enforced by the server, not this screen: a plain 사용자/제작자
 * only ever receives their own rows in the response — 사용자/조직 filter
 * inputs below are shown only to AUDITOR/ADMIN because a non-auditor's
 * request for a different actor/organization is denied with 403 regardless
 * of whether this screen tries to send one.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Inbox, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  inputClass,
} from "../_components/ui";
import type { BadgeTone } from "../_components/ui";
import {
  DISTRIBUTION_MODE_LABEL,
  ROOT_TYPE_LABEL,
  formatDateTime,
} from "../_components/distribution-meta";
import {
  canReadDownloadHistory,
  canSearchAllDownloadHistory,
  useRole,
} from "../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const PAGE_SIZE = 20;

// "미기재" — 값이 진짜로 없을 때만 사용한다(CLAUDE.md: 추측·0·빈 문자열로
// 채우지 않는다). null이지만 "해당 없음"인 경우(예: 성공 건의 실패 사유)는
// 별도로 "-"를 쓴다.
const NOT_RECORDED = "미기재";

function naText(value: string | null | undefined): string {
  return value && value.length > 0 ? value : NOT_RECORDED;
}

const KIND_LABEL: Record<string, string> = {
  BUNDLE_REQUEST: "Bundle 요청",
  DOWNLOAD: "다운로드",
};

const OUTCOME_LABEL: Record<string, string> = {
  SUCCESS: "성공",
  FAILURE: "실패",
  DENIED: "거부됨",
  CANCELLED: "취소됨",
  IN_PROGRESS: "진행중",
};

const OUTCOME_TONE: Record<string, BadgeTone> = {
  SUCCESS: "success",
  FAILURE: "danger",
  DENIED: "danger",
  CANCELLED: "neutral",
  IN_PROGRESS: "warning",
};

interface DownloadHistoryEntry {
  id: string;
  kind: "BUNDLE_REQUEST" | "DOWNLOAD";
  distribution_id: string;
  user: string;
  organization: string | null;
  target_site: string | null;
  root_type: string | null;
  root_id: string | null;
  asset_name: string | null;
  version: string | null;
  mode: string | null;
  requested_at: string;
  completed_at: string | null;
  client_ip: string | null;
  outcome: string;
  reason: string | null;
  trace_id: string | null;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";

interface Filters {
  from: string;
  to: string;
  mode: string;
  outcome: string;
  actorId: string;
  organizationId: string;
}

const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  mode: "",
  outcome: "",
  actorId: "",
  organizationId: "",
};

export default function DownloadHistoryPage() {
  const { role } = useRole();
  const canSearchAll = canSearchAllDownloadHistory(role.code);

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<DownloadHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const permitted = canReadDownloadHistory(role.code);

  useEffect(() => {
    if (!permitted) {
      setState("forbidden");
      return;
    }
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("page_size", String(PAGE_SIZE));
        if (applied.from) params.set("from", new Date(applied.from).toISOString());
        if (applied.to) params.set("to", new Date(applied.to).toISOString());
        if (applied.mode) params.set("mode", applied.mode);
        if (applied.outcome) params.set("outcome", applied.outcome);
        if (canSearchAll && applied.actorId) params.set("actor_id", applied.actorId);
        if (canSearchAll && applied.organizationId) {
          params.set("organization_id", applied.organizationId);
        }

        const res = await fetch(`${API_BASE}/api/v1/distributions/download-history?${params}`, {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, applied, role.token, permitted, canSearchAll]);

  function applyFilters() {
    setPage(1);
    setApplied({ ...draft });
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS);
    setPage(1);
    setApplied(EMPTY_FILTERS);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="다운로드 이력"
        description="본인의 Bundle 요청과 다운로드 이력을 조회합니다. 감사자·관리자는 전체 이력을 검색할 수 있습니다."
      />

      {state === "forbidden" ? (
        <EmptyState
          icon={<ShieldAlert size={40} strokeWidth={1.5} />}
          title="이 역할에는 다운로드 이력 조회 권한이 없습니다."
          description={`현재 역할: ${role.label}. 상단의 개발용 역할 전환에서 자산 제작자, 감사자 또는 관리자로 전환해 보세요.`}
        />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">
                시작 일시
              </label>
              <input
                type="datetime-local"
                value={draft.from}
                onChange={(e) => setDraft((f) => ({ ...f, from: e.target.value }))}
                className={`${inputClass} w-56`}
              />
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">
                종료 일시
              </label>
              <input
                type="datetime-local"
                value={draft.to}
                onChange={(e) => setDraft((f) => ({ ...f, to: e.target.value }))}
                className={`${inputClass} w-56`}
              />
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">방식</label>
              <select
                value={draft.mode}
                onChange={(e) => setDraft((f) => ({ ...f, mode: e.target.value }))}
                className={`${inputClass} w-48`}
              >
                <option value="">전체</option>
                <option value="OFFLINE_BUNDLE">{DISTRIBUTION_MODE_LABEL.OFFLINE_BUNDLE}</option>
                <option value="ONLINE">{DISTRIBUTION_MODE_LABEL.ONLINE}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-text-secondary">상태</label>
              <select
                value={draft.outcome}
                onChange={(e) => setDraft((f) => ({ ...f, outcome: e.target.value }))}
                className={`${inputClass} w-40`}
              >
                <option value="">전체</option>
                {Object.entries(OUTCOME_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {canSearchAll && (
              <>
                <div>
                  <label className="mb-1 block text-caption font-medium text-text-secondary">
                    사용자
                  </label>
                  <input
                    value={draft.actorId}
                    onChange={(e) => setDraft((f) => ({ ...f, actorId: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                    placeholder="예: dev-user@miracom.com"
                    className={`${inputClass} w-64`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-caption font-medium text-text-secondary">
                    조직
                  </label>
                  <input
                    value={draft.organizationId}
                    onChange={(e) => setDraft((f) => ({ ...f, organizationId: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                    placeholder="예: miracom"
                    className={`${inputClass} w-48`}
                  />
                </div>
              </>
            )}
            <Button onClick={applyFilters}>조회</Button>
            <Button variant="secondary" onClick={resetFilters}>
              초기화
            </Button>
          </div>

          {state === "loading" && <LoadingState label="다운로드 이력을 불러오는 중..." />}

          {state === "error" && (
            <ErrorBanner message={`다운로드 이력을 불러오지 못했습니다: ${errorMessage}`} />
          )}

          {state === "ok" && items.length === 0 && (
            <EmptyState
              icon={<Inbox size={40} strokeWidth={1.5} />}
              title="조건에 맞는 다운로드 이력이 없습니다."
            />
          )}

          {state === "ok" && items.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
                <table className="w-full text-left text-body">
                  <thead>
                    <tr className="border-b border-border text-caption text-text-secondary">
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">종류</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">사용자</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">조직</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">자산/Bundle</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">버전</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">방식</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">요청 시각</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">완료 시각</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">대상 사업장</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">Client IP</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">결과</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-medium">Trace ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className={`border-b border-border last:border-0 ${
                          item.outcome === "DENIED" || item.outcome === "FAILURE"
                            ? "bg-danger/5"
                            : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <Badge tone={item.kind === "DOWNLOAD" ? "brand" : "neutral"}>
                            {KIND_LABEL[item.kind] ?? item.kind}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {item.user}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {naText(item.organization)}
                        </td>
                        <td className="px-4 py-2.5 text-text-secondary">
                          <div className="flex flex-col">
                            <span className="text-text-primary">{naText(item.asset_name)}</span>
                            <span className="text-caption text-text-muted">
                              {item.root_type ? ROOT_TYPE_LABEL[item.root_type] ?? item.root_type : NOT_RECORDED}
                              {" · "}
                              <span title={item.root_id ?? undefined}>
                                {item.root_id ?? NOT_RECORDED}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {naText(item.version)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {item.mode ? DISTRIBUTION_MODE_LABEL[item.mode] ?? item.mode : NOT_RECORDED}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {formatDateTime(item.requested_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {item.completed_at
                            ? formatDateTime(item.completed_at)
                            : item.outcome === "IN_PROGRESS"
                              ? "진행중"
                              : NOT_RECORDED}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                          {naText(item.target_site)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-secondary">
                          {naText(item.client_ip)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Badge tone={OUTCOME_TONE[item.outcome] ?? "neutral"}>
                              {OUTCOME_LABEL[item.outcome] ?? item.outcome}
                            </Badge>
                            {item.reason && (
                              <span className="text-caption text-text-muted">{item.reason}</span>
                            )}
                          </div>
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
