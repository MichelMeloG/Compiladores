# Contrato back ↔ infra

Fonte única do que a infraestrutura entrega ao serviço `roboflow-api` (Cloud Run) e do que o serviço pode assumir. A frente de backend lê **este** arquivo; mudanças aqui exigem atualizar `infra/terraform/cloudrun.tf`.

Projeto `compiladores-512823` · região `us-central1` · serviço `roboflow-api` · porta 8080.

## 1. Variáveis de ambiente

| Variável | Valor em produção | Origem | Observação |
|---|---|---|---|
| `GCP_PROJECT` | `compiladores-512823` | Terraform | |
| `STORE` | `firestore` | Terraform | `memory` só em testes locais |
| `PUBSUB_TOPIC_EVENTS` | `agv-events` | Terraform | Tópico principal de eventos |
| `PUBSUB_TOPIC_DLQ` | `agv-events-dlq` | Terraform | Mensagens mortas (a API também tem permissão de publicar nele) |
| `CORS_ORIGINS` | `https://michelmelog.github.io` | `var.cors_origins` | Lista separada por vírgula. Nunca `*` |
| `AUTH_MODE` | `firebase` | `var.auth_mode` | `off` só em testes locais; o serviço deve **recusar iniciar** com `off` quando `STORE=firestore` |
| `ALLOWED_OPERATOR_EMAILS` | lista de e-mails Google | `var.operator_emails` | Separada por vírgula. **Vazio = ninguém autorizado** (falha fechada) |
| `DEVICE_SECRETS_JSON` | `{"RB-01":"<hex>"}` | `var.device_secrets_json` (Terraform, `sensitive`, só em `terraform.tfvars` fora do git) → env do Cloud Run | Segredo HMAC por dispositivo. **O nome e o formato não mudaram.** Sem Secret Manager. Lido no start; nunca logar |
| `INTERNAL_AUDIENCE` | `https://roboflow-api-483331439325.us-central1.run.app` | Terraform | Audiência (`aud`) esperada nos ID tokens OIDC de `/internal/*` |
| `PUBSUB_PUSH_SA` | `pubsub-invoker@compiladores-512823.iam.gserviceaccount.com` | Terraform | E-mail permitido em `/internal/events` |
| `SCHEDULER_SA` | `scheduler-invoker@compiladores-512823.iam.gserviceaccount.com` | Terraform | E-mail permitido em `/internal/offline-check` |
| `LOG_LEVEL` | `info` | `var.log_level` | |
| `PORT` | `8080` | Cloud Run | Definido pela plataforma |

Para testes locais, `STORE=memory AUTH_MODE=off` devem funcionar sem nenhuma credencial GCP.

## 2. Autenticação dos endpoints (o que a infra garante)

| Prefixo | Quem chama | O que a aplicação DEVE validar |
|---|---|---|
| `/health` | qualquer um | nada (não expor versão detalhada nem segredos) |
| `/api/*` | dashboard | Firebase ID token (`Authorization: Bearer`) + e-mail em `ALLOWED_OPERATOR_EMAILS` |
| `/device/*` | ESP32 | HMAC do corpo com o segredo do `deviceId` + `sessionId`/`sequence` (anti-replay) |
| `/internal/events` | Pub/Sub push | ID token OIDC: assinatura Google, `aud == INTERNAL_AUDIENCE`, `email == PUBSUB_PUSH_SA`, `email_verified == true` |
| `/internal/offline-check` | Cloud Scheduler | idem, com `email == SCHEDULER_SA` |

O Cloud Run está com `allUsers` como invoker (navegador e ESP32 não têm credencial IAM), então **a aplicação é a única barreira**: `/internal/*` sem OIDC válido deve responder 401/403.

## 3. Pub/Sub

| Recurso | Detalhe |
|---|---|
| Tópico `agv-events` | Retenção 24 h. A API publica; consumidor é a subscription push abaixo |
| Subscription `agv-events-push` | Push para `<INTERNAL_AUDIENCE>/internal/events`, ack deadline 30 s, retry exponencial 10 s–600 s, **5 tentativas** e então DLQ |
| Tópico `agv-events-dlq` + subscription pull `agv-events-dlq-pull` | Retenção 7 dias, para inspeção manual |
| Corpo do push | Envelope padrão do Pub/Sub: `{ "message": { "data": "<base64>", "messageId": "...", "attributes": {...} }, "subscription": "..." }`. Responder **2xx** para confirmar; qualquer outro status reentrega. Consumidores devem ser **idempotentes** (entrega at-least-once) |

