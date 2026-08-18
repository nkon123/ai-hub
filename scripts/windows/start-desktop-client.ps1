<#
.SYNOPSIS
    Desktop Client (M04, Electron)를 개발 모드로 기동한다.

.DESCRIPTION
    `apps/desktop-client`의 `pnpm dev`와 동일한 명령이다
    (`tsc -p tsconfig.electron.json` -> Vite 렌더러(:5173) + Electron Main
    동시 기동). 나머지 서비스와 달리 이것은 HTTP 서비스가 아니라 창을 띄우는
    앱이므로 health-check.ps1 의 점검 대상이 아니다.

    기동 전에 Electron 실행 바이너리가 이 저장소가 고정한 버전으로 실제
    설치되어 있는지 확인한다 — install-node.ps1 이 기본적으로 바이너리
    내려받기를 건너뛰기 때문에, 확인하지 않으면 `electron .` 이 PATH 의
    전역 Electron(예: 31.x)으로 넘어가 엉뚱한 버전으로 실행되거나 그대로
    실패한다. 실제로 겪은 문제다.
#>

. "$PSScriptRoot\_preflight.ps1"

Assert-PnpmReady
Assert-ElectronReady

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "apps\desktop-client")

# Desktop 은 로컬 서비스에 붙어 동작한다. 없으면 앱은 뜨지만 연결 상태
# 화면이 전부 끊김으로 표시되므로 미리 알린다(막지는 않는다 — Ollama 만
# 있어도 일반 대화는 된다).
foreach ($dep in @(@{ Port = 8100; Name = "agent-runtime" }, @{ Port = 8500; Name = "office-mcp-server" }, @{ Port = 8300; Name = "search-runtime" })) {
    if (-not (Get-NetTCPConnection -LocalPort $dep.Port -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host ("[경고] {0}(:{1})가 아직 기동되지 않았습니다 — 연결 상태 화면에 끊김으로 표시됩니다." -f $dep.Name, $dep.Port) -ForegroundColor Yellow
    }
}

pnpm dev
