<#
.SYNOPSIS
    전체 스택을 멈췄다가 다시 기동한다.

.DESCRIPTION
    `stop-all.ps1` 로 정리한 뒤 기동 스크립트를 부른다. 기본은 기존
    `start-all.ps1`(서비스마다 창 하나)이고, `-Background` 를 주면
    `start-all-background.ps1`(이 창 하나 + 파일 로그)을 쓴다.

    멈춘 뒤 바로 띄우지 않고 포트가 실제로 풀릴 때까지 기다린다 — uvicorn
    `--reload` 와 pnpm 은 종료 신호를 받고도 잠깐 포트를 잡고 있고, 그
    사이에 새로 띄우면 "포트 사용 중"으로 죽는다(재시작이 가장 흔하게
    실패하는 지점이다).

.PARAMETER Background
    한 창 + 백그라운드 + 파일 로그로 기동한다.

.PARAMETER NoDesktop
    Desktop Client(Electron)는 멈추지도, 다시 띄우지도 않는다. 기본은 함께
    다룬다(`start-all.ps1`/`start-all-background.ps1` 과 같은 규칙).

.PARAMETER Only
    일부 서비스만 재시작한다(예: `-Only agent-runtime`).

.PARAMETER TimeoutSeconds
    포트가 풀리기를 기다리는 최대 시간(기본 20초). 이 시간을 넘기면 어느
    포트가 아직 잡혀 있는지 이름과 함께 알려주고 멈춘다 — 실패할 것이 뻔한
    기동을 그냥 시도하지 않는다.
#>

param(
    [switch]$Background,
    [switch]$NoDesktop,
    [string[]]$Only,
    [int]$TimeoutSeconds = 20
)

. "$PSScriptRoot\_services.ps1"

Write-Host "1/3 종료 중..." -ForegroundColor Cyan
$stopArgs = @{}
if ($NoDesktop) { $stopArgs["NoDesktop"] = $true }
if ($Only) { $stopArgs["Only"] = $Only }
& (Join-Path $PSScriptRoot "stop-all.ps1") @stopArgs

Write-Host ""
Write-Host "2/3 포트가 풀리기를 기다리는 중..." -ForegroundColor Cyan

$watched = Get-HubServices | Where-Object { $_.Kind -eq "service" -and $_.Port -gt 0 }
if ($Only) { $watched = $watched | Where-Object { $Only -contains $_.Name } }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$busy = @()
while ($true) {
    $busy = @($watched | Where-Object { (Get-HubListenerProcessIds -Port $_.Port).Count -gt 0 })
    if ($busy.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 500
}

if ($busy.Count -gt 0) {
    Write-Host ""
    Write-Host ("[중단] {0}초를 기다렸지만 아직 사용 중인 포트가 있습니다:" -f $TimeoutSeconds) -ForegroundColor Red
    foreach ($service in $busy) {
        $pids = (Get-HubListenerProcessIds -Port $service.Port) -join ", "
        Write-Host ("  {0,-20} :{1}  PID {2}" -f $service.Name, $service.Port, $pids) -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "지금 기동하면 그 서비스는 '포트 사용 중'으로 죽습니다. 위 PID를 확인해" -ForegroundColor Yellow
    Write-Host "직접 종료한 뒤(taskkill /PID <번호> /T /F) 다시 실행하세요." -ForegroundColor Yellow
    exit 1
}

Write-Host "  모든 포트가 풀렸습니다." -ForegroundColor Green
Write-Host ""
Write-Host "3/3 기동 중..." -ForegroundColor Cyan

$startArgs = @{}
if ($Background) {
    if ($NoDesktop) { $startArgs["NoDesktop"] = $true }
    if ($Only) { $startArgs["Only"] = $Only }
    & (Join-Path $PSScriptRoot "start-all-background.ps1") @startArgs
} else {
    if ($Only) {
        # 창 모드에는 부분 기동이 없다(start-all.ps1 은 전체만 띄운다) —
        # 조용히 전체를 띄우면 사용자가 요청하지 않은 서비스까지 올라간다.
        Write-Host "[안내] -Only 는 -Background 모드에서만 지원합니다. 해당 서비스만 창으로 띄우려면" -ForegroundColor Yellow
        foreach ($name in $Only) {
            $service = Get-HubServices | Where-Object { $_.Name -eq $name }
            if ($service) { Write-Host ("  .\scripts\windows\{0}" -f $service.Script) -ForegroundColor Yellow }
        }
        exit 1
    }
    if ($NoDesktop) { $startArgs["NoDesktop"] = $true }
    & (Join-Path $PSScriptRoot "start-all.ps1") @startArgs
}
