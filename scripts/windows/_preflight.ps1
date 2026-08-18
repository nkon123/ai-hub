<#
.SYNOPSIS
    기동 전 사전 점검 함수 모음. 다른 스크립트가 dot-source 해서 쓴다.

.DESCRIPTION
    반입 과정에서 "명령이 없다"로 막히는 일이 반복됐는데, 원인은 대부분
    프로젝트 로컬 설치(.venv, node_modules)를 못 찾은 것이었다. 그때
    원시 오류(ModuleNotFoundError, 'pnpm'을 찾을 수 없습니다) 대신
    무엇을 실행하면 되는지 한국어로 알려주기 위한 헬퍼다.

    각 함수는 문제가 없으면 조용히 통과하고, 문제가 있으면 원인과 해결
    명령을 출력한 뒤 스크립트를 종료한다(exit 1).
#>

# Windows 한국어 환경의 기본 인코딩은 cp949 다. Python 은 파일을 열 때
# 로케일 인코딩을 쓰는 경우가 있어(예: configparser 가 alembic.ini 를 읽을 때)
# UTF-8 문자가 들어 있으면 UnicodeDecodeError 로 죽는다.
# PYTHONUTF8=1 은 Python 의 UTF-8 모드를 켜서 이 계열의 문제를 없앤다.
# (`.py` 소스 자체는 PEP 3120 에 따라 항상 UTF-8 로 읽히므로 영향 없다.)
$env:PYTHONUTF8 = "1"

function Write-Fix {
    param([string]$Problem, [string[]]$Fixes)

    Write-Host ""
    Write-Host "  문제: $Problem" -ForegroundColor Red
    Write-Host "  해결:" -ForegroundColor Yellow
    foreach ($f in $Fixes) { Write-Host "    $f" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  전체 상태를 보려면: .\scripts\windows\doctor.ps1" -ForegroundColor DarkGray
    Write-Host ""
}

function Get-RepoRootPath {
    return (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

<#
    .venv 의 python 경로를 돌려준다. 없으면 현재 환경의 python 으로 넘어가고,
    그것도 없으면 해결 안내 후 종료한다.
#>
function Resolve-Python {
    $repoRoot = Get-RepoRootPath
    $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

    if (Test-Path $venvPython) { return $venvPython }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }

    if (-not $python) {
        Write-Fix "Python 을 찾을 수 없습니다 (.venv 도 없음)." @(
            "1) Python 3.11 이상 설치 후 PATH 에 추가",
            "2) .\scripts\windows\install-pip.ps1 실행"
        )
        exit 1
    }

    Write-Host "[안내] .venv 가 없어 현재 환경의 python 을 사용합니다." -ForegroundColor Yellow
    Write-Host "       권장: .\scripts\windows\install-pip.ps1 로 .venv 를 만들어 설치" -ForegroundColor DarkGray
    return $python.Source
}

<#
    지정한 파이썬 모듈이 import 되는지 확인한다. 실행 파일(.exe) 존재 여부가
    아니라 import 가능 여부로 판단한다 — 기동은 `python -m <모듈>` 로 하므로
    .venv\Scripts\ 에 .exe 가 없어도 정상이다.
#>
function Assert-PythonModule {
    param(
        [Parameter(Mandatory = $true)][string]$Python,
        [Parameter(Mandatory = $true)][string]$Module,
        [string]$Purpose = ""
    )

    & $Python -c "import $Module" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $what = if ($Purpose) { "$Module ($Purpose)" } else { $Module }
        Write-Fix "파이썬 패키지 '$what' 를 import 할 수 없습니다." @(
            "1) .\scripts\windows\install-pip.ps1 실행 (권장)",
            "2) 이미 설치했다면 중간에 실패했을 수 있습니다:",
            "     .venv\Scripts\python.exe -m pip install -r requirements.txt",
            "3) 설치가 계속 실패하면 사내 미러 설정 확인: pip config list"
        )
        exit 1
    }
}

<#
    워크스페이스 패키지(예: portal_api)가 import 되는지 확인한다.
    실패 원인이 외부 패키지와 달라 안내를 구분한다.
#>
function Assert-WorkspaceModule {
    param(
        [Parameter(Mandatory = $true)][string]$Python,
        [Parameter(Mandatory = $true)][string]$Module
    )

    & $Python -c "import $Module" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Fix "워크스페이스 패키지 '$Module' 를 import 할 수 없습니다." @(
            "이 저장소의 로컬 패키지가 설치되지 않았습니다.",
            "  .\scripts\windows\install-pip.ps1",
            "",
            "수동으로 한다면 --no-deps 가 필요합니다 (없으면 pip 이 PyPI 에서",
            "찾다가 실패합니다):",
            "  .venv\Scripts\python.exe -m pip install -e <경로> --no-deps"
        )
        exit 1
    }
}

<#
    pnpm 과 portal-web 의존성 설치 여부를 확인한다.
