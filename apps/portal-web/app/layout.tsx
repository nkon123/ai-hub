import type { Metadata } from "next";
import { Search, Sparkles } from "lucide-react";
import { NavLinks } from "./_components/nav-links";
import { RoleProvider } from "./_components/role-context";
import { RoleSwitcher } from "./_components/role-switcher";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enterprise AI Asset Hub",
  description: "AI 지식 자산 관리 포털",
};

// Sidebar width — style guide §4.2 "240px 내외". Kept as one constant so the
// fixed sidebar and the content column's offset can never drift apart.
const SIDEBAR_WIDTH = "w-60"; // 240px
const SIDEBAR_OFFSET = "pl-60";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <RoleProvider>
          <div className="min-h-screen bg-background">
            {/* Left sidebar — style guide §4.2: fixed, ~240px, white, right
                border, icon+label items, current item highlighted. */}
            <aside
              className={`fixed inset-y-0 left-0 z-40 flex ${SIDEBAR_WIDTH} flex-col border-r border-border bg-white`}
            >
              <a href="/" className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white">
                  <Sparkles size={18} strokeWidth={2} />
                </span>
                <span className="text-card-title font-bold text-text-primary">AI Asset Hub</span>
              </a>
              <NavLinks />
            </aside>

            <div className={`flex min-h-screen flex-col ${SIDEBAR_OFFSET}`}>
              {/* Top header — style guide §4.3: 64-72px, white, bottom
                  border, search left, status/profile right. There is no
                  global search backend or notification system yet (see
                  CLAUDE.md's disabled-with-reason rule), so search renders
                  visibly disabled instead of being faked, and the
                  notification/help icons are omitted rather than faked. The
                  role switcher is our one real "user profile" affordance. */}
              <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-white px-6">
                <div className="flex min-w-0 flex-1 items-center">
                  <div
                    className="flex w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-slate-50 px-3 py-2 text-text-muted"
                    title="통합 검색은 아직 제공되지 않습니다. 자산 카탈로그의 검색을 이용하세요."
                  >
                    <Search size={16} className="shrink-0" />
                    <input
                      type="text"
                      disabled
                      placeholder="통합 검색 (준비 중)"
                      aria-label="통합 검색 (준비 중, 자산 카탈로그의 검색을 이용하세요)"
                      className="w-full cursor-not-allowed bg-transparent text-body text-text-muted placeholder:text-text-muted focus:outline-none"
                    />
                  </div>
                </div>
                <RoleSwitcher />
              </header>

              {/* Main content — background #F7F8FC, no max-width cap per
                  §4.4 (kept full-width/responsive; individual pages may
                  still cap prose-heavy sections for readability). */}
              <main className="flex-1 px-6 py-8 md:px-8">{children}</main>
            </div>
          </div>
        </RoleProvider>
      </body>
    </html>
  );
}
