# Estágio 4. Banco único do POC.
#
# ATENÇÃO: a localização do Firestore é IMUTÁVEL depois de criada. Só o banco
# "(default)" entra na cota gratuita. Se mudar de região, será preciso apagar o
# banco e recriá-lo (perda de dados).

resource "google_firestore_database" "default" {
  count       = local.main_stack
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  # Recursos que exigem faturamento/cobram: desligados de propósito.
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  app_engine_integration_mode       = "DISABLED"

  depends_on = [google_project_service.apis]
}

# TTL: mantém o armazenamento < 1 GiB e as exclusões previsíveis. O campo precisa ser do
# tipo Timestamp (uma string ISO NÃO expira). Mapa vem de var.firestore_ttl_fields.
resource "google_firestore_field" "ttl" {
  for_each = local.main_stack == 1 ? var.firestore_ttl_fields : {}

  project    = var.project_id
  database   = google_firestore_database.default[0].name
  collection = each.key
  field      = each.value

  ttl_config {}
}

# Índices compostos: ver infra/OPEN_QUESTIONS.md (Q1).
