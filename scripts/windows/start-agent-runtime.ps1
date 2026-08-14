<#
.SYNOPSIS
    agent-runtime (M05, Local Agent Runtime)을 :8100 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-agent-runtime` 타겟과 동일한 명령. 이 서비스는 로컬
    Ollama(기본 http://127.0.0.1:11434)를 호출하므로, 먼저 `ollama serve`가
    떠 있고 exaone3.5:7.8b / qwen3-embedding:0.6b 모델이 pull되어 있어야
    정상 동작한다 (docs/implementation-spec/13-windows-local-setup.md 참고).
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "agent_runtime"
Warn-IfPortInUse -Port 8100 -ServiceName "agent-runtime"
Warn-IfOllamaMissing

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\agent-runtime")

# 로컬 데모에서만, Office Profile이 이미 허용한 서버 Alias에 한해 Desktop의
# MCP Tool 계약 등록을 연다. Tool 실행 권한은 office-profile.json의
# allowed_tools와 Office MCP Server가 별도로 다시 검사한다.
$env:AGENT_RUNTIME_MCP_TOOL_REGISTRATION_ALLOWED_ALIASES = '["oracle-connector"]'

& $Python -m uvicorn agent_runtime.main:app --reload --port 8100
