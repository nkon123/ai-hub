<#
.SYNOPSIS
    7개 서비스(+선택적으로 Ollama)의 Health Check 엔드포인트를 확인한다.

.DESCRIPTION
    Makefile의 `health-check` 타겟과 동일한 대상을 확인한다. 각 서비스는
    독립적으로 실패할 수 있으므로 하나가 응답하지 않아도 나머지는 계속
    확인한다(첫 실패에서 멈추지 않음).

.PARAMETER IncludeOllama
    지정하면 Ollama(:11434)의 /api/tags도 함께 확인하고, 필요한 두 모델
    (exaone3.5:7.8b, qwen3-embedding:0.6b)이 pull되어 있는지도 표시한다.
    기본은 꺼짐 — Makefile의 `health-check` 타겟에는 없는 확인이라 기본
    동작을 그대로 유지하기 위함이다.
#>

param(
    [switch]$IncludeOllama
)

$Endpoints = @(
    @{ Name = "portal-api (:8000)";           Url = "http://127.0.0.1:8000/health" },
    @{ Name = "agent-runtime (:8100)";        Url = "http://127.0.0.1:8100/health" },
    @{ Name = "indexing-runtime (:8200)";     Url = "http://127.0.0.1:8200/health" },
    @{ Name = "search-runtime (:8300)";       Url = "http://127.0.0.1:8300/health" },
    @{ Name = "distribution-service (:8400)"; Url = "http://127.0.0.1:8400/health" },
    @{ Name = "office-mcp-server (:8500)";    Url = "http://127.0.0.1:8500/health/live" },
    @{ Name = "portal-web (:3000)";           Url = "http://127.0.0.1:3000" }
)

$allOk = $true

foreach ($ep in $Endpoints) {
    try {
        $response = Invoke-WebRequest -Uri $ep.Url -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Write-Host "[OK]   $($ep.Name)" -ForegroundColor Green
        } else {
            Write-Host "[WARN] $($ep.Name) - HTTP $($response.StatusCode)" -ForegroundColor Yellow
            $allOk = $false
        }
    } catch {
        Write-Host "[FAIL] $($ep.Name) - $($_.Exception.Message)" -ForegroundColor Red
        $allOk = $false
    }
}

if ($IncludeOllama) {
    Write-Host ""
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 5
        $tags = ($response.Content | ConvertFrom-Json).models | ForEach-Object { $_.name }
        Write-Host "[OK]   Ollama (:11434) - 설치된 모델: $($tags -join ', ')" -ForegroundColor Green

        foreach ($required in @("exaone3.5:7.8b", "qwen3-embedding:0.6b")) {
            if ($tags -contains $required) {
                Write-Host "       - $required 확인됨" -ForegroundColor Green
            } else {
                Write-Host "       - $required 없음 -> ollama pull $required 필요" -ForegroundColor Red
                $allOk = $false
            }
        }
    } catch {
        Write-Host "[FAIL] Ollama (:11434) - $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "       'ollama serve'가 실행 중인지 확인하세요." -ForegroundColor Red
        $allOk = $false
    }
}

Write-Host ""
if ($allOk) {
    Write-Host "모든 확인 항목이 정상입니다." -ForegroundColor Green
    exit 0
} else {
    Write-Host "일부 항목이 정상이 아닙니다. 위 실패 항목의 PowerShell 창 로그를 확인하세요." -ForegroundColor Red
    exit 1
}
