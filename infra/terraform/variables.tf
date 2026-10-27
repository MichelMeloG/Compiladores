variable "project_id" {
  description = "ID do projeto GCP."
  type        = string
  default     = "compiladores-512823"
}

variable "region" {
  description = "Região dos recursos regionais (Cloud Run, Artifact Registry, Firestore, Scheduler)."
  type        = string
  default     = "us-central1"
}

variable "github_repo" {
  description = "Repositório GitHub autorizado a implantar via Workload Identity Federation (dono/nome)."
  type        = string
  default     = "MichelMeloG/Compiladores"
}

variable "github_ref" {
  description = "Ref autorizada a implantar."
  type        = string
  default     = "refs/heads/main"
}

variable "billing_account" {
  description = "ID da conta de faturamento (sem o prefixo billingAccounts/)."
  type        = string
  default     = "01B754-38F742-DA56DB"
}

variable "budget_amount" {
  description = "Valor mensal do orçamento. Ao atingi-lo, o kill-switch bloqueia o tráfego público do roboflow-api."
  type        = number
  default     = 5
}

variable "budget_currency" {
  description = "Moeda do orçamento. DEVE ser a moeda da conta de faturamento (a conta atual é BRL; 5 BRL ~ US$1)."
  type        = string
  default     = "BRL"
}

variable "operator_emails" {
  description = "Allowlist de operadores (e-mails Google). Vira a env ALLOWED_OPERATOR_EMAILS (texto simples). Vazio = ninguém autorizado (falha fechada). Mantenha em terraform.tfvars (ignorado pelo git)."
  type        = list(string)
  default     = []
}

variable "device_secrets_json" {
  description = <<-EOT
    Segredos HMAC por dispositivo, no formato {"RB-01":"<hex>"}. Vira a env DEVICE_SECRETS_JSON.
    SEM default: precisa estar em terraform.tfvars (ignorado pelo git). O valor fica no state
    local e em texto na configuração do Cloud Run (visível a quem tem acesso ao projeto).
    Rotação = alterar o tfvars e reaplicar. Nunca vai ao repositório.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = can(keys(jsondecode(var.device_secrets_json)))
    error_message = "device_secrets_json deve ser um objeto JSON válido, ex.: {\"RB-01\":\"<hex>\"}."
  }
}

variable "firestore_ttl_fields" {
  description = "Políticas de TTL do Firestore: coleção => campo. O campo PRECISA ser do tipo Timestamp (string ISO não expira). Confirmar se as exclusões por TTL contam na cota gratuita de exclusões (COST_ZERO.md)."
  type        = map(string)
  default     = {}
}

variable "cors_origins" {
  description = "Origens permitidas por CORS. Vira CORS_ORIGINS."
  type        = list(string)
  default     = ["https://michelmelog.github.io"]
}

variable "auth_mode" {
  description = "firebase | off. Produção deve usar firebase."
  type        = string
  default     = "firebase"

  validation {
    condition     = contains(["firebase", "off"], var.auth_mode)
    error_message = "auth_mode deve ser firebase ou off."
  }
}

variable "log_level" {
  description = "Nível de log do serviço."
  type        = string
  default     = "info"
}

variable "api_service_name" {
  description = "Nome do serviço Cloud Run da API."
  type        = string
  default     = "roboflow-api"
}

variable "use_placeholder_image" {
  description = "true: cria o serviço com a imagem de exemplo do Cloud Run (bootstrap, antes de existir imagem). O CI troca a imagem depois; o Terraform ignora mudanças de imagem."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "Tag da imagem da API no Artifact Registry (usada só quando use_placeholder_image = false)."
  type        = string
  default     = "bootstrap"
}

variable "killswitch_image_tag" {
  description = "Tag da imagem do budget-killswitch no Artifact Registry. Construída por infra/scripts/bootstrap.ps1 antes do estágio 3."
  type        = string
  default     = "v1"
}

variable "enable_killswitch_service" {
  description = "Estágio 3 do bootstrap: cria o serviço budget-killswitch (precisa da imagem já publicada)."
  type        = bool
  default     = false
}

variable "enable_budget" {
  description = "Cria o orçamento e seus alertas. Só ligue depois de enable_killswitch_service."
  type        = bool
  default     = false
}

variable "enable_main_stack" {
  description = "Estágio 4: cria Firestore, Pub/Sub da aplicação, Cloud Run da API, Scheduler. Só ligue depois do kill-switch e do orçamento."
  type        = bool
  default     = false
}

variable "artifact_keep_versions" {
  description = "Quantas versões mais recentes de cada imagem manter no Artifact Registry (cota grátis: 0,5 GB por conta de faturamento)."
  type        = number
  default     = 2
}
