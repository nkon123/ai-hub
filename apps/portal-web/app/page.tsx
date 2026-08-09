"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  Database,
  Download,
  FilePlus2,
  Inbox,
  MessageSquare,
  MessageSquarePlus,
  Package,
  PackageSearch,
  PauseCircle,
  PlayCircle,
  Rocket,
  RotateCcw,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  StatusBadge,
  type BadgeTone,
} from "./_components/ui";
import { canReadAudit, useRole } from "./_components/role-context";
import { formatDateTime } from "./_components/deployment-meta";
import { describeEventType, RESOURCE_TYPE_LABEL } from "./_components/activity-meta";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AssetVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

interface AssetItem {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  created_at: string;
  versions: AssetVersionSummary[];
}

interface DeploymentItem {
  id: string;
  slug: string;
  status: string;
  deployment_url: string;
  created_by: string;
  created_at: string;
}

interface AuditEventItem {
  id: string;
  timestamp: string;
  event_type: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  result: string;
  trace_id: string | null;
}

type SectionState = "loading" | "ok" | "error";
type ActivityState = "loading" | "ok" | "forbidden" | "error";

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

const ACTIVITY_ICON: Array<[string, LucideIcon]> = [
  ["PERMISSION_DENIED", ShieldAlert],
  ["ASSET_VERSION_CREATED", FilePlus2],
  ["ASSET_VERSION_SUBMIT_DENIED", ShieldAlert],
  ["ASSET_VERSION_SUBMITTED", Send],
  ["ASSET_VERSION_SUSPENDED", PauseCircle],
  ["ASSET_DEPRECATED", Archive],
  ["REVIEW_DECISION_APPROVE", ClipboardCheck],
  ["REVIEW_DECISION_REJECT", XCircle],
  ["REVIEW_DECISION_REQUEST_CHANGES", RotateCcw],
  ["DEPLOYMENT_PUBLISHED", Rocket],
  ["DEPLOYMENT_SUSPENDED", PauseCircle],
  ["DEPLOYMENT_RESUMED", PlayCircle],
  ["DEPLOYMENT_ROLLED_BACK", RotateCcw],
  ["SERVICE_VERSION_CREATED", Settings],
  ["DISTRIBUTION_REQUESTED", PackageSearch],
  ["BUNDLE_DOWNLOADED", Download],
];

function activityIcon(eventType: string): LucideIcon {
  return ACTIVITY_ICON.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? Activity;
}

function latestVersion(asset: AssetItem): AssetVersionSummary | undefined {
  return [...asset.versions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];
}

function isWithinLastWeek(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() <= SEVEN_DAYS_MS;
}

interface KpiCardProps {
  icon: LucideIcon;
  iconClassName: string;
  label: string;
  value: number;
  caption: string;
}

