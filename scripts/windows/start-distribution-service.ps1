<#
.SYNOPSIS
    distribution-service (M03, Repository/Download/Offline Bundle)를 :8400
    포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-distribution-service` 타겟과 동일한 명령.
#>

. "$PSScriptRoot\_uv.ps1"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\distribution-service")

Invoke-Uv run uvicorn distribution_service.main:app --reload --port 8400
