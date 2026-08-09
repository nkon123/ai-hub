"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Package, PackageOpen, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../_components/ui";
import {
  DISTRIBUTION_MODE_LABEL,
  ROOT_TYPE_LABEL,
  formatBytes,
  formatDateTime,
} from "../_components/distribution-meta";
import { useRole } from "../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const PAGE_SIZE = 20;

interface DistributionItem {
  id: string;
  root_type: string;
  root_id: string;
  mode: string;
  target_site_id: string | null;
  requested_by: string;
  status: string;
  stage: string | null;
  bundle_size_bytes: number | null;
  created_at: string;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";

export default function DistributionsListPage() {
  const router = useRouter();
  const { role } = useRole();

  const [page, setPage] = useState(1);
  const [items, setItems] = useState<DistributionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/distributions?page=${page}&page_size=${PAGE_SIZE}`,
          { headers: { Authorization: `Bearer ${role.token}` } }
        );
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
  }, [page, role.token]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="반출 요청"
        description="폐쇄망 반입용 Offline Bundle 요청 이력입니다. 일반 사용자에게는 본인이 요청한 항목만 표시됩니다."
        actions={
          <Button href="/distributions/new">
            <PackageOpen size={16} />
            새 반출 요청
          </Button>
        }
      />

      {state === "loading" && <LoadingState label="반출 요청 목록을 불러오는 중..." />}

      {state === "forbidden" && (
        <EmptyState
          icon={<ShieldAlert size={40} strokeWidth={1.5} />}
          title="이 역할에는 반출 요청 조회 권한이 없습니다."
          description={`현재 역할: ${role.label}. 자산 제작자, 감사자 또는 관리자로 전환해 보세요.`}
        />
      )}

      {state === "error" && (
        <ErrorBanner message={`반출 요청 목록을 불러오지 못했습니다: ${errorMessage}`} />
      )}

      {state === "ok" && items.length === 0 && (
        <EmptyState
          icon={<Package size={40} strokeWidth={1.5} />}
          title="반출 요청 이력이 없습니다."
          action={
            <a href="/distributions/new" className="text-sm font-medium text-brand-600 hover:underline">
              첫 반출 요청을 만들어 보세요 →
            </a>
          }
        />
      )}

      {state === "ok" && items.length > 0 && (
        <>
          <div className="grid gap-3">
            {items.map((item) => (
              <Card
                key={item.id}
                onClick={() => router.push(`/distributions/${item.id}`)}
                className="px-5 py-4"
              >
                <div className="flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{ROOT_TYPE_LABEL[item.root_type] ?? item.root_type}</Badge>
                      <span className="truncate text-caption text-text-muted" title={item.root_id}>
                        {item.root_id}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-caption text-text-secondary">
                      {DISTRIBUTION_MODE_LABEL[item.mode] ?? item.mode}
                      {item.target_site_id ? ` · ${item.target_site_id}` : ""} · 요청자{" "}
                      {item.requested_by} · {formatDateTime(item.created_at)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-caption text-text-muted">{formatBytes(item.bundle_size_bytes)}</div>
                    <div className="mt-1">
                      <StatusBadge status={item.status} />
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between text-caption text-text-secondary">
            <span>
              총 {total}건 · {page} / {totalPages} 페이지
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft size={14} />
                이전
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                다음
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
