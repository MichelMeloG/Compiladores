# Auditoria de custo zero

Diretriz: o POC deve ficar **dentro da cota gratuita do GCP, sem exceções**. Este documento audita cada recurso: cota gratuita, onde começaria a cobrar e a trava que impede.

Data da auditoria: **26/10/2026**. Cotas conferidas por pesquisa nas páginas oficiais de preços; links na coluna de fonte. O que não foi possível confirmar está marcado **NÃO CONFIRMADO**. Antes de publicar números no artigo, reconfira nas páginas.

> **Orçamento não é limite rígido.** O orçamento (R$ 5) e o kill-switch são rede de segurança: os dados de custo chegam com atraso de horas e o gasto pode passar do valor antes do corte. O limite real é **desenhar o sistema para nunca passar da cota**: `max-instances = 2`, rate limit na aplicação, poll adaptativo do AGV, TTL e throttling de escrita no Firestore, e escala a zero. Com o faturamento ativo, **estourar uma cota gratuita não bloqueia o serviço: passa a cobrar** (a preços baixos, mas cobra).

## 1. Risco que já não é zero hoje (leia primeiro)

**A conta de faturamento `01B754-38F742-DA56DB` já passa da cota gratuita do Artifact Registry** por causa de **outros projetos**. Medido por `gcloud artifacts repositories list` (somente leitura) em 26/10/2026:

| Projeto | Repositório | Tamanho |
|---|---|---|
| `sentinela-494722` | `cloud-run-source-deploy` | 509.772.428 bytes (≈ 486 MB) |
| `claravus-staging` | `cloud-run-source-deploy` | 159.927.370 bytes (≈ 153 MB) |
| **Total, sem este projeto** | | **≈ 670 MB** (cota gratuita: 0,5 GB somados na conta) |

Consequência: qualquer imagem que o RoboFlow publique é cobrada a ~US$ 0,10/GB-mês. Com 2 imagens limpas (≈ 100–150 MB) o custo é da ordem de **US$ 0,01–0,02/mês** (centavos de real), mas **não é zero estrito**. Opções, para decisão do dono da conta (não mexi nesses projetos):

1. Aplicar política de limpeza (manter as 2 últimas versões) nos repositórios `cloud-run-source-deploy` de `sentinela-494722` e `claravus-staging`, que provavelmente guardam imagens antigas de deploys por código-fonte. Isso traz a conta para baixo de 0,5 GB e libera folga para o RoboFlow.
2. Aceitar ~R$ 0,10/mês.
3. Mover o POC para uma conta de faturamento própria.

Os outros itens abaixo estão dentro da cota. Sobre Cloud Scheduler: **nenhum job** nesses dois projetos nas regiões `us-central1`, `us-east1`, `us-west1`, `southamerica-east1` e `europe-west1`, então os 3 jobs gratuitos estão livres (usamos 1; outras regiões não foram verificadas).

## 2. Tabela recurso → cota → quando cobra → trava

