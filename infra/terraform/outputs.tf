output "api_url" {
  description = "URL do serviço roboflow-api (também usada como audiência OIDC)."
  value       = local.api_url
}

output "registry_path" {
  description = "Prefixo das imagens no Artifact Registry."
  value       = local.registry_path
}

output "wif_provider" {
  description = "Valor para a variável de repositório GCP_WIF_PROVIDER no GitHub."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Valor para a variável de repositório GCP_DEPLOYER_SA no GitHub."
  value       = google_service_account.github_deployer.email
}

output "runtime_service_account" {
  value = google_service_account.api.email
}

output "killswitch_url" {
  value = var.enable_killswitch_service ? google_cloud_run_v2_service.killswitch[0].uri : null
}

output "build_staging_bucket" {
  description = "Bucket regional de staging para `gcloud builds submit --gcs-source-staging-dir=gs://<bucket>/source`."
  value       = google_storage_bucket.build_staging.name
}

output "build_service_account" {
  description = "Conta usada pelos builds (--service-account projects/<projeto>/serviceAccounts/<email>)."
  value       = google_service_account.build.email
}
