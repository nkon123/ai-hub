"use client";

import { usePathname } from "next/navigation";
import {
  BookOpen,
  ClipboardCheck,
  Cog,
  Database,
  Download,
  FolderKanban,
  History,
  Home,
  Layers,
  MessageSquarePlus,
  PackageOpen,
  PlusCircle,
  Rocket,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavSection {
  /** Group label rendered above its items — a heading, never a link. */
  section: string;
  items: NavLink[];
}

// Always visible above any grouping. P07 내 자산은 지식/에이전트/서비스 중
// 특정 자산 유형 생성 흐름에 속하지 않고(그 구분들은 각 §NAV_SECTIONS의
// 소유 모듈 기준) 소유자 본인의 자산을 유형 불문 가로질러 보여주는 개인
// 작업 공간이라 기존 섹션 어디에도 깔끔히 들어가지 않는다 — 카탈로그
// (`/assets`, 전체 공개 뷰)의 "내 것만 보기" 대응 화면이므로 그 옆에
// 최상위 항목으로 둔다. P04 자산 유형 선택(`/assets/new`)도 같은 이유로
// 여기 둔다 — Knowledge/Agent/Prompt/MCP Tool/AI Service 중 어느 한
// §NAV_SECTIONS에도 속하지 않는, 모든 유형의 등록 진입점이다.
const TOP_LEVEL_LINKS: NavLink[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/assets", label: "자산 카탈로그", icon: BookOpen },
  { href: "/assets/new", label: "자산 등록", icon: PlusCircle },
  { href: "/my/assets", label: "내 자산", icon: FolderKanban },
];

// Grouped by 업무 대분류. Data-driven so a later addition (e.g. 거버넌스 grows
// an /admin/lifecycle item) is a one-line change to an existing group's
// `items` array rather than a markup change.
//
// Style guide §4.2/§14 also lists Prompt/Tool/Agent/Workflow/MCP as separate
// menu items, but this build manages every asset type through the single
// unified 자산 카탈로그 (`/assets`) rather than per-type screens — adding
// those as extra menu items would duplicate that catalog and imply screens
// that don't exist, so they're intentionally omitted rather than shown
// disabled.
//
// Knowledge 품질 (`/knowledge/[assetId]/quality`) is intentionally not a nav
// item — it requires an asset id and is reached from asset detail, not the
// sidebar.
const NAV_SECTIONS: NavSection[] = [
  {
    section: "지식",
    items: [{ href: "/knowledge/new", label: "지식 등록", icon: Database }],
  },
  {
    section: "에이전트",
    items: [{ href: "/chatbots/new", label: "챗봇 만들기", icon: MessageSquarePlus }],
  },
  {
    section: "서비스",
    items: [
      // P17 목록(/services)이 여기 목적지다 — Composer(/services/new)로 바로 보내면
      // 이미 구성된 6개 Service가 조회 API 부재로 만든 즉시 안 보이던 원래 문제와
      // 똑같이 "만들고 나면 사라지는" 사용자 경험이 된다. "새 서비스 만들기"는 목록
      // 화면 안의 CTA(P17 §행동)로 옮기고, 이 메뉴는 결과를 확인하는 화면을
      // 가리킨다 — /deployments("게시 관리")가 /deployments/new가 아니라 목록을
      // 가리키는 것과 동일한 원칙.
      { href: "/services", label: "AI Service", icon: Layers },
      { href: "/deployments", label: "게시 관리", icon: Rocket },
      { href: "/distributions", label: "반출 요청", icon: PackageOpen },
    ],
  },
  {
    section: "거버넌스",
    items: [
      { href: "/reviews", label: "검토함", icon: ClipboardCheck },
      { href: "/downloads", label: "다운로드 이력", icon: Download },
      { href: "/audit", label: "감사 로그", icon: ShieldCheck },
      { href: "/admin/lifecycle", label: "수명주기·회수", icon: History },
      // P15 관리자 설정 — style guide §4.2/§14의 "System Settings" 자리를
      // 대신한다(PLANNED_LINKS의 "시스템 설정" 준비 중 항목을 대체). ADMIN이
      // 아닌 역할도 항목 자체는 보되(다른 거버넌스 링크와 동일 관례 — 화면
      // 진입 후 서버 판정에 따라 권한 없음 상태를 봄), 실제 통제는 서버의
      // Permission.ADMIN_SETTINGS_READ가 전담한다.
      { href: "/admin/settings", label: "관리자 설정", icon: Cog },
    ],
  },
];

// Style guide §4.2/§14 admin section (Datasets, User Management) has no
// implementation yet in this build. Kept here — disabled, with a visible
// 준비 중 reason — only for structural fidelity to the guide's sidebar
// shape; CLAUDE.md prohibits creating dead links, so these render as inert
// rows, never as <a> tags. ("System Settings" moved out of this list — see
// "관리자 설정" above, now a real read-only P15 screen.)
const PLANNED_LINKS: { label: string; icon: LucideIcon }[] = [
  { label: "데이터셋", icon: Database },
  { label: "사용자 관리", icon: Users },
];

function isActive(pathname: string | null, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

function sectionHeadingId(section: string) {
  return `nav-section-${section}`;
}

function NavItem({ link, active }: { link: NavLink; active: boolean }) {
  const Icon = link.icon;
  return (
    <li>
      <a
        href={link.href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-body font-medium transition-colors ${
          active
            ? "bg-brand-100 text-brand-700"
            : "text-text-secondary hover:bg-slate-50 hover:text-text-primary"
        }`}
      >
        <Icon size={20} strokeWidth={1.75} className="shrink-0" />
        <span>{link.label}</span>
      </a>
    </li>
  );
}

/** Left sidebar menu — style guide §4.2. */
export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="주요 메뉴" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
      <ul className="flex flex-col gap-1">
        {TOP_LEVEL_LINKS.map((link) => (
          <NavItem key={link.href} link={link} active={isActive(pathname, link.href)} />
        ))}
      </ul>

      {NAV_SECTIONS.map(({ section, items }) => {
        const headingId = sectionHeadingId(section);
        return (
          <div key={section} className="flex flex-col gap-1">
            <p
              id={headingId}
              className="px-3 text-caption font-semibold uppercase tracking-wide text-text-muted"
            >
              {section}
            </p>
            <ul aria-labelledby={headingId} className="flex flex-col gap-1">
              {items.map((link) => (
                <NavItem key={link.href} link={link} active={isActive(pathname, link.href)} />
              ))}
            </ul>
          </div>
        );
      })}

      <div className="flex flex-col gap-1">
        <p
          id={sectionHeadingId("관리")}
          className="px-3 text-caption font-semibold uppercase tracking-wide text-text-muted"
        >
          관리 (준비 중)
        </p>
        <ul aria-labelledby={sectionHeadingId("관리")} className="flex flex-col gap-1">
          {PLANNED_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <li
                key={item.label}
                title="다음 릴리스에서 제공 예정입니다."
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2.5 text-body text-slate-400"
              >
                <Icon size={20} strokeWidth={1.75} className="shrink-0" />
                <span className="flex-1">{item.label}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-400">
                  준비 중
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
