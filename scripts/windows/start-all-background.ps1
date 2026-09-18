<#
.SYNOPSIS
    전체 스택을 **이 창 하나에서** 백그라운드로 기동하고, 로그는 파일로 남긴다.

.DESCRIPTION
    `start-all.ps1` 은 서비스마다 PowerShell 창을 하나씩 띄운다 — 로그는 바로
    보이지만 창이 7~8개가 되어 화면을 덮는다. 이 스크립트는 같은 기동
    스크립트들을 **숨긴 프로세스**로 띄우고 출력을 `logs\<서비스>.log` 로
    보낸다. 창은 이것 하나뿐이고, 표 하나로 무엇이 떴는지 보여준 뒤 끝난다.

    기동한 프로세스 ID는 `logs\running-services.json` 에 기록한다 —
    `stop-all.ps1` / `restart-all.ps1` 이 **그 프로세스만** 정확히 종료하기
    위해서다(이름으로 python/node 를 싹 죽이면 이 PC 의 다른 작업까지 죽는다).

    로그는 `.\scripts\windows\logs.ps1` 로 본다:
        .\scripts\windows\logs.ps1                      # 어떤 로그가 있는지
        .\scripts\windows\logs.ps1 agent-runtime -Follow  # 실시간으로 따라가기

    사전 준비는 `start-all.ps1` 과 같다(install-pip / pnpm install / migrate /
    Ollama). 이 스크립트도 Ollama 는 기동하지 않는다.

.PARAMETER NoDesktop
    Desktop Client(Electron)를 띄우지 않는다. 기본은 **함께 띄운다**
    (`start-all.ps1` 과 같은 규칙). `-WindowStyle Hidden` 이 숨기는 것은
    PowerShell 콘솔이지 Electron 앱 창이 아니다 — 앱 창은 평소처럼 뜨고,
    콘솔 창만 사라진다. Electron 바이너리가 없으면 그 이유가
    `logs\desktop-client.log` 에 남는다.

.PARAMETER Only
    일부만 기동한다(예: `-Only portal-api,agent-runtime`). 이름은
    `_services.ps1` 의 서비스 이름이다.

.NOTES
    종료: `.\scripts\windows\stop-all.ps1`
    재시작: `.\scripts\windows\restart-all.ps1 -Background`
    상태:   `.\scripts\windows\health-check.ps1`
#>

param(
    [switch]$NoDesktop,
    [string[]]$Only
)

. "$PSScriptRoot\_preflight.ps1"
. "$PSScriptRoot\_services.ps1"

Write-Host "사전 점검 중..." -ForegroundColor Cyan
$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "portal_api"
Assert-PnpmReady
Warn-IfOllamaMissing
Write-Host "사전 점검 통과." -ForegroundColor Green
Write-Host ""

$LogDir = Get-HubLogDir
$PidFile = Get-HubPidFile

$targets = Get-HubServices | Where-Object { $_.Kind -eq "service" -or (-not $NoDesktop) }
if ($Only) {
    $targets = $targets | Where-Object { $Only -contains $_.Name }
    if (-not $targets) {
        Write-Host "[오류] -Only 에 맞는 서비스가 없습니다. 사용 가능한 이름:" -ForegroundColor Red
        Get-HubServices | ForEach-Object { Write-Host ("  {0}" -f $_.Name) }
        exit 1
    }
}

# 이전 실행 기록에 살아 있는 프로세스가 있으면 알려준다 — 모르고 두 번 띄우면
# 뒤엣것이 "포트 사용 중"으로 죽고, 사용자는 로그에서 그 이유를 찾아야 한다.
if (Test-Path $PidFile) {
    $previous = @(Get-Content $PidFile -Raw | ConvertFrom-Json)
    $alive = @($previous | Where-Object { $_.ProcessId -gt 0 -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) })
    if ($alive.Count -gt 0) {
        Write-Host ("[경고] 이전에 기동한 프로세스 {0}개가 아직 살아 있습니다: {1}" -f $alive.Count, (($alive | ForEach-Object { $_.Name }) -join ", ")) -ForegroundColor Yellow
        Write-Host "       먼저 .\scripts\windows\stop-all.ps1 로 정리하거나, restart-all.ps1 -Background 를 쓰세요." -ForegroundColor Yellow
        Write-Host ""
    }
}

