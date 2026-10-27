# Cloud Build como caminho principal de build (decisão do dono do projeto).
#
# Para ficar na cota gratuita, o código-fonte NÃO pode ir para o bucket padrão
# `<projeto>_cloudbuild`, que o gcloud cria em multi-região US (fora da cota de Cloud
# Storage). Este bucket REGIONAL em us-central1 é o staging: todo build deve usar
# `--gcs-source-staging-dir=gs://<bucket>/source`. Ver infra/COST_ZERO.md.

resource "google_storage_bucket" "build_staging" {
  name          = "${var.project_id}-build-staging"
  location      = var.region # regional, não multi-região
  storage_class = "STANDARD"
  project       = var.project_id

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = false
  }

  # O código-fonte enviado só serve durante o build.
  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# Conta de serviço dedicada ao build (privilégio mínimo). Em projetos novos o Cloud Build
# não usa mais a conta legada do Cloud Build; sem uma conta explícita ele cai na conta
# padrão do Compute Engine ou falha com "permission denied". Ver infra/RUNBOOK.md.
resource "google_service_account" "build" {
  account_id   = "cloud-build"
  display_name = "Cloud Build (imagens do RoboFlow)"
  depends_on   = [google_project_service.apis]
}

# Ler o código-fonte enviado ao staging.
resource "google_storage_bucket_iam_member" "build_reads_source" {
  bucket = google_storage_bucket.build_staging.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.build.email}"
}

# Publicar as imagens (somente neste repositório).
resource "google_artifact_registry_repository_iam_member" "build_pushes_images" {
  location   = google_artifact_registry_repository.roboflow.location
  repository = google_artifact_registry_repository.roboflow.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}

# Escrever os logs do build (builds usam CLOUD_LOGGING_ONLY).
resource "google_project_iam_member" "build_logwriter" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.build.email}"
}

# --- github-deployer: só para o deploy OPCIONAL pelo CI (desligado por padrão) ---

# Enviar o código ao staging.
resource "google_storage_bucket_iam_member" "deployer_uploads_source" {
  bucket = google_storage_bucket.build_staging.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Criar builds (o papel não permite mexer em outros recursos).
resource "google_project_iam_member" "deployer_builds_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Pedir que o build rode como a conta cloud-build.
resource "google_service_account_iam_member" "deployer_actas_build" {
  service_account_id = google_service_account.build.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}
