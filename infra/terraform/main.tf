data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number = data.google_project.this.number

  # URL determinística do Cloud Run (formato por número de projeto). Usada como
  # audiência OIDC e como INTERNAL_AUDIENCE sem criar dependência circular.
  api_url = "https://${var.api_service_name}-${local.project_number}.${var.region}.run.app"

  registry_host = "${var.region}-docker.pkg.dev"
  registry_path = "${local.registry_host}/${var.project_id}/roboflow"

  api_image        = var.use_placeholder_image ? "us-docker.pkg.dev/cloudrun/container/hello" : "${local.registry_path}/api:${var.image_tag}"
  killswitch_image = "${local.registry_path}/killswitch:${var.killswitch_image_tag}"

  # Estágio 4 inteiro depende do kill-switch e do orçamento já existirem.
  main_stack = var.enable_main_stack && var.enable_killswitch_service && var.enable_budget ? 1 : 0

  # Somente o necessário. Ver infra/COST_ZERO.md ("APIs").
  # Fora de propósito: secretmanager, identitytoolkit, firebase.
  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "storage.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "billingbudgets.googleapis.com",
    "sts.googleapis.com",
    "logging.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
