<#
  Modo demonstração da PoC: a API fica FECHADA (ingress internal) o tempo todo e só é
  aberta durante a demo. Fora disso, a superfície de ataque é zero e o custo também.

  Uso:
    .\infra\scripts\demo.ps1 on [-Minutes 60]   abre a API e agenda o fechamento automático
    .\infra\scripts\demo.ps1 off                fecha a API agora
    .\infra\scripts\demo.ps1 status             mostra o ingress atual

  -AutoOff cria um job do Cloud Scheduler de execução única ("demo-auto-off") que fecha a API sozinho.
  Requer UMA vez dar roles/run.developer à SA scheduler-invoker no serviço roboflow-api.
  Sem -AutoOff, lembre de rodar `off`.
  O kill-switch de orçamento continua valendo por cima de tudo.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('on', 'off', 'status')][string]$Action,
  [int]$Minutes = 60,
  [switch]$AutoOff,
  [string]$Project = 'compiladores-512823',
  [string]$Region = 'us-central1',
  [string]$Service = 'roboflow-api'
)
$ErrorActionPreference = 'Continue'
$job = 'demo-auto-off'
$api = "https://run.googleapis.com/v2/projects/$Project/locations/$Region/services/${Service}?updateMask=ingress"

function Get-Ingress {
  (gcloud run services describe $Service --region $Region --project $Project --format "value(metadata.annotations['run.googleapis.com/ingress'])").Trim()
}

switch ($Action) {
  'status' { Write-Host "ingress: $(Get-Ingress)" }
  'on' {
    gcloud run services update $Service --region $Region --project $Project --ingress all --quiet
    if ($LASTEXITCODE -ne 0) { throw 'falha ao abrir a API' }
    # Fechamento automático: Scheduler de disparo único, na SA scheduler-invoker (precisa de run.developer, ver README).
    if (-not $AutoOff) { Write-Host 'API ABERTA. Rode "demo.ps1 off" ao terminar (ou use -AutoOff).'; return }
    $when = (Get-Date).AddMinutes($Minutes)
    $cron = "$($when.Minute) $($when.Hour) $($when.Day) $($when.Month) *"
    gcloud scheduler jobs delete $job --location $Region --project $Project --quiet 2>$null | Out-Null
    gcloud scheduler jobs create http $job --location $Region --project $Project `
      --schedule $cron --time-zone 'America/Sao_Paulo' --http-method PATCH `
      --uri $api --message-body '{"ingress":"INGRESS_TRAFFIC_INTERNAL_ONLY"}' `
      --headers 'Content-Type=application/json' `
      --oauth-service-account-email "scheduler-invoker@$Project.iam.gserviceaccount.com" `
      --oauth-token-scope 'https://www.googleapis.com/auth/cloud-platform' --quiet
    if ($LASTEXITCODE -ne 0) { Write-Warning 'API aberta, mas o fechamento automático NÃO foi agendado. Rode "demo.ps1 off" ao terminar.' }
    else { Write-Host "API ABERTA. Fecha sozinha às $($when.ToString('HH:mm')) (ou rode: demo.ps1 off)." }
  }
  'off' {
    gcloud run services update $Service --region $Region --project $Project --ingress internal --quiet
    gcloud scheduler jobs delete $job --location $Region --project $Project --quiet 2>$null | Out-Null
    Write-Host "API FECHADA. ingress: $(Get-Ingress)"
  }
}
