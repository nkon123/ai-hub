<#
.SYNOPSIS
    설치 상태를 한 번에 점검한다. 무엇이 빠졌는지와 다음에 무엇을 할지 알려준다.

.DESCRIPTION
    사내 PC 반입 시 "명령이 없다"는 문제가 반복되어 만든 점검 스크립트다.
    Python / venv / 파이썬 패키지 / Node / pnpm / node_modules / Ollama /
    모델 / 포트 사용 여부를 순서대로 확인한다.

    실행해도 아무것도 변경하지 않는다(읽기 전용).

.EXAMPLE
    .\scripts\windows\doctor.ps1
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

$problems = @()

function Show-Result($label, $ok, $detail, $fix) {
    if ($ok) {
        Write-Host ("  [OK]   {0,-28} {1}" -f $label, $detail) -ForegroundColor Green
    } else {
        Write-Host ("  [실패] {0,-28} {1}" -f $label, $detail) -ForegroundColor Red
        if ($fix) { $script:problems += "$label : $fix" }
    }
}

Write-Host ""
Write-Host "=== Python ===" -ForegroundColor Cyan

$py = Get-Command python -ErrorAction SilentlyContinue
Show-Result "python" ($null -ne $py) $(if ($py) { (& python --version 2>&1) } else { "찾을 수 없음" }) `
    "Python 3.11 이상을 설치하고 PATH 에 추가하세요."

$venvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$hasVenv = Test-Path $venvPython
Show-Result ".venv" $hasVenv $(if ($hasVenv) { $venvPython } else { "없음" }) `
    ".\scripts\windows\install-pip.ps1 을 실행하세요."

if ($hasVenv) {
    Write-Host ""
    Write-Host "=== Python 패키지 (.venv) ===" -ForegroundColor Cyan

    # 실행 파일(.exe)이 아니라 import 가능 여부로 판단한다 —
    # 기동 스크립트는 `python -m <모듈>` 로 부르므로 .exe 는 없어도 된다.
    $modules = @(
        @{ Name = "uvicorn";  Import = "uvicorn" },
        @{ Name = "fastapi";  Import = "fastapi" },
        @{ Name = "alembic";  Import = "alembic" },
        @{ Name = "chromadb"; Import = "chromadb" },
        @{ Name = "pypdf (PDF 색인)";      Import = "pypdf" },
        @{ Name = "python-docx (Word 색인)"; Import = "docx" }
    )
    foreach ($m in $modules) {
        & $venvPython -c "import $($m.Import)" 2>$null
        Show-Result $m.Name ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -eq 0) { "import 가능" } else { "import 실패" }) `
            "python -m pip install -r requirements.txt 를 다시 실행하세요."
    }

    Write-Host ""
    Write-Host "=== 워크스페이스 패키지 (.venv) ===" -ForegroundColor Cyan
    foreach ($mod in @("ai_asset_schemas", "security_policy", "observability", "portal_api", "agent_runtime", "indexing_runtime", "search_runtime")) {
        & $venvPython -c "import $mod" 2>$null
        Show-Result $mod ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -eq 0) { "import 가능" } else { "import 실패" }) `
            ".\scripts\windows\install-pip.ps1 의 editable 설치 단계를 확인하세요."
    }
}

Write-Host ""
Write-Host "=== Node / pnpm ===" -ForegroundColor Cyan

$node = Get-Command node -ErrorAction SilentlyContinue
Show-Result "node" ($null -ne $node) $(if ($node) { (& node --version 2>&1) } else { "찾을 수 없음" }) `
    "Node.js 를 설치하세요."

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
Show-Result "pnpm" ($null -ne $pnpm) $(if ($pnpm) { (& pnpm --version 2>&1) } else { "찾을 수 없음" }) `
    "corepack enable 또는 npm install -g pnpm 을 실행하세요."

$nextBin = Join-Path $RepoRoot "apps\portal-web\node_modules\.bin\next"
$hasNext = (Test-Path $nextBin) -or (Test-Path "$nextBin.cmd")
Show-Result "portal-web 의존성" $hasNext $(if ($hasNext) { "설치됨" } else { "node_modules 없음" }) `
    "저장소 루트에서 pnpm install 을 실행하세요."

Write-Host ""
Write-Host "=== Ollama ===" -ForegroundColor Cyan
try {
    $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -ErrorAction Stop
    Show-Result "Ollama 서버" $true "응답함" $null
    $names = @($tags.models | ForEach-Object { $_.name })
    foreach ($want in @("exaone3.5:7.8b", "qwen3-embedding:0.6b")) {
        $found = $names -contains $want
        Show-Result "모델 $want" $found $(if ($found) { "설치됨" } else { "없음" }) `
            "ollama pull $want 를 실행하세요."
    }
} catch {
    Show-Result "Ollama 서버" $false "127.0.0.1:11434 응답 없음" "ollama serve 가 실행 중인지 확인하세요."
}

Write-Host ""
Write-Host "=== 서비스 포트 ===" -ForegroundColor Cyan
$ports = @{ 3000 = "portal-web"; 8000 = "portal-api"; 8100 = "agent-runtime"; 8200 = "indexing-runtime"; 8300 = "search-runtime"; 8400 = "distribution-service"; 8500 = "office-mcp-server" }
foreach ($port in ($ports.Keys | Sort-Object)) {
    $inUse = $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $state = if ($inUse) { "기동 중" } else { "미기동" }
    Write-Host ("  [--]   {0,-28} {1} ({2})" -f "$port", $ports[$port], $state) -ForegroundColor DarkGray
}

Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "문제 없음. .\scripts\windows\start-all.ps1 로 기동하세요." -ForegroundColor Green
} else {
    Write-Host "해결해야 할 항목:" -ForegroundColor Yellow
    foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Yellow }
}
Write-Host ""
