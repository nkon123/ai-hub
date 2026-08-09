import { useState } from "react";
import { Database, FileText, Home, MessageSquare, Package, RefreshCcw, Store, Wifi } from "lucide-react";
import { HomeScreen } from "./screens/HomeScreen";
import { ImportScreen } from "./screens/ImportScreen";
import { StoreScreen } from "./screens/StoreScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { AssetsScreen } from "./screens/AssetsScreen";
import { UpdateScreen } from "./screens/UpdateScreen";
import { LogsScreen } from "./screens/LogsScreen";

type Tab = "home" | "store" | "import" | "chat" | "assets" | "update" | "connections" | "logs";

const TABS: Array<{ id: Tab; label: string; icon: typeof Home }> = [
  { id: "home", label: "홈", icon: Home },
  { id: "store", label: "스토어", icon: Store },
  { id: "import", label: "가져오기", icon: Package },
  { id: "chat", label: "대화", icon: MessageSquare },
  { id: "assets", label: "자산 관리", icon: Database },
  { id: "update", label: "업데이트/복구", icon: RefreshCcw },
  { id: "connections", label: "연결 상태", icon: Wifi },
  { id: "logs", label: "로그/진단", icon: FileText },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  // Bumping this remounts HomeScreen so it reloads the asset list right
  // after a successful import, without HomeScreen and ImportScreen having
  // to share state directly.
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);

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
          {tab === "home" && <HomeScreen key={homeRefreshKey} onGoToImport={() => setTab("import")} />}
          {tab === "store" && (
            <StoreScreen onGoToImport={() => setTab("import")} onInstalled={() => setHomeRefreshKey((k) => k + 1)} />
          )}
          {tab === "import" && <ImportScreen onInstalled={() => setHomeRefreshKey((k) => k + 1)} />}
          {tab === "chat" && <ChatScreen />}
          {tab === "assets" && <AssetsScreen />}
          {tab === "update" && <UpdateScreen onGoToImport={() => setTab("import")} />}
          {tab === "connections" && <ConnectionsScreen />}
          {tab === "logs" && <LogsScreen />}
        </main>
      </div>
    </div>
  );
}
