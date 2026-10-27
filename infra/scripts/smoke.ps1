<#
  Smoke pós-deploy: GET /health (com retries por causa de cold start) e suíte de contrato.
  Uso: .\infra\scripts\smoke.ps1 -BaseUrl https://roboflow-api-483331439325.us-central1.run.app
  Variável opcional: CONTRACT_TEST_TOKEN (ID token do Firebase) para endpoints de operador.
#>
param([Parameter(Mandatory = $true)][string]$BaseUrl)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$ok = $false
for ($i = 1; $i -le 6 -and -not $ok; $i++) {
  try {
    $r = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 20
    if ($r.status -eq 'ok') { $ok = $true; Write-Host "health ok (tentativa $i)" }
    else { Write-Host "health respondeu sem status ok (tentativa $i)" }
  } catch {
    Write-Host "health falhou (tentativa $i): $($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
}
if (-not $ok) { throw "GET $BaseUrl/health não ficou ok" }

Push-Location (Join-Path $root 'contracts')
try {
  npm ci
  npm run contract:test -- --base-url $BaseUrl
  if ($LASTEXITCODE -ne 0) { throw 'suíte de contrato falhou' }
} finally { Pop-Location }
Write-Host 'smoke ok'
