#!/usr/bin/env bash
#
# dev-stack.sh — macOS/POSIX 로컬 개발 스택(7개 서비스) 제어 스크립트.
# scripts/windows/start-all.ps1 + health-check.ps1 의 macOS 대응물이지만,
# 이 스크립트는 하나의 진입점에서 start/stop/restart/status 를 모두 지원한다
# (Windows 쪽은 새 PowerShell 창을 띄우기만 하고 일괄 종료 기능이 없다).
#
# ── 이 스크립트가 막으려는 사고 ─────────────────────────────────────────
# search-runtime(:8300)이 6일 전 코드를 그대로 서빙한 적이 있다. 터미널은
# 닫혔고 프로세스는 고아(PPID 1)가 된 채 포트를 계속 점유하고 있었다 — 새로
# 추가한 라우트는 전부 404 였고, 원인을 찾는 데 오래 걸렸다. "전부 재시작"
# 스크립트는 이 상태를 (1) 애초에 불가능하게 만들고 (2) 그래도 재현되면
# 즉시 눈에 보이게 만들어야만 쓸모가 있다. 그래서:
#   - start: 포트가 이미 점유돼 있으면 새 인스턴스를 덧띄우지 않고 거부한다
#            (거부하지 않으면 "재시작했는데 그대로다"가 반복된다).
#   - stop:  PID 파일뿐 아니라 포트 소유자 PID·명령줄 패턴까지 함께 찾아
#            종료하고, 실제로 포트가 비었는지 재확인한다(PID 파일만 믿지
#            않는다 — 오늘의 고아 프로세스는애초에 PID 파일이 없었다).
#   - status: 각 프로세스가 "지금 응답하는 코드가 무슨 커밋인지"를
#            HEAD 커밋과 나란히 보여준다. 헬스 엔드포인트가 200을 반환해도
#            커밋이 다르면 그 자체로 이상 신호다.
#
# ── Makefile과의 의도적 차이: --reload 를 쓰지 않는다 ───────────────────
# `make dev-*` 타겟은 전부 `uvicorn ... --reload`를 쓴다. 이 스크립트는
# 뺀다 — reloader(watchfiles)는 감시용 부모 프로세스와 실제 요청을 처리하는
# 자식 프로세스를 따로 띄우는데, 그러면 "포트를 실제로 듣는 PID"와
# "우리가 기동한 PID"가 달라져 PID/포트 관리가 불안정해진다. 이 스크립트로
# 기동한 스택은 코드를 바꾸면 `restart`로 통째로 다시 띄우는 것이 전제라,
# 파일 감시로 얻는 편의가 필요하지 않다.
#
# ── 빌드 아이덴티티 (7개 중 6개 지원, 2026-08-14 기준) ──────────────────
# portal-api / distribution-service / search-runtime 에 이어 agent-runtime /
# indexing-runtime / office-mcp-server 도 BUILD_VERSION·COMMIT_SHA 를 갖게
# 되어, 이 스크립트가 기동 시 주입하고 `status`에서 프로세스가 실제로 보고한
# 값을 저장소 HEAD 와 대조한다. 값을 지어내지 않는다 — 주입되지 않은 프로세스는
# 스스로 "unknown"이라고 답한다.
#
# 남은 미지원: portal-web(Next.js dev 서버 — JSON health 자체가 없다). 이
# 스크립트는 그것을 "미지원"으로 표시하며, 빈칸을 "정상"으로 읽지 않는다.
#
# 이 대조가 필요한 이유: 2026-08-13 에 엿새 전 기동된 search-runtime 프로세스가
# 계속 listen 중이어서, 그 주에 추가한 라우트가 404 나는데도 `/health` 는
# 하드코딩된 버전을 반환해 새 프로세스와 구분되지 않았다.
#
# ── 다루지 않는 것 ───────────────────────────────────────────────────────
# - Ollama(:11434) 시작/중지: 하지 않는다. status 에서 확인만 한다.
# - DB 마이그레이션 자동 적용: 하지 않는다. status 에서 "최신이 아님"만
#   경고한다 — 실제 적용은 `make migrate`를 사용자가 직접 실행해야 한다.
# - data/indexes/ 변경: 하지 않는다.
# - Windows _preflight.ps1 이 하는 "Python/pnpm 사전 설치 확인" 같은 진단은
#   이 스크립트 범위 밖이다 — 명령을 못 찾으면 실패가 로그 파일에 그대로
#   남는다(uv/pnpm 자체 오류 메시지).
#
# ── desktop-client (M04) — 실제 Electron 창까지 이 스크립트로 띄운다 ─────
# 2026-08-14 이전에는 이 저장소 문서(13-windows-local-setup.md §7)가 "이
# macOS 세션에서 Electron 앱을 한 번도 실제로 기동한 적이 없다(회사 정책상
# 서명되지 않은 바이너리가 Gatekeeper/XProtect에 격리됨)"고 기록하고 있었다.
# 실측 결과 이미 설치된 node_modules/electron 바이너리에는 quarantine
# 속성이 없었고, `pnpm dev`로 실제 창(제목 "Enterprise AI Asset Hub —
# Desktop")이 뜨는 것을 이 스크립트 밖에서 먼저 수동으로 확인한 뒤 여기에
# 편입했다 — Windows Runbook에 남아 있던 "미검증"은 이제 macOS 개발 세션
# 한정으로는 사실이 아니다(Windows 타깃 PC는 여전히 별도 검증 필요).
# `pnpm dev`는 `tsc && concurrently vite electron .`을 실행하므로 다른
# 서비스처럼 exec 체인 하나가 아니라 여러 자식 프로세스(vite, electron 본체,
# GPU/렌더러 Helper)를 만든다 — 그래서 desktop-client만 pkill 패턴이
# 여러 줄이다(아래 resolve_service 참고).
#
# 사용법:
#   scripts/macos/dev-stack.sh <start|stop|restart|status> [서비스...]
#   서비스 이름을 생략하면 8개 전체(desktop-client 포함)를 대상으로 한다.
#   예) scripts/macos/dev-stack.sh restart search-runtime portal-api
#       scripts/macos/dev-stack.sh status
#       scripts/macos/dev-stack.sh start desktop-client

