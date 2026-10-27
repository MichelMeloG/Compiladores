# ADR 0006 — Infraestrutura GCP: região, IaC, orçamento com kill-switch e cota gratuita

- **Status:** proposto
- **Data:** 26/10/2026
- **Projeto:** `compiladores-512823` (conta de faturamento `01B754-38F742-DA56DB`, moeda **BRL**)
- **Relacionados:** ADR 0007 (segurança de infra), `infra/README.md`, `infra/ENV_CONTRACT.md`

## Contexto

O RoboFlow é uma prova de conceito para um artigo, com código aberto. Precisa demonstrar boa arquitetura em nuvem **sem custo ocioso**: nada de Postgres/Cloud SQL, VM ligada ou balanceador. O projeto exige cartão no faturamento, o que torna um abuso ou um loop de polling uma conta real. Por isso o desenho prioriza escala a zero, tetos de instância e um corte automático de gasto.

## Decisões

### 1. Região: `us-central1`

- Cloud Run em região **Tier 1** tem a cota gratuita integral; regiões Tier 2 (inclui `southamerica-east1`) têm cotas gratuitas menores (por exemplo 128.571 vCPU-s/mês em vez de 180.000, segundo a página de preços consultada).
- O Firestore tem localização **imutável**; `us-central1` é regional e o banco `(default)` entra na cota gratuita.
- Latência a partir do Brasil (~150–200 ms) é irrelevante para telemetria a cada 1–2 s e para um POC.
- Custo da decisão: dados fora do Brasil. Aceitável: o POC não guarda dado pessoal além de e-mails de operadores.

### 2. Infra como código com Terraform, estado local

- Reprodutível (`terraform apply` recria o ambiente) e legível no artigo.
- **State local ignorado pelo git** no POC: evita criar um bucket (e uma dependência do bootstrap) e vazar o estado. Trade-off: sem trava de concorrência nem backup; perder o arquivo exige `terraform import`. Para equipe, migrar para bucket GCS com versionamento.
- Bootstrap em **estágios** (flags `enable_*`) para garantir que o kill-switch e o orçamento existam **antes** dos recursos faturáveis.

### 3. Orçamento e kill-switch

- `google_billing_budget` mensal de **R$ 5** (≈ US$ 1; a conta é BRL), alertas a 50 %, 90 % e 100 % por e-mail e por Pub/Sub (`budget-alerts`).
- Um Cloud Run mínimo (`budget-killswitch`, Node sem dependências) recebe o push, e se `costAmount ≥ budgetAmount` altera o ingress do `roboflow-api` para **internal-only**, bloqueando o tráfego da internet. Reversível; não apaga nada.
- Por que `internal-only` e não `max-instances = 0`: o Cloud Run não aceita zero como máximo de instâncias.
- **Limitação declarada:** orçamento **não é limite rígido**. Os dados de custo chegam com atraso de horas; o gasto pode ultrapassar o valor antes do corte. O que protege de verdade o bolso são os tetos (`max-instances = 2`, concorrência 80, timeout 30 s) e a escala a zero; o kill-switch é a rede de segurança.
- O kill-switch só chama a API do Cloud Run para um alvo validado por regex e é idempotente.

### 4. Build no GCP com Cloud Build e staging regional

Decisão do dono do projeto: o build das imagens (kill-switch e backend) acontece no **Cloud Build**, não no GitHub Actions. O que o torna compatível com custo zero:

- **Bucket de staging regional** (`<projeto>-build-staging`, `us-central1`, STANDARD, acesso uniforme, sem versionamento, acesso público bloqueado, ciclo de vida de 1 dia), usado em todo `gcloud builds submit --gcs-source-staging-dir`. Evita o bucket multirregional padrão `<projeto>_cloudbuild`, fora da cota de Cloud Storage.
- **Conta de serviço dedicada** `cloud-build` com três papéis estreitos (ler o staging, escrever no repositório do Artifact Registry, escrever logs), e builds com `CLOUD_LOGGING_ONLY`.
- **Pool padrão** `e2-standard-2` (coberto pelos 2.500 min/mês gratuitos), build manual por script, sem gatilhos.
- **Deploy:** `gcloud run deploy --image` (não `terraform apply -var image_tag`), porque o Terraform ignora mudanças de imagem. O GitHub Actions faz só testes, typecheck e `terraform fmt/validate`; o deploy pelo CI existe, mas está **desligado** por padrão.
- Custos assumidos: o bucket de staging (centavos no pior caso, normalmente zero na cota "Always Free" regional); a cota regional do Cloud Build não foi confirmada.

### 5. Pilha mínima dentro da cota

Cloud Run (1 serviço) + Firestore + Pub/Sub (1 tópico + DLQ) + Artifact Registry (2 imagens) + Cloud Scheduler (1 job) + Cloud Logging. **Sem Secret Manager e sem Cloud Monitoring (alert policies)**, sem Cloud SQL, VPC connector, NAT, load balancer ou Cloud Armor. Diretriz do dono do projeto: **custo zero estrito**; a auditoria recurso a recurso está em `infra/COST_ZERO.md`.