# Desktop 은 맨 뒤로 민다. 기동 시점에 agent-runtime/search-runtime/
# office-mcp-server 를 점검해 경고를 띄우므로, 서비스보다 먼저 뜨면 "연결
# 끊김" 경고를 보고 시작하게 된다(start-all.ps1 이 5초를 기다리는 것과 같은
# 이유다).
# `Sort-Object` 를 쓰지 않는다 — PowerShell 5.1 의 정렬은 **안정적이지 않아**
# 서비스 기동 순서(portal-api 가 먼저)가 조용히 뒤섞인다(실측). 두 목록으로
# 나눠 이어 붙이면 선언 순서가 그대로 유지된다.
$targets = @(@($targets | Where-Object { $_.Kind -ne "app" }) + @($targets | Where-Object { $_.Kind -eq "app" }))

$started = @()
foreach ($service in $targets) {
    if ($service.Kind -eq "app" -and $started.Count -gt 0) {
        Write-Host "  (서비스가 포트를 잡을 때까지 5초 대기)" -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
    $scriptPath = Join-Path $PSScriptRoot $service.Script
    $outLog = Get-HubServiceLogPath -Name $service.Name
    $errLog = Get-HubServiceErrorLogPath -Name $service.Name

    # `Start-Process -RedirectStandardOutput` 는 기존 파일을 **덮어쓴다**
    # (실측). 그대로 두면 방금 왜 죽었는지가 다음 기동 순간 사라지므로,
    # 직전 로그를 `<서비스>.prev.log` 로 옮겨 둔다 — 한 세대만 남긴다
    # (더 쌓아 두면 아무도 지우지 않아 로그 폴더가 계속 커진다).
    foreach ($pair in @(@{ From = $outLog; To = "$outLog.prev" }, @{ From = $errLog; To = "$errLog.prev" })) {
        if ((Test-Path $pair.From) -and ((Get-Item $pair.From).Length -gt 0)) {
            Move-Item -Path $pair.From -Destination $pair.To -Force
        }
    }

    $process = Start-Process powershell `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -PassThru

    $started += [pscustomobject]@{
        Name      = $service.Name
        ProcessId = $process.Id
        Port      = $service.Port
        Log       = $outLog
        StartedAt = (Get-Date).ToString("o")
    }
    Write-Host ("  기동 {0,-20} PID {1,-7} 로그 {2}" -f $service.Name, $process.Id, (Split-Path -Leaf $outLog))
    Start-Sleep -Milliseconds 700
}

$started | ConvertTo-Json -Depth 3 | Set-Content -Path $PidFile -Encoding utf8

Write-Host ""
Write-Host ("{0}개를 백그라운드로 기동했습니다. 이 창은 닫아도 됩니다." -f $started.Count) -ForegroundColor Green
if ($started | Where-Object { $_.Name -eq "desktop-client" }) {
    Write-Host "Desktop Client(Electron) 앱 창은 곧 뜹니다 — 뜨지 않으면 logs\desktop-client.log 에 이유가 있습니다." -ForegroundColor DarkGray
}
Write-Host ("로그 폴더: {0}" -f $LogDir)
Write-Host ""
Write-Host "다음 명령을 쓰세요:"
Write-Host "  .\scripts\windows\logs.ps1                       # 로그 목록"
Write-Host "  .\scripts\windows\logs.ps1 agent-runtime -Follow # 실시간"
Write-Host "  .\scripts\windows\health-check.ps1               # 기동 확인(10~20초 뒤)"
Write-Host "  .\scripts\windows\stop-all.ps1                   # 전부 종료"
