<#
.SYNOPSIS
    search-runtime (M08, Knowledge Search)을 :8300 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-search-runtime` 타겟과 동일한 명령.
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "search_runtime"
Warn-IfPortInUse -Port 8300 -ServiceName "search-runtime"
Warn-IfOllamaMissing

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\search-runtime")

& $Python -m uvicorn search_runtime.main:app --reload --port 8300
