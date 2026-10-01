"use client";

/**
 * 영구 삭제 구역 — 자산(지식 상세 `/assets/[id]`, 프롬프트·MCP·에이전트 버전 화면
 * `/assets/[id]/versions`)과 서비스(`/services/[versionId]`)가 **같은 것**을 쓴다. 화면마다 복사해 두면
 * 한쪽의 규칙만 바뀐다.
 *
 * 누가 무엇을 지울 수 있는가(서버 `DELETE /assets/{id}`·`DELETE /services/{id}` 와 같은 규칙,
 * D-109·D-110):
 * - 제작자(소유자): 초안·수정 요청 상태만.
 * - 관리자(ADMIN): 승인 절차에 들어간 것도. 단 자산은 서비스·다른 자산·배포 요청·회수 기록이, 서비스는
 *   **게시 중인 배포**나 반출 기록이 가리키면 서버가 거절하고, 그 이유가 대화상자에 그대로 나온다.
 * 서버가 확실히 거절할 경우에는 버튼을 보여 주지 않는다. 최종 판정은 서버가 한다.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button, ReasonDialog } from "./ui";
import { useRole } from "./role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type DeletableKind = "asset" | "service";

const KIND_META: Record<
  DeletableKind,
  { noun: string; path: string; redirect: string; draftNote: string; approvedNote: string; dialogNote: string }
> = {
  asset: {
    noun: "자산",
    path: "assets",
    redirect: "/assets",
    draftNote:
      "아직 검토를 요청하지 않은 초안입니다. 모든 버전과 업로드한 문서, 만들어진 색인이 함께 영구 삭제되며 되돌릴 수 없습니다.",
    approvedNote:
      "관리자만 삭제할 수 있고, 서비스·다른 자산·배포 요청·회수 기록에서 쓰이고 있으면 삭제되지 않습니다. 모든 버전과 검토·평가 기록, 업로드한 문서, 만들어진 색인이 함께 영구 삭제되며 되돌릴 수 없습니다(감사 로그는 남습니다). 서비스에서만 내리려면 중단 또는 지원 종료를 쓰세요.",
    dialogNote: "이 자산의 모든 버전과 업로드한 문서, 만들어진 색인이 함께 영구 삭제됩니다.",
  },
  service: {
    noun: "서비스",
    path: "services",
    redirect: "/services",
    draftNote:
      "아직 검토를 요청하지 않은 초안입니다. 모든 서비스 버전이 함께 영구 삭제되며 되돌릴 수 없습니다.",
    approvedNote:
      "관리자만 삭제할 수 있고, 게시(배포) 중이면 삭제되지 않습니다 — 먼저 게시 관리에서 게시를 종료하세요. 반출 기록이 있어도 삭제되지 않습니다. 모든 서비스 버전과 종료된 게시, 검토 기록이 함께 영구 삭제되며 되돌릴 수 없습니다(감사 로그는 남습니다). 이 서비스가 쓰는 지식·프롬프트 같은 자산은 그대로 남습니다.",
    dialogNote: "이 서비스의 모든 버전과 종료된 게시, 검토 기록이 함께 영구 삭제됩니다.",
  },
};

interface Props {
  kind: DeletableKind;
  resourceId: string;
  /** 확인 대화상자에서 다시 입력받는 이름(명세 §1.2). */
  resourceName: string;
  ownerCreatorId: string;
  versions: { status: string }[];
}

export function DeleteResourceSection({ kind, resourceId, resourceName, ownerCreatorId, versions }: Props) {
  const router = useRouter();
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KIND_META[kind];

  // 승인 절차에 들어간(초안·수정 요청이 아닌) 버전이 하나라도 있는가 — 서버의
  // `*_NOT_DELETABLE` 규칙과 같은 기준이다.
  const hasApprovalHistory = versions.some(
    (v) => v.status !== "DRAFT" && v.status !== "CHANGES_REQUESTED",
  );
  const canDelete =
    versions.length > 0 &&
    (role.code === "ADMIN" || (role.userId === ownerCreatorId && !hasApprovalHistory));
  if (!canDelete) return null;

  async function handleDelete(reason: string) {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/${meta.path}/${resourceId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `삭제하지 못했습니다. (오류 ${res.status})`);
        return;
      }
      // 방금 지운 것의 화면에 남아 있을 이유가 없다.
      router.push(meta.redirect);
    } catch {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="rounded-card border border-danger/30 bg-danger/5 p-5">
        <h2 className="text-card-title font-semibold text-danger">{meta.noun} 삭제</h2>
        <p className="mt-1.5 text-body text-text-secondary">
          {hasApprovalHistory ? (
            <>
              <strong>승인 절차에 들어간 {meta.noun}입니다</strong>(
              {Array.from(new Set(versions.map((v) => v.status))).join(", ")}). {meta.approvedNote}
            </>
          ) : (
            meta.draftNote
          )}
        </p>
        <div className="mt-4">
          <Button
            variant="danger"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            <Trash2 size={16} />
            {meta.noun} 삭제
          </Button>
        </div>
      </div>

      <ReasonDialog
        open={open}
        title={`${meta.noun} 삭제 확인`}
        description={
          <>
            <strong className="text-danger">되돌릴 수 없습니다.</strong> {meta.dialogNote} 이 작업은
            감사 로그에 기록됩니다.
          </>
        }
        confirmLabel="영구 삭제"
        confirmVariant="danger"
        reasonLabel="삭제 사유"
        reasonPlaceholder="삭제 사유를 입력하세요 (필수)"
        confirmName={resourceName}
        submitting={deleting}
        error={error}
        onConfirm={handleDelete}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
      />
    </>
  );
}
