<#
.SYNOPSIS
    portal-web (M01, Portal UI)을 :3000 포트에서 기동한다 (Next.js dev
    서버).

.DESCRIPTION
    package.json 루트의 `dev:portal` 스크립트(`pnpm --filter portal-web
    dev` -> `next dev --port 3000`)와 동일한 명령. 사전에 저장소 루트에서
    `pnpm install`이 끝나 있어야 한다.
#>

. "$PSScriptRoot\_preflight.ps1"

Assert-PnpmReady
Warn-IfPortInUse -Port 3000 -ServiceName "portal-web"

# portal-web 은 브라우저 요청을 :8000 으로 넘긴다(next.config.mjs rewrite).
# portal-api 가 없으면 화면은 뜨지만 데이터가 비어 보이므로 미리 알린다.
if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "[경고] portal-api(:8000)가 아직 기동되지 않았습니다." -ForegroundColor Yellow
    Write-Host "       화면은 뜨지만 데이터가 비어 보입니다 — start-portal-api.ps1 을 먼저 실행하세요." -ForegroundColor DarkGray
}

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

# 폐쇄망 전제: Next.js 익명 통계 외부 전송을 끈다. next.config.mjs 에서도
# 동일하게 설정하지만, 빌드/기동 시점에 따라 config 로드 전에 참조되는
# 경우가 있어 프로세스 환경변수로도 명시한다 (이중 방어).
$env:NEXT_TELEMETRY_DISABLED = "1"

pnpm --filter portal-web dev
