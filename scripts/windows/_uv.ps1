<#
.SYNOPSIS
    `uv` 를 어떻게 호출할지 결정한다. 다른 스크립트가 dot-source 해서 쓴다.

.DESCRIPTION
    `pip install uv` 로 설치했을 때 Windows 에서 `Scripts\` 디렉터리가 PATH 에
    없어 `uv` 명령이 잡히지 않는 경우가 흔하다(실제로 이 PoC 반입 과정에서
    발생했다). 이때도 `python -m uv` 는 항상 동작하므로, PATH 에 없으면
    자동으로 그쪽으로 넘어간다.

    사용 예:
        . "$PSScriptRoot\_uv.ps1"
        Invoke-Uv run uvicorn portal_api.main:app --reload --port 8000
#>

function Get-UvCommand {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        return @{ Exe = "uv"; Prefix = @() }
    }

    # PATH 에 없다 — python -m uv 로 실행 가능한지 확인한다.
    # 주의: `??`(null 병합)는 PowerShell 7+ 전용이라 Windows 기본인
    # Windows PowerShell 5.1 에서 구문 오류가 난다. 5.1 호환으로 작성한다.
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        $python = Get-Command py -ErrorAction SilentlyContinue
    }
    if (-not $python) {
        throw "uv 와 python 을 모두 찾을 수 없습니다. docs/implementation-spec/13-windows-local-setup.md §2.5 를 참고해 설치하세요."
    }

    & $python.Source -m uv --version *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[안내] uv 가 PATH 에 없어 'python -m uv' 로 실행합니다." -ForegroundColor Yellow
        Write-Host "       PATH 에 추가하려면 13-windows-local-setup.md §2.6 참고." -ForegroundColor DarkGray
        return @{ Exe = $python.Source; Prefix = @("-m", "uv") }
    }

    throw "uv 를 찾을 수 없습니다. 'python -m pip install uv' 후 다시 시도하세요. (13-windows-local-setup.md §2.5)"
}

function Invoke-Uv {
    $uv = Get-UvCommand
    & $uv.Exe @($uv.Prefix + $args)
}
