<#
.SYNOPSIS
    agent-runtime (M05, Local Agent Runtime)을 :8100 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-agent-runtime` 타겟과 동일한 명령. 이 서비스는 로컬
    Ollama(기본 http://127.0.0.1:11434)를 호출하므로, 먼저 `ollama serve`가
    떠 있고 exaone3.5:7.8b / qwen3-embedding:0.6b 모델이 pull되어 있어야
    정상 동작한다 (docs/implementation-spec/13-windows-local-setup.md 참고).
#>

. "$PSScriptRoot\_python.ps1"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\agent-runtime")

Invoke-Py -m uvicorn agent_runtime.main:app --reload --port 8100
