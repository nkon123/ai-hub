<#
.SYNOPSIS
    어떤 Python 으로 실행할지 결정한다. 다른 스크립트가 dot-source 해서 쓴다.

.DESCRIPTION
    Windows 로컬 실행은 pip + venv 경로를 기본으로 한다(uv 불필요).
    저장소 루트의 `.venv` 가 있으면 그 안의 python 을, 없으면 현재 활성화된
    환경의 python 을 쓴다. 둘 다 없으면 설치 문서를 가리키는 오류로 실패한다.

    사용 예:
        . "$PSScriptRoot\_python.ps1"
        Invoke-Py -m uvicorn portal_api.main:app --reload --port 8000
#>

function Get-RepoPython {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

    if (Test-Path $venvPython) {
        return $venvPython
    }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        $python = Get-Command py -ErrorAction SilentlyContinue
    }
    if (-not $python) {
        throw "Python 을 찾을 수 없습니다. docs/implementation-spec/13-windows-local-setup.md 를 참고해 설치하세요."
    }

    Write-Host "[안내] .venv 가 없어 현재 환경의 python 을 사용합니다." -ForegroundColor Yellow
    Write-Host "       권장: .\scripts\windows\install-pip.ps1 로 .venv 를 만들어 설치." -ForegroundColor DarkGray
    return $python.Source
}

function Invoke-Py {
    $py = Get-RepoPython
    & $py @args
}
