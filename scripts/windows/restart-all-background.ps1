<#
.SYNOPSIS
    전체 스택을 멈췄다가 백그라운드(한 창 + 파일 로그)로 다시 기동한다.

.DESCRIPTION
    `restart-all.ps1 -Background` 와 같다. `start-all-background.ps1` 과 짝을
    맞춰 이름만으로 바로 쓸 수 있게 둔 얇은 래퍼다 — 종료, 포트 대기, 기동
    로직은 전부 `restart-all.ps1` 에 있고 여기서 다시 구현하지 않는다(두 곳에
    두면 반드시 갈라진다).

    로그는 `logs\<서비스>.log` 에 남는다. `.\scripts\windows\logs.ps1` 로 본다.

.PARAMETER NoDesktop
    Desktop Client(Electron)는 멈추지도, 다시 띄우지도 않는다.

.PARAMETER Only
    일부 서비스만 재시작한다(예: `-Only agent-runtime,search-runtime`).

.PARAMETER TimeoutSeconds
    포트가 풀리기를 기다리는 최대 시간(기본 20초).
#>

param(
    [switch]$NoDesktop,
    [string[]]$Only,
    [int]$TimeoutSeconds = 20
)

$restartArgs = @{ Background = $true; TimeoutSeconds = $TimeoutSeconds }
if ($NoDesktop) { $restartArgs["NoDesktop"] = $true }
if ($Only) { $restartArgs["Only"] = $Only }

& (Join-Path $PSScriptRoot "restart-all.ps1") @restartArgs
exit $LASTEXITCODE
