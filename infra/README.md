# Infraestrutura (GCP) — RoboFlow

Terraform para o POC, dentro da cota gratuita do GCP. Decisões e cotas em [ADR 0006](../docs/adr/0006-infra-gcp-regiao-iac-orcamento-e-cota-gratuita.md); segurança em [ADR 0007](../docs/adr/0007-modelo-de-seguranca-da-infra.md); contrato com o backend em [ENV_CONTRACT.md](ENV_CONTRACT.md); operação em [RUNBOOK.md](RUNBOOK.md); pendências em [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## O que existe

```
infra/
  terraform/     recursos GCP (estágios controlados por variáveis enable_*)
  killswitch/    serviço Node que corta o tráfego quando o orçamento é atingido (testes: npm test)
  scripts/       bootstrap.ps1 (estágios), smoke.ps1 / smoke.sh (pós-deploy), disable-unneeded-apis.ps1
  COST_ZERO.md   auditoria de custo zero de cada recurso
```

Projeto `compiladores-512823` · região `us-central1` · conta de faturamento `01B754-38F742-DA56DB` (BRL).

## Pré-requisitos

1. `gcloud` instalado e logado com a conta dona do projeto (`bernardolobomarques@gmail.com`): `gcloud auth login`.
2. Credencial para o Terraform: `gcloud auth application-default login` (login separado, abre o navegador).
3. Terraform ≥ 1.6 (`winget install Hashicorp.Terraform`).
4. `cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars` e preencher `operator_emails` e **`device_secrets_json`** (obrigatório, sem valor padrão). O arquivo é ignorado pelo git; nunca o versione.
5. APIs já habilitadas manualmente; o Terraform declara só as necessárias (sem desabilitar ao destruir). Para desligar as dispensáveis, veja `scripts/disable-unneeded-apis.ps1` (não executado).
6. Diretriz: **custo zero estrito**. Leia [COST_ZERO.md](COST_ZERO.md): há um risco já existente na conta de faturamento (Artifact Registry).

## State

**Local, ignorado pelo git** (`infra/.gitignore`). Vantagem: nenhum bucket para criar nem credencial extra; nada de state no repositório aberto. Desvantagem: sem trava de concorrência, sem backup, e perder o arquivo exige `terraform import` de cada recurso. Faça backup de `terraform.tfstate` fora do OneDrive sincronizado se o projeto durar. Para mais de uma pessoa, migre para um bucket GCS com versionamento.

## Ordem de bootstrap (exata)

Cada estágio mostra o plano e pede **SIM** antes de aplicar. Nada faturável existe antes do estágio 3.

| Estágio | O que faz | Custo |
|---|---|---|
| 1 | APIs, service accounts, Artifact Registry, **bucket regional de staging**, tópico `budget-alerts`, Workload Identity Federation | Zero |
| 2 | Constrói e publica a imagem do kill-switch com **Cloud Build** (staging regional, conta `cloud-build`) | Dentro de 2.500 min grátis |
| 3 | Cria o serviço `budget-killswitch`, a subscription e o **orçamento** (R$ 5) | Zero (escala a zero) |
| 4 | Publica uma mensagem de teste (custo 0) e lê o log: deve dizer "sem corte" | Zero |
| 5 | Firestore `(default)` (a região é imutável) | Dentro da cota |
| 6 | Stack completa: tópicos Pub/Sub, Cloud Run `roboflow-api` (imagem de exemplo), Scheduler, exclusões de log | Dentro da cota |

```powershell
cd C:\Users\vinic\OneDrive\Documentos\GitHub\Compiladores
.\infra\scripts\bootstrap.ps1 -Stage 1
.\infra\scripts\bootstrap.ps1 -Stage 2
.\infra\scripts\bootstrap.ps1 -Stage 3
.\infra\scripts\bootstrap.ps1 -Stage 4
.\infra\scripts\bootstrap.ps1 -Stage 5
.\infra\scripts\bootstrap.ps1 -Stage 6
```

Se preferir comandos manuais, o equivalente do estágio 1 é `cd infra/terraform; terraform init; terraform plan -out tfplan; terraform apply tfplan`, e os demais ligam as variáveis `enable_killswitch_service`, `enable_budget`, `enable_main_stack` (nessa ordem; `enable_main_stack` só tem efeito se as outras duas estiverem ligadas).

### Depois do estágio 6

1. **Segredos de dispositivos (sem Secret Manager).** Gere um segredo forte por AGV e coloque em `device_secrets_json` no `terraform.tfvars` (ignorado pelo git):
   ```powershell
   # 64 hex = 256 bits (o openssl vem com o Git for Windows)
   & "C:\Program Files\Git\usr\bin\openssl.exe" rand -hex 32
   ```
   ```hcl
   device_secrets_json = "{\"RB-01\":\"<64 hex>\"}"
   ```
   Grave o mesmo valor no NVS do ESP32 e rode `terraform apply` para criar uma nova revisão. **Trade-off:** o valor fica no state local e, em texto, na configuração do Cloud Run (visível a quem tem acesso ao projeto). Aceitável para o POC; ver ADR 0007.
2. **Variáveis do GitHub (só se quiser deploy pelo CI; padrão: desligado).**
   ```powershell
   cd infra\terraform
   terraform output wif_provider
   terraform output deployer_service_account
   ```
   Cadastre `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA` e, para ligar o job, `CI_DEPLOY_ENABLED=true`. Sem isso, o workflow roda apenas testes, typecheck e `terraform fmt/validate`.
3. **Proteja a branch `main`** (revisão obrigatória): quem altera `main` controla o deploy (ADR 0007).
4. **Build e deploy do backend** (Cloud Build, a partir da raiz usando `backend/Dockerfile`):
   ```powershell
   .\infra\scripts\build-and-deploy.ps1 -Smoke
   ```
   Por padrão o script faz `gcloud run deploy --image`, e **não** `terraform apply -var image_tag=...`: o Terraform ignora mudanças de imagem (`ignore_changes`), então o apply não trocaria nada; o deploy por gcloud só troca a imagem e preserva env, escala e IAM. Depois do primeiro deploy, defina `use_placeholder_image = false` no tfvars (passa a configurar a sonda `/health`).
5. **Smoke manual:** `.\infra\scripts\smoke.ps1 -BaseUrl <api_url>`.

## Custos esperados

Em uso normal do POC (um AGV, um operador, algumas horas de missão por dia): **R$ 0**, dentro das cotas. Estimativas de ordem de grandeza, não medições:

- Cloud Run: poll do AGV a cada 30–60 s em repouso e 1–2 s em missão, mais o Scheduler (288/dia) e a dashboard: algumas centenas de milhares de requisições/mês, contra 2 milhões gratuitos.
- Firestore: o limite que importa (50 mil leituras e 20 mil escritas por dia). Depende do desenho de rollups do backend.
- Pub/Sub, Logging: muito abaixo das cotas, com as retenções mínimas e as exclusões de log.
- **Artifact Registry: a conta de faturamento já excede os 0,5 GB por causa de outros projetos** (≈ 670 MB). O RoboFlow acrescenta centavos por mês; não é zero estrito. Detalhes e opções em [COST_ZERO.md](COST_ZERO.md), seção 1.

Mecanismos de proteção: escala a zero, `max-instances = 2`, rate limit e poll adaptativo no backend, TTL e throttling de escrita no Firestore, orçamento de R$ 5 com e-mail e kill-switch. **O orçamento não é limite rígido** (atraso de horas, ver ADR 0006): o limite real é o desenho que nunca passa da cota. Confirme as cotas em [cloud.google.com/free](https://cloud.google.com/free) antes de publicar números.

## Cloud Build: bucket de staging e permissões

- Todo build usa o bucket regional `compiladores-512823-build-staging` (`--gcs-source-staging-dir`). **Nunca** rode `gcloud builds submit` sem essa flag nem `gcloud run deploy --source`: ambos criam o bucket multirregional `<projeto>_cloudbuild` e o repositório `cloud-run-source-deploy`, fora da cota gratuita (foi o que encheu os outros projetos desta conta). Detalhes em [COST_ZERO.md](COST_ZERO.md) §7.
- Em projetos novos o Cloud Build não vem com permissões prontas para a conta que executa o build. O Terraform cria a conta `cloud-build` com três papéis estreitos. Se um build falhar com `permission denied`, veja [RUNBOOK.md](RUNBOOK.md), "Permissões do Cloud Build".

## Destruir

`terraform destroy` não apaga o Firestore (`deletion_policy = ABANDON` + proteção contra exclusão) nem desabilita APIs. Para zerar de vez, apague o projeto no console.

## Validação local sem tocar na nuvem

```powershell
cd infra\terraform; terraform fmt -check -recursive; terraform init -backend=false; terraform validate
cd ..\killswitch;   npm test      # Node ≥ 22, sem dependências
```
