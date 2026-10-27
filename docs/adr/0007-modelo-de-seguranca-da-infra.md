# ADR 0007 — Modelo de segurança da infraestrutura

- **Status:** proposto
- **Data:** 26/10/2026
- **Relacionados:** ADR 0006, `infra/ENV_CONTRACT.md`, `infra/terraform/iam.tf`, `infra/terraform/wif.tf`

## Contexto

O serviço é público na internet por necessidade: o navegador do operador e o ESP32 não têm credencial IAM. Isso desloca a barreira de segurança para a aplicação e para um IAM bem recortado. O repositório é aberto, então nada sensível pode estar nele. O custo é atrelado a um cartão, de modo que abuso também é um risco financeiro.

## Decisões

### 1. IAM de privilégio mínimo

Uma service account por função (`cloud-build`, `roboflow-api`, `pubsub-invoker`, `scheduler-invoker`, `github-deployer`, `budget-killswitch`, `budget-invoker`). Papéis concedidos no **recurso**, não no projeto, sempre que possível: `pubsub.publisher` nos dois tópicos, `run.developer` somente no serviço alvo, `artifactregistry.writer` somente no repositório. A conta *default* do Compute **não** é usada. Papéis básicos (`owner`/`editor`) não são concedidos a nenhuma SA. Tabela completa em `ENV_CONTRACT.md` §5.

### 2. CI sem chave: Workload Identity Federation

O GitHub Actions troca seu token OIDC por credenciais curtas da SA `github-deployer`. A condição do provedor restringe a `assertion.repository == "MichelMeloG/Compiladores"` **e** `assertion.ref == "refs/heads/main"`: forks, pull requests e outras branches não conseguem a troca. Não existe chave JSON. O `github-deployer` só pode: enviar código ao bucket de staging, criar builds (`cloudbuild.builds.editor`), agir como a conta `cloud-build` e como a SA de runtime, e criar revisões do `roboflow-api`. Ele **não** publica imagens diretamente: quem escreve no Artifact Registry é a conta `cloud-build`. O deploy pelo CI está desligado por padrão.

### 3. Segredos (sem Secret Manager)

Para manter **custo zero estrito**, não usamos o Secret Manager. Os valores sensíveis entram por variáveis do Terraform e chegam ao serviço como variáveis de ambiente:

- `device_secrets_json` (`sensitive = true`, **sem valor padrão**) → env `DEVICE_SECRETS_JSON` (`{"RB-01":"<hex>"}`).
- `operator_emails` → env `ALLOWED_OPERATOR_EMAILS` (texto simples, não é segredo).
- Ambos ficam só em `infra/terraform/terraform.tfvars`, ignorado pelo git (`infra/.gitignore` cobre `*.tfvars`, o state e chaves). O repositório traz apenas `terraform.tfvars.example` com marcadores.

**Trade-off honesto.** Comparado ao Secret Manager: (a) o valor fica no **state local** (`terraform.tfstate`, em texto); (b) o valor aparece **em texto na configuração do serviço Cloud Run** e no histórico de revisões, visível a quem tem acesso de leitura ao projeto; (c) não há versionamento, auditoria de acesso nem rotação nativos; (d) rotação = editar o tfvars e reaplicar (nova revisão). É aceitável para um POC com um único dono e um AGV; **não** é para produção. O segredo nunca vai ao repositório.

Mitigações e limites: proteger o state (fora de pastas compartilhadas; backup criptografado); um segredo por dispositivo; 256 bits; só o dono do projeto com acesso de leitura (IAM). O segredo também fica na flash do ESP32 sem criptografia por padrão: quem obtiver o aparelho obtém o segredo (flash encryption do ESP32 está fora do escopo). Varredura de segredos no CI (item SEC-006 do backlog) completa a defesa.

### 4. Endpoints `/internal/*` somente com OIDC

`/internal/events` (Pub/Sub) e `/internal/offline-check` (Scheduler) exigem ID token do Google com `aud == INTERNAL_AUDIENCE` e `email` igual à SA esperada. Como o Cloud Run está com `allUsers`, **a verificação acontece na aplicação** e responde 401/403 sem token válido. O contrato está em `ENV_CONTRACT.md` §2.

### 5. Autenticação dos demais caminhos

`/api/*`: Firebase ID token + allowlist (falha fechada com lista vazia). `/device/*`: HMAC por dispositivo com `sessionId` e `sequence` contra replay. A infra não faz essa validação; apenas entrega os segredos e variáveis.

### 6. Limites e abuso (sem Cloud Armor)

Teto de 2 instâncias, concorrência 80, timeout 30 s, memória 256 MiB; rate limit **na aplicação** (por usuário e por dispositivo); corpo máximo imposto pela aplicação (4 KB no dispositivo); orçamento com kill-switch (ADR 0006). O CORS é restrito à origem da dashboard.

### 7. Rede

Sem VPC, sem IP privado. Firestore e Pub/Sub são acessados pela API pública do Google sob IAM. Ingress do `roboflow-api` é `all`; o do `budget-killswitch` é protegido por IAM (sem `allUsers`).

## O que NÃO é coberto

- **Cloud Armor / WAF / proteção contra DDoS de camada 7:** é pago. Um ataque volumétrico até o teto de 2 instâncias degrada o serviço e pode consumir a cota; o kill-switch corta, mas com atraso.
- **Isolamento de rede e VPC Service Controls:** fora do orçamento do POC.
- **Criptografia de flash e *secure boot* do ESP32:** fora do escopo da infra.
- **Auditoria de acesso a dados (Data Access logs):** desligados por padrão por causa do volume e do custo; os logs de atividade administrativa do GCP continuam ativos e gratuitos.
- **Autenticação do front (Firebase Auth):** configuração no console, fora do Terraform nesta entrega.
- **Revisão de dependências e imagens:** tratada no pipeline do backend (SEC-006).
- **Separação de ambientes:** há um único ambiente.

## Consequências

- Um erro na validação OIDC da aplicação expõe `/internal/*` à internet. Precisa de teste automatizado (token ausente, `aud` errado e e-mail errado devem falhar).
- Reabilitar o serviço após o kill-switch exige uma decisão humana e uma conta com `run.developer`.
- Quem controla a branch `main` do repositório controla o deploy. Proteger a branch (revisão obrigatória) é pré-requisito operacional.
