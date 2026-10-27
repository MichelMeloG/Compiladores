# KILL-SWITCH DE CUSTO. Estágios 1 e 3. Deve existir antes de qualquer recurso faturável.
#
# Fluxo: Budget (conta de faturamento) -> topic budget-alerts -> push OIDC ->
# Cloud Run budget-killswitch -> Cloud Run Admin API: ingress do roboflow-api = internal-only.
#
# LIMITAÇÃO: orçamento NÃO é limite rígido. Os alertas têm atraso de horas; o gasto
# pode ultrapassar o valor antes do corte. Ver docs/adr/0006.

# --- Estágio 1: tópicos (sem custo) ---

resource "google_pubsub_topic" "budget_alerts" {
  name       = "budget-alerts"
  depends_on = [google_project_service.apis]
}

# --- Estágio 3: serviço ---

resource "google_cloud_run_v2_service" "killswitch" {
  count    = var.enable_killswitch_service ? 1 : 0
  name     = "budget-killswitch"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # protegido por IAM (sem allUsers): só budget-invoker chama

  deletion_protection = false

  template {
    service_account = google_service_account.killswitch.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = local.killswitch_image

      resources {
        limits = {
          cpu    = "1"
          memory = "128Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "TARGET_SERVICE"
        value = "projects/${var.project_id}/locations/${var.region}/services/${var.api_service_name}"
      }
      env {
        name  = "DRY_RUN"
        value = "false"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_artifact_registry_repository.roboflow,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "killswitch_invoker" {
  count    = var.enable_killswitch_service ? 1 : 0
  location = var.region
  name     = google_cloud_run_v2_service.killswitch[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.budget_invoker.email}"
}

resource "google_pubsub_subscription" "budget_push" {
  count = var.enable_killswitch_service ? 1 : 0
  name  = "budget-alerts-push"
  topic = google_pubsub_topic.budget_alerts.id

  ack_deadline_seconds       = 60
  message_retention_duration = "3600s"

  push_config {
    push_endpoint = google_cloud_run_v2_service.killswitch[0].uri
    oidc_token {
      service_account_email = google_service_account.budget_invoker.email
      audience              = google_cloud_run_v2_service.killswitch[0].uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  depends_on = [google_service_account_iam_member.pubsub_agent_token_budget]
}

# O service agent do Pub/Sub precisa gerar o token OIDC como budget-invoker.
resource "google_project_service_identity" "pubsub" {
  provider = google-beta
  project  = var.project_id
  service  = "pubsub.googleapis.com"

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "pubsub_agent_token_budget" {
  service_account_id = google_service_account.budget_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

# --- Estágio 3: orçamento (alertas por e-mail aos administradores da conta de faturamento) ---

resource "google_billing_budget" "poc" {
  count           = var.enable_budget ? 1 : 0
  billing_account = var.billing_account
  display_name    = "RoboFlow POC (${var.project_id})"

  budget_filter {
    projects        = ["projects/${local.project_number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.budget_alerts.id
    schema_version = "1.0"
    # Sem Cloud Monitoring (alert policies passam a ser cobradas): o e-mail vai para os
    # administradores da conta de faturamento (destinatários padrão).
    disable_default_iam_recipients = false
  }

  depends_on = [google_pubsub_topic.budget_alerts]
}