| Recurso | Cota gratuita vigente (fonte, 26/10/2026) | Passa a cobrar quando | Trava no projeto |
|---|---|---|---|
| **Cloud Run** (`roboflow-api`, `budget-killswitch`) | 2 M requisições/mês; 180.000 vCPU-s e 360.000 GiB-s/mês, cobrança por requisição, regiões Tier 1 ([preços](https://cloud.google.com/run/pricing)). Copias da página divergem nos números do modo "instância sempre ativa" (240.000/450.000): **não usamos esse modo** | Mais de 2 M req/mês ou excesso de vCPU-s/GiB-s; instâncias mínimas > 0; CPU de startup boost; modo instance-based | `min_instance_count = 0`, `max_instance_count = 2` (kill-switch: 1), `cpu_idle = true` (CPU só durante a requisição), `startup_cpu_boost = false`, 256 MiB (128 MiB no kill-switch), `timeout 30s`, concorrência 80. **Ausentes de propósito:** domain mapping, load balancer, IP estático, Cloud NAT, VPC connector |
| **Artifact Registry** | 0,5 GB por **conta de faturamento** ([preços](https://cloud.google.com/artifact-registry/pricing)) | Acima de 0,5 GB somados na conta (**já ocorre**, seção 1) | `cleanup_policies`: manter só as **2** versões mais recentes por imagem e apagar o resto com mais de 1 dia; imagem do kill-switch em `node:22-alpine`; **Container Scanning desligado** (não habilitar `containerscanning.googleapis.com`) |
| **Cloud Build** | 2.500 min/mês no pool padrão `e2-standard-2` ([preços](https://cloud.google.com/build/pricing)); promocional, "sujeito a mudança". Builds **regionais** (`--region us-central1`): **NÃO CONFIRMADO** que contam na mesma cota | Acima de 2.500 min/mês; máquina maior que a padrão; private pools (US$ 0,0097/min) | **Caminho principal de build** (decisão do dono do projeto). Pool padrão (`machineType` omitido), `timeout` 600–900 s, build só quando se pede (sem gatilhos automáticos), conta dedicada de privilégio mínimo, `CLOUD_LOGGING_ONLY`. Ver "Cloud Build e o bucket de staging" abaixo |
| **Cloud Storage** (só o bucket `<projeto>-build-staging`) | "Always Free": 5 GB-mês de armazenamento regional **em `us-central1`/`us-east1`/`us-west1`**, 5.000 operações Classe A e 50.000 Classe B por mês, por conta de faturamento. **Fonte secundária; não encontrei a página oficial nesta pesquisa: NÃO CONFIRMADO** (links: [preços](https://cloud.google.com/storage/pricing), [free tier](https://cloud.google.com/free/docs/free-cloud-features)) | Bucket multirregional ou fora dessas 3 regiões; versionamento; objetos acumulados | Bucket **regional** `us-central1`, `STANDARD`, sem versionamento, `public_access_prevention = enforced`, regra de ciclo de vida que **apaga objetos com mais de 1 dia**. Código-fonte do build ocupa KB a poucos MB |
| **Firestore** | 1 GiB; 50.000 leituras/dia; 20.000 escritas/dia; 20.000 exclusões/dia; 10 GiB/mês de saída; **só 1 banco gratuito por projeto, o `(default)`** ([preços](https://cloud.google.com/firestore/pricing)) | Excesso de qualquer cota diária (cobrança, não bloqueio); mais de um banco; PITR, backup, restore, clone, TTL (exigem faturamento) | Só `(default)`; `POINT_IN_TIME_RECOVERY_DISABLED`; sem backups, sem multi-database; proteção contra exclusão; TTL opcional (`firestore_ttl_fields`). **Trava de verdade está no backend**: rollups em vez de varrer listas, `limit` em consultas, telemetria "ao vivo" com taxa limitada |
| **Pub/Sub** | Primeiros 10 GiB/mês de vazão, por conta de faturamento ([preços](https://cloud.google.com/pubsub/pricing)) | Acima de 10 GiB; retenção de tópico (armazenamento); schemas; assinaturas BigQuery/Cloud Storage | Tópicos **sem** `message_retention_duration`; subscription push com retenção de 1 h, DLQ de 24 h, budget de 1 h; **sem** schemas, **sem** BigQuery subscription, sem ordenação nem exactly-once |
| **Cloud Scheduler** | 3 jobs por conta de faturamento ([preços](https://cloud.google.com/scheduler/pricing)) | 4º job (US$ 0,10/mês) | **1 job** (`device-offline-check`, a cada 5 min). Verificado: a conta não tem jobs nos outros projetos |
| **Cloud Logging** | 50 GiB/mês de ingestão por projeto; retenção padrão 30 dias ([preços](https://cloud.google.com/logging/pricing)) | Acima de 50 GiB; retenção maior que 30 dias; buckets e sinks extras | Bucket `_Default` fixado em 30 dias; **sem** buckets/sinks extras; duas *exclusion filters* cortam requisições `/health` e `/device/poll` bem-sucedidas (a categoria mais barulhenta). Data Access logs desligados (padrão). Os filtros de exclusão **não foram testados** contra logs reais |
| **Cloud Monitoring** | Escrita de métricas gratuita; leitura 1 M chamadas/mês (resultado de pesquisa, [preços](https://cloud.google.com/monitoring/pricing)). **Alert policies passam a ser cobradas** (US$ 0,10 por condição, a partir de "no mínimo 1º/05/2026", segundo [a página de controle de custos](https://cloud.google.com/monitoring/alerts/cost-control)). Canais de notificação: **NÃO CONFIRMADO** | Ao criar alert policies ou métricas customizadas | **Nenhuma** alert policy, métrica customizada nem canal de notificação. Os e-mails do orçamento vão aos administradores da conta de faturamento (destinatários padrão). Alertas de erro: usar o Logs Explorer, não policies |
| **Firebase Auth / Identity Platform** | Camada gratuita de 50.000 MAU para e-mail/social, em projetos Blaze; Spark limitado a 3.000 DAU ([documentação](https://firebase.google.com/docs/auth)). **SMS/telefone é cobrado** (preço **NÃO CONFIRMADO**) | MFA por SMS, login por telefone, SAML/OIDC acima de 49 MAU, mais de 50.000 MAU | Só provedor **Google** (ou e-mail); **sem** telefone e **sem** MFA por SMS. Não configurado nesta entrega; APIs `identitytoolkit`/`firebase` desligadas até a etapa do front. A verificação do ID token no backend usa as chaves públicas do Google (sem chamada à API) |
| **Egress de rede** | 1 GiB/mês de saída para a internet a partir da América do Norte; tráfego na mesma região é gratuito ([Cloud Run](https://cloud.google.com/run/pricing)) | Acima de 1 GiB/mês de respostas da API | O front hospedado no GitHub Pages **não gera egress do GCP**; só as respostas da API contam. Estimativa: ~5 MB/dia com um operador (~150 MB/mês). Mitigações do backend: compressão gzip, `204` quando não há novidade no poll, `limit` nas listas. Firestore e Pub/Sub na mesma região: sem custo |
| **Secret Manager** | **Removido** | — | **Não usamos.** Segredos de dispositivo e allowlist entram por variável do Terraform → env do Cloud Run (ADR 0007 documenta o trade-off) |
| **IAM, service accounts, Workload Identity Federation** | Sem custo | — | — |
| **Orçamento (Billing Budgets) e kill-switch** | Orçamentos são gratuitos; o kill-switch é um Cloud Run que escala a zero | Alertas chegam com atraso de horas; **não é limite rígido** | Orçamento R$ 5/mês (50 %, 90 %, 100 %) + `budget-killswitch` (`internal-only`). Veja a nota no topo |
| **Terraform state** | Local, sem custo | — | Sem bucket |

## 3. Estimativa de uso (ordem de grandeza, não medição)

Premissas: 1 AGV e 1 operador, 2 h de missão por dia. AGV em repouso faz poll a cada 30–60 s e em missão a cada 1–2 s; dashboard a cada 3 s só com a aba visível; Scheduler a cada 5 min.

| Item | Estimativa/mês | Cota | Folga |
|---|---|---|---|
| Requisições ao Cloud Run | ~230 mil a ~390 mil (Scheduler 8.640 + AGV + dashboard) | 2 M | ≥ 5× |
| vCPU-segundos (150 ms por requisição + cold starts) | ~40 mil a ~65 mil | 180 mil | ≈ 3× |
| GiB-segundos (256 MiB) | ~15 mil | 360 mil | ≫ |
| Escritas no Firestore | missão ~50; "ao vivo" ≤ 1 por 5 s em missão ≈ 1.440/dia; mais eventos | 20.000/dia | ~10× se a taxa for limitada |
| Leituras no Firestore | depende de rollups: sem eles, listas varridas a cada abertura de tela podem passar de 50.000/dia | 50.000/dia | **Ponto frágil**; ver BE-033/FE-040 |
| Logs | < 1 GB/mês após as exclusões | 50 GiB | ≫ |
| Egress | ~150 MB | 1 GiB | ≈ 6× |

## 4. APIs

Habilitadas pelo Terraform (necessárias): `run`, `artifactregistry`, `cloudbuild`, `storage`, `firestore`, `pubsub`, `cloudscheduler`, `iam`, `iamcredentials`, `cloudresourcemanager`, `billingbudgets`, `sts`, `logging`.

**Desnecessárias** (candidatas a desabilitar; nenhuma gera custo parada, é só reduzir superfície e evitar uso acidental): `secretmanager`, `identitytoolkit`, `firebase`. APIs padrão de analytics do projeto (BigQuery, Dataform, Dataplex, Analytics Hub, App Topology, `sql-component`) também não são usadas; o script as inclui com `-IncludeOptional`. **`cloudbuild` e `storage` ficam habilitadas** (Cloud Build é o caminho principal).

O Terraform **não** desabilita APIs quando elas saem da lista (`disable_on_destroy = false`, para não derrubar dependências por engano). Para desabilitar de fato, `infra/scripts/disable-unneeded-apis.ps1` (sem `-Apply` só lista; **não foi executado**).

`monitoring.googleapis.com` permanece como está (padrão do projeto): sem policies nem métricas customizadas, não gera custo.

## 5. Resumo das travas

1. Escala a zero, máximo de 2 instâncias, CPU só durante a requisição.
2. Nenhum recurso com custo fixo: sem Cloud SQL, load balancer, VPC connector, NAT, IP estático, domain mapping, Secret Manager, alert policies.
3. Retenção mínima no Pub/Sub; sem schemas nem BigQuery subscriptions.
4. Registro de imagens com limpeza agressiva (2 versões).
5. Firestore só `(default)`, sem PITR/backup; escrita e leitura contidas pelo backend; TTL.
6. Logging com exclusões e retenção de 30 dias.
7. Orçamento + kill-switch como última linha (não é limite rígido).

## 6. Riscos que ainda podem gerar cobrança

1. **Artifact Registry** já excedido pela conta (seção 1). Impacto: centavos.
2. **Firestore**: excesso de leituras/escritas diárias (cobra a US$ 0,03 por 100 mil leituras e US$ 0,09 por 100 mil escritas, preços da página consultada). Depende de o backend implementar rollups e throttling.
3. **TTL do Firestore**: exige faturamento ativo; **NÃO CONFIRMADO** se as exclusões por TTL contam nas 20.000 exclusões gratuitas por dia. O campo precisa ser `Timestamp`; hoje o backend grava `expireAt` como **string ISO**, que **não expira**.
4. **Egress** acima de 1 GiB se o dashboard fizer poll agressivo com respostas grandes.
5. **Abuso da API pública** (`allUsers`) até o teto de 2 instâncias; o kill-switch corta com atraso.
6. **Alert policies** futuras no Cloud Monitoring (passam a ser cobradas).
7. **Bucket padrão multirregional do Cloud Build** (`<projeto>_cloudbuild`, US multi-região) e o repositório `cloud-run-source-deploy`: aparecem se alguém rodar `gcloud builds submit` sem `--gcs-source-staging-dir` ou `gcloud run deploy --source`. Foi exatamente isso que encheu o Artifact Registry dos outros projetos da conta. **Sempre** usar os scripts de `infra/scripts` (que passam o staging regional). Ainda não existe nenhum bucket no projeto (verificado em 26/10/2026).
8. **Builds regionais e a cota de 2.500 min**: não confirmei que o build com `--region` conta na cota gratuita. Se não contar, cada build de ~1–2 min custa fração de centavo (US$ 0,006/min no pool padrão); o risco é pequeno, mas não é zero estrito.
9. Filtros de exclusão do Logging não testados: se estiverem errados, o efeito é só registrar mais logs (muito abaixo de 50 GiB).

## 7. Cloud Build e o bucket de staging

**Por que existe o bucket.** `gcloud builds submit` envia o código-fonte a um bucket. Sem `--gcs-source-staging-dir`, o gcloud cria e usa `gs://<projeto>_cloudbuild` em **multi-região US**, que **não** está na cota gratuita de Cloud Storage (a cota vale para regionais `us-central1`, `us-east1` e `us-west1`, segundo fonte secundária). Por isso o Terraform cria `compiladores-512823-build-staging`: regional `us-central1`, `STANDARD`, acesso uniforme, sem versionamento, `public_access_prevention = enforced`, ciclo de vida de 1 dia.

**Como evitar o bucket padrão (regras):**

1. Todo build usa `--gcs-source-staging-dir gs://compiladores-512823-build-staging/source` (já feito em `bootstrap.ps1` estágio 2, `build-and-deploy.ps1` e no job opcional do CI).
2. Builds usam arquivo de configuração com `options.logging: CLOUD_LOGGING_ONLY` e `--service-account` próprio, então o Cloud Build não precisa de bucket de logs.
3. Nunca usar `gcloud run deploy --source` nem `gcloud builds submit --tag` sem staging: ambos recriam o bucket padrão (e o segundo ainda usa a conta padrão).
4. `build-and-deploy.ps1` avisa se o bucket `<projeto>_cloudbuild` existir. Se aparecer, apague-o: `gcloud storage rm -r gs://compiladores-512823_cloudbuild`.

**Cota de build.** 2.500 min/mês no pool padrão (`e2-standard-2`, sem `machineType` customizado). Estimativa: o kill-switch (Node alpine) leva ~1 min; o backend, 1–3 min. Mesmo com 20 builds por mês ficam bem abaixo de 100 min.