set -euo pipefail

# ── 0. 저장소 루트 확인 ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ ! -f "$REPO_ROOT/Makefile" ]; then
  echo "[오류] 저장소 루트를 찾지 못했습니다 (Makefile 없음): $REPO_ROOT" >&2
  exit 1
fi

# ── 1. 출력 색상 (터미널이 아니면 끔) ────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

log_info() { printf '%s[정보]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
log_ok()   { printf '%s[정상]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
log_warn() { printf '%s[경고]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
log_err()  { printf '%s[오류]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()      { log_err "$*"; exit 1; }

# ── 2. 상태 저장 위치 (PID/로그) ─────────────────────────────────────────
# 소스가 아닌 실행 시점 산출물이라 .gitignore에 등록돼 있다(다른 런타임
# 산출물 — data/indexes/, storage/ — 과 같은 섹션).
STATE_DIR="$REPO_ROOT/.dev-stack"
PID_DIR="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

# ── 3. Git 기반 빌드 아이덴티티 ──────────────────────────────────────────
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null)" || GIT_SHA="unknown"
GIT_DATE="$(git -C "$REPO_ROOT" log -1 --format=%cd --date=format:%Y-%m-%d 2>/dev/null)" || GIT_DATE="unknown"
BUILD_VERSION_VALUE="dev-${GIT_DATE}"

# ── 4. Desktop 로컬 색인 활성화 (D-079) — 재정의 가능한 기본값 ──────────
# 이미 설정된 환경변수가 있으면 그것을 우선한다(":-" 이므로 비어있지 않은
# 기존 값을 덮어쓰지 않는다).
DEFAULT_SEARCH_LOCAL_INDEX_ROOTS="$HOME/Library/Application Support/desktop-client/assets"
SEARCH_LOCAL_INDEX_ROOTS_VALUE="${SEARCH_LOCAL_INDEX_ROOTS:-$DEFAULT_SEARCH_LOCAL_INDEX_ROOTS}"

# ── 5. 서비스 목록 ────────────────────────────────────────────────────────
SERVICES="portal-api agent-runtime indexing-runtime search-runtime distribution-service office-mcp-server portal-web desktop-client"

svc_is_valid() {
  case " $SERVICES " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# resolve_service <name> — 아래 전역변수를 채운다:
#   SVC_PORT, SVC_HEALTH_PATH(빈 문자열=JSON /health 없음, TCP+루트만 확인),
#   SVC_SUPPORTS_BUILD(yes/no), SVC_WORKDIR(빈 문자열=저장소 루트에서 실행),
#   SVC_CMD(배열), SVC_ENVS(배열, KEY=VALUE)
# 실행 명령은 Makefile의 dev-* 타겟과 동일하다(--reload만 제외) — 이 함수가
# 그 타겟들의 실제 명령을 그대로 옮긴 것이지 재해석한 것이 아니다.
resolve_service() {
  local name="$1"
  SVC_PORT=""; SVC_HEALTH_PATH=""; SVC_SUPPORTS_BUILD="no"; SVC_WORKDIR=""
  # 빌드 아이덴티티를 읽을 경로. 대부분 health 와 같지만 office-mcp-server 는
  # `/health/live` 가 §11 liveness 규약상 최소 응답을 유지하므로 다르다.
  SVC_IDENTITY_PATH=""
  SVC_CMD=(); SVC_ENVS=()
  case "$name" in
    portal-api)
      SVC_PORT=8000
      SVC_HEALTH_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="apps/portal-api"
      SVC_CMD=(uv run uvicorn portal_api.main:app --port 8000)
      SVC_ENVS=("PORTAL_BUILD_VERSION=$BUILD_VERSION_VALUE" "PORTAL_COMMIT_SHA=$GIT_SHA")
      ;;
    agent-runtime)
      SVC_PORT=8100
      SVC_HEALTH_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="services/agent-runtime"
      SVC_CMD=(uv run uvicorn agent_runtime.main:app --port 8100)
      SVC_ENVS=("AGENT_RUNTIME_BUILD_VERSION=$BUILD_VERSION_VALUE" "AGENT_RUNTIME_COMMIT_SHA=$GIT_SHA")
      ;;
    indexing-runtime)
      SVC_PORT=8200
      SVC_HEALTH_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="services/indexing-runtime"
      SVC_CMD=(uv run uvicorn indexing_runtime.main:app --port 8200)
      SVC_ENVS=("INDEXING_BUILD_VERSION=$BUILD_VERSION_VALUE" "INDEXING_COMMIT_SHA=$GIT_SHA")
      ;;
    search-runtime)
      SVC_PORT=8300
      SVC_HEALTH_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="services/search-runtime"
      SVC_CMD=(uv run uvicorn search_runtime.main:app --port 8300)
      SVC_ENVS=(
        "SEARCH_BUILD_VERSION=$BUILD_VERSION_VALUE"
        "SEARCH_COMMIT_SHA=$GIT_SHA"
        "SEARCH_LOCAL_INDEX_ROOTS=$SEARCH_LOCAL_INDEX_ROOTS_VALUE"
      )
      ;;
    distribution-service)
      SVC_PORT=8400
      SVC_HEALTH_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="services/distribution-service"
      SVC_CMD=(uv run uvicorn distribution_service.main:app --port 8400)
      SVC_ENVS=("DISTRIBUTION_BUILD_VERSION=$BUILD_VERSION_VALUE" "DISTRIBUTION_COMMIT_SHA=$GIT_SHA")
      ;;
    office-mcp-server)
      SVC_PORT=8500
      SVC_HEALTH_PATH="/health/live"
      # `/health/live` 는 의도적으로 {"status":"ok"} 만 돌려준다(§11 liveness).
      # 빌드 아이덴티티는 다른 서비스와 같은 모양인 `/health` 에 있다.
      SVC_IDENTITY_PATH="/health"
      SVC_SUPPORTS_BUILD="yes"
      SVC_WORKDIR="services/office-mcp-server"
      SVC_CMD=(uv run uvicorn office_mcp_server.main:app --port 8500)
      SVC_ENVS=("OFFICE_MCP_BUILD_VERSION=$BUILD_VERSION_VALUE" "OFFICE_MCP_COMMIT_SHA=$GIT_SHA")
      ;;
    desktop-client)
      # 관측 가능한 포트는 Vite 렌더러(5173)다 — `vite.config.ts`가
      # `strictPort: true`로 5173에 고정하고 `electron/main.ts`도 5173을
      # 로드하므로, 이 포트가 곧 "Desktop이 떠 있는가"의 기준이다.
      # Electron 창 자체는 포트를 듣지 않으므로 pkill 패턴으로 함께 정리한다.
      SVC_PORT=5173
      SVC_HEALTH_PATH=""    # Vite dev 서버에는 JSON /health가 없다 — 루트 응답으로 확인
      SVC_SUPPORTS_BUILD="no"   # 대신 status가 dist/electron 빌드 신선도를 본다
      SVC_WORKDIR=""            # 저장소 루트에서 pnpm --filter 로 실행
      SVC_CMD=(pnpm --filter desktop-client dev)
      ;;
    portal-web)
      SVC_PORT=3000
      SVC_HEALTH_PATH=""   # Next.js dev 서버에는 JSON /health가 없다 — 루트 응답으로 확인
      SVC_SUPPORTS_BUILD="no"
      SVC_WORKDIR=""        # Makefile과 동일하게 저장소 루트에서 pnpm --filter 로 실행
      SVC_CMD=(pnpm --filter portal-web dev)
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# desktop_build_state — dist/electron 산출물이 electron/*.ts 소스보다 최신인가.
# 서비스에게 "프로세스가 오래됐다"가 있다면 Desktop에는 "빌드 산출물이
# 오래됐다"가 있다. 2026-08-13 실제 장애가 정확히 이것이었다: 소스에는 새 IPC
# 메서드가 있는데 dist/electron/preload.js가 그 이전 것이라, 실행 중인 앱이
# 옛 bridge를 노출해 `TypeError: ... is not a function`으로 화면이 죽었다.
# TypeScript는 이 불일치를 원리상 잡을 수 없다(번들과 빌드 산출물 사이의 문제).
# 출력: "fresh" | "stale" | "missing"
desktop_build_state() {
  local artifact="$REPO_ROOT/apps/desktop-client/dist/electron/preload.js"
  [ -f "$artifact" ] || { echo "missing"; return; }
  local newer
  newer="$(find "$REPO_ROOT/apps/desktop-client/electron" -name '*.ts' -newer "$artifact" -print -quit 2>/dev/null || true)"
  [ -n "$newer" ] && echo "stale" || echo "fresh"
}

