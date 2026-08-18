<#
.SYNOPSIS
    Enterprise AI Asset Hub 전체 스택(7개 서비스 + Desktop Client)을 로컬에 기동한다.

.DESCRIPTION
    Makefile의 dev-* 타겟들을 각각 별도의 PowerShell 창에서 실행해, 로그를
    서비스별로 분리해서 볼 수 있게 한다. Windows에는 `make`가 없으므로 이
    스크립트가 그 대체 진입점이다.

    사전 준비(한 번만):
      1. `.\scripts\windows\install-pip.ps1`
      2. `pnpm install`
      3. `.\scripts\windows\migrate.ps1` (portal.db 스키마 최신화)
      4. `ollama serve`가 이미 실행 중이고, exaone3.5:7.8b /
         qwen3-embedding:0.6b 모델이 pull되어 있을 것
         (docs/implementation-spec/13-windows-local-setup.md 참고)

    이 스크립트는 Ollama를 기동하지 않는다 — 위 4번은 별도로 준비한다.

.NOTES
    종료하려면 열린 각 PowerShell 창에서 Ctrl+C로 프로세스를 멈춘 뒤 창을
    닫는다. 이 스크립트 자체에는 일괄 종료 기능이 없다(각 창이 독립
    프로세스이기 때문) — 필요하면 작업 관리자에서 개별 종료한다.
#>

param(
    # Desktop Client(Electron)를 함께 띄우지 않는다. Portal 만 쓰거나
    # Electron 바이너리를 반입하지 못한 PC 에서 사용한다.
    [switch]$NoDesktop
)

. "$PSScriptRoot\_preflight.ps1"

# 7개 창을 띄운 뒤 전부 같은 이유로 실패하는 일을 막기 위해 먼저 한 번 점검한다.
Write-Host "사전 점검 중..." -ForegroundColor Cyan
$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "portal_api"
Assert-PnpmReady
Warn-IfOllamaMissing
Write-Host "사전 점검 통과." -ForegroundColor Green
Write-Host ""

$ScriptDir = $PSScriptRoot

$Services = @(
    "start-portal-api.ps1",
    "start-agent-runtime.ps1",
    "start-indexing-runtime.ps1",
    "start-search-runtime.ps1",
    "start-distribution-service.ps1",
    "start-office-mcp-server.ps1",
    "start-portal-web.ps1"
)

# Desktop Client(M04)는 HTTP 서비스가 아니라 창을 띄우는 Electron 앱이라
# 위 목록과 분리한다 — health-check.ps1 의 점검 대상도 아니고, Electron
# 바이너리가 없으면 기동할 수 없어서 실패 조건도 다르다. 기본으로 함께
# 띄우되 -NoDesktop 으로 뺄 수 있다.
$DesktopScript = "start-desktop-client.ps1"

foreach ($service in $Services) {
    $scriptPath = Join-Path $ScriptDir $service
    Write-Host "Starting $service ..."
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $scriptPath
    Start-Sleep -Seconds 1
}

if (-not $NoDesktop) {
    # 서비스들이 포트를 잡을 시간을 준다 — Desktop 은 기동 시점에
    # agent-runtime/search-runtime/office-mcp-server 를 점검해 경고를 띄운다.
    Start-Sleep -Seconds 5
    Write-Host "Starting $DesktopScript ..."
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ScriptDir $DesktopScript)
}

Write-Host ""
Write-Host "7개 서비스를 각자의 PowerShell 창에서 기동했습니다."
if (-not $NoDesktop) {
    Write-Host "Desktop Client(Electron)도 함께 기동했습니다 — Electron 바이너리가 없으면 그 창에 해결 방법이 표시됩니다."
}
Write-Host "모두 준비될 때까지 10~20초 정도 기다린 뒤 아래로 상태를 확인하세요:"
Write-Host "  .\scripts\windows\health-check.ps1"
