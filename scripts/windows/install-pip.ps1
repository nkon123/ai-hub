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

.PARAMETER Loose
    requirements.txt 의 고정 버전 대신 각 pyproject.toml 의 범위로 설치한다.
    사내 미러에 정확한 고정 버전이 없을 때의 대안. 재현성은 떨어진다.

.EXAMPLE
    .\scripts\windows\install-pip.ps1

.EXAMPLE
    .\scripts\windows\install-pip.ps1 -Loose
#>

param(
    [switch]$SkipVenv,
    # 사내 미러에 고정된 정확한 버전이 없을 때 사용한다. requirements.txt 의
    # `==` 고정을 무시하고 각 pyproject.toml 의 범위(`>=`)로 설치한다.
    # 재현성이 떨어지므로 일괄 설치가 실패했을 때만 쓴다.
    [switch]$Loose
)

# 주의: $ErrorActionPreference = "Stop" 을 쓰지 않는다.
# pip 은 성공했을 때도 경고(새 pip 버전 알림 등)를 stderr 로 내보내는데,
# "Stop" 에서는 PowerShell 이 그것만으로 스크립트를 중단시킬 수 있다.
# 실제로 "단독 pip install 은 되는데 이 스크립트로는 실패한다"는 보고가 있었다.
# 성공/실패는 아래에서 $LASTEXITCODE 로만 판정한다.
$ErrorActionPreference = "Continue"

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
        if ($LASTEXITCODE -ne 0) { throw "가상환경 생성 실패 (python -m venv .venv)" }
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
# 업그레이드 실패는 치명적이지 않다 — 기존 pip 으로도 설치가 가능한 경우가 많다.
if ($LASTEXITCODE -ne 0) {
    Write-Host "      pip 업그레이드에 실패했지만 계속 진행합니다." -ForegroundColor Yellow
}

if ($Loose) {
    Write-Host "[3/4] 외부 의존성 설치 (-Loose: 고정 버전 대신 pyproject 범위)" -ForegroundColor Cyan
    Write-Host "      재현성이 떨어집니다 - 미러에 고정 버전이 없을 때만 쓰세요." -ForegroundColor Yellow

    # 워크스페이스 패키지를 --no-deps 없이 설치하면 pip 이 그 pyproject 의
    # 외부 의존성을 범위(>=)대로 해석해 가져온다. 워크스페이스끼리의 참조는
    # PyPI 에 없어 실패하므로, 의존 순서대로 설치해 앞선 것이 이미 환경에
    # 있는 상태를 만든다.
    foreach ($group in @($Layer1, $Layer2, $Layer3)) {
        foreach ($pkg in $group) {
            Write-Host "      - $pkg (의존성 포함)" -ForegroundColor DarkGray
            & $Python -m pip install -e $pkg
            if ($LASTEXITCODE -ne 0) { throw "-Loose 설치 실패: $pkg" }
        }
    }
    Write-Host "      외부 의존성 설치 완료 (-Loose)." -ForegroundColor Green
}
else {
Write-Host "[3/4] 외부 의존성 설치 (requirements.txt)" -ForegroundColor Cyan
& $Python -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "일괄 설치가 실패했습니다. 어느 패키지가 문제인지 하나씩 확인합니다..." -ForegroundColor Yellow
    Write-Host "(시간이 걸립니다. 이미 설치된 것은 건너뜁니다.)" -ForegroundColor DarkGray
    Write-Host ""

    # 어떤 줄에서 실패했는지 알려주지 않으면 사용자가 손쓸 방법이 없다.
    # 한 줄씩 설치해 실패 목록을 모은다.
    $failed = @()
    foreach ($line in (Get-Content requirements.txt)) {
        $spec = $line.Trim()
        if (-not $spec -or $spec.StartsWith("#")) { continue }

        & $Python -m pip install $spec --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            $failed += $spec
            Write-Host "  실패: $spec" -ForegroundColor Red
        }
    }

    Write-Host ""
    if ($failed.Count -eq 0) {
        Write-Host "개별 설치는 모두 성공했습니다. 일괄 설치만 실패한 경우로, 그대로 진행합니다." -ForegroundColor Green
    } else {
        Write-Host "설치하지 못한 패키지 $($failed.Count)개:" -ForegroundColor Red
        foreach ($f in $failed) { Write-Host "  - $f" -ForegroundColor Red }
        Write-Host ""
        Write-Host "확인할 것:" -ForegroundColor Yellow
        Write-Host "  1) 사내 미러에 해당 패키지가 있는가" -ForegroundColor Yellow
        Write-Host "       python -m pip index versions <패키지명>" -ForegroundColor DarkGray
        Write-Host "  2) 고정된 정확한 버전이 미러에 없을 수 있다." -ForegroundColor Yellow
        Write-Host "     그럴 때는 버전 고정을 풀고 설치한다(재현성은 떨어진다):" -ForegroundColor Yellow
        Write-Host "       .\scripts\windows\install-pip.ps1 -Loose" -ForegroundColor DarkGray
        Write-Host "  3) 인덱스/인증서 설정 확인" -ForegroundColor Yellow
        Write-Host "       python -m pip config list" -ForegroundColor DarkGray
        Write-Host ""
        throw "외부 의존성 설치 실패 — 위 목록을 확인하세요."
    }
}
}

Write-Host "[4/4] 워크스페이스 패키지 editable 설치 (의존 순서)" -ForegroundColor Cyan
if ($Loose) { Write-Host "      -Loose 에서 이미 설치했으므로 --no-deps 로 다시 확정합니다." -ForegroundColor DarkGray }
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
