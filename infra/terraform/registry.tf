resource "google_artifact_registry_repository" "roboflow" {
  location      = var.region
  repository_id = "roboflow"
  format        = "DOCKER"
  description   = "Imagens do RoboFlow (api, killswitch)"

  cleanup_policy_dry_run = false

  # Cota grátis: 0,5 GB por CONTA DE FATURAMENTO (somada entre projetos). Limpeza agressiva.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_keep_versions
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "86400s" # 1 dia (a KEEP acima protege as versões recentes)
    }
  }

  depends_on = [google_project_service.apis]
}