# http_get <port> <path> [timeout] — 응답 본문을 stdout 으로, 실패하면 비영 반환.
#
# 127.0.0.1 과 localhost 를 모두 시도한다. 실측(2026-08-14): Vite dev 서버는
# **IPv6 `[::1]` 에만** 바인딩해서 `127.0.0.1` 로는 절대 응답하지 않는다
# (`localhost` 는 ::1 로 풀린다). 127.0.0.1 만 검사하던 동안 desktop-client 는
# 실제로 멀쩡히 떠 있는데도 "90초 내에 준비되지 않았습니다"로 실패했다 —
# 서비스는 정상인데 검사가 틀려서 고장으로 보고한 사례다. 반대로 어떤
# 서비스는 IPv4 에만 바인딩할 수 있으므로 한쪽으로 통일하지 않고 둘 다 본다.
http_get() {
  local port="$1" path="$2" tmo="${3:-5}" out=""
  if out="$(curl -sf --max-time "$tmo" "http://127.0.0.1:${port}${path}" 2>/dev/null)"; then
    printf '%s' "$out"; return 0
  fi
  if out="$(curl -sf --max-time "$tmo" "http://localhost:${port}${path}" 2>/dev/null)"; then
    printf '%s' "$out"; return 0
  fi
  return 1
}

