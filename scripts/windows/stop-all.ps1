<#
.SYNOPSIS
    기동한 스택 전체를 종료한다.

.DESCRIPTION
    두 경로로 찾는다:
      1. `logs\running-services.json` 에 기록된 PID (background 기동분)
      2. 각 서비스 포트를 **실제로 듣고 있는** 프로세스 (창을 띄워 기동했거나
         기록이 오래된 경우)

    이름으로 python/node 를 싹 죽이지 않는다 — 이 PC 에서 돌고 있는 다른 작업
    까지 함께 죽기 때문이다. 종료는 `taskkill /T`(프로세스 트리)로 한다:
    uvicorn `--reload` 와 pnpm 은 실제 작업을 자식 프로세스에서 하므로 부모만
    죽이면 포트를 계속 잡은 고아가 남고, 다음 기동이 "포트 사용 중"으로
    실패한다.

    Desktop Client(Electron)도 기본 대상이다 — `start-all-background.ps1` 이
    기본으로 띄우기 때문이다. 기록된 PID 트리, Vite 포트(5173), 그리고 그래도
    남은 **이 저장소 폴더 안의** `electron.exe` 순서로 찾는다 — VS Code 같은
    이 PC 의 다른 Electron 앱은 건드리지 않는다.

.PARAMETER NoDesktop
    Desktop Client 는 그대로 둔다.

.PARAMETER Only
    일부만 종료한다(예: `-Only portal-web`).
#>

param(
    [switch]$NoDesktop,
    [string[]]$Only
)

. "$PSScriptRoot\_services.ps1"

$PidFile = Get-HubPidFile
$targets = Get-HubServices | Where-Object { $_.Kind -eq "service" -or (-not $NoDesktop) }
if ($Only) {
    $targets = $targets | Where-Object { $Only -contains $_.Name }
}

$recorded = @()
if (Test-Path $PidFile) {
    try {
        $recorded = @(Read-HubPidRecords)
    } catch {
        Write-Host ("[경고] PID 기록을 읽지 못했습니다({0}) — 포트로만 찾습니다." -f $_.Exception.Message) -ForegroundColor Yellow
    }
}

$stoppedCount = 0
$notFound = @()

foreach ($service in $targets) {
    $killed = @()

    foreach ($entry in @($recorded | Where-Object { $_.Name -eq $service.Name })) {
        if (Stop-HubProcessTree -ProcessId ([int]$entry.ProcessId)) {
            $killed += [int]$entry.ProcessId
        }
    }

    # 기록에 없어도(창으로 띄웠거나 기록이 오래됨) 포트를 잡고 있으면 그것이
    # 이 서비스다. 여기서 멈추지 않으면 다음 기동이 반드시 실패한다.
    foreach ($processId in (Get-HubListenerProcessIds -Port $service.Port)) {
        if ($killed -contains [int]$processId) { continue }
        if (Stop-HubProcessTree -ProcessId ([int]$processId)) {
            $killed += [int]$processId
        }
    }

    # Desktop 의 마지막 안전망 — 부모가 먼저 죽어 트리가 끊겼으면 위 두 경로로는
    # Electron 이 안 보인다. 살아남으면 로그 파일을 잡고 있어 다음 기동이
    # 로그를 옮기지 못한다(2026-09-18 실측).
    if ($service.Kind -eq "app") {
        foreach ($processId in (Get-HubDesktopElectronProcessIds)) {
            if ($killed -contains [int]$processId) { continue }
            if (Stop-HubProcessTree -ProcessId ([int]$processId)) {
                $killed += [int]$processId
            }
        }
    }

    if ($killed.Count -gt 0) {
        $stoppedCount += $killed.Count
        Write-Host ("  종료 {0,-20} PID {1}" -f $service.Name, ($killed -join ", ")) -ForegroundColor Green
    } else {
        $notFound += $service.Name
    }
}

if ($notFound.Count -gt 0) {
    Write-Host ("  실행 중이 아님: {0}" -f ($notFound -join ", ")) -ForegroundColor DarkGray
}

# 기록은 지운다 — 남겨 두면 다음 기동에서 "이미 살아 있다"는 잘못된 경고가
# 뜬다. 종료하지 못한 것이 있어도 그 사실은 위에 이미 출력했다.
if (Test-Path $PidFile) { Remove-Item $PidFile -Force }

Write-Host ""
if ($stoppedCount -gt 0) {
    Write-Host ("{0}개 프로세스를 종료했습니다." -f $stoppedCount) -ForegroundColor Green
} else {
    Write-Host "종료할 프로세스를 찾지 못했습니다(이미 모두 멈춰 있습니다)." -ForegroundColor Yellow
}
Write-Host "로그 파일은 지우지 않았습니다 — logs\ 폴더에 그대로 남아 있습니다."
