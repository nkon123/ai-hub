import { useState } from "react";
import { CalendarClock, Database, MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { ImportScreen } from "./screens/ImportScreen";
import { StoreScreen } from "./screens/StoreScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { AssetsScreen } from "./screens/AssetsScreen";
import { LocalToolsScreen } from "./screens/LocalToolsScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";
import { UpdateScreen } from "./screens/UpdateScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { SetupWizardScreen } from "./screens/SetupWizardScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { InfoScreen } from "./screens/InfoScreen";
import { ServiceDetailScreen, type ServiceDetailTarget } from "./screens/ServiceDetailScreen";
import { Tabs, StaleBridgeBuildBanner } from "./ui";
import { getDesktopBridge, getMissingBridgeMethods } from "./bridge";

// IA 재편(11개 사이드바 탭 -> 3개, D14에서 스케줄 추가로 4개): 채팅 / 스케줄 /
// 자산 허브 / 설정. "detail"(D03)과 "setup"(D01)은 사이드바에 없는
// Drill-down 화면이다 — 진입 시 어디서 왔는지를 함께 기억해 "뒤로"가 항상
// 올바른 화면으로 되돌아간다. 스케줄은 채팅 레시피를 그대로 실행하므로
// 채팅과 인접한 자리(자산 허브 앞)에 둔다 — 자산 허브의 하위 탭이나 설정
// 아래에 넣지 않는다(별도 최상위 화면으로 요청됨).
type MainTab = "chat" | "schedule" | "hub" | "settings" | "detail" | "setup";
type HubSubTab = "store" | "import" | "assets" | "localTools" | "update";
type SettingsSubTab = "general" | "connections" | "logs" | "info";

const MAIN_TABS: Array<{ id: MainTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "채팅", icon: MessageSquare },
  { id: "schedule", label: "스케줄", icon: CalendarClock },
  { id: "hub", label: "자산 허브", icon: Database },
  { id: "settings", label: "설정", icon: SettingsIcon },
];

const HUB_TABS: Array<{ id: HubSubTab; label: string }> = [
  { id: "store", label: "찾아 설치" },
  { id: "import", label: "ZIP 가져오기" },
  { id: "assets", label: "설치된 자산" },
  { id: "localTools", label: "로컬 Tool" },
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

  // 앱 시작 시 한 번만 확인한다 — `getDesktopBridge()`를 호출해야 stale
  // `preload.js`로 인해 빠진 메서드가 있는지 알 수 있다(`src/bridge.ts`).
  // 어떤 화면을 먼저 열든 동일한 배너가 한 번만 보이도록 여기(App 레벨)에서
  // 계산한다 — 화면마다 각자 발견하고 각자 알리면 "한 번만 보여준다"는
  // 요구사항을 어긴다. `window.desktop` 자체가 없는 정상 상태(브라우저
  // 개발 모드)에서는 `getMissingBridgeMethods()`가 항상 빈 배열이라 배너가
  // 뜨지 않는다 — `BridgeUnavailableState`가 이미 다루는 그 경로는 바뀌지
  // 않는다.
  const [missingBridgeMethods] = useState(() => {
    getDesktopBridge();
    return getMissingBridgeMethods();
  });

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
      {/* 상단 브랜딩 바는 2026-08-14에 제거했다 — 로고와 앱 이름만 있고
          동작이 하나도 없어서 68px을 그냥 쓰고 있었다. 앱 이름은 Electron
          `BrowserWindow`의 title(=OS 창 제목)이 이미 보여주므로 정보가
          사라지지도 않는다. 아래 StaleBridgeBuildBanner는 그대로 남는다 —
          실행 중인 빌드가 낡았다는 것을 알리는 유일한 신호라, 헤더를
          치우면서 같이 지우면 이번 주에 고친 문제가 되살아난다. */}

      <StaleBridgeBuildBanner missingMethods={missingBridgeMethods} />

      <div className="flex flex-1 overflow-hidden">
        {/* 아이콘 전용 세로 내비게이션(2026-08-14). 예전에는 240px 폭에
            아이콘+텍스트였다. 텍스트를 없앴으므로 **접근성 이름은 반드시
            남긴다** — `aria-label`이 없으면 화면 낭독기 사용자에게는 이름
            없는 버튼 3개가 되고, 그건 단순화가 아니라 퇴행이다. hover/focus
            시 툴팁으로 눈에 보이는 이름도 함께 준다.
            선택 상태는 색만으로 구분하지 않는다 — 좌측 세로 막대를 함께 두어
            색 대비가 약한 환경에서도 위치로 읽히게 한다. */}
        <nav aria-label="주 메뉴" className="w-16 shrink-0 border-r border-border bg-surface py-3">
          <ul className="flex flex-col items-center gap-1">
            {MAIN_TABS.map(({ id, label, icon: Icon }) => {
              // "detail"/"setup"은 사이드바에 없지만, 그 상위 메인 탭이 계속
              // 강조돼야 사용자가 길을 잃지 않는다.
              const active =
                tab === id || (tab === "detail" && id === "hub") || (tab === "setup" && id === "settings");
              return (
                <li key={id} className="group relative">
                  <button
                    type="button"
                    onClick={() => setTab(id)}
                    aria-label={label}
                    aria-current={active ? "page" : undefined}
                    title={label}
                    className={`relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      active ? "bg-brand-50 text-brand-700" : "text-text-secondary hover:bg-background"
                    }`}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r bg-brand-500"
                      />
                    )}
                    <Icon size={20} />
                  </button>
                  {/* 툴팁 — 텍스트 라벨이 사라진 자리를 눈으로도 메운다.
                      `pointer-events-none`이라 클릭을 가로채지 않는다. */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-slate-50 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    {label}
                  </span>
                </li>
              );
            })}
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

          {tab === "schedule" && <ScheduleScreen />}

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
              {hubTab === "localTools" && <LocalToolsScreen />}
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