svc_pkill_pattern() {
  case "$1" in
    portal-api)            echo "uvicorn portal_api.main:app" ;;
    agent-runtime)          echo "uvicorn agent_runtime.main:app" ;;
    indexing-runtime)       echo "uvicorn indexing_runtime.main:app" ;;
    search-runtime)         echo "uvicorn search_runtime.main:app" ;;
    distribution-service)   echo "uvicorn distribution_service.main:app" ;;
    office-mcp-server)      echo "uvicorn office_mcp_server.main:app" ;;
    portal-web)             echo "next dev --port 3000" ;;
    # `pnpm dev`가 concurrently로 vite와 electron을 함께 띄우므로 자식이 여럿이다.
    # **반드시 저장소 경로로 범위를 좁힌다** — `Electron.app/Contents/MacOS/Electron`
    # 같은 일반 패턴은 이 머신에서 실행 중인 VS Code/Claude 등 다른 Electron 앱까지
    # 잡는다(실제로 이 머신에 여러 개가 떠 있다).
    # 실측(2026-08-14): Electron 본체는 `apps/desktop-client/node_modules/electron`이
    # 아니라 pnpm 스토어 경로 `<repo>/node_modules/.pnpm/electron@<ver>/...`에서
    # 실행된다. 앱 폴더만 보는 패턴은 창을 하나도 잡지 못했다("stop 했는데 창이
    # 남는" 상태 = 이 스크립트가 막으려는 바로 그 실패).
    # 반드시 저장소 경로로 범위를 좁힌다 — 일반적인 `Electron.app` 패턴은 이
    # 머신에서 실행 중인 VS Code/Claude 등 다른 Electron 앱까지 죽인다.
    desktop-client)         echo "(--filter desktop-client dev|${REPO_ROOT}/apps/desktop-client|${REPO_ROOT}/node_modules/.pnpm/electron@)" ;;
    *)                      echo "" ;;
  esac
}

