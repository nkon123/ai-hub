import { useState } from "react";
import {
  Database,
  FileText,
  Home,
  Info,
  MessageSquare,
  Package,
  RefreshCcw,
  Settings as SettingsIcon,
  Sparkles,
  Store,
  Wifi,
} from "lucide-react";
import { HomeScreen } from "./screens/HomeScreen";
import { ImportScreen } from "./screens/ImportScreen";
import { StoreScreen } from "./screens/StoreScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { AssetsScreen } from "./screens/AssetsScreen";
import { UpdateScreen } from "./screens/UpdateScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { SetupWizardScreen } from "./screens/SetupWizardScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { InfoScreen } from "./screens/InfoScreen";
import { ServiceDetailScreen, type ServiceDetailTarget } from "./screens/ServiceDetailScreen";

type Tab = "home" | "store" | "import" | "chat" | "assets" | "update" | "connections" | "logs" | "setup" | "settings" | "info" | "detail";

const TABS: Array<{ id: Tab; label: string; icon: typeof Home }> = [
  { id: "home", label: "홈", icon: Home },
  { id: "store", label: "스토어", icon: Store },
  { id: "import", label: "가져오기", icon: Package },
  { id: "chat", label: "대화", icon: MessageSquare },
  { id: "assets", label: "자산 관리", icon: Database },
  { id: "update", label: "업데이트/복구", icon: RefreshCcw },
  { id: "connections", label: "연결 상태", icon: Wifi },
  { id: "logs", label: "로그/진단", icon: FileText },
  { id: "setup", label: "최초 설정", icon: Sparkles },
  { id: "settings", label: "설정", icon: SettingsIcon },
  { id: "info", label: "정보/보안", icon: Info },
  // "detail"(D03)은 사이드바에 없다 — D02/D08의 "상세" 버튼을 통해서만
  // 진입하는 Drill-down 화면이다(스펙 §3: D03은 목적/입력/의존성/버전/권한
  // 확인용 상세 화면).
];

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  // Bumping this remounts HomeScreen so it reloads the asset list right
  // after a successful import, without HomeScreen and ImportScreen having
  // to share state directly.
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  // D03 진입 대상 — D02(HomeScreen)/D08(AssetsScreen)의 "상세" 버튼이
  // 설정하고, "detail" 탭으로 전환한다. 이전 탭으로 돌아갈 곳을 함께
  // 기억해 "뒤로"가 항상 올바른 화면으로 되돌아가게 한다.
  const [detailTarget, setDetailTarget] = useState<ServiceDetailTarget | null>(null);
  const [detailReturnTab, setDetailReturnTab] = useState<Tab>("home");

  function openDetail(target: ServiceDetailTarget, fromTab: Tab) {
    setDetailTarget(target);
    setDetailReturnTab(fromTab);
    setTab("detail");
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Style guide §4.3: 64-72px header, white, bottom border. */}
      <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-xs font-bold text-white">
            AI
          </div>
          <div className="leading-tight">
            <div className="text-card-title font-semibold text-text-primary">AI Asset Hub</div>
            <div className="text-caption text-text-muted">Desktop · 폐쇄망 클라이언트</div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Style guide §4.2: ~240px sidebar, white, right border. */}
        <nav className="w-60 shrink-0 border-r border-border bg-surface p-4">
          <ul className="space-y-1">
            {TABS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setTab(id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-body font-medium transition-colors ${
                    tab === id ? "bg-brand-50 text-brand-700" : "text-text-secondary hover:bg-background"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Style guide §4.4: #F7F8FC content background, 24-32px padding. */}
        <main className="flex-1 overflow-y-auto bg-background p-8">
          {tab === "home" && (
            <HomeScreen key={homeRefreshKey} onGoToImport={() => setTab("import")} onOpenDetail={(a) => openDetail(a, "home")} />
          )}
          {tab === "store" && (
            <StoreScreen onGoToImport={() => setTab("import")} onInstalled={() => setHomeRefreshKey((k) => k + 1)} />
          )}
          {tab === "import" && <ImportScreen onInstalled={() => setHomeRefreshKey((k) => k + 1)} />}
          {tab === "chat" && <ChatScreen />}
          {tab === "assets" && <AssetsScreen onOpenDetail={(a) => openDetail(a, "assets")} />}
          {tab === "update" && <UpdateScreen onGoToImport={() => setTab("import")} />}
          {tab === "connections" && <ConnectionsScreen />}
          {tab === "logs" && <LogsScreen />}
          {tab === "setup" && <SetupWizardScreen onCompleted={() => setTab("home")} />}
          {tab === "settings" && <SettingsScreen />}
          {tab === "info" && <InfoScreen />}
          {tab === "detail" && detailTarget && (
            <ServiceDetailScreen
              target={detailTarget}
              onBack={() => setTab(detailReturnTab)}
              onGoToChat={() => setTab("chat")}
              onRemoved={() => {
                setHomeRefreshKey((k) => k + 1);
                setTab(detailReturnTab);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
