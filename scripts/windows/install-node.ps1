<#
.SYNOPSIS
    Node 의존성을 설치한다. 폐쇄망에서 Electron 바이너리 내려받기가 막히는
    상황을 처리한다.

.DESCRIPTION
    `pnpm install` 은 apps/desktop-client 의 postinstall 단계에서 Electron
    실행 바이너리(약 100MB)를 GitHub Releases 에서 내려받는다. 사내망에서는
    이 요청이 막혀 `RequestError: read ECONNRESET` 로 실패하는 경우가 많다.

    중요한 점: **Portal 을 띄우는 데 Electron 은 필요 없다.** Electron 은
    Desktop Client 전용이고, Portal(:3000)은 Next.js 만 있으면 된다.

    기본 동작은 Electron 바이너리 내려받기를 건너뛰고 나머지를 모두
    설치하는 것이다. Desktop 의 렌더러(Vite)는 그대로 개발/실행할 수 있고,
    Electron 앱 자체를 띄울 때만 바이너리가 필요하다.

.PARAMETER PortalOnly
    portal-web 과 그 의존성만 설치한다. desktop-client 를 아예 건드리지 않는다.

.PARAMETER WithElectron
    Electron 바이너리도 내려받는다(네트워크가 허용되거나 ELECTRON_MIRROR 를
    설정한 경우).

.EXAMPLE
    .\scripts\windows\install-node.ps1
    # Electron 바이너리 없이 전체 설치 (권장)

.EXAMPLE
    .\scripts\windows\install-node.ps1 -PortalOnly
    # Portal 만 쓸 때

.EXAMPLE
    $env:ELECTRON_MIRROR = "https://사내미러/electron/"
    .\scripts\windows\install-node.ps1 -WithElectron
#>

param(
    [switch]$PortalOnly,
    [switch]$WithElectron,
    # 이미 설치된 Electron 바이너리를 지우고 다시 받는다. 전역/구버전
    # Electron 이 섞여 앱이 뜨지 않을 때 쓴다(실제로 겪은 문제: 전역 31.x).
    # -WithElectron 을 함께 켠 것으로 간주한다.
    [switch]$ReinstallElectron,
    # 폐쇄망 반입용: 인터넷 되는 PC 에서 받아 온
    # electron-v<버전>-win32-x64.zip 의 경로. 지정하면 네트워크 다운로드
    # 없이 이 zip 을 electron 패키지의 dist 로 풀고 path.txt 를 쓴다
    # (electron 의 install.js 가 isInstalled() 에서 확인하는 두 가지가
    # 정확히 dist\version 과 path.txt 다).
    [string]$ElectronZip
)

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host ""
    Write-Host "  문제: pnpm 을 찾을 수 없습니다." -ForegroundColor Red
    Write-Host "  해결:" -ForegroundColor Yellow
    Write-Host "    corepack enable          (Node 16.13 이상에 기본 포함)" -ForegroundColor Yellow
    Write-Host "    또는 npm install -g pnpm" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

