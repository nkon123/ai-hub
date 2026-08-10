<#
.SYNOPSIS
    office-mcp-server (M10, 읽기 전용 MCP Tool 서버)를 :8500 포트에서
    기동한다.

.DESCRIPTION
    Makefile의 `dev-office-mcp-server` 타겟과 동일한 명령. Health Check는
    `/health`가 아니라 `/health/live`, `/health/ready`에 있다(health-check.ps1
    참고).
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "office_mcp_server"
Warn-IfPortInUse -Port 8500 -ServiceName "office-mcp-server"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\office-mcp-server")

& $Python -m uvicorn office_mcp_server.main:app --reload --port 8500
