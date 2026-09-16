<#
.SYNOPSIS
    search-runtime (M08, Knowledge Search)을 :8300 포트에서 기동한다.

.DESCRIPTION
    Makefile의 `dev-search-runtime` 타겟과 동일한 명령.

    추가로 `SEARCH_LOCAL_INDEX_ROOTS`를 Desktop Client의 설치 경로로 지정한다
    (이미 설정돼 있으면 건드리지 않는다). 이 값이 비어 있으면 Desktop이 Offline
    Bundle로 설치한 Knowledge는 `POST /search/v1/local-indexes`가 403
    `local_indexes_disabled`로 거부해 영원히 검색되지 않는다(D-079).

    코드 기본값이 아니라 여기서 지정하는 이유: 빈 기본값은 의도된 것이다.
    중앙에 배포된 search-runtime은 이 기능으로 새 파일시스템 접근 면을 얻지
    않아야 하고, 오직 Desktop과 같은 PC에서 도는 배포만 이 경로를 명시적으로
    지정한다 — 이 개발용 스크립트가 정확히 그 경우다.
#>

. "$PSScriptRoot\_preflight.ps1"

$Python = Resolve-Python
Assert-PythonModule -Python $Python -Module "uvicorn" -Purpose "서비스 기동"
Assert-WorkspaceModule -Python $Python -Module "search_runtime"
Warn-IfPortInUse -Port 8300 -ServiceName "search-runtime"
Warn-IfOllamaMissing

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Electron의 userData 이름은 개발 실행과 패키징 설치가 다르다: 개발은
# package.json의 `name`("desktop-client"), 설치본은 electron-builder.yml의
# `productName`("AI Asset Hub 데스크톱"). 어느 쪽으로 띄웠는지 여기서 알 수
# 없으므로 둘 다 허용한다 — 허용 루트는 "닿을 수 있는 경로의 상한"일 뿐이고
# (그 안의 디렉터리는 index-meta.json 일치, 비실행 bm25.json 등을 추가로
# 통과해야 등록된다), 둘 다 같은 사용자의 자기 앱 데이터다.
if (-not $env:SEARCH_LOCAL_INDEX_ROOTS) {
    $env:SEARCH_LOCAL_INDEX_ROOTS = @(
        (Join-Path $env:APPDATA "desktop-client\assets"),
        (Join-Path $env:APPDATA "AI Asset Hub 데스크톱\assets")
    ) -join [System.IO.Path]::PathSeparator
    Write-Host "Desktop 설치 Knowledge 활성화 허용 경로:" -ForegroundColor DarkGray
    foreach ($p in $env:SEARCH_LOCAL_INDEX_ROOTS -split [System.IO.Path]::PathSeparator) {
        Write-Host "  $p" -ForegroundColor DarkGray
    }
}

Set-Location (Join-Path $RepoRoot "services\search-runtime")

& $Python -m uvicorn search_runtime.main:app --reload --port 8300
