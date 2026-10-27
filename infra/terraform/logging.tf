# Cloud Logging dentro da cota gratuita (50 GiB/mês por projeto). Sem buckets nem sinks
# extras: tudo continua no bucket _Default, com retenção padrão de 30 dias.

resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = 30

  depends_on = [google_project_service.apis]
}

# Corta ruído de alto volume que não ajuda a diagnosticar nada:
#  - requisições de /health (sondas e smoke) que deram certo;
#  - polls do AGV que deram certo (/device/poll com 2xx), a categoria mais frequente.
# Erros (4xx/5xx) e os logs de aplicação continuam sendo gravados.
resource "google_logging_project_exclusion" "noise_health" {
  name        = "exclude-health-ok"
  description = "Requisições /health bem-sucedidas"
  filter      = "resource.type=\"cloud_run_revision\" AND logName:\"run.googleapis.com%2Frequests\" AND httpRequest.requestUrl:\"/health\" AND httpRequest.status<400"

  depends_on = [google_logging_project_bucket_config.default]
}

resource "google_logging_project_exclusion" "noise_poll" {
  name        = "exclude-device-poll-ok"
  description = "Polls do AGV bem-sucedidos"
  filter      = "resource.type=\"cloud_run_revision\" AND logName:\"run.googleapis.com%2Frequests\" AND httpRequest.requestUrl:\"/device/poll\" AND httpRequest.status<400"

  depends_on = [google_logging_project_bucket_config.default]
}
