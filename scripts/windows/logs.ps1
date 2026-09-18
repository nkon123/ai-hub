<#
.SYNOPSIS
    백그라운드로 기동한 서비스의 로그를 본다.

.DESCRIPTION
    `start-all-background.ps1` 은 각 서비스 출력을 `logs\<서비스>.log` 로,
    오류 출력을 `logs\<서비스>.err.log` 로 보낸다. 이 스크립트는 그 파일을
    찾아 보여준다.

        .\scripts\windows\logs.ps1                        # 무엇이 있는지, 얼마나 컸는지
        .\scripts\windows\logs.ps1 agent-runtime          # 마지막 80줄
        .\scripts\windows\logs.ps1 agent-runtime -Follow  # 실시간(Ctrl+C로 중단)
        .\scripts\windows\logs.ps1 portal-api -Tail 300
        .\scripts\windows\logs.ps1 search-runtime -Errors # 오류 로그 쪽
        .\scripts\windows\logs.ps1 -Grep "stage.timing"   # 전체에서 찾기

.PARAMETER Service
    서비스 이름(`portal-api`, `agent-runtime`, …). 생략하면 목록만 보여준다.

.PARAMETER Tail
    보여줄 마지막 줄 수(기본 80).

.PARAMETER Follow
    새 줄이 쌓이는 대로 계속 보여준다(`Get-Content -Wait`).

.PARAMETER Errors
    표준 출력(.log) 대신 오류 출력(.err.log)을 본다.

.PARAMETER Previous
    **직전 기동**의 로그(`.log.prev`)를 본다. 기동할 때마다 이전 로그는 이
    이름으로 한 세대만 보관된다 — 방금 죽은 이유를 다음 기동이 덮어쓰지
    않게 하기 위해서다.

.PARAMETER Grep
    모든 로그에서 이 문자열이 든 줄만 찾아 보여준다(서비스 이름과 함께).
    느린 턴을 추적할 때 `stage.timing`, 기동 실패는 `Traceback`/`Error`.
#>

param(
    [Parameter(Position = 0)]
    [string]$Service,
    [int]$Tail = 80,
    [switch]$Follow,
    [switch]$Errors,
    [switch]$Previous,
    [string]$Grep
)

. "$PSScriptRoot\_services.ps1"

$LogDir = Get-HubLogDir

function Show-LogInventory {
    # `.log` 와 직전 기동 로그(`.log.prev`)를 함께 본다 — 방금 죽은 이유는
    # 대개 직전 로그에 있다.
    $files = @(Get-ChildItem -Path $LogDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*.log" -or $_.Name -like "*.log.prev" } | Sort-Object Name)
    if ($files.Count -eq 0) {
        Write-Host "로그 파일이 없습니다." -ForegroundColor Yellow
        Write-Host "백그라운드로 기동해야 파일 로그가 쌓입니다:"
        Write-Host "  .\scripts\windows\start-all-background.ps1"
        Write-Host "(창을 띄우는 start-all.ps1 은 각 창에 직접 출력합니다 — 파일로 남지 않습니다.)"
        return
    }
    Write-Host ("로그 폴더: {0}" -f $LogDir)
    Write-Host ""
    $files | ForEach-Object {
        $sizeKb = [math]::Round($_.Length / 1KB, 1)
        Write-Host ("  {0,-28} {1,8} KB  마지막 기록 {2}" -f $_.Name, $sizeKb, $_.LastWriteTime.ToString("MM-dd HH:mm:ss"))
    }
    Write-Host ""
    Write-Host "보기:  .\scripts\windows\logs.ps1 <서비스> [-Follow] [-Tail 200] [-Errors] [-Previous]"
    Write-Host "       .log.prev 는 직전 기동의 로그입니다(한 세대만 보관)."
}

function Find-InAllLogs {
    param([string]$Pattern)
    # `.log` 와 직전 기동 로그(`.log.prev`)를 함께 본다 — 방금 죽은 이유는
    # 대개 직전 로그에 있다.
    $files = @(Get-ChildItem -Path $LogDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*.log" -or $_.Name -like "*.log.prev" } | Sort-Object Name)
    if ($files.Count -eq 0) {
        Write-Host "로그 파일이 없습니다." -ForegroundColor Yellow
        return
    }
    $found = 0
    foreach ($file in $files) {
        $matches = @(Select-String -Path $file.FullName -Pattern $Pattern -SimpleMatch -ErrorAction SilentlyContinue)
        if ($matches.Count -eq 0) { continue }
        $found += $matches.Count
        Write-Host ("--- {0} ({1}건)" -f $file.Name, $matches.Count) -ForegroundColor Cyan
        $matches | Select-Object -Last 40 | ForEach-Object { Write-Host ("  {0}" -f $_.Line) }
    }
    if ($found -eq 0) {
        Write-Host ("'{0}' 을(를) 어느 로그에서도 찾지 못했습니다." -f $Pattern) -ForegroundColor Yellow
    }
}

if ($Grep) {
    Find-InAllLogs -Pattern $Grep
    return
}

if (-not $Service) {
    Show-LogInventory
    return
}

$known = Get-HubServices | Where-Object { $_.Name -eq $Service }
if (-not $known) {
    Write-Host ("[오류] 모르는 서비스입니다: {0}" -f $Service) -ForegroundColor Red
    Write-Host "사용 가능한 이름:"
    Get-HubServices | ForEach-Object { Write-Host ("  {0}" -f $_.Name) }
    exit 1
}

if ($Errors) {
    $path = Get-HubServiceErrorLogPath -Name $Service
} else {
    $path = Get-HubServiceLogPath -Name $Service
}
if ($Previous) { $path = "$path.prev" }

if (-not (Test-Path $path)) {
    # "파일이 없다"와 "서비스가 죽었다"는 다른 사실이다 — 섞어서 말하지 않는다.
    Write-Host ("로그 파일이 아직 없습니다: {0}" -f $path) -ForegroundColor Yellow
    Write-Host "이 서비스를 백그라운드로 기동한 적이 없거나, 방금 기동해 아직 출력이 없습니다."
    exit 1
}

Write-Host ("{0}  (Ctrl+C로 중단)" -f $path) -ForegroundColor Cyan
Write-Host ""
if ($Follow) {
    Get-Content -Path $path -Tail $Tail -Wait
} else {
    Get-Content -Path $path -Tail $Tail
}
