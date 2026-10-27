# Estágio 4. Verificação de AGV offline (1 job; a cota gratuita cobre 3 por conta de faturamento).

resource "google_cloud_scheduler_job" "offline_check" {
  count       = local.main_stack
  name        = "device-offline-check"
  region      = var.region
  description = "Marca dispositivos sem poll como offline e gera alerta"
  schedule    = "*/5 * * * *"
  time_zone   = "America/Sao_Paulo"

  attempt_deadline = "30s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "${local.api_url}/internal/offline-check"

    oidc_token {
      service_account_email = google_service_account.scheduler_invoker.email
      audience              = local.api_url
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_service.api]
}
