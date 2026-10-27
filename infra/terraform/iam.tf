# Service accounts (estágio 1; sem custo). Privilégio mínimo: cada papel concedido
# está comentado com a razão.

resource "google_service_account" "api" {
  account_id   = "roboflow-api"
  display_name = "RoboFlow API (runtime Cloud Run)"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "pubsub_invoker" {
  account_id   = "pubsub-invoker"
  display_name = "Pub/Sub push -> /internal/events"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "scheduler_invoker" {
  account_id   = "scheduler-invoker"
  display_name = "Cloud Scheduler -> /internal/offline-check"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions (WIF) - build e deploy"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "killswitch" {
  account_id   = "budget-killswitch"
  display_name = "Kill-switch de orçamento (runtime)"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "budget_invoker" {
  account_id   = "budget-invoker"
  display_name = "Pub/Sub push -> budget-killswitch"
  depends_on   = [google_project_service.apis]
}

# --- roboflow-api: Firestore, publicar eventos, escrever logs ---

resource "google_project_iam_member" "api_datastore" {
  project = var.project_id
  role    = "roles/datastore.user" # ler/escrever documentos do Firestore
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_logwriter" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# roles/pubsub.publisher é concedido nos tópicos específicos (pubsub.tf), não no projeto.

# --- killswitch: logs. O papel run.developer fica no serviço (cloudrun.tf). ---

resource "google_project_iam_member" "killswitch_logwriter" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.killswitch.email}"
}

# Alterar um serviço Cloud Run exige poder "agir como" a SA de runtime dele.
resource "google_service_account_iam_member" "killswitch_actas_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.killswitch.email}"
}