#>
function Assert-PnpmReady {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Fix "pnpm 을 찾을 수 없습니다." @(
            "1) corepack enable      (Node 16.13 이상에 기본 포함)",
            "2) 또는 npm install -g pnpm"
        )
        exit 1
    }

    $repoRoot = Get-RepoRootPath
    $nextBin = Join-Path $repoRoot "apps\portal-web\node_modules\.bin\next"
    if (-not ((Test-Path $nextBin) -or (Test-Path "$nextBin.cmd"))) {
        Write-Fix "portal-web 의 의존성이 설치되어 있지 않습니다 (next 없음)." @(
            "저장소 루트에서 실행하세요:",
            "  pnpm install"
        )
        exit 1
    }
}

<#
    포트가 이미 사용 중이면 경고한다. 종료하지는 않는다 — 같은 서비스를
    다시 띄우려는 것일 수도 있어 판단은 사용자에게 맡긴다.
#>
function Warn-IfPortInUse {
    param([Parameter(Mandatory = $true)][int]$Port, [string]$ServiceName = "")

    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $label = if ($ServiceName) { "$ServiceName ($Port)" } else { "$Port" }
        Write-Host "[경고] 포트 $label 가 이미 사용 중입니다." -ForegroundColor Yellow
        Write-Host "       이미 기동되어 있다면 이 창은 닫아도 됩니다." -ForegroundColor DarkGray
        Write-Host "       사용 중인 프로세스 확인: Get-NetTCPConnection -LocalPort $Port -State Listen" -ForegroundColor DarkGray
    }
}

<#
    Ollama 서버와 필요한 모델을 확인한다. 없으면 경고만 한다 — 서비스 자체는
    기동되고, 실제 대화/색인을 시도할 때 실패하기 때문이다.
#>
function Assert-ElectronReady {
    <#
        Electron 실행 바이너리가 이 저장소가 고정한 버전으로 실제 설치되어
        있는지 확인한다.

        install-node.ps1 은 기본적으로 ELECTRON_SKIP_BINARY_DOWNLOAD=1 로
        바이너리를 건너뛴다(사내망에서 GitHub Releases 다운로드가 자주
        실패하기 때문). 그 상태로 `pnpm dev` 를 돌리면 `electron .` 이
        node_modules 대신 PATH 의 전역 Electron 으로 넘어가, 저장소가 원하는
        버전이 아닌 것으로 실행되거나 그대로 실패한다 — 실제로 겪은 문제이며
        (전역 31.x), 증상만 보면 원인을 알 수 없다. 그래서 여기서 명시적으로
        구분해 알린다.
    #>
    $repoRoot = Get-RepoRootPath
    $pkgPath = Join-Path $repoRoot "apps\desktop-client\package.json"
    $expectedRange = $null
    if (Test-Path $pkgPath) {
        try {
            $expectedRange = (Get-Content $pkgPath -Raw | ConvertFrom-Json).devDependencies.electron
        } catch {
            $expectedRange = $null
        }
    }

    $electronDir = Join-Path $repoRoot "node_modules\electron"
    if (-not (Test-Path $electronDir)) {
        $electronDir = Join-Path $repoRoot "apps\desktop-client\node_modules\electron"
    }

    $pathTxt = Join-Path $electronDir "path.txt"
    $installedVersionFile = Join-Path $electronDir "dist\version"

    if (-not (Test-Path $pathTxt)) {
        Write-Fix -Problem "Electron 실행 바이너리가 설치되어 있지 않습니다(패키지는 있어도 dist 바이너리가 없는 상태). 이대로 두면 PATH 의 전역 Electron 으로 실행되어 엉뚱한 버전이 뜹니다." -Fixes @(
            ".\scripts\windows\install-node.ps1 -WithElectron",
            "사내 미러가 있다면 먼저: `$env:ELECTRON_MIRROR = 'https://<사내미러>/electron/'"
        )
        exit 1
    }

    if (Test-Path $installedVersionFile) {
        $installed = (Get-Content $installedVersionFile -Raw).Trim()
        if ($expectedRange) {
            $expected = $expectedRange.TrimStart('^', '~', '=', 'v')
            if ($installed -ne $expected) {
                Write-Host ""
                Write-Host ("  [경고] 설치된 Electron 버전이 저장소가 고정한 버전과 다릅니다: {0} (기대: {1})" -f $installed, $expected) -ForegroundColor Yellow
                Write-Host "         버전이 낮으면 앱이 뜨지 않을 수 있습니다." -ForegroundColor DarkGray
                Write-Host "         해결: .\scripts\windows\install-node.ps1 -WithElectron -ReinstallElectron" -ForegroundColor Yellow
                Write-Host ""
            } else {
                Write-Host ("Electron {0} 확인." -f $installed) -ForegroundColor Green
            }
        }
    }
}

function Warn-IfOllamaMissing {
    try {
        $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -ErrorAction Stop
    } catch {
        Write-Host "[경고] Ollama(127.0.0.1:11434)가 응답하지 않습니다." -ForegroundColor Yellow
        Write-Host "       ollama serve 를 실행하세요. 없으면 대화/색인이 실패합니다." -ForegroundColor DarkGray
        return
    }

    $names = @($tags.models | ForEach-Object { $_.name })
    foreach ($want in @("exaone3.5:7.8b", "qwen3-embedding:0.6b")) {
        if ($names -notcontains $want) {
            Write-Host "[경고] Ollama 모델 '$want' 가 없습니다." -ForegroundColor Yellow
            Write-Host "       ollama pull $want" -ForegroundColor DarkGray
        }
    }
}