# ── 6. 저수준 헬퍼 (모두 set -e/pipefail 아래에서 "못 찾음"을 정상 흐름으로
#      처리한다 — 실패를 곧 스크립트 종료로 만들지 않는다) ───────────────

port_owner_pid() {
  # 해당 포트를 LISTEN 중인 PID(첫 번째) — 없으면 빈 문자열.
  lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

collect_pids() {
  # 포트 소유자 PID + 명령줄 패턴이 일치하는 PID를 합쳐 중복 제거한다.
  # PID 파일만으로는 오늘의 고아 프로세스(PID 파일 없음)를 잡지 못하므로
  # 두 방법을 항상 함께 쓴다.
  local port="$1" pattern="$2"
  {
    lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    if [ -n "$pattern" ]; then
      pgrep -f "$pattern" 2>/dev/null || true
    fi
  } | sort -un
}

json_field() {
  # 평평한(1-depth) JSON에서 문자열 필드 하나를 뽑는다. 이 스크립트가 읽는
  # /health 응답이 전부 이 모양이라 별도 JSON 파서 의존성을 추가하지 않았다.
  local json="$1" key="$2"
  printf '%s' "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null \
    | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true
}

kill_pids() {
  # $1=시그널, 이후=PID 목록(줄 단위 문자열)
  local sig="$1" pids="$2"
  [ -z "$pids" ] && return 0
  local p
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    kill "-$sig" "$p" 2>/dev/null || true
  done <<PIDS
$pids
PIDS
  return 0
}

# ── 7. start ──────────────────────────────────────────────────────────────

start_one() {
  local name="$1"
  if ! resolve_service "$name"; then
    log_err "알 수 없는 서비스: $name"
    return 1
  fi
  local port="$SVC_PORT" pidfile="$PID_DIR/$name.pid" logfile="$LOG_DIR/$name.log"

  local owner
  owner="$(port_owner_pid "$port")"
  if [ -n "$owner" ]; then
    local tracked=""
    if [ -f "$pidfile" ]; then
      tracked="$(cat "$pidfile" 2>/dev/null)" || tracked=""
    fi
    # PID 파일과 포트 소유자 PID가 정확히 같을 필요는 없다: `uv run`은
    # exec가 아니라 fork라서(직접 확인함 — `uv`가 부모, 실제 uvicorn이
    # 자식 PID로 남는다) $!로 잡히는 PID는 `uv` 래퍼이고 포트를 실제로 듣는
    # PID는 그 자식이다. 그래서 "우리가 띄운 것"의 증거는 PID 파일에 적힌
    # 래퍼 PID가 아직 살아있는지(kill -0)로 판단한다 — 그 래퍼가 살아있는
    # 한 자식도 같이 살아있다는 전제(위에서 실측 확인).
    if [ -n "$tracked" ] && kill -0 "$tracked" 2>/dev/null; then
      log_ok "$name: 이미 실행 중입니다 (PID $owner, port $port) — 건너뜀"
      return 0
    fi
    local started=""
    started="$(ps -o lstart= -p "$owner" 2>/dev/null)" || started=""
    started="$(printf '%s' "$started" | sed -e 's/^[[:space:]]*//')"
    log_err "$name: 포트 $port 이(가) 이미 사용 중입니다 (PID $owner, 시작 시각: ${started:-알 수 없음})."
    log_err "$name: 이 PID는 이 스크립트가 추적하는 프로세스가 아닙니다. 먼저 '$0 stop $name' (또는 restart)을 실행하세요."
    return 1
  fi

  local dir="$REPO_ROOT"
  [ -n "$SVC_WORKDIR" ] && dir="$REPO_ROOT/$SVC_WORKDIR"

  # Desktop의 preload 재빌드는 여기서 따로 하지 않는다 — `pnpm --filter
  # desktop-client dev`의 첫 단계가 이미 `tsc -p tsconfig.electron.json &&`
  # 이므로 중복 실행일 뿐이고(초기 기동이 두 배로 느려져 준비 대기가 실제로
  # 시간 초과했다), 빌드 실패 시 dev 스크립트 자체가 electron을 띄우지 않는다.
  # 산출물이 오래된 상태는 `status`의 "Electron 빌드" 줄이 잡는다.

  (
    cd "$dir"
    exec nohup env "${SVC_ENVS[@]+"${SVC_ENVS[@]}"}" "${SVC_CMD[@]}" >"$logfile" 2>&1 </dev/null
  ) &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$pidfile"

  # 준비될 때까지 대기 (최대 30초). --reload를 안 쓰므로 코드 재컴파일
  # 대기 없이 바로 뜨는 것이 정상이다.
  # desktop-client는 tsc 컴파일 + vite + Electron 창까지 띄우므로 uvicorn
  # 한 프로세스보다 느리다(실측 30초 초과). 서비스별로 상한을 나눈다.
  local max_wait=30
  [ "$name" = "desktop-client" ] && max_wait=90
  local waited=0 ready=""
  while [ "$waited" -lt "$max_wait" ]; do
    local cur
    cur="$(port_owner_pid "$port")"
    if [ -n "$cur" ]; then
      if [ -n "$SVC_HEALTH_PATH" ]; then
        if http_get "$port" "$SVC_HEALTH_PATH" 2 >/dev/null; then
          ready="1"; break
        fi
      else
        if http_get "$port" "/" 2 >/dev/null; then
          ready="1"; break
        fi
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ -n "$ready" ]; then
    local finalpid
    finalpid="$(port_owner_pid "$port")"
    log_ok "$name: 기동 완료 (PID ${finalpid:-$pid}, port $port). 로그: $logfile"
    return 0
  fi
  log_err "$name: ${max_wait}초 내에 준비 상태가 되지 않았습니다. 로그를 확인하세요: $logfile"
  return 1
}

