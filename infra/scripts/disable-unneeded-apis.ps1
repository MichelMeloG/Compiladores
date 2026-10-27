<#
  Lista (e, com -Apply, desabilita) as APIs desnecessárias para o POC de custo zero.
  O Terraform NÃO desabilita APIs ao remover da lista (disable_on_destroy = false), por isso este script.

  Sem -Apply: só mostra o que seria desabilitado e o que está habilitado hoje (leitura).
  Com -Apply: executa `gcloud services disable` (altera o projeto). Rode só depois de ler infra/COST_ZERO.md.
  -IncludeOptional também remove APIs padrão de analytics (BigQuery, Dataform, Dataplex...). Não geram custo
  parado; desabilitar só reduz superfície.
#>
param(
  [string]$Project = 'compiladores-512823',
  [switch]$Apply,
  [switch]$IncludeOptional
)

$unneeded = @(
  'secretmanager.googleapis.com',   # removido: sem Secret Manager (custo zero)
  'identitytoolkit.googleapis.com', # só quando for configurar o Firebase Auth (front)
  'firebase.googleapis.com'         # idem
)
$optional = @(
  'bigquery.googleapis.com', 'bigqueryconnection.googleapis.com', 'bigquerydatapolicy.googleapis.com',
  'bigquerydatatransfer.googleapis.com', 'bigquerymigration.googleapis.com', 'bigqueryreservation.googleapis.com',
  'bigquerystorage.googleapis.com', 'analyticshub.googleapis.com', 'dataform.googleapis.com',
  'dataplex.googleapis.com', 'apptopology.googleapis.com', 'sql-component.googleapis.com'
)
$targets = if ($IncludeOptional) { $unneeded + $optional } else { $unneeded }

$enabled = gcloud services list --enabled --project $Project --format 'value(config.name)'
$toDisable = $targets | Where-Object { $enabled -contains $_ }
Write-Host "Habilitadas e dispensáveis: $($toDisable -join ', ')"
if (-not $toDisable) { return }
if (-not $Apply) { Write-Host 'Nada alterado (use -Apply para desabilitar).'; return }

gcloud services disable @toDisable --project $Project
