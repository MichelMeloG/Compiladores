# Questões abertas (infra)

Cada item traz o padrão adotado enquanto não houver decisão. Os padrões são os mais baratos/seguros.

| # | Questão | Padrão adotado | Quem decide |
|---|---|---|---|
| Q1 | **TTL e índices do Firestore.** O TTL só atua em campos do tipo `Timestamp`; o backend grava `expireAt` como **string ISO** (`services/common.ts`, coleção `idempotency`), que não expira. Falta definir quais coleções/campos recebem TTL (`events`, `outbox`, `processed`, `idempotency`) e se as exclusões por TTL contam nas 20.000 exclusões gratuitas/dia (**não confirmado**). Índices compostos dependem das consultas reais | `firestore_ttl_fields = {}` (nenhum TTL) e nenhum índice composto | Frentes B/C |
| Q2 | **Artifact Registry já está acima de 0,5 GB na conta de faturamento** por causa de `sentinela-494722` (≈ 486 MB) e `claravus-staging` (≈ 153 MB). Cada imagem do RoboFlow é cobrada (~US$ 0,10/GB-mês) | Imagens mínimas (alpine), manter 2 versões. O custo estimado é de centavos. **Para custo zero estrito:** aplicar limpeza nesses outros repositórios ou usar outra conta de faturamento. Não mexi nos outros projetos | Dono da conta de faturamento |
| Q3 | **Suíte de contrato no smoke** roda contra produção (`AUTH_MODE=firebase`): precisa limitar-se a endpoints públicos/`/device/*` com dispositivo de teste, ou receber `CONTRACT_TEST_TOKEN` | Smoke passa `CONTRACT_TEST_TOKEN` se existir; senão a suíte deve pular testes de operador | Frente C |
| Q4 | **Dispositivo de teste** (`RB-TEST`) em `device_secrets_json` para o smoke | Não criado. O smoke só valida `/health` e o que não exige HMAC | Dono do projeto |
| Q5 | **Autenticação do front**: Firebase Auth exige criar o app Firebase no projeto e habilitar o provedor Google; fora do Terraform. As APIs `identitytoolkit`/`firebase` ficam desligadas até lá | Fora do escopo desta entrega (front fica para depois). Só provedor Google/e-mail; **nada de SMS/telefone** (cobrado) | Dono do projeto |
| Q6 | **Política de organização** que bloqueie `allUsers` no Cloud Run | Conta Gmail pessoal sem organização: não deve se aplicar. Se bloquear, o desenho muda | Dono do projeto |
| Q7 | **State do Terraform** local, que agora contém `device_secrets_json` em texto | Local, ignorado no git. Mantenha fora de pastas compartilhadas (OneDrive sincroniza o repositório!) e faça backup protegido. Perder o arquivo exige `terraform import` | Dono do projeto |
| Q8 | **Moeda do orçamento**: a conta é BRL, então "US$ 1" virou R$ 5 | `budget_amount = 5`, `budget_currency = "BRL"` | Dono do projeto |
| Q9 | **Ação do kill-switch**: altera o ingress para `internal-only` (o Cloud Run não aceita `max-instances = 0`). Alternativa dura: apagar o serviço | `internal-only` (reversível) | Dono do projeto |
| Q10 | **Filtros de exclusão do Logging** (`/health` e `/device/poll` bem-sucedidos) não foram testados contra logs reais | Aplicados como estão; se não casarem, apenas se grava mais log | Infra, após o primeiro deploy |
| Q11 | **Preço de SMS/telefone e dos canais de notificação do Monitoring** não confirmados | Não usamos nenhum dos dois | — |
| Q12 | **O repositório fica dentro do OneDrive**: o `terraform.tfstate` e o `terraform.tfvars` (com segredos) seriam sincronizados com a nuvem da Microsoft | Considere mover `infra/terraform` para fora do OneDrive ou excluir a pasta da sincronização | Dono do projeto |
| Q13 | **Builds regionais (`--region us-central1`) contam na cota de 2.500 min?** Não confirmado. A cota gratuita de Cloud Storage "Always Free" também veio de fonte secundária | Seguir assim; se o primeiro mês mostrar cobrança, voltar ao build local/GitHub Actions | Infra, após o primeiro mês |
| Q14 | **`backend/Dockerfile`** precisa ter contexto na raiz, porta 8080 e `GET /health` sem Firestore | Contrato descrito em `ENV_CONTRACT.md` §7 | Frente B |