# ── 8. stop ───────────────────────────────────────────────────────────────

stop_one() {
  local name="$1"
  if ! resolve_service "$name"; then
    log_err "알 수 없는 서비스: $name"
    return 1
  fi
  local port="$SVC_PORT" pidfile="$PID_DIR/$name.pid"
  local pattern; pattern="$(svc_pkill_pattern "$name")"

  local pids; pids="$(collect_pids "$port" "$pattern")"
  if [ -z "$pids" ]; then
    rm -f "$pidfile"
    log_ok "$name: 이미 중지되어 있습니다."
    return 0
  fi

  log_info "$name: 종료 신호(SIGTERM) 전송 — PID: $(printf '%s' "$pids" | tr '\n' ' ')"
  kill_pids TERM "$pids"

  local waited=0
  while [ "$waited" -lt 10 ]; do
    pids="$(collect_pids "$port" "$pattern")"
    [ -z "$pids" ] && break
    sleep 0.5
    waited=$((waited + 1))
  done

  pids="$(collect_pids "$port" "$pattern")"
  if [ -n "$pids" ]; then
    log_warn "$name: 정상 종료가 안 됐습니다 — SIGKILL로 강제 종료합니다. PID: $(printf '%s' "$pids" | tr '\n' ' ')"
    kill_pids KILL "$pids"
    sleep 1
  fi

  pids="$(collect_pids "$port" "$pattern")"
  if [ -n "$pids" ]; then
    log_err "$name: 강제 종료 후에도 포트 $port 이(가) 여전히 점유되어 있습니다 (PID: $(printf '%s' "$pids" | tr '\n' ' '))."
    log_err "$name: 수동으로 원인을 확인하세요 — 계속 진행하지 않습니다."
    return 1
  fi

  rm -f "$pidfile"
  log_ok "$name: 중지 완료."
  return 0
}

# ── 9. status ─────────────────────────────────────────────────────────────

print_head_banner() {
  echo "================================================================"
  echo " Enterprise AI Asset Hub — 로컬 개발 스택 상태"
  echo " 저장소 HEAD: commit=${GIT_SHA}  buildVersion=${BUILD_VERSION_VALUE}"
  echo " (서비스별 '빌드' 값과 위 HEAD를 비교하십시오 — 다르면 재시작 필요)"
  echo "================================================================"
}

