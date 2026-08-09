<#
.SYNOPSIS
    search-runtime (M08, Knowledge Search)을 :8300 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-search-runtime` 타겟과 동일한 명령.
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\search-runtime")

uv run uvicorn search_runtime.main:app --reload --port 8300
