<#
.SYNOPSIS
    portal-api (M02)를 :8000 포트에서 기동한다.

.DESCRIPTION
    portal-api 를 개발 모드로 기동한다 (`uvicorn
    portal_api.main:app --reload --port 8000`)과 동일한 명령을 Windows
    PowerShell에서 실행한다. 사전에 `.\scripts\windows\install-pip.ps1` 과
    `.\scripts\windows\migrate.ps1` 이 끝나
    있어야 한다.
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "portal_api"
Warn-IfPortInUse -Port 8000 -ServiceName "portal-api"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "apps\portal-api")

& $Python -m uvicorn portal_api.main:app --reload --port 8000
