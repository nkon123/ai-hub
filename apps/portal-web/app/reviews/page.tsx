"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, ShieldAlert } from "lucide-react";
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
import { ASSET_TYPE_LABEL, STAGE_LABEL, STAGE_TONE } from "../_components/review-meta";
import { useRole } from "../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface ReviewItem {
  id: string;
  subject_type: string;
  subject_id: string;
  stage: string;
  status: string;
  requested_by: string;
  requested_at: string;
  assigned_to: string | null;
  policy_version: string | null;
  asset_name: string | null;
  asset_type: string | null;
  version_label: string | null;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";

export default function ReviewsInboxPage() {
  const router = useRouter();
  const { role } = useRole();

  const [stageFilter, setStageFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const params = new URLSearchParams();
        // D-041 후속: no subject_type filter here by default — SERVICE_VERSION
        // and ASSET_VERSION reviews both land in the same inbox (the
        // subjectFilter dropdown below narrows it when useful).
        if (subjectFilter) params.set("subject_type", subjectFilter);
        if (stageFilter) params.set("stage", stageFilter);
        if (statusFilter) params.set("status", statusFilter);

        const res = await fetch(`${API_BASE}/api/v1/reviews?${params}`, {
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
  }, [stageFilter, statusFilter, subjectFilter, role.token]);

  return (
    <div>
      <PageHeader title="검토함" description="검토 대기 중인 자산 버전을 확인하고 처리합니다." />

      <div className="mb-6 flex gap-3">
        <select
          value={subjectFilter}
          onChange={(e) => setSubjectFilter(e.target.value)}
          className={`${inputClass} w-auto`}
        >
          <option value="">자산·서비스 모두</option>
          <option value="ASSET_VERSION">Knowledge 자산만</option>
          <option value="SERVICE_VERSION">AI Service만</option>
        </select>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className={`${inputClass} w-auto`}
        >
          <option value="">모든 단계</option>
          <option value="TECHNICAL">기술 검토</option>
          <option value="SECURITY">보안 검토</option>
          <option value="RELEASE">배포 승인</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={`${inputClass} w-auto`}
        >
          <option value="">모든 상태</option>
          <option value="PENDING">대기중</option>
          <option value="APPROVED">승인됨</option>
          <option value="REJECTED">반려됨</option>
          <option value="CHANGES_REQUESTED">수정요청됨</option>
        </select>
      </div>

      {state === "loading" && <LoadingState label="검토 목록을 불러오는 중..." />}

      {state === "forbidden" && (
        <EmptyState
          icon={<ShieldAlert size={40} strokeWidth={1.5} />}
          title="이 역할에는 검토 권한이 없습니다."
          description={`현재 역할: ${role.label}. 상단의 개발용 역할 전환에서 기술 검토자, 보안 검토자, 배포 관리자, 감사자, 관리자 중 하나로 전환해 보세요.`}
        />
      )}

      {state === "error" && <ErrorBanner message={`검토 목록을 불러오지 못했습니다: ${errorMessage}`} />}

      {state === "ok" && items.length === 0 && (
        <EmptyState icon={<Inbox size={40} strokeWidth={1.5} />} title="대기 중인 검토가 없습니다." />
      )}

      {state === "ok" && items.length > 0 && (
        <div className="grid gap-3">
          {items.map((item) => (
            <Card
              key={item.id}
              onClick={() => router.push(`/reviews/${item.id}`)}
              className="flex items-center gap-4 px-5 py-4"
            >
              <div className="flex-1">
                <div className="text-card-title font-semibold text-text-primary">
                  {item.asset_name ?? "(알 수 없는 자산)"}
                </div>
                <div className="mt-0.5 text-caption text-text-secondary">
                  {ASSET_TYPE_LABEL[item.asset_type ?? ""] ?? item.asset_type ?? "-"}
                  {item.version_label ? ` · v${item.version_label}` : ""} · 제출자{" "}
                  {item.requested_by} · {new Date(item.requested_at).toLocaleDateString("ko-KR")}
                </div>
              </div>
              <Badge tone={STAGE_TONE[item.stage] ?? "neutral"}>
                {STAGE_LABEL[item.stage] ?? item.stage}
              </Badge>
              <StatusBadge status={item.status} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