## 4. Firestore

- Banco `(default)`, modo nativo, `us-central1`. A API acessa por `roles/datastore.user`.
- Região **imutável**. Só o banco `(default)` entra na cota gratuita.
- **TTL:** o Terraform aceita `firestore_ttl_fields` (coleção → campo). O campo **precisa ser do tipo `Timestamp`**; uma string ISO (como o `expireAt` gravado hoje em `idempotency`) **não expira**. Backend: gravar `Timestamp` nos campos de TTL (ver `OPEN_QUESTIONS.md`, Q1).
- **Índices compostos** não estão no Terraform ainda (Q1).
- **Cotas diárias (50.000 leituras, 20.000 escritas)** são o limite real de custo: rollups, `limit` nas consultas e throttling de telemetria são obrigação do backend (`COST_ZERO.md`).
- Nomes de coleções pertencem ao documento de contratos, não a este.

## 5. Identidades e papéis (privilégio mínimo)

| Service account | Papéis |
|---|---|
| `roboflow-api` (runtime) | `datastore.user` (projeto), `logging.logWriter` (projeto), `pubsub.publisher` em `agv-events` e `agv-events-dlq` |
| `pubsub-invoker` | `run.invoker` em `roboflow-api`; o service agent do Pub/Sub tem `serviceAccountTokenCreator` sobre ela |
| `scheduler-invoker` | `run.invoker` em `roboflow-api` |
| `github-deployer` (deploy opcional pelo CI, desligado por padrão) | `run.developer` em `roboflow-api`, `cloudbuild.builds.editor` (projeto), `storage.objectAdmin` no bucket de staging, `serviceAccountUser` sobre `roboflow-api` e sobre `cloud-build`, `workloadIdentityUser` para `MichelMeloG/Compiladores` (branch `main`) |
| `cloud-build` (identidade dos builds) | `storage.objectViewer` no bucket `<projeto>-build-staging`, `artifactregistry.writer` no repositório `roboflow`, `logging.logWriter` (projeto) |
| `budget-killswitch` | `run.developer` em `roboflow-api`, `serviceAccountUser` sobre `roboflow-api`, `logging.logWriter` |
| `budget-invoker` | `run.invoker` em `budget-killswitch` |

A API **não** tem permissão para criar tópicos nem administrar IAM. Não existe Secret Manager: nada de `secretAccessor`. Se o backend precisar de algo novo, peça à infra; não assuma.

## 6. Limites e comportamento da plataforma

- Instâncias: mín. **0**, máx. **2**, concorrência 80, 256 MiB, 1 vCPU, CPU só durante a requisição, timeout 30 s. **Nenhum estado em memória** entre requisições.
- Cold start existe (centenas de ms a poucos s). `GET /health` precisa responder rápido e **sem depender de Firestore**.
- O kill-switch pode colocar o serviço em ingress `internal-only` (orçamento estourado). Nesse caso o serviço fica inalcançável pela internet até a reabilitação manual (`infra/RUNBOOK.md`).
- Logs: escrever JSON em stdout com `severity` e `message`; o Cloud Logging indexa automaticamente. Campos úteis: `deviceId`, `missionId`, `sessionId`. **Nunca logar segredos, tokens nem HMACs.**
- Corpo máximo aceito pela aplicação: 4 KB em `/device/*` (limite do protocolo). O Cloud Run aceita até 32 MiB; a aplicação deve impor o limite.

## 7. Build e deploy

Imagens são construídas no Cloud Build (`infra/scripts/build-and-deploy.ps1`) e implantadas com `gcloud run deploy --image`. O backend precisa de um `backend/Dockerfile` cujo **contexto é a raiz do repositório** (`docker build -f backend/Dockerfile .`), que expõe a porta 8080 e responde `GET /health` sem depender do Firestore.

## 8. Variáveis do CI/CD (GitHub, não do serviço)

Só para o deploy opcional: `CI_DEPLOY_ENABLED=true` (liga o job), `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA` (variáveis de repositório, não segredos). Sem elas, o workflow só roda testes, typecheck e `terraform fmt/validate`.
