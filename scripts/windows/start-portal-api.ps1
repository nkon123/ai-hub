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

. "$PSScriptRoot\_python.ps1"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "apps\portal-api")

Invoke-Py -m uvicorn portal_api.main:app --reload --port 8000
