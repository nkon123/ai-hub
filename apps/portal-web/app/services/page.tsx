"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Plus } from "lucide-react";
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
import { formatDateTime } from "../_components/deployment-meta";
import { useRole } from "../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// GET /services has no server-side `q`/`status` filter (portal_api routers/
// services.py::list_services takes only page/page_size) — a single generous
// page is fine at PoC data scale, matching the same choice already made in
// app/deployments/page.tsx for the same reason.
const FETCH_PAGE_SIZE = 100;

interface ServiceVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

interface ServiceListItem {
  id: string;
  name: string;
  owner_org: string;
  owner_creator_id: string;
  created_at: string;
  version_count: number;
  latest_version: ServiceVersionSummary | null;
}

type LoadState = "loading" | "ok" | "error" | "forbidden";

export default function ServicesListPage() {
  const router = useRouter();
  const { role } = useRole();

  const [items, setItems] = useState<ServiceListItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/services?page=1&page_size=${FETCH_PAGE_SIZE}`,
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

  return (
    <div>
      <PageHeader
        title="AI Service"
        description="Agent·Knowledge·MCP Tool·Prompt·모델 정책을 조합해 구성한 업무 서비스 목록입니다."
        actions={
          <Button href="/services/new">
            <Plus size={16} />
            새 서비스 만들기
          </Button>
        }
      />

      {state === "loading" && <LoadingState label="Service 목록을 불러오는 중..." />}

      {state === "forbidden" && (
        <ErrorBanner message="이 화면을 조회할 권한이 없습니다." />
      )}

      {state === "error" && (
        <ErrorBanner message={`Service 목록을 불러오지 못했습니다: ${errorMessage}`} />
      )}

      {state === "ok" && items.length === 0 && (
        <EmptyState
          icon={<Layers size={40} strokeWidth={1.5} />}
          title="등록된 AI Service가 없습니다."
          description="AI Service Composer 또는 Knowledge 챗봇 빠른 만들기로 첫 서비스를 구성해 보세요."
          action={
            <div className="flex justify-center gap-2">
              <Button href="/services/new" size="sm">
                AI Service Composer
              </Button>
              <Button href="/chatbots/new" variant="secondary" size="sm">
                챗봇 빠른 만들기
              </Button>
            </div>
          }
        />
      )}

      {state === "ok" && items.length > 0 && (
        <div className="grid gap-3">
          {items.map((item) => (
            <Card
              key={item.id}
              onClick={() =>
                item.latest_version && router.push(`/services/${item.latest_version.id}`)
              }
              className="px-5 py-4"
            >
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-card-title font-semibold text-text-primary">
                      {item.name}
                    </span>
                    {item.latest_version && (
                      <Badge tone="neutral">v{item.latest_version.version}</Badge>
                    )}
                    <Badge tone="brand">버전 {item.version_count}개</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-caption text-text-secondary">
                    {item.owner_org} · {item.owner_creator_id} · 생성{" "}
                    {formatDateTime(item.created_at)}
                  </div>
                </div>
                {item.latest_version && <StatusBadge status={item.latest_version.status} />}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
