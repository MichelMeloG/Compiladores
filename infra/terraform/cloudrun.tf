# Estágio 4. API única (modular monolith): /api/* (operador), /device/* (AGV),
# /internal/* (somente OIDC de Pub/Sub e Scheduler, validado pela aplicação).

resource "google_cloud_run_v2_service" "api" {
  count    = local.main_stack
  name     = var.api_service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = 80
    timeout                          = "30s"

    scaling {
      min_instance_count = 0 # escala a zero: custo ocioso nulo
      max_instance_count = 2 # teto de custo e de abuso (DoS)
    }

    containers {
      image = local.api_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle          = true # CPU só durante a requisição (cobrança por requisição)
        startup_cpu_boost = false
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "STORE"
        value = "firestore"
      }
      env {
        name  = "PUBSUB_TOPIC_EVENTS"
        value = "agv-events"
      }
      env {
        name  = "PUBSUB_TOPIC_DLQ"
        value = "agv-events-dlq"
      }
      env {
        name  = "CORS_ORIGINS"
        value = join(",", var.cors_origins)
      }
      env {
        name  = "AUTH_MODE"
        value = var.auth_mode
      }
      env {
        name  = "ALLOWED_OPERATOR_EMAILS"
        value = join(",", var.operator_emails)
      }
      env {
        name  = "INTERNAL_AUDIENCE"
        value = local.api_url
      }
      env {
        name  = "PUBSUB_PUSH_SA"
        value = google_service_account.pubsub_invoker.email
      }
      env {
        name  = "SCHEDULER_SA"
        value = google_service_account.scheduler_invoker.email
      }
      env {
        name  = "LOG_LEVEL"
        value = var.log_level
      }

      # Sem Secret Manager (custo zero estrito): o valor vem de var.device_secrets_json
      # (sensitive, só em terraform.tfvars ignorado pelo git). Fica no state local e, em
      # texto, na configuração do serviço. Ver ADR 0007.
      env {
        name  = "DEVICE_SECRETS_JSON"
        value = var.device_secrets_json
      }

      # A imagem de exemplo (bootstrap) não expõe /health: sem sonda HTTP nesse modo.
      dynamic "startup_probe" {
        for_each = var.use_placeholder_image ? [] : [1]
        content {
          http_get {
            path = "/health"
          }
          initial_delay_seconds = 0
          period_seconds        = 3
          failure_threshold     = 10
        }
      }
    }
  }

  # O CI troca a imagem a cada deploy; o Terraform não deve revertê-la.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].labels,
      template[0].revision,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.api_datastore,
    google_firestore_database.default,
  ]
}

# Dispositivos e navegadores não têm credencial IAM: o serviço é público no nível do
# Cloud Run e a autenticação é feita na aplicação (Firebase ID token / HMAC / OIDC).
# Se uma política de organização bloquear allUsers, ver infra/OPEN_QUESTIONS.md.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  count    = local.main_stack
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Redundante com allUsers hoje, mas mantém o acesso das contas de serviço caso o
# serviço passe a exigir IAM.
resource "google_cloud_run_v2_service_iam_member" "pubsub_invoker" {
  count    = local.main_stack
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  count    = local.main_stack
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Kill-switch altera o ingress; CI implanta revisões.
resource "google_cloud_run_v2_service_iam_member" "killswitch_developer" {
  count    = local.main_stack
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.killswitch.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deployer_developer" {
  count    = local.main_stack
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

# O CI precisa "agir como" a SA de runtime para criar revisões.
resource "google_service_account_iam_member" "deployer_actas_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}
