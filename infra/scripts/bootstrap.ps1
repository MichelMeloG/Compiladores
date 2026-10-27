<#
  Bootstrap por estágios. NADA é aplicado sem você pedir o estágio e confirmar o plano.

  Uso:   .\infra\scripts\bootstrap.ps1 -Stage 1
  Ordem: 1 (base, sem custo) -> 2 (imagem do kill-switch via Cloud Build) -> 3 (kill-switch + orçamento)
         -> 4 (testa o kill-switch) -> 5 (Firestore) -> 6 (stack completa)

  Pré-requisitos: gcloud logado na conta dona do projeto, `gcloud auth application-default login`,
  terraform no PATH e infra/terraform/terraform.tfvars criado a partir do .example
  (inclui device_secrets_json, que nunca é versionado).
#>
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 6)][int]$Stage,
  [string]$Project = 'compiladores-512823',
  [string]$Region = 'us-central1'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$tfdir = Join-Path $root 'infra\terraform'
$registry = "$Region-docker.pkg.dev/$Project/roboflow"

# State e tfvars (com segredos) ficam FORA do repositório e do OneDrive.
$stateDir = if ($env:ROBOFLOW_INFRA_DIR) { $env:ROBOFLOW_INFRA_DIR } else { Join-Path $HOME '.roboflow-infra' }
$stateFile = Join-Path $stateDir 'terraform.tfstate'
$varFile = Join-Path $stateDir 'terraform.tfvars'
if (-not (Test-Path $varFile)) { throw "Crie $varFile a partir de infra/terraform/terraform.tfvars.example" }

function Invoke-Tf([string[]]$TfArgs) {
  Push-Location $tfdir
  try {
    terraform init -input=false "-backend-config=path=$stateFile" -reconfigure
    terraform plan -input=false "-var-file=$varFile" -out=tfplan @TfArgs
    $answer = Read-Host 'Aplicar este plano? (digite SIM)'
    if ($answer -ne 'SIM') { Write-Host 'Cancelado.'; return }
    terraform apply -input=false tfplan
  } finally { Pop-Location }
}

switch ($Stage) {
  1 {
    # APIs, service accounts, Artifact Registry, bucket regional de staging, tópico budget-alerts, WIF. Nenhum recurso faturável.
    Invoke-Tf @()
  }
  2 {
    # Cloud Build com bucket de staging REGIONAL (criado no estágio 1) e conta dedicada.
    # Sem --gcs-source-staging-dir o gcloud criaria o bucket multirregional gs://<projeto>_cloudbuild
    # (fora da cota gratuita). Nunca omita essa flag.
    $bucket = "$Project-build-staging"
    gcloud builds submit (Join-Path $root 'infra\killswitch') `
      --project $Project --region $Region `
      --config (Join-Path $root 'infra\cloudbuild\killswitch.yaml') `
      --gcs-source-staging-dir "gs://$bucket/source" `
      --service-account "projects/$Project/serviceAccounts/cloud-build@$Project.iam.gserviceaccount.com" `
      --substitutions "_IMAGE=$registry/killswitch:v1"
  }
  3 {
    # Kill-switch ANTES do orçamento e de qualquer outro recurso faturável.
    Invoke-Tf @('-var', 'enable_killswitch_service=true', '-var', 'enable_budget=true')
  }
  4 {
    # Mensagem de teste (custo 0 < orçamento): o serviço deve registrar "sem corte".
    $msg = '{"costAmount":0,"budgetAmount":5,"alertThresholdExceeded":0.5}'
    gcloud pubsub topics publish budget-alerts --message=$msg --project $Project
    Start-Sleep -Seconds 20
    gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="budget-killswitch"' --limit 5 --freshness 5m --project $Project --format 'value(jsonPayload.message)'
  }
  5 {
    # Firestore primeiro (a localização é imutável: confira a região antes de aplicar).
    Invoke-Tf @('-var', 'enable_killswitch_service=true', '-var', 'enable_budget=true', '-var', 'enable_main_stack=true',
      '-target=google_firestore_database.default')
  }
  6 {
    Invoke-Tf @('-var', 'enable_killswitch_service=true', '-var', 'enable_budget=true', '-var', 'enable_main_stack=true')
  }
}
