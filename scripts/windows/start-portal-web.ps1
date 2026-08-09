<#
.SYNOPSIS
    portal-web (M01, Portal UI)을 :3000 포트에서 기동한다 (Next.js dev
    서버).

.DESCRIPTION
    package.json 루트의 `dev:portal` 스크립트(`pnpm --filter portal-web
    dev` -> `next dev --port 3000`)와 동일한 명령. 사전에 저장소 루트에서
    `pnpm install`이 끝나 있어야 한다.
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

# 폐쇄망 전제: Next.js 익명 통계 외부 전송을 끈다. next.config.mjs 에서도
# 동일하게 설정하지만, 빌드/기동 시점에 따라 config 로드 전에 참조되는
# 경우가 있어 프로세스 환경변수로도 명시한다 (이중 방어).
$env:NEXT_TELEMETRY_DISABLED = "1"

pnpm --filter portal-web dev
