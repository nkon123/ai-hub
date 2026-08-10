<#
.SYNOPSIS
    distribution-service (M03, Repository/Download/Offline Bundle)를 :8400
    포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-distribution-service` 타겟과 동일한 명령.
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "distribution_service"
Warn-IfPortInUse -Port 8400 -ServiceName "distribution-service"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\distribution-service")

& $Python -m uvicorn distribution_service.main:app --reload --port 8400
