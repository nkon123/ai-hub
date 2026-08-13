import { useState } from "react";
import { Database, MessageSquare, Settings as SettingsIcon } from "lucide-react";
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
import { Tabs } from "./ui";

// IA 재편(11개 사이드바 탭 -> 3개): 채팅 / 자산 허브 / 설정. "detail"(D03)과
// "setup"(D01)은 사이드바에 없는 Drill-down 화면이다 — 진입 시 어디서
// 왔는지를 함께 기억해 "뒤로"가 항상 올바른 화면으로 되돌아간다.
type MainTab = "chat" | "hub" | "settings" | "detail" | "setup";
type HubSubTab = "store" | "import" | "assets" | "update";
type SettingsSubTab = "general" | "connections" | "logs" | "info";

const MAIN_TABS: Array<{ id: MainTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "채팅", icon: MessageSquare },
  { id: "hub", label: "자산 허브", icon: Database },
  { id: "settings", label: "설정", icon: SettingsIcon },
];

const HUB_TABS: Array<{ id: HubSubTab; label: string }> = [
  { id: "store", label: "찾아 설치" },
  { id: "import", label: "ZIP 가져오기" },
  { id: "assets", label: "설치된 자산" },
  { id: "update", label: "복구" },
];

const SETTINGS_TABS: Array<{ id: SettingsSubTab; label: string }> = [
  { id: "general", label: "일반" },
  { id: "connections", label: "연결 상태" },
  { id: "logs", label: "로그·진단" },
  { id: "info", label: "정보·보안" },
];

export default function App() {
  // 대화 우선(Chat-first) 기본값 — Ollama Desktop 앱과 같은 정신으로, 실행
  // 시 곧바로 D06 대화 화면으로 진입한다.
  const [tab, setTab] = useState<MainTab>("chat");
  const [hubTab, setHubTab] = useState<HubSubTab>("store");
  const [settingsTab, setSettingsTab] = useState<SettingsSubTab>("general");

  // Bumping this remounts the 설치된 자산 화면 so it reloads the asset list
  // right after a successful import/store install, without the screens
  // having to share state directly.
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);

  // D03 진입 대상 — 자산 허브 > 설치된 자산의 "상세 보기" 버튼이 설정하고,
  // "detail" 탭으로 전환한다. 어느 메인/하위 탭에서 왔는지 함께 기억해
  // "뒤로"가 항상 올바른 화면으로 되돌아가게 한다.
  const [detailTarget, setDetailTarget] = useState<ServiceDetailTarget | null>(null);
  const [detailReturnTab, setDetailReturnTab] = useState<HubSubTab>("assets");

  // 최초 설정 Wizard(D01) — 사이드바에서 뺐다. 설정 > 일반의 "최초 설정 다시
  // 실행" 버튼으로만 진입하고, 완료되면 항상 그 버튼이 있던 곳(설정 > 일반)
  // 으로 되돌아간다.
  function openSetupWizard() {
    setTab("setup");
  }

  function openDetail(target: ServiceDetailTarget, fromHubTab: HubSubTab) {
    setDetailTarget(target);
    setDetailReturnTab(fromHubTab);
    setTab("detail");
  }

  function goToImport() {
    setTab("hub");
    setHubTab("import");
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
            {MAIN_TABS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setTab(id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-body font-medium transition-colors ${
                    // "detail"/"setup"은 사이드바에 없지만, 그 상위 메인 탭이
                    // 계속 강조돼야 사용자가 길을 잃지 않는다.
                    tab === id || (tab === "detail" && id === "hub") || (tab === "setup" && id === "settings")
                      ? "bg-brand-50 text-brand-700"
                      : "text-text-secondary hover:bg-background"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Style guide §4.4: #F7F8FC content background, 24-32px padding.
            채팅은 스스로 좌측 대화 목록 패널을 갖는 전체 화면 레이아웃이라
            상하 padding만 주고 좌우는 화면 자체가 관리한다(Ollama Desktop
            앱과 같은 방식). */}
        <main className={`flex-1 overflow-y-auto bg-background ${tab === "chat" ? "p-4" : "p-8"}`}>
          {tab === "chat" && (
            <ChatScreen
              onGoToInstalledAssets={() => {
                setTab("hub");
                setHubTab("assets");
              }}
            />
          )}

          {tab === "hub" && (
            <div>
              <h1 className="mb-1 text-page-title font-bold text-text-primary">자산 허브</h1>
              <p className="mb-6 text-body text-text-secondary">
                Knowledge와 MCP Tool을 찾아 설치하거나, 반입한 ZIP을 가져옵니다.
              </p>
              <Tabs tabs={HUB_TABS} activeId={hubTab} onChange={(id) => setHubTab(id as HubSubTab)} />
              {hubTab === "store" && (
                <StoreScreen onGoToImport={goToImport} onInstalled={() => setAssetsRefreshKey((k) => k + 1)} />
              )}
              {hubTab === "import" && <ImportScreen onInstalled={() => setAssetsRefreshKey((k) => k + 1)} />}
              {hubTab === "assets" && (
                <AssetsScreen
                  key={assetsRefreshKey}
                  onOpenDetail={(a) => openDetail(a, "assets")}
                  onGoToImport={goToImport}
                />
              )}
              {hubTab === "update" && <UpdateScreen onGoToImport={goToImport} />}
            </div>
          )}

          {tab === "settings" && (
            <div>
              <h1 className="mb-1 text-page-title font-bold text-text-primary">설정</h1>
              <p className="mb-6 text-body text-text-secondary">
                Office Profile·연결·로그·Client 정보를 확인하고 변경합니다.
              </p>
              <Tabs tabs={SETTINGS_TABS} activeId={settingsTab} onChange={(id) => setSettingsTab(id as SettingsSubTab)} />
              {settingsTab === "general" && <SettingsScreen onRunSetupWizard={openSetupWizard} />}
              {settingsTab === "connections" && <ConnectionsScreen />}
              {settingsTab === "logs" && <LogsScreen />}
              {settingsTab === "info" && <InfoScreen />}
            </div>
          )}

          {tab === "detail" && detailTarget && (
            <ServiceDetailScreen
              target={detailTarget}
              onBack={() => {
                setTab("hub");
                setHubTab(detailReturnTab);
              }}
              onGoToChat={() => setTab("chat")}
              onRemoved={() => {
                setAssetsRefreshKey((k) => k + 1);
                setTab("hub");
                setHubTab(detailReturnTab);
              }}
            />
          )}

          {tab === "setup" && (
            <SetupWizardScreen
              onCompleted={() => {
                setTab("settings");
                setSettingsTab("general");
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