# desktop-client 전용 부가 상태 — 프로세스 유무와 별개로 항상 보여준다.
desktop_extra_status() {
  case "$(desktop_build_state)" in
    fresh)
      printf '  └ Electron 빌드: %s최신%s (dist/electron/preload.js가 electron/*.ts보다 새로움)\n' "$C_GREEN" "$C_RESET" ;;
    stale)
      printf '  └ Electron 빌드: %s오래됨 — 재빌드 필요%s (소스가 dist/electron/preload.js보다 새로움. `start`/`restart`가 자동 재빌드한다)\n' "$C_RED" "$C_RESET"
      STATUS_FAIL=1 ;;
    missing)
      printf '  └ Electron 빌드: %s없음%s (dist/electron/preload.js 미생성 — `start`/`restart`가 생성한다)\n' "$C_RED" "$C_RESET"
      STATUS_FAIL=1 ;;
  esac
  # Electron 셸은 `electron/main.ts`가 5173을 로드한다. 다른 포트에 남아 있는
  # 렌더러는 Electron이 영영 보지 못하므로, 멀쩡해 보이는데 창은 비어 있는
  # 상태를 만든다 — 실제로 이 세션에서 5174 잔재가 그 상태였다.
  if lsof -nP -iTCP:5174 -sTCP:LISTEN >/dev/null 2>&1; then
    printf '  └ %s경고%s: 5174에 렌더러가 떠 있습니다. Electron 셸은 5173만 로드하므로 이 서버는 창에 반영되지 않습니다(오래된 잔재일 가능성).\n' "$C_YELLOW" "$C_RESET"
  fi
}

status_one() {
  local name="$1"
  if ! resolve_service "$name"; then
    log_err "알 수 없는 서비스: $name"
    STATUS_FAIL=1
    return
  fi
  local port="$SVC_PORT"
  local pid; pid="$(port_owner_pid "$port")"

  if [ -z "$pid" ]; then
    printf '%-22s [중지됨]  port=%s\n' "$name" "$port"
    if [ "$name" = "desktop-client" ]; then desktop_extra_status; fi
    STATUS_FAIL=1
    return
  fi

  local started=""
  started="$(ps -o lstart= -p "$pid" 2>/dev/null)" || started=""
  started="$(printf '%s' "$started" | sed -e 's/^[[:space:]]*//')"

  local health_str build_str="미지원"
  if [ -n "$SVC_HEALTH_PATH" ]; then
    local resp=""
    if resp="$(http_get "$port" "$SVC_HEALTH_PATH" 5)"; then
      health_str="OK"
      if [ "$SVC_SUPPORTS_BUILD" = "yes" ]; then
        local ver sha ident_resp="$resp"
        # 대부분은 health 응답이 곧 아이덴티티 응답이다. office-mcp-server 만
        # liveness(`/health/live`)와 아이덴티티(`/health`)가 분리돼 있어 한 번
        # 더 조회한다. 이 조회가 실패하면 값을 지어내지 않고 아래 "필드 없음"
        # 경로로 떨어진다.
        if [ -n "$SVC_IDENTITY_PATH" ] && [ "$SVC_IDENTITY_PATH" != "$SVC_HEALTH_PATH" ]; then
          ident_resp="$(http_get "$port" "$SVC_IDENTITY_PATH" 5)" || ident_resp=""
        fi
        ver="$(json_field "$ident_resp" version)"
        sha="$(json_field "$ident_resp" commit_sha)"
        if [ -z "$sha" ]; then
          # commit_sha 필드 자체가 응답에 없다 — 이 필드가 코드에 추가되기
          # 전에 떠 있던 프로세스일 가능성이 크다(실제로 이 세션에서 관찰된
          # 사례: portal-api/distribution-service가 이 상태였다). "HEAD와
          # 일치"로 잘못 표시하면 안 되므로 별도로, 더 눈에 띄게 경고한다.
          build_str="${C_RED}${ver}(commit_sha 필드 없음 — 오래된 코드로 추정, HEAD=${GIT_SHA}와 비교 불가)${C_RESET}"
          STATUS_FAIL=1
        elif [ "$sha" != "$GIT_SHA" ]; then
          build_str="${C_YELLOW}${ver}(${sha}) [경고: HEAD(${GIT_SHA})와 다름 — 오래된 코드일 수 있음]${C_RESET}"
          STATUS_FAIL=1
        else
          build_str="${ver}(${sha}) [HEAD와 일치]"
        fi
      fi
    else
      health_str="${C_RED}실패(무응답/오류)${C_RESET}"
      STATUS_FAIL=1
    fi
  else
    if http_get "$port" "/" 5 >/dev/null; then
      health_str="OK"
    else
      health_str="${C_RED}실패${C_RESET}"
      STATUS_FAIL=1
    fi
  fi

  printf '%-22s [기동중]  PID=%-8s 시작=%-28s health=%-32s 빌드=%s\n' \
    "$name" "$pid" "${started:-알수없음}" "$health_str" "$build_str"
  # Desktop은 "프로세스가 살아 있음"만으로 정상이라 말할 수 없다 — 빌드
  # 산출물이 소스보다 오래되면 앱은 멀쩡히 떠도 옛 bridge를 노출한다.
  if [ "$name" = "desktop-client" ]; then desktop_extra_status; fi
}

