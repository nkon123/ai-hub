"use client";

import { usePathname } from "next/navigation";
import {
  ClipboardCheck,
  Cog,
  Database,
  Download,
  FolderKanban,
  History,
  Layers,
  Lightbulb,
  PackageOpen,
  Rocket,
  Server,
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

// 메뉴에 **없는** 것 셋과 그 이유(다음에 "빠졌네" 하고 되돌리지 않도록):
// - 홈(`/`): 좌상단 "AI Asset Hub" 타이틀(`layout.tsx`)이 이미 `/` 링크다.
// - 전체 카탈로그(`/assets`, P02): "자산" 섹션의 유형별 목록이 일상 진입점이
//   되면서 뺐다. 화면은 살아 있고 홈·지식 등록 완료 화면·자산 상세의
//   "목록으로"가 가리킨다.
// - 자산 유형 선택(`/assets/new`, P04): 유형별 목록 화면이 각자 우상단에 자기
//   유형의 등록 버튼을 갖게 되면서 중간 단계가 됐다. 화면은 살아 있고
//   `/assets/new/[type]` Wizard가 되돌아갈 곳으로 쓴다.
//
// Grouped by 업무 대분류. Data-driven so a later addition (e.g. 거버넌스 grows
// an /admin/lifecycle item) is a one-line change to an existing group's
// `items` array rather than a markup change.
//
// Style guide §4.2/§14 lists Prompt/Tool/Agent/Workflow/MCP as separate menu
// items; 이 빌드는 그중 실제 화면이 있는 유형만 "자산" 섹션에 노출한다.
//
// Knowledge 품질 (`/knowledge/[assetId]/quality`) is intentionally not a nav
// item — it requires an asset id and is reached from asset detail, not the
// sidebar.
const NAV_SECTIONS: NavSection[] = [
  {
    // 유형별 자산 목록. 한 유형만 보여주는 목록 화면이고, 그 유형을 새로 만드는
    // 버튼은 메뉴가 아니라 **각 화면 우상단**에 있다 — 메뉴는 "무엇이 있는가"를,
    // 화면은 "무엇을 만드는가"를 담당한다(그래서 "지식 등록"·"챗봇 만들기"가
    // 각각 있던 옛 "지식"·"에이전트" 섹션은 없앴다).
    //
    // "서비스"(P17 `/services`)가 이 셋과 나란히 있는 이유: 사용자에게 AI
    // Service 도 등록·관리하는 자산의 한 종류다. 챗봇 빠른 만들기·Agent 자산
    // 등록·AI Service Composer 세 진입점을 그 화면 우상단에 모았다 —
    // Composer(`/services/new`)로 메뉴를 바로 연결하면 만든 결과를 확인할
    // 화면을 거치지 않게 된다.
    section: "자산",
    items: [
      { href: "/assets/knowledge", label: "지식", icon: Database },
      { href: "/assets/prompts", label: "프롬프트", icon: Lightbulb },
      // mcp_server 와 이전 방식 mcp_tool 을 한 화면에서 함께 보여준다.
      { href: "/assets/mcp", label: "MCP", icon: Server },
      { href: "/services", label: "서비스", icon: Layers },
      // P07 내 자산은 유형을 가로지르는 개인 작업 공간이다(내가 올린 것만,
      // 유형 불문). 위 항목들이 "무엇이 있는가"라면 이건 "그중 내 것"이라
      // 같은 섹션의 마지막에 둔다.
      { href: "/my/assets", label: "내 자산", icon: FolderKanban },
    ],
  },
  {
    // 만들어진 서비스를 내보내는 쪽 — 자산 자체가 아니라 그 자산으로 하는 일이다.
    // /deployments·/distributions 둘 다 목록을 가리킨다(신규 생성은 각 화면 안).
    section: "운영",
    items: [
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

function matches(pathname: string | null, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

/**
 * 현재 경로에 해당하는 Nav 항목은 **하나**다 — 가장 구체적으로 일치하는 항목.
 *
 * 접두사 일치만 쓰면 중첩된 경로에서 항목 두 개가 동시에 강조된다(`/assets/new`
 * 는 "자산 카탈로그"와 "자산 등록" 둘 다에, `/assets/knowledge` 는 "자산
 * 카탈로그"와 "지식" 둘 다에 걸린다). 일치하는 href 중 가장 긴 것만 남긴다.
 */
function activeHref(pathname: string | null, links: NavLink[]): string | null {
  return links
    .filter((link) => matches(pathname, link.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

const ALL_LINKS: NavLink[] = NAV_SECTIONS.flatMap((section) => section.items);

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
  const active = activeHref(pathname, ALL_LINKS);

  return (
    <nav aria-label="주요 메뉴" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
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
                <NavItem key={link.href} link={link} active={link.href === active} />
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
