"use client";

/**
 * P07 내 자산 (01-portal-and-distribution.md §2 P07).
 *
 * 구분: 작성 중 / 자동검증 실패 / 검토 대기 / 반려 / 승인됨 / 지원 종료 예정
 * (portal-api `GET /api/v1/my/assets`가 6개 구분을 항상 포함해 반환한다 —
 * 화면은 그 순서와 구분을 그대로 사용한다). 각 행의 행동: 초안 편집, 검증
 * 결과 보기, 반려 의견 보기, 새 버전 만들기 — 모두 P06 버전 관리 화면
 * (`/assets/[id]/versions`)으로 연결되거나 그 자리에서 조회 전용 다이얼로그를
 * 연다.
 *
 * "담당자 변경 요청"은 명세에 있지만 이를 처리할 백엔드 개념(소유자 변경
 * Workflow)이 전혀 없어 구현하지 않는다 — 가짜 버튼을 만드는 대신
 * open-decisions.md D-058로 기록하고 이 행동 자체를 생략한다.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileEdit,
  Lock,
  MessageSquareWarning,
  PlusCircle,
  ShieldQuestion,
  X,
} from "lucide-react";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../../_components/ui";
import { DECISION_LABEL, STAGE_LABEL, formatDateTime } from "../../_components/review-meta";
import { useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

const CATEGORY_LABEL: Record<string, string> = {
  IN_PROGRESS: "작성 중",
  VALIDATION_FAILED: "자동검증 실패",
  PENDING_REVIEW: "검토 대기",
  REJECTED: "반려",
  APPROVED: "승인됨",
  DEPRECATED: "지원 종료 예정",
};

const CATEGORY_DESCRIPTION: Record<string, string> = {
  IN_PROGRESS: "아직 검토를 요청하지 않은 초안입니다.",
  VALIDATION_FAILED: "자동검증에 실패한 초안입니다. 오류를 수정한 뒤 다시 검증하세요.",
  PENDING_REVIEW: "기술/보안/배포 검토가 진행 중입니다.",
  REJECTED: "검토에서 반려되었습니다. 의견을 확인하고 새 버전을 만드세요.",
  APPROVED: "검토를 통과해 배포 가능한 버전입니다.",
  DEPRECATED: "지원 종료 예정이거나 완료된 버전입니다.",
};

const CATEGORY_TONE: Record<string, BadgeTone> = {
  IN_PROGRESS: "neutral",
  VALIDATION_FAILED: "danger",
  PENDING_REVIEW: "info",
  REJECTED: "danger",
  APPROVED: "success",
  DEPRECATED: "warning",
};

const ASSET_TYPE_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  agent: "Agent",
  prompt: "Prompt",
  mcp_tool: "MCP 도구",
  service: "서비스",
};

interface ReviewDecisionSummary {
  stage: string;
  decision: string;
  comments: string;
  reviewer_id: string;
  decided_at: string;
}

interface MyAssetRow {
  id: string;
  asset_id: string;
  asset_name: string;
  asset_type: string;
  version: string;
  status: string;
  category: string;
  validation_status: string;
  validation_errors: string[] | null;
  validated_at: string | null;
  latest_review_decision: ReviewDecisionSummary | null;
  can_create_new_version: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

interface MyAssetCategory {
  code: string;
  count: number;
  items: MyAssetRow[];
}

interface MyAssetsResponse {
  categories: MyAssetCategory[];
  total: number;
}

type LoadState = "loading" | "ok" | "forbidden" | "error";
type DialogState = { kind: "validation" | "decision"; row: MyAssetRow };

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function MyAssetsPage() {
  const { role } = useRole();
  const router = useRouter();

  const [data, setData] = useState<MyAssetsResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  async function load() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/my/assets`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (res.status === 403) {
        setState("forbidden");
        return;
      }
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
      setState("ok");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.token]);

  if (state === "loading") return <LoadingState label="내 자산을 불러오는 중..." />;

  if (state === "forbidden") {
    return (
      <div>
        <PageHeader title="내 자산" description="내가 소유한 자산 버전의 진행 상태를 확인합니다." />
        <EmptyState
          icon={<ShieldQuestion size={40} strokeWidth={1.5} />}
          title="이 역할에는 내 자산 조회 권한이 없습니다."
          description={`현재 역할: ${role.label}.`}
        />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div>
        <PageHeader title="내 자산" />
        <ErrorBanner message={`내 자산 정보를 불러오지 못했습니다: ${errorMessage}`} />
      </div>
    );
  }

  const categories = data?.categories ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="내 자산"
        description={
          total > 0
            ? `내가 소유한 자산 버전 ${total}건을 진행 상태별로 확인합니다.`
            : "내가 소유한 자산 버전의 진행 상태를 확인합니다."
        }
      />

      {total === 0 && (
        <EmptyState
          icon={<ClipboardList size={40} strokeWidth={1.5} />}
          title="소유한 자산 버전이 없습니다."
          description="지식 등록이나 챗봇 만들기에서 새 자산을 등록해 보세요."
          action={
            <Button size="sm" onClick={() => router.push("/knowledge/new")}>
              지식 등록하러 가기
            </Button>
          }
        />
      )}

      {total > 0 && (
        <div className="space-y-7">
          {categories.map((cat) => (
            <section key={cat.code}>
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-card-title font-semibold text-text-primary">
                  {CATEGORY_LABEL[cat.code] ?? cat.code}
                </h2>
                <Badge tone={CATEGORY_TONE[cat.code] ?? "neutral"}>{cat.count}</Badge>
              </div>
              <p className="mb-3 text-caption text-text-secondary">
                {CATEGORY_DESCRIPTION[cat.code]}
              </p>

              {cat.items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-surface px-4 py-3 text-caption text-text-muted">
                  해당 항목이 없습니다.
                </p>
              ) : (
                <div className="grid gap-2">
                  {cat.items.map((row) => (
                    <AssetRow
                      key={row.id}
                      row={row}
                      onEdit={() =>
                        router.push(`/assets/${row.asset_id}/versions?versionId=${row.id}`)
                      }
                      onNewVersion={() =>
                        router.push(`/assets/${row.asset_id}/versions?action=new`)
                      }
                      onShowValidation={() => setDialog({ kind: "validation", row })}
                      onShowDecision={() => setDialog({ kind: "decision", row })}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {dialog && (
        <InfoDialog
          title={dialog.kind === "validation" ? "자동검증 결과" : "검토 의견"}
          onClose={() => setDialog(null)}
        >
          {dialog.kind === "validation" ? (
            <ValidationDetail row={dialog.row} />
          ) : (
            <DecisionDetail decision={dialog.row.latest_review_decision} />
          )}
        </InfoDialog>
      )}
    </div>
  );
}

function AssetRow({
  row,
  onEdit,
  onNewVersion,
  onShowValidation,
  onShowDecision,
}: {
  row: MyAssetRow;
  onEdit: () => void;
  onNewVersion: () => void;
  onShowValidation: () => void;
  onShowDecision: () => void;
}) {
  const editDisabledReason = row.can_edit
    ? null
    : `현재 상태(${row.status})의 버전은 편집할 수 없습니다.`;
  const newVersionDisabledReason = row.can_create_new_version
    ? null
    : "승인된 버전이 없어 새 버전을 만들 수 없습니다.";
  const decisionDisabledReason = row.latest_review_decision ? null : "아직 검토 의견이 없습니다.";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold text-text-primary">{row.asset_name}</span>
            <Badge tone="neutral">{ASSET_TYPE_LABEL[row.asset_type] ?? row.asset_type}</Badge>
            <span className="text-caption text-text-muted">v{row.version}</span>
            <StatusBadge status={row.status} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
            <span>최근 수정: {formatDateTime(row.updated_at)}</span>
            {row.category === "VALIDATION_FAILED" && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertTriangle size={12} />
                오류 {row.validation_errors?.length ?? 0}건
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <RowActionButton
          icon={<FileEdit size={13} />}
          label="초안 편집"
          disabledReason={editDisabledReason}
          onClick={onEdit}
        />
        <RowActionButton
          icon={<CheckCircle2 size={13} />}
          label="검증 결과 보기"
          disabledReason={null}
          onClick={onShowValidation}
        />
        <RowActionButton
          icon={<MessageSquareWarning size={13} />}
          label="반려 의견 보기"
          disabledReason={decisionDisabledReason}
          onClick={onShowDecision}
        />
        <RowActionButton
          icon={<PlusCircle size={13} />}
          label="새 버전 만들기"
          disabledReason={newVersionDisabledReason}
          onClick={onNewVersion}
        />
      </div>
    </Card>
  );
}

function RowActionButton({
  icon,
  label,
  disabledReason,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  const disabled = !!disabledReason;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      title={disabledReason ?? undefined}
      onClick={onClick}
    >
      {disabled ? <Lock size={12} /> : icon}
      {label}
    </Button>
  );
}

function InfoDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="rounded p-1 text-text-muted hover:bg-slate-100 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-3">{children}</div>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}

function ValidationDetail({ row }: { row: MyAssetRow }) {
  if (row.validation_status === "NOT_RUN") {
    return <p className="text-body text-text-secondary">아직 자동검증을 실행하지 않았습니다.</p>;
  }
  if (row.validation_status === "PASSED") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-body text-success">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
        <span>
          자동검증을 통과했습니다.
          {row.validated_at && (
            <span className="block text-caption text-text-secondary">
              검증 시각: {formatDateTime(row.validated_at)}
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-body text-danger">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>
          자동검증에 실패했습니다.
          {row.validated_at && (
            <span className="block text-caption text-text-secondary">
              검증 시각: {formatDateTime(row.validated_at)}
            </span>
          )}
        </span>
      </div>
      {row.validation_errors && row.validation_errors.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-text-secondary">
          {row.validation_errors.map((err, idx) => (
            <li key={idx}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionDetail({ decision }: { decision: ReviewDecisionSummary | null }) {
  if (!decision) {
    return <p className="text-body text-text-secondary">아직 검토 의견이 없습니다.</p>;
  }
  return (
    <div className="space-y-2 text-body">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{STAGE_LABEL[decision.stage] ?? decision.stage}</Badge>
        <Badge tone={decision.decision === "APPROVE" ? "success" : "danger"}>
          {DECISION_LABEL[decision.decision] ?? decision.decision}
        </Badge>
        <span className="text-caption text-text-muted">{formatDateTime(decision.decided_at)}</span>
      </div>
      <p className="text-text-primary">{decision.comments}</p>
      <p className="text-caption text-text-secondary">검토자: {decision.reviewer_id}</p>
    </div>
  );
}
