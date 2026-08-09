<#
.SYNOPSIS
    portal-api (M02)를 :8000 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-portal-api` 타겟(`cd apps/portal-api && uv run uvicorn
    portal_api.main:app --reload --port 8000`)과 동일한 명령을 Windows
    PowerShell에서 실행한다. 사전에 `uv sync --all-packages`와
    `apps/portal-api`에서 `uv run alembic upgrade head`(migrate.ps1)가 끝나
    있어야 한다.
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "apps\portal-api")

uv run uvicorn portal_api.main:app --reload --port 8000
