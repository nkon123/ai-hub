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
      - `app`     : Desktop Client(Electron). 포트가 없고 창을 직접 띄우므로
                    백그라운드 기동 대상에서 기본 제외한다.
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
        [pscustomobject]@{ Name = "desktop-client";       Script = "start-desktop-client.ps1";       Port = 0;    Kind = "app" }
    )
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
