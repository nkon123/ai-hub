<#
.SYNOPSIS
    pip 만으로 Python 의존성을 설치한다 (uv 불필요).

.DESCRIPTION
    사내망에서 uv 가 pip.ini 의 미러 설정을 읽지 못해 설치가 실패하는 경우가
    있어, pip 만으로 완결되는 설치 경로를 제공한다.

    두 단계로 나뉜다.

      1. requirements.txt — uv.lock 에서 생성한 외부 패키지 고정 버전 목록.
      2. 워크스페이스 내부 패키지 — PyPI 에 없으므로 로컬 경로에서 editable 로
         설치한다.

    2단계는 `--no-deps` 로 설치한다. 이 패키지들은 서로를 이름으로만 참조하는데
    (예: portal-api 가 `ai-asset-schemas` 를 요구), 그 이름은 PyPI 에 존재하지
    않으므로 `--no-deps` 없이 설치하면 pip 이 PyPI 에서 찾다가 실패한다.
    외부 의존성은 이미 1단계에서 고정 버전으로 전부 설치되므로 `--no-deps` 로
    건너뛰어도 빠지는 것이 없다.

    아래 순서는 각 pyproject.toml 의 [tool.uv.sources] 에서 도출한 의존 순서다.
    `--no-deps` 를 쓰는 한 순서 자체는 결과에 영향이 없지만, 누군가 그 옵션을
    뺐을 때 바로 깨지지 않도록 방어적으로 유지한다.

.PARAMETER SkipVenv
    가상환경 생성을 건너뛰고 현재 활성화된 환경에 설치한다.

.EXAMPLE
    .\scripts\windows\install-pip.ps1
#>

param([switch]$SkipVenv)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

# 의존 순서: 앞선 단계가 먼저 설치되어 있어야 다음 단계가 해석된다.
$Layer1 = @("packages/schemas", "packages/observability")
$Layer2 = @("packages/security-policy", "packages/evaluation-runner", "packages/knowledge-packager")
$Layer3 = @(
    "services/agent-runtime",
    "services/indexing-runtime",
    "services/search-runtime",
    "services/distribution-service",
    "services/office-mcp-server",
    "apps/portal-api"
)

if (-not $SkipVenv) {
    if (-not (Test-Path ".venv")) {
        Write-Host "[1/4] 가상환경 생성 (.venv)" -ForegroundColor Cyan
        python -m venv .venv
    } else {
        Write-Host "[1/4] 기존 .venv 사용" -ForegroundColor Cyan
    }
    $Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path $Python)) {
        throw ".venv\Scripts\python.exe 를 찾을 수 없습니다. 가상환경 생성이 실패했는지 확인하세요."
    }
} else {
    Write-Host "[1/4] -SkipVenv — 현재 활성 환경에 설치" -ForegroundColor Cyan
    $Python = "python"
}

Write-Host "[2/4] pip 업그레이드" -ForegroundColor Cyan
& $Python -m pip install --upgrade pip

Write-Host "[3/4] 외부 의존성 설치 (requirements.txt)" -ForegroundColor Cyan
& $Python -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "requirements.txt 설치 실패 — 사내 미러 설정(pip config list)을 확인하세요." }

Write-Host "[4/4] 워크스페이스 패키지 editable 설치 (의존 순서)" -ForegroundColor Cyan
foreach ($group in @($Layer1, $Layer2, $Layer3)) {
    foreach ($pkg in $group) {
        Write-Host "      - $pkg" -ForegroundColor DarkGray
        & $Python -m pip install -e $pkg --no-deps
        if ($LASTEXITCODE -ne 0) { throw "$pkg 설치 실패" }
    }
}

Write-Host ""
Write-Host "설치 완료." -ForegroundColor Green
Write-Host "다음 단계:" -ForegroundColor Green
Write-Host "  .\.venv\Scripts\Activate.ps1        # 가상환경 활성화"
Write-Host "  .\scripts\windows\migrate.ps1       # DB 마이그레이션"
Write-Host "  .\scripts\windows\start-all.ps1     # 서비스 기동"
