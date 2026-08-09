<#
.SYNOPSIS
    indexing-runtime (M07, Knowledge Indexing)을 :8200 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-indexing-runtime` 타겟과 동일한 명령. INDEX_BASE 환경
    변수를 지정하지 않으면 저장소 루트 기준 `data\indexes`를 기본값으로
    사용한다(services/indexing-runtime/src/indexing_runtime/main.py).
    PDF(.pdf)/Word(.docx) Knowledge를 색인하려면 `uv sync`가 pypdf/
    python-docx까지 설치를 마친 뒤여야 한다 — 설치 전에는 해당 파일이
    "PDF 로더에 필요한 pypdf가 설치되어 있지 않습니다" 같은 명확한 오류로
    실패한다(크래시 아님).
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "services\indexing-runtime")

uv run uvicorn indexing_runtime.main:app --reload --port 8200