function KpiCard({ icon: Icon, iconClassName, label, value, caption }: KpiCardProps) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconClassName}`}>
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <div>
        <div className="text-caption text-text-secondary">{label}</div>
        <div className="text-kpi font-bold text-text-primary">{value}</div>
      </div>
      <div className="text-caption text-text-muted">{caption}</div>
    </Card>
  );
}

function KpiCardSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className="h-10 w-10 animate-pulse rounded-lg bg-slate-100" />
      <div className="space-y-2">
        <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
        <div className="h-7 w-10 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
    </Card>
  );
}

const QUICK_START = [
  {
    href: "/knowledge/new",
    icon: Database,
    label: "지식 등록",
    desc: "문서를 업로드해 Knowledge 자산을 만듭니다.",
    accent: "bg-asset-knowledge/10 text-asset-knowledge",
  },
  {
    href: "/chatbots/new",
    icon: MessageSquarePlus,
    label: "챗봇 만들기",
    desc: "등록된 Knowledge로 챗봇을 구성·게시합니다.",
    accent: "bg-asset-chatbot/10 text-asset-chatbot",
  },
  {
    href: "/assets",
    icon: BookOpen,
    label: "자산 카탈로그",
    desc: "등록된 전체 자산을 검색하고 둘러봅니다.",
    accent: "bg-brand-100 text-brand-700",
  },
] as const;

export default function DashboardPage() {
  const router = useRouter();
  const { role } = useRole();

  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [assetsState, setAssetsState] = useState<SectionState>("loading");
  const [assetsError, setAssetsError] = useState<string | null>(null);

  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [deploymentsState, setDeploymentsState] = useState<SectionState>("loading");
  const [deploymentsError, setDeploymentsError] = useState<string | null>(null);

  const [activity, setActivity] = useState<AuditEventItem[]>([]);
  const [activityState, setActivityState] = useState<ActivityState>("loading");
  const [activityError, setActivityError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadAssets() {
      setAssetsState("loading");
      setAssetsError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setAssets(data.items ?? []);
          setAssetsState("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setAssetsError(e instanceof Error ? e.message : String(e));
          setAssetsState("error");
        }
      }
    }
    loadAssets();
    return () => {
      cancelled = true;
    };
  }, [role.token]);

  useEffect(() => {
    let cancelled = false;
    async function loadDeployments() {
      setDeploymentsState("loading");
      setDeploymentsError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/deployments?page=1&page_size=100`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setDeployments(data.items ?? []);
          setDeploymentsState("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setDeploymentsError(e instanceof Error ? e.message : String(e));
          setDeploymentsState("error");
        }
      }
    }
    loadDeployments();
    return () => {
      cancelled = true;
    };
  }, [role.token]);

  useEffect(() => {
    let cancelled = false;
    async function loadActivity() {
      setActivityState("loading");
      setActivityError(null);

      // 최근 활동 카드는 사용자가 명시적으로 요청한 것이 아니라 홈 화면을 열면
      // 자동으로 실행되는 배경 조회다. 현재 역할에 AUDIT_READ 권한이 없다는
      // 것을 클라이언트가 이미 알고 있다면 요청 자체를 보내지 않는다 — 그렇지
      // 않으면 portal-api가 홈 화면을 열 때마다 PERMISSION_DENIED:AUDIT_READ
      // 감사 이벤트를 기록하게 되어, 실제 권한 거부 시도(예: /audit 페이지로의
      // 의도적 이동)와 구분되지 않는 노이즈로 감사 로그를 채운다. 서버가 이
      // 권한의 유일한 기준이며 이 검사는 UX 편의일 뿐이므로, 서버 정책이
      // 클라이언트의 가정과 다를 수 있는 예외 상황을 위해 아래 403 처리는
      // 그대로 남겨둔다.
      if (!canReadAudit(role.code)) {
        if (!cancelled) setActivityState("forbidden");
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/audit-events?page_size=8`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (res.status === 403) {
          if (!cancelled) setActivityState("forbidden");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setActivity(data.items ?? []);
          setActivityState("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setActivityError(e instanceof Error ? e.message : String(e));
          setActivityState("error");
        }
      }
    }
    loadActivity();
    return () => {
      cancelled = true;
    };
  }, [role.token, role.code]);

  const knowledgeAssets = assets.filter((a) => a.type === "knowledge");
  const pendingReviewAssets = assets.filter((a) => latestVersion(a)?.status === "IN_REVIEW");
  const activeChatbots = deployments.filter((d) => d.status === "ACTIVE");

  const newAssetsThisWeek = assets.filter((a) => isWithinLastWeek(a.created_at)).length;
  const newChatbotsThisWeek = deployments.filter(
    (d) => d.status === "ACTIVE" && isWithinLastWeek(d.created_at)
  ).length;

  const recentAssets = [...assets]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Welcome Banner — 스타일 가이드 §8.1 */}
      <div className="relative overflow-hidden rounded-card border border-border bg-gradient-to-br from-brand-600 to-brand-800 px-7 py-8 text-white shadow-card">
        <div className="relative z-10 max-w-xl">
          <h1 className="text-page-title font-bold">AI Asset Hub에 오신 것을 환영합니다.</h1>
          <p className="mt-2 text-body text-brand-100">
            AI 지식 자산을 체계적으로 관리하고, Knowledge 챗봇을 빠르게 구성·게시해 업무 생산성을
            높여보세요.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button href="/knowledge/new" variant="inverse" size="lg">
              <Database size={17} />
              지식 등록
            </Button>
            <Button href="/chatbots/new" variant="inverse-outline" size="lg">
              <MessageSquarePlus size={17} />
              챗봇 만들기
            </Button>
          </div>
        </div>

        {/* 추상적인 AI 자산 일러스트 (아이콘 배지 구성) — 외부 이미지 없이 lucide 아이콘만 사용 */}
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-72 items-center justify-center md:flex">
          <div className="absolute h-56 w-56 rounded-full bg-white/10 blur-2xl" />
          <div className="relative grid grid-cols-2 gap-4">
            <span className="flex h-16 w-16 translate-y-4 items-center justify-center rounded-2xl bg-white/15 text-white backdrop-blur">
              <BookOpen size={26} strokeWidth={1.5} />
            </span>
            <span className="flex h-16 w-16 -translate-y-3 items-center justify-center rounded-2xl bg-white/20 text-white backdrop-blur">
              <MessageSquare size={26} strokeWidth={1.5} />
            </span>
            <span className="flex h-16 w-16 -translate-y-1 items-center justify-center rounded-2xl bg-white/20 text-white backdrop-blur">
              <Sparkles size={26} strokeWidth={1.5} />
            </span>
            <span className="flex h-16 w-16 translate-y-6 items-center justify-center rounded-2xl bg-white/15 text-white backdrop-blur">
              <Package size={26} strokeWidth={1.5} />
            </span>
          </div>
        </div>
      </div>

      {/* KPI 카드 — 스타일 가이드 §8.2. 이 시스템에 실제로 존재하는 자산 유형(Knowledge)과
          실제로 계산 가능한 값만 표시한다. Prompt/Tool/Agent 카드는 아직 구현되지 않은
          기능이므로 "0"으로 표시하지 않고 아예 렌더링하지 않는다. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {assetsState === "loading" || deploymentsState === "loading" ? (
          <>
            <KpiCardSkeleton />
            <KpiCardSkeleton />
            <KpiCardSkeleton />
            <KpiCardSkeleton />
          </>
        ) : (
          <>
            <KpiCard
              icon={Package}
              iconClassName="bg-brand-100 text-brand-700"
              label="전체 자산"
              value={assetsState === "ok" ? assets.length : 0}
              caption={
                assetsState === "error"
                  ? "불러오지 못함"
                  : newAssetsThisWeek > 0
                  ? `최근 7일 신규 ${newAssetsThisWeek}건`
                  : "최근 7일 신규 없음"
              }
            />
            <KpiCard
              icon={BookOpen}
              iconClassName="bg-asset-knowledge/10 text-asset-knowledge"
              label="Knowledge"
              value={assetsState === "ok" ? knowledgeAssets.length : 0}
              caption={assetsState === "error" ? "불러오지 못함" : "지식 자산 수"}
            />
            <KpiCard
              icon={ClipboardCheck}
              iconClassName="bg-warning/10 text-warning"
              label="승인 대기"
              value={assetsState === "ok" ? pendingReviewAssets.length : 0}
              caption={assetsState === "error" ? "불러오지 못함" : "검토 진행 중인 버전"}
            />
            <KpiCard
              icon={MessageSquare}
              iconClassName="bg-asset-chatbot/10 text-asset-chatbot"
              label="챗봇"
              value={deploymentsState === "ok" ? activeChatbots.length : 0}
              caption={
                deploymentsState === "error"
                  ? "불러오지 못함"
                  : newChatbotsThisWeek > 0
                  ? `최근 7일 신규 게시 ${newChatbotsThisWeek}건`
                  : "게시된 챗봇 수"
              }
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* 최근 자산 — 스타일 가이드 §8.3 */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-section-title font-semibold text-text-primary">최근 자산</h2>
            <a
              href="/assets"
              className="inline-flex items-center gap-1 text-caption font-medium text-brand-600 hover:underline"
            >
              전체 보기
              <ArrowRight size={13} />
            </a>
          </div>

          {assetsState === "loading" && <LoadingState label="자산 목록을 불러오는 중..." />}
          {assetsState === "error" && (
            <ErrorBanner message={`최근 자산을 불러오지 못했습니다: ${assetsError}`} />
          )}
          {assetsState === "ok" && recentAssets.length === 0 && (
            <EmptyState
              icon={<Inbox size={36} strokeWidth={1.5} />}
              title="등록된 자산이 없습니다."
              action={
                <a href="/knowledge/new" className="text-caption font-medium text-brand-600 hover:underline">
                  첫 번째 지식을 등록하세요 →
                </a>
              }
            />
          )}
          {assetsState === "ok" && recentAssets.length > 0 && (
            <div className="divide-y divide-border">
              {recentAssets.map((asset) => {
                const ver = latestVersion(asset);
                return (
                  <button
                    key={asset.id}
                    onClick={() => router.push(`/assets/${asset.id}`)}
                    className="flex w-full items-center gap-3 py-3 text-left first:pt-0 last:pb-0 hover:bg-slate-50"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-asset-knowledge/10 text-asset-knowledge">
                      <BookOpen size={17} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-medium text-text-primary">{asset.name}</div>
                      <div className="mt-0.5 truncate text-caption text-text-secondary">
                        {asset.owner_org} · {formatDateTime(asset.created_at)}
                      </div>
                    </div>
                    {ver && <StatusBadge status={ver.status} />}
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        {/* 최근 활동 — 스타일 가이드 §8.4. AUDIT_READ 권한(AUDITOR/ADMIN)이 없는 역할에는
            빈 목록이 아니라 명시적인 권한 안내를 보여준다 (CLAUDE.md Permission 상태 원칙). */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-section-title font-semibold text-text-primary">최근 활동</h2>
            {activityState === "ok" && (
              <a
                href="/audit"
                className="inline-flex items-center gap-1 text-caption font-medium text-brand-600 hover:underline"
              >
                감사 로그 전체 보기
                <ArrowRight size={13} />
              </a>
            )}
          </div>

          {activityState === "loading" && <LoadingState label="활동 이력을 불러오는 중..." />}

          {activityState === "forbidden" && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-slate-50/60 px-4 py-10 text-center">
              <ShieldAlert size={32} className="mb-1 text-slate-300" strokeWidth={1.5} />
              <p className="text-body font-medium text-text-primary">
                이 역할에는 활동 이력 조회 권한이 없습니다.
              </p>
              <p className="text-caption text-text-secondary">
                현재 역할: {role.label}. 감사자 또는 관리자 역할에서 확인할 수 있습니다.
              </p>
            </div>
          )}

          {activityState === "error" && (
            <ErrorBanner message={`활동 이력을 불러오지 못했습니다: ${activityError}`} />
          )}

          {activityState === "ok" && activity.length === 0 && (
            <EmptyState icon={<Activity size={36} strokeWidth={1.5} />} title="최근 활동이 없습니다." />
          )}

          {activityState === "ok" && activity.length > 0 && (
            <ul className="divide-y divide-border">
              {activity.map((event) => {
                const Icon = activityIcon(event.event_type);
                const denied = event.result === "DENIED";
                return (
                  <li
                    key={event.id}
                    className={`flex items-start gap-3 py-3 first:pt-0 last:pb-0 ${
                      denied ? "bg-danger/5" : ""
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        denied ? "bg-danger/10 text-danger" : "bg-slate-100 text-text-secondary"
                      }`}
                    >
                      <Icon size={15} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-body font-medium text-text-primary">
                          {describeEventType(event.event_type)}
                        </span>
                        <Badge tone={RESULT_TONE[event.result] ?? "neutral"}>
                          {RESULT_LABEL[event.result] ?? event.result}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate text-caption text-text-secondary">
                        {event.actor_id} · {RESOURCE_TYPE_LABEL[event.resource_type] ?? event.resource_type}
                      </div>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-caption text-text-muted">
                      {formatDateTime(event.timestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* 빠른 시작 — 스타일 가이드 §8.5. 실제 존재하는 생성 화면으로만 연결한다. */}
      <div>
        <h2 className="mb-3 text-section-title font-semibold text-text-primary">빠른 시작</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {QUICK_START.map((item) => (
            <Card key={item.href} href={item.href} className="flex items-start gap-3 p-5">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${item.accent}`}>
                <item.icon size={20} strokeWidth={1.75} />
              </span>
              <div>
                <div className="text-card-title font-semibold text-text-primary">{item.label}</div>
                <div className="mt-0.5 text-caption text-text-secondary">{item.desc}</div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
