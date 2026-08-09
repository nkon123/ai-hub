"use client";

/**
 * P04 자산 유형 선택 (01-portal-and-distribution.md §2 P04).
 *
 * 명세: "카드가 아니라 간결한 목록으로" 5개 유형을 설명하고, "각 유형은
 * 필요한 사전 준비, 예상 파일, 검토 범위를 표시한다." — 그래서 아래는
 * `Card`를 다열 그리드가 아니라 세로로 쌓은 단일 열 목록(다른 목록 화면인
 * `/admin/lifecycle`과 동일한 관례)으로 렌더링한다.
 *
 * Knowledge와 AI Service는 이미 동작하는 전용 화면(`/knowledge/new`,
 * `/services/new`)이 있으므로 그리로 바로 링크한다 — 이 화면 자체나
 * `/assets/new/[type]` Wizard로 절대 라우팅하지 않는다(과제 지시사항,
 * `/knowledge/new`·`/services/new`는 수정 금지).
 *
 * 자산 등록(`POST /api/v1/assets`, 그리고 그 사전 점검인
 * `POST /api/v1/manifests/validate`)은 CREATOR 또는 ADMIN만 호출할 수
 * 있다(Permission.ASSET_CREATE). 이 화면은 순수 내비게이션이라 목록 자체는
 * 누구에게나 보여주고, 대신 다른 역할일 때는 다음 화면에서 실제 제출이
 * 막힌다는 사실을 안내 문구로 미리 알려준다(하드 블록 아님).
 */

import {
  BookOpen,
  Database,
  Layers,
  Lock,
  MessageSquareCode,
  Puzzle,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, Card, PageHeader } from "../../_components/ui";
import { useRole } from "../../_components/role-context";

const CAN_CREATE_ROLES = new Set(["CREATOR", "ADMIN"]);

interface AssetTypeRow {
  key: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** 사전 준비 · 예상 파일 · 검토 범위 (spec 문구). */
  prep: string;
  href: string;
  ctaLabel: string;
}

const ASSET_TYPES: AssetTypeRow[] = [
  {
    key: "knowledge",
    label: "Knowledge",
    icon: Database,
    description: "사전에 가공·검증된 검색 지식",
    prep: "사전 준비: Markdown 문서 · 예상 파일: 문서 원본(.md) · 검토 범위: 기술 검토",
    href: "/knowledge/new",
    ctaLabel: "지식 등록으로 이동",
  },
  {
    key: "agent",
    label: "Agent",
    icon: MessageSquareCode,
    description: "업무 흐름과 판단 로직",
    prep: "사전 준비: Workflow·Capability 정의 · 예상 파일: 선택(참고 자료) · 검토 범위: 기술·보안 검토",
    href: "/assets/new/agent",
    ctaLabel: "Agent 등록 시작",
  },
  {
    key: "prompt",
    label: "Prompt",
    icon: Puzzle,
    description: "모델 지침",
    prep: "사전 준비: System Prompt·변수 정의 · 예상 파일: Template 본문(.md, 필수) · 검토 범위: 기술 검토",
    href: "/assets/new/prompt",
    ctaLabel: "Prompt 등록 시작",
  },
  {
    key: "mcp_tool",
    label: "MCP Tool",
    icon: Wrench,
    description: "사내 시스템 기능",
    prep: "사전 준비: 연결 서버·입력 Schema 정의(읽기 전용만 가능) · 예상 파일: 선택 · 검토 범위: 보안 검토",
    href: "/assets/new/mcp_tool",
    ctaLabel: "MCP Tool 등록 시작",
  },
  {
    key: "service",
    label: "AI Service",
    icon: Layers,
    description: "기존 자산을 조합한 완성된 업무 서비스",
    prep: "사전 준비: 승인된 Agent·Knowledge·MCP·Prompt · 예상 파일: 없음(Wizard로만 구성) · 검토 범위: 배포 승인",
    href: "/services/new",
    ctaLabel: "AI Service Composer로 이동",
  },
];

export default function AssetTypeSelectPage() {
  const { role } = useRole();
  const canCreate = CAN_CREATE_ROLES.has(role.code);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="자산 유형 선택"
        description="등록할 자산의 유형을 선택하세요. 유형별로 필요한 사전 준비와 검토 범위가 다릅니다."
        actions={<Button href="/assets" variant="secondary" size="sm"><BookOpen size={15} />자산 카탈로그</Button>}
      />

      {!canCreate && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <Lock size={15} className="mt-0.5 shrink-0" />
          <span>
            현재 역할({role.label})은 조회만 가능합니다. Knowledge와 AI Service 화면은 열람할 수 있지만,
            Agent·Prompt·MCP Tool 등록을 실제로 제출하려면 자산 제작자(CREATOR) 또는 관리자 역할이
            필요합니다.
          </span>
        </div>
      )}

      <div className="grid gap-3">
        {ASSET_TYPES.map((row) => {
          const Icon = row.icon;
          return (
            <Card key={row.key} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon size={20} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-card-title font-semibold text-text-primary">{row.label}</span>
                      <Badge tone="neutral">{row.description}</Badge>
                    </div>
                    <p className="mt-1.5 text-caption text-text-secondary">{row.prep}</p>
                  </div>
                </div>
                <Button href={row.href} size="sm" className="shrink-0">
                  {row.ctaLabel}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