if ($ReinstallElectron) {
    $WithElectron = $true
    foreach ($rel in @("node_modules\electron", "apps\desktop-client\node_modules\electron")) {
        $dir = Join-Path $RepoRoot $rel
        if (Test-Path $dir) {
            Write-Host "기존 Electron 설치를 지웁니다: $rel" -ForegroundColor Cyan
            Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not $WithElectron) {
    # Electron 의 install 스크립트가 읽는 공식 환경 변수.
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
    Write-Host "Electron 바이너리 내려받기를 건너뜁니다." -ForegroundColor Yellow
    Write-Host "  Portal(:3000)과 Desktop 렌더러(Vite)는 정상 동작합니다." -ForegroundColor DarkGray
    Write-Host "  Electron 앱 자체를 띄우려면 -WithElectron 으로 다시 실행하세요." -ForegroundColor DarkGray
    Write-Host ""
}

if ($PortalOnly) {
    Write-Host "portal-web 만 설치합니다..." -ForegroundColor Cyan
    pnpm install --filter portal-web...
} else {
    Write-Host "전체 워크스페이스를 설치합니다..." -ForegroundColor Cyan
    pnpm install
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  설치에 실패했습니다." -ForegroundColor Red
    Write-Host "  확인할 것:" -ForegroundColor Yellow
    Write-Host "    1) Electron 단계에서 실패했다면 -PortalOnly 로 우회할 수 있습니다:" -ForegroundColor Yellow
    Write-Host "         .\scripts\windows\install-node.ps1 -PortalOnly" -ForegroundColor DarkGray
    Write-Host "    2) 사내 npm 레지스트리 설정 확인:" -ForegroundColor Yellow
    Write-Host "         pnpm config get registry" -ForegroundColor DarkGray
    Write-Host "    3) 자체 서명 인증서를 쓰는 프록시라면:" -ForegroundColor Yellow
    Write-Host "         pnpm config set strict-ssl false   (보안팀 확인 후)" -ForegroundColor DarkGray
    Write-Host ""
    exit 1
}

$nextBin = Join-Path $RepoRoot "apps\portal-web\node_modules\.bin\next"
if ((Test-Path $nextBin) -or (Test-Path "$nextBin.cmd")) {
    Write-Host ""
    Write-Host "설치 완료. portal-web 을 기동할 수 있습니다." -ForegroundColor Green
    Write-Host "  .\scripts\windows\start-portal-web.ps1"
} else {
    Write-Host ""
    Write-Host "설치는 끝났지만 next 를 찾을 수 없습니다." -ForegroundColor Yellow
    Write-Host "  .\scripts\windows\install-node.ps1 -PortalOnly 로 다시 시도해 보세요." -ForegroundColor DarkGray
}


# --- 폐쇄망 반입: 미리 받아 둔 Electron zip 을 직접 설치 -------------------
# 사내망에서 GitHub Releases 에 닿지 않을 때 쓴다. 여기서 하는 일은
# electron 의 install.js 가 다운로드 후 하는 것과 같다: zip 을 패키지의
# dist 로 풀고, path.txt 에 실행 파일 상대경로(win32 는 electron.exe)를
# 쓴다. 그 둘이 있어야 isInstalled() 가 참이 된다.
if ($ElectronZip) {
    if (-not (Test-Path $ElectronZip)) {
        Write-Fix -Problem "지정한 Electron zip 을 찾을 수 없습니다: $ElectronZip" -Fixes @(
            "인터넷이 되는 PC 에서 electron-v<버전>-win32-x64.zip 을 받아 이 PC 로 옮긴 뒤 경로를 다시 지정하세요."
        )
        exit 1
    }

    # pnpm 배치에 따라 위치가 다르다. 링크(junction)면 실제 대상에 풀어야 한다.
    $link = $null
    foreach ($rel in @("apps\desktop-client\node_modules\electron", "node_modules\electron")) {
        $candidate = Join-Path $RepoRoot $rel
        if (Test-Path $candidate) { $link = $candidate; break }
    }
    if (-not $link) {
        Write-Fix -Problem "electron 패키지를 찾을 수 없습니다(pnpm install 이 끝나지 않았을 수 있습니다)." -Fixes @(
            "먼저 .\scripts\windows\install-node.ps1 을 실행해 의존성을 설치하세요."
        )
        exit 1
    }
    $pkg = (Get-Item $link).Target
    if (-not $pkg) { $pkg = (Resolve-Path $link).Path }

    Write-Host "Electron zip 을 설치합니다: $ElectronZip" -ForegroundColor Cyan
    Write-Host "  대상: $pkg" -ForegroundColor DarkGray
    Remove-Item (Join-Path $pkg "dist") -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $ElectronZip -DestinationPath (Join-Path $pkg "dist") -Force
    Set-Content -Path (Join-Path $pkg "path.txt") -Value "electron.exe" -NoNewline -Encoding ascii

    $versionFile = Join-Path $pkg "dist\version"
    $exe = Join-Path $pkg "dist\electron.exe"
    if ((Test-Path $versionFile) -and (Test-Path $exe)) {
        $installed = (Get-Content $versionFile -Raw).Trim()
        Write-Host "Electron $installed 설치 완료." -ForegroundColor Green
        Write-Host "  확인: .\scripts\windows\start-desktop-client.ps1" -ForegroundColor DarkGray
    } else {
        Write-Fix -Problem "zip 을 풀었지만 dist\version 또는 dist\electron.exe 가 없습니다 — zip 이 win32-x64 빌드가 맞는지 확인하세요." -Fixes @(
            "electron-v<버전>-win32-x64.zip 인지 확인(다른 플랫폼/아키텍처 zip 은 쓸 수 없습니다).",
            "받은 zip 의 SHA256 을 릴리스의 SHASUMS256.txt 와 대조하세요."
        )
        exit 1
    }
}