check_alembic_status() {
  # 마이그레이션을 적용하지 않는다 — 읽기 전용 비교만 한다(alembic current
  # /heads 둘 다 상태를 바꾸지 않는 명령). 실패해도 status 전체를 막지 않는다.
  local cur head
  cur="$( (cd "$REPO_ROOT/apps/portal-api" && uv run alembic current) 2>/dev/null \
    | grep -oE '^[0-9a-f]+' | head -1 || true )"
  head="$( (cd "$REPO_ROOT/apps/portal-api" && uv run alembic heads) 2>/dev/null \
    | grep -oE '^[0-9a-f]+' | head -1 || true )"
  if [ -z "$cur" ] || [ -z "$head" ]; then
    log_warn "portal-api DB 마이그레이션 상태를 확인할 수 없습니다(uv/DB 접근 실패) — 건너뜀."
    return
  fi
  if [ "$cur" != "$head" ]; then
    log_warn "portal-api DB가 최신 마이그레이션이 아닙니다 (current=$cur, head=$head). 'make migrate'를 직접 실행하세요(이 스크립트는 자동 적용하지 않습니다)."
  fi
}

check_ollama() {
  # 관리 대상이 아니다 — 확인만 한다. 응답 없어도 전체 상태를 실패로
  # 만들지 않는다(이 스택으로 하는 모든 개발이 Ollama를 필요로 하지는
  # 않으며, 이 스크립트가 켜고 끌 수도 없는 것을 "필수"로 취급하면
  # 오히려 잘못된 경보가 된다) — 다만 항상 눈에 띄게 표시한다.
  if curl -sf --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    printf '%-22s [응답함]  port=11434 (외부 도구 — 이 스크립트가 시작/중지하지 않음)\n' "ollama"
  else
    printf '%-22s [무응답]  port=11434 (외부 도구 — 이 스크립트가 시작/중지하지 않음. 필요하면 "ollama serve"를 직접 실행)\n' "ollama"
  fi
}

# ── 10. main ──────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<USAGE
사용법: $0 <start|stop|restart|status> [서비스 이름...]

서비스 이름을 생략하면 7개 전체를 대상으로 합니다:
  $SERVICES

예:
  $0 status
  $0 restart search-runtime portal-api
  $0 stop
USAGE
}

main() {
  if [ $# -lt 1 ]; then
    usage
    exit 1
  fi
  local sub="$1"; shift

  local names=()
  if [ $# -eq 0 ]; then
    for n in $SERVICES; do names+=("$n"); done
  else
    names=("$@")
  fi

  for n in "${names[@]}"; do
    svc_is_valid "$n" || die "알 수 없는 서비스명: '$n' (가능한 값: $SERVICES)"
  done

  case "$sub" in
    start)
      local fail=0
      for n in "${names[@]}"; do start_one "$n" || fail=1; done
      exit "$fail"
      ;;
    stop)
      local fail=0
      for n in "${names[@]}"; do stop_one "$n" || fail=1; done
      exit "$fail"
      ;;
    restart)
      local fail=0
      for n in "${names[@]}"; do
        stop_one "$n" || fail=1
        start_one "$n" || fail=1
      done
      exit "$fail"
      ;;
    status)
      STATUS_FAIL=0
      print_head_banner
      for n in "${names[@]}"; do status_one "$n"; done
      check_alembic_status
      check_ollama
      exit "$STATUS_FAIL"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
