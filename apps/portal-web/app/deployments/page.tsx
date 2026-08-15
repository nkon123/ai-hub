"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Rocket } from "lucide-react";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  StatusBadge,
  inputClass,
} from "../_components/ui";
import {
  DEPLOYMENT_STATUS_LABEL,
  ENVIRONMENT_LABEL,
  formatDateTime,
} from "../_components/deployment-meta";
import { useRole } from "../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// GET /deployments has no server-side `status` filter (portal_api routers/
// services.py::list_deployments takes only page/page_size) — confirmed by
// reading the router before assuming. The 상태 filter below is therefore
// applied client-side over a single generously-sized page, which is
// acceptable at PoC data scale; a real deployment would add the filter to
// the contract instead of growing page_size.
const FETCH_PAGE_SIZE = 100;

interface DeploymentItem {
  id: string;
  service_id: string;
  service_version_id: string;
  slug: string;
  environment: string;
  access_policy: string;
  status: string;
  deployment_url: string;
  created_by: string;
  created_at: string;
  suspend_reason: string | null;
  retire_reason: string | null;
}

type LoadState = "loading" | "ok" | "error";

const STATUS_FILTERS = ["", "ACTIVE", "SUSPENDED", "PENDING", "RETIRED"];

export default function DeploymentsListPage() {
  const router = useRouter();
  const { role } = useRole();

  const [statusFilter, setStatusFilter] = useState("");
  const [items, setItems] = useState<DeploymentItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/deployments?page=1&page_size=${FETCH_PAGE_SIZE}`,
          { headers: { Authorization: `Bearer ${role.token}` } }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setItems(data.items ?? []);
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
  }, [role.token]);

  const filtered = statusFilter ? items.filter((d) => d.status === statusFilter) : items;

  return (
    <div>
      <PageHeader
        title="게시 관리"
        description="게시된 챗봇 서비스의 운영 상태를 확인하고 중단·재개·롤백을 처리합니다."
      />

      <div className="mb-6 flex gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={`${inputClass} w-auto`}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s || "ALL"} value={s}>
              {s ? DEPLOYMENT_STATUS_LABEL[s] ?? s : "모든 상태"}
            </option>
          ))}
        </select>
      </div>

      {state === "loading" && <LoadingState label="게시 목록을 불러오는 중..." />}

      {state === "error" && (
        <ErrorBanner message={`게시 목록을 불러오지 못했습니다: ${errorMessage}`} />
      )}

      {state === "ok" && filtered.length === 0 && (
        <EmptyState icon={<Rocket size={40} strokeWidth={1.5} />} title="게시된 챗봇이 없습니다." />
      )}

      {state === "ok" && filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((item) => (
            <Card
              key={item.id}
              onClick={() => router.push(`/deployments/${item.id}`)}
              className="px-5 py-4"
            >
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-card-title font-semibold text-text-primary">
                      {item.slug}
                    </span>
                    <Badge tone="neutral">{ENVIRONMENT_LABEL[item.environment] ?? item.environment}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-caption text-text-secondary">
                    {item.deployment_url} · 게시자 {item.created_by} ·{" "}
                    {formatDateTime(item.created_at)}
                  </div>
                </div>
                <StatusBadge status={item.status} />
              </div>

              {item.status === "SUSPENDED" && item.suspend_reason && (
                <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-caption text-danger">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>중단 사유: {item.suspend_reason}</span>
                </div>
              )}

              {item.status === "RETIRED" && (
                <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-border bg-slate-50 px-3 py-2 text-caption text-text-secondary">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    폐기됨 — 되돌릴 수 없습니다
                    {item.retire_reason ? `. 사유: ${item.retire_reason}` : ""}
                  </span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
