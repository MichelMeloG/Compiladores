# Estágio 4. Barramento de eventos do AGV.

resource "google_pubsub_topic" "events" {
  count      = local.main_stack
  name       = "agv-events"
  depends_on = [google_project_service.apis]
  # Sem message_retention_duration no tópico (retenção de tópico é armazenamento cobrado).
  # Sem schema e sem assinatura BigQuery: ausência intencional (COST_ZERO.md).
}

resource "google_pubsub_topic" "events_dlq" {
  count      = local.main_stack
  name       = "agv-events-dlq"
  depends_on = [google_project_service.apis]
}

# Subscription pull só para reter e inspecionar mensagens mortas.
resource "google_pubsub_subscription" "events_dlq_pull" {
  count                      = local.main_stack
  name                       = "agv-events-dlq-pull"
  topic                      = google_pubsub_topic.events_dlq[0].id
  message_retention_duration = "86400s"
  ack_deadline_seconds       = 60
}

resource "google_pubsub_subscription" "events_push" {
  count = local.main_stack
  name  = "agv-events-push"
  topic = google_pubsub_topic.events[0].id

  ack_deadline_seconds       = 30
  message_retention_duration = "3600s"

  push_config {
    push_endpoint = "${local.api_url}/internal/events"
    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
      audience              = local.api_url
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.events_dlq[0].id
    max_delivery_attempts = 5
  }

  depends_on = [google_cloud_run_v2_service.api]
}

# --- IAM ---

# A API publica eventos e (se decidir) mensagens mortas.
resource "google_pubsub_topic_iam_member" "api_publish_events" {
  count  = local.main_stack
  topic  = google_pubsub_topic.events[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_topic_iam_member" "api_publish_dlq" {
  count  = local.main_stack
  topic  = google_pubsub_topic.events_dlq[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

# O service agent do Pub/Sub precisa: gerar OIDC como pubsub-invoker, publicar na DLQ
# e ler a subscription de origem para encaminhar mensagens mortas.
resource "google_service_account_iam_member" "pubsub_agent_token_events" {
  service_account_id = google_service_account.pubsub_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

resource "google_pubsub_topic_iam_member" "agent_publish_dlq" {
  count  = local.main_stack
  topic  = google_pubsub_topic.events_dlq[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

resource "google_pubsub_subscription_iam_member" "agent_subscribe_events" {
  count        = local.main_stack
  subscription = google_pubsub_subscription.events_push[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_project_service_identity.pubsub.email}"
}
