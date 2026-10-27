# Runbook operacional (infra)

Comandos de `gcloud` usam o projeto padrão (`gcloud config set project compiladores-512823`).

## 1. O kill-switch cortou o serviço (orçamento atingido)

Sintoma: dashboard e AGV sem resposta; o ingress do serviço aparece como **internal** (`gcloud run services describe roboflow-api --region us-central1 --format="value(metadata.annotations['run.googleapis.com/ingress'])"` ou o console); log `ingress do serviço alterado para internal-only` do `budget-killswitch`.

1. Entenda o gasto antes de religar: console > Billing > Reports, filtrando pelo projeto.
2. Corrija a causa (loop de polling, abuso, importação gigante).
3. Reabilite:
   ```powershell
   gcloud run services update roboflow-api --region us-central1 --ingress all
   ```
   (Um `terraform apply` também restaura `INGRESS_TRAFFIC_ALL`.)
4. Se o orçamento do mês continua estourado, o alerta seguinte cortará de novo. Aumente `budget_amount` no `terraform.tfvars` e aplique, ou espere o mês virar.

## 2. Criar o orçamento manualmente (se o Terraform falhar por permissão)

O Terraform cria `google_billing_budget`, que exige `billing.budgets.create` na conta `01B754-38F742-DA56DB` (papel `billing.admin`/`billing.costsManager`). Se não for possível:

1. Console > Billing > Budgets & alerts > Create budget.
2. Escopo: projeto `compiladores-512823`. Valor: **R$ 5** (≈ US$ 1; a conta é em BRL). Limiares 50 %, 90 %, 100 % (gasto real).
3. Em "Manage notifications": marcar **Connect a Pub/Sub topic** e escolher `projects/compiladores-512823/topics/budget-alerts`; adicionar e-mails.
4. Verifique que a subscription `budget-alerts-push` existe e aponta para `budget-killswitch`.

## 3. Testar o kill-switch sem cortar nada

```powershell
gcloud pubsub topics publish budget-alerts --message='{"costAmount":0,"budgetAmount":5}'
gcloud logging read 'resource.labels.service_name="budget-killswitch"' --limit 5 --freshness 5m --format 'value(jsonPayload.message)'
```
Esperado: `sem corte: custo 0 < orçamento 5`. Para ensaiar o corte de verdade, rode o serviço com `DRY_RUN=true` (variável de ambiente do `budget-killswitch`) e publique `costAmount` ≥ `budgetAmount`: deve aparecer `ORÇAMENTO ATINGIDO` sem alterar o ingress.

## 4. Girar o segredo de um dispositivo (sem Secret Manager)

O segredo vive em `device_secrets_json` no `infra/terraform/terraform.tfvars` (ignorado pelo git) e chega ao serviço como env `DEVICE_SECRETS_JSON`.

```powershell
# 1. gerar um novo segredo (64 hex)
& "C:\Program Files\Git\usr\bin\openssl.exe" rand -hex 32
# 2. editar terraform.tfvars: trocar o valor do dispositivo em device_secrets_json
# 3. aplicar: cria uma nova revisão do Cloud Run com o valor novo
cd infra\terraform; terraform plan -out tfplan; terraform apply tfplan
# 4. gravar o mesmo valor no NVS do ESP32
```
Janela de rotação: entre os passos 3 e 4 o AGV com o segredo antigo recebe 401. Hoje o formato é um valor por dispositivo; para rotação sem corte o backend poderia aceitar uma lista de segredos por dispositivo. O valor antigo continua no state local e no histórico de revisões do Cloud Run; apague revisões antigas (`gcloud run revisions delete`) se isso importar.

## 5. Mensagens na DLQ

```powershell
gcloud pubsub subscriptions pull agv-events-dlq-pull --limit 10 --auto-ack=false --format json
```
Inspecione, corrija a causa, e republique em `agv-events` ou descarte (`--auto-ack`).

## 6. Desligar tudo (emergência)

```powershell
gcloud run services update roboflow-api --region us-central1 --ingress internal
gcloud scheduler jobs pause device-offline-check --location us-central1
```

## 7. Permissões do Cloud Build (projetos novos)

**O snag.** Em projetos novos, habilitar a API do Cloud Build não concede à conta que executa o build as permissões que antes vinham por padrão. O build roda como uma conta sem os papéis necessários (a documentação cita a conta padrão do Compute Engine) e falha com erros como:

- `Permission 'artifactregistry.repositories.uploadArtifacts' denied` (não consegue publicar a imagem);
- `does not have permission to write logs to Cloud Logging` / exigência de bucket de logs ao usar `--service-account`;
- `storage.objects.get` negado ao ler o código-fonte do staging;
- `iam.serviceAccounts.actAs` negado para quem submete o build.

(Não consegui confirmar na documentação o comportamento exato da conta padrão de build; a recomendação do Google é usar conta própria.)

**A solução sem papéis amplos.** Não conceda `roles/cloudbuild.builds.builder`, `editor` ou `owner` à conta padrão. O Terraform já cria a conta `cloud-build` com exatamente três papéis. Equivalente manual:

```powershell
$P = 'compiladores-512823'
$SA = "cloud-build@$P.iam.gserviceaccount.com"
gcloud iam service-accounts create cloud-build --display-name "Cloud Build (imagens do RoboFlow)" --project $P

# 1. ler o código enviado ao staging
gcloud storage buckets add-iam-policy-binding "gs://$P-build-staging" --member "serviceAccount:$SA" --role roles/storage.objectViewer

# 2. publicar imagens SÓ neste repositório
gcloud artifacts repositories add-iam-policy-binding roboflow --location us-central1 --member "serviceAccount:$SA" --role roles/artifactregistry.writer --project $P

# 3. escrever logs do build
gcloud projects add-iam-policy-binding $P --member "serviceAccount:$SA" --role roles/logging.logWriter --condition None
```

Quem submete o build (você) precisa poder usar essa conta e enviar o código: o dono do projeto já tem, mas outra pessoa precisa de `roles/iam.serviceAccountUser` sobre a conta `cloud-build`, `roles/cloudbuild.builds.editor` no projeto e `roles/storage.objectAdmin` no bucket de staging:

```powershell
gcloud iam service-accounts add-iam-policy-binding $SA --member "user:<email>" --role roles/iam.serviceAccountUser --project $P
```

Os builds precisam de `--service-account projects/$P/serviceAccounts/$SA` e de um arquivo de configuração com `options.logging: CLOUD_LOGGING_ONLY` (já presente em `infra/cloudbuild/*.yaml`).

## 8. Apareceu o bucket `<projeto>_cloudbuild` ou o repositório `cloud-run-source-deploy`

Alguém rodou `gcloud builds submit` sem `--gcs-source-staging-dir` ou `gcloud run deploy --source`. Remova para não acumular custo:

```powershell
gcloud storage rm -r gs://compiladores-512823_cloudbuild
gcloud artifacts repositories delete cloud-run-source-deploy --location us-central1 --project compiladores-512823
```
