<#
.SYNOPSIS
    Enterprise AI Asset Hub 전체 스택(7개 서비스)을 로컬에 기동한다.

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

foreach ($service in $Services) {
    $scriptPath = Join-Path $ScriptDir $service
    Write-Host "Starting $service ..."
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $scriptPath
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "7개 서비스를 각자의 PowerShell 창에서 기동했습니다."
Write-Host "모두 준비될 때까지 10~20초 정도 기다린 뒤 아래로 상태를 확인하세요:"
Write-Host "  .\scripts\windows\health-check.ps1"