## Cotas gratuitas (consultadas em 26/10/2026)

Os valores abaixo vieram de pesquisa nas páginas oficiais de preços na data acima. **Confirme nas páginas antes de citá-los no artigo:** Google altera cotas sem aviso.

| Serviço | Cota gratuita | Escopo | Fonte | Situação |
|---|---|---|---|---|
| Cloud Run (cobrança por requisição, Tier 1) | 2 milhões de requisições/mês; 180.000 vCPU-s/mês; 360.000 GiB-s/mês | Conta de faturamento | [cloud.google.com/run/pricing](https://cloud.google.com/run/pricing) | Confirmado nos números de requisição-based. Cópias da página divergem nos números de cobrança por instância (240.000 vCPU-s / 450.000 GiB-s); **não usamos** esse modo |
| Firestore | 1 GiB armazenado; 50.000 leituras/dia; 20.000 escritas/dia; 20.000 exclusões/dia; 10 GiB/mês de saída | 1 banco gratuito por projeto, apenas o `(default)`; reset à meia-noite do Pacífico | [cloud.google.com/firestore/pricing](https://cloud.google.com/firestore/pricing) | Confirmado |
| Pub/Sub | Primeiros 10 GiB/mês de vazão | Conta de faturamento | [cloud.google.com/pubsub/pricing](https://cloud.google.com/pubsub/pricing) | Confirmado (a página de produto cita "10 GB"; vale a da página de preços) |
| Cloud Logging | 50 GiB/mês de ingestão por projeto; retenção padrão de 30 dias | Projeto | [cloud.google.com/logging/pricing](https://cloud.google.com/logging/pricing) | Confirmado |
| Artifact Registry | 0,5 GB de armazenamento | Conta de faturamento (somado entre projetos) | [cloud.google.com/artifact-registry/pricing](https://cloud.google.com/artifact-registry/pricing) | Confirmado; o repositório tem política de limpeza para respeitar |
| Cloud Build | 2.500 minutos/mês (e2-standard-2, pool padrão); "promocional, sujeito a mudança"; builds regionais **não confirmados** na cota | Conta de faturamento | [cloud.google.com/build/pricing](https://cloud.google.com/build/pricing) | Confirmado; **caminho principal de build** (ver decisão 5) |
| Cloud Scheduler | 3 jobs grátis | Conta de faturamento | [cloud.google.com/scheduler/pricing](https://cloud.google.com/scheduler/pricing) | Confirmado; usamos 1 |
| Cloud Monitoring | Alert policies passam a ser cobradas a partir de maio/2026 (US$ 0,10 por condição, segundo a página de controle de custos); canais de notificação **não confirmados** | — | [cloud.google.com/monitoring/alerts/cost-control](https://cloud.google.com/monitoring/alerts/cost-control) | **Não usado**: nenhuma policy nem canal; e-mails de orçamento vão aos administradores da conta |
| Firebase Auth / Identity Platform | — | — | — | **Não confirmado** (fora do escopo desta entrega) |

**Efeito prático para o POC:** o gargalo é o Firestore (50 mil leituras/dia), não o Cloud Run. Ver os rollups no backlog.

**Alerta:** a conta de faturamento já excede a cota do Artifact Registry por causa de outros projetos (≈ 670 MB medidos); ver `COST_ZERO.md` §1. Esse é o único ponto conhecido onde o custo não é zero.

## Consequências

- O primeiro `apply` não cria nada faturável; o orçamento e o kill-switch vêm antes.
- A conta está em BRL: "US$ 1" virou R$ 5. Se a taxa mudar, ajuste `budget_amount`.
- O ingress `internal-only` pode entrar em conflito com um `terraform apply` posterior (que o restaura para `all`). É intencional: reabilitar exige decisão humana (runbook).
- O Terraform ignora mudanças de imagem do serviço, para que o CI seja a única fonte de deploy.
- **Estourar uma cota gratuita não bloqueia nada** (o faturamento está ativo): passa a cobrar. Por isso o limite real é o desenho (rate limit, poll adaptativo, `max-instances = 2`, TTL e throttling no Firestore); o orçamento é só a rede de segurança.
- Sem `terraform apply` automatizado em CI: mudanças de infra são aplicadas por humano.

## Alternativas descartadas

- **Cloud SQL/Postgres:** custo desde o primeiro minuto.
- **Instance-based billing / min-instances > 0:** custo ocioso.
- **Build no GitHub Actions:** foi a decisão inicial (evitava o bucket padrão); o dono do projeto preferiu manter o build dentro do GCP, o que exige o staging regional acima.
- **Cloud Functions para o kill-switch:** exigiria Eventarc e mais APIs para o mesmo resultado.
- **Bucket de state:** complexidade extra no bootstrap para um único operador.
- **MQTT em e2-micro com Mosquitto:** coberto na decisão de transporte (ADR 0002), fora deste ADR.
