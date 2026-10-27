<#
  Constrói a imagem do backend com Cloud Build (a partir da RAIZ do repo, usando backend/Dockerfile)
  e implanta no Cloud Run.

  Por que `gcloud run deploy --image` e não `terraform apply -var image_tag=...`:
  o Terraform ignora mudanças de imagem do serviço (lifecycle.ignore_changes), para não
  desfazer o que o CI/este script implantam. Um `terraform apply` com nova image_tag não
  trocaria a imagem. O deploy por gcloud só troca a imagem e preserva env, escala e IAM.
  O Terraform continua dono da configuração; o deploy é dono da imagem.

  Pré-requisitos: estágios 1 a 6 do bootstrap aplicados (bucket de staging, conta cloud-build,
  Artifact Registry e serviço roboflow-api existem).

  Uso: .\infra\scripts\build-and-deploy.ps1 [-Tag <tag>] [-SkipDeploy] [-Smoke]
#>
param(
  [string]$Project = 'compiladores-512823',
  [string]$Region = 'us-central1',
  [string]$Service = 'roboflow-api',
  [string]$Tag,
  [switch]$SkipDeploy,
  [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if (-not $Tag) {
  $sha = (git -C $root rev-parse --short HEAD).Trim()
  $dirty = if (git -C $root status --porcelain) { '-dirty-' + (Get-Date -Format 'yyyyMMddHHmmss') } else { '' }
  $Tag = "$sha$dirty"
}

$bucket = "$Project-build-staging"
$image = "$Region-docker.pkg.dev/$Project/roboflow/api:$Tag"
$buildSa = "projects/$Project/serviceAccounts/cloud-build@$Project.iam.gserviceaccount.com"

# Guarda: o bucket multirregional padrão fica fora da cota gratuita. Avisa se ele existir.
$legacy = gcloud storage buckets list --project $Project --filter "name=${Project}_cloudbuild" --format 'value(name)' 2>$null
if ($legacy) { Write-Warning "Existe o bucket padrão gs://${Project}_cloudbuild (multi-região). Veja infra/COST_ZERO.md para removê-lo." }

Write-Host "Build: $image"
gcloud builds submit $root `
  --project $Project --region $Region `
  --config (Join-Path $root 'infra\cloudbuild\api.yaml') `
  --ignore-file (Join-Path $root 'infra\cloudbuild\api.gcloudignore') `
  --gcs-source-staging-dir "gs://$bucket/source" `
  --service-account $buildSa `
  --substitutions "_IMAGE=$image"
if ($LASTEXITCODE -ne 0) { throw 'Cloud Build falhou (veja infra/RUNBOOK.md, "Permissões do Cloud Build")' }

if ($SkipDeploy) { Write-Host "Imagem publicada: $image"; return }

Write-Host "Deploy: $Service <- $image"
gcloud run deploy $Service --image $image --region $Region --project $Project --quiet
if ($LASTEXITCODE -ne 0) { throw 'gcloud run deploy falhou' }

$url = (gcloud run services describe $Service --region $Region --project $Project --format 'value(status.url)').Trim()
Write-Host "Serviço: $url"
if ($Smoke) { & (Join-Path $PSScriptRoot 'smoke.ps1') -BaseUrl $url }
