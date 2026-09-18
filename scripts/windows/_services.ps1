<#
.SYNOPSIS
    Windows 기동 스크립트들이 공유하는 서비스 목록과 로그/PID 경로.

.DESCRIPTION
    `start-all.ps1`(창 여러 개) / `start-all-background.ps1`(한 창) /
    `stop-all.ps1` / `restart-all.ps1` / `logs.ps1` 이 **같은 목록**을 보게
    한다. 각 스크립트가 자기 목록을 들고 있으면 서비스를 하나 추가했을 때
    어느 하나만 갱신되고, "기동은 되는데 멈추지 않는다" 같은 상태가 생긴다.

    포트는 종료·상태 확인의 보조 수단이다(PID 기록이 없거나 오래됐을 때
    그 포트를 듣고 있는 프로세스를 찾는다).
#>

# 이 파일은 점(dot) 소싱 전용이다 — 직접 실행하면 아무 일도 하지 않는다.

function Get-HubRepoRoot {
    return (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

function Get-HubLogDir {
    $dir = Join-Path (Get-HubRepoRoot) "logs"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    return $dir
}

function Get-HubPidFile {
    return (Join-Path (Get-HubLogDir) "running-services.json")
}

<#
.SYNOPSIS
    기동 대상 서비스 목록.
.DESCRIPTION
    `Kind`:
      - `service` : HTTP 서비스. health-check 대상이고 포트로도 찾을 수 있다.
      - `app`     : Desktop Client(Electron). HTTP 서비스가 아니라 창을 띄운다.
                    `Port` 5173 은 함께 뜨는 Vite 렌더러 포트다 — health-check
                    대상은 아니지만, 종료할 때 기록된 PID 가 없어도 찾을 수
                    있게 하고, 재시작할 때 이 포트가 풀릴 때까지 기다리게
                    한다(Vite 는 `strictPort` 라 5173 이 잡혀 있으면 죽는다).
#>
function Get-HubServices {
    return @(
        [pscustomobject]@{ Name = "portal-api";           Script = "start-portal-api.ps1";           Port = 8000; Kind = "service" },
        [pscustomobject]@{ Name = "agent-runtime";        Script = "start-agent-runtime.ps1";        Port = 8100; Kind = "service" },
        [pscustomobject]@{ Name = "indexing-runtime";     Script = "start-indexing-runtime.ps1";     Port = 8200; Kind = "service" },
        [pscustomobject]@{ Name = "search-runtime";       Script = "start-search-runtime.ps1";       Port = 8300; Kind = "service" },
        [pscustomobject]@{ Name = "distribution-service"; Script = "start-distribution-service.ps1"; Port = 8400; Kind = "service" },
        [pscustomobject]@{ Name = "office-mcp-server";    Script = "start-office-mcp-server.ps1";    Port = 8500; Kind = "service" },
        [pscustomobject]@{ Name = "portal-web";           Script = "start-portal-web.ps1";           Port = 3000; Kind = "service" },
        [pscustomobject]@{ Name = "desktop-client";       Script = "start-desktop-client.ps1";       Port = 5173; Kind = "app" }
    )
}

<#
.SYNOPSIS
    `running-services.json` 의 기록을 **평평한 배열**로 읽는다.
.DESCRIPTION
    PowerShell 5.1 의 `ConvertFrom-Json` 은 JSON 배열을 파이프라인에 **객체
    하나(Object[])** 로 내보낸다. 그래서 `@(Get-Content ... | ConvertFrom-Json)`
    은 "원소 하나짜리 배열 안에 전체 배열"이 되고, 거기서 `.ProcessId` 를 읽으면
    모든 PID 의 배열이 나와 `[int]` 변환이 실패한다(2026-09-18 실측:
    "System.Object[] 유형의 값을 System.Int32 유형으로 변환할 수 없습니다").
    그 결과 기록된 PID 로는 아무것도 종료되지 않았고, 포트가 없는 Desktop
    Client 는 살아남아 로그 파일을 잡고 있었다.

    변수에 받은 뒤 한 번 더 펼친다. 파일이 없으면 빈 배열, 읽지 못하면 예외를
    그대로 던진다 — 호출자가 "포트로만 찾는다"고 알린다.
#>
function Read-HubPidRecords {
    $pidFile = Get-HubPidFile
    if (-not (Test-Path $pidFile)) { return @() }
    $parsed = Get-Content $pidFile -Raw | ConvertFrom-Json
    return @($parsed | ForEach-Object { $_ } | Where-Object { $null -ne $_ })
}

<#
.SYNOPSIS
    **이 저장소에서** 실행 중인 Electron 프로세스 ID들.
.DESCRIPTION
    Desktop Client 의 마지막 안전망이다 — 기록된 PID 트리와 5173 포트로도
    못 찾았을 때(부모 PowerShell 이 먼저 죽어 트리가 끊긴 경우) 쓴다. 실행
    파일 경로가 저장소 폴더 안에 있는 `electron.exe` 만 고른다 — VS Code,
    Slack 같은 이 PC 의 다른 Electron 앱은 건드리지 않는다.
#>
function Get-HubDesktopElectronProcessIds {
    $root = (Get-HubRepoRoot).TrimEnd('\') + '\'
    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction Stop
    } catch {
        return @()
    }
    return @($processes |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -ExpandProperty ProcessId)
}

function Get-HubServiceLogPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    return (Join-Path (Get-HubLogDir) ("{0}.log" -f $Name))
}

function Get-HubServiceErrorLogPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    # stdout 과 같은 파일로 합칠 수 없다 — Start-Process 는 두 리다이렉션
    # 대상이 같으면 거부한다. 그래서 오류는 별도 파일로 둔다.
    return (Join-Path (Get-HubLogDir) ("{0}.err.log" -f $Name))
}

<#
.SYNOPSIS
    그 포트를 듣고 있는 프로세스 ID들.
.DESCRIPTION
    PID 기록이 없거나(다른 방식으로 띄웠다) 오래됐을 때 쓰는 보조 경로.
    `Get-NetTCPConnection` 이 없는 환경(구형 Windows)에서는 빈 배열을 돌려주고
    호출자는 "찾지 못했다"로 degrade 한다 — 조용히 아무것도 안 하지 않는다.
#>
function Get-HubListenerProcessIds {
    param([Parameter(Mandatory = $true)][int]$Port)
    if ($Port -le 0) { return @() }
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return @() }
    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch {
        return @()
    }
    return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

<#
.SYNOPSIS
    프로세스와 그 자식들을 확실히 종료한다.
.DESCRIPTION
    `Stop-Process` 는 자식을 남긴다. uvicorn `--reload` 와 pnpm 은 실제 작업을
    자식 프로세스에서 하므로, 부모만 죽이면 포트를 계속 잡고 있는 고아
    프로세스가 남는다 — 그러면 다음 기동이 "포트 사용 중"으로 실패한다.
    그래서 `taskkill /T`(트리) 를 쓴다.
#>
function Stop-HubProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
    & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
    return $true
}
