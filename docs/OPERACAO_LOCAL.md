# Operação local sem consumo de Cloud Run ou Firestore

O front e o backend funcionam neste computador. Os dados ficam em memória,
com cadastro inicial de robôs e mapas, sem missões simuladas. Reiniciar o
backend perde as alterações locais; o banco remoto não é sincronizado.

## Preparar uma máquina

Na raiz do repositório, com Node.js 22 ou superior:

```powershell
npm.cmd --prefix contracts ci
npm.cmd --prefix backend ci
npm.cmd --prefix dashboard ci
node infra/scripts/setup-local.mjs
```

O script cria `backend/.env` com segredo aleatório para `RB-01` e
`dashboard/.env.local` com `/api`, sem Firebase. Não sobrescreve arquivos
existentes. Ambos são ignorados pelo Git. Não reutilize o segredo de produção.

## Iniciar

Em um terminal:

```powershell
npm.cmd --prefix backend run dev:local
```

Em outro:

```powershell
npm.cmd --prefix dashboard run dev
```

Abra <http://127.0.0.1:3000/Compiladores/>. O front e o backend escutam apenas
em `127.0.0.1`. O operador não precisa de login neste modo; esse acesso sem
autenticação depende de manter as portas 3000 e 8080 restritas à própria máquina.
O front usa o proxy local; não consome a API hospedada nem o Firestore.

## ESP32 na mesma rede

Para permitir acesso ao dispositivo sem expor a API do operador à rede:

```powershell
npm.cmd --prefix backend run device:local
```

Esse processo escuta na porta **8081**, nas interfaces da máquina. Ele encaminha
apenas `POST /device/hello`, `POST /device/events` e `GET /device/poll`, preservando
o corpo e os cabeçalhos assinados para validação pelo backend. Não encaminha
`/api/*`, `/internal/*` nem o protocolo legado de sensores com token Bearer.
Mensagens acima de 4096 bytes são recusadas.

No firmware autônomo, configure Wi-Fi, `ROBO=RB-01`, `TOKEN` com o segredo de
`backend/.env` e `URL=http://IP_LOCAL_DO_PC:8081`, sem `/api`. O ESP32 continua
precisando sincronizar seu relógio. O teste físico e a calibração continuam
necessários; a verificação de software não movimentou motores.

Use somente uma rede de confiança, sem encaminhar portas no roteador nem usar
túneis públicos. Se o Windows bloquear o ESP32, a regra de firewall deve se
restringir à porta 8081, perfil privado e rede local; não abra as portas do
operador. Encerre os processos com Ctrl+C ao terminar.

## Situação da publicação e segurança

O conteúdo do GitHub Pages foi substituído por um site sem aplicativo; os
endereços públicos retornaram HTTP 404. O workflow foi desativado para novas
publicações. Isso não torna o repositório privado nem apaga o histórico Git.
A API Cloud Run passou a aceitar somente entrada interna e a checagem
agendada de robôs foi pausada. Esses estados também foram registrados no
Terraform local para evitar reabertura acidental.

A chave de Firebase Web que aparecia no workflow é uma configuração pública,
não uma chave privada ou credencial de administrador. Sua restrição foi reduzida
às APIs de autenticação (`identitytoolkit` e `securetoken`) e às origens locais
na porta 3000. O cadastro por clientes no Firebase continua desabilitado.
Restrições de origem não substituem autenticação e autorização.

Na revisão dos 34 commits disponíveis na sessão, não houve correspondência
com os quatro segredos de dispositivo da configuração remota, nem com os
padrões pesquisados de chaves privadas, tokens GitHub e access tokens Google.
Isso é uma verificação delimitada, não garantia de ausência de qualquer segredo
em todos os locais, artefatos, clones ou formatos.

O backend possui verificação de tokens Firebase, lista de e-mails autorizados,
papéis de usuário, HMAC e proteção contra replay no protocolo autônomo e OIDC
para rotas internas. Há limites de corpo e limites por usuário/dispositivo.
Esses limites são aplicados na aplicação e não constituem um teto financeiro.
Antes de fechar a entrada externa, `/api/health` consultava o banco sem login,
e um ID de dispositivo conhecido provocava leitura do cadastro antes da
validação HMAC. Esses caminhos não devem ser reabertos publicamente sem revisão.

Recursos de nuvem existentes não foram excluídos nem o faturamento foi
desvinculado. Rodar localmente evita consumo de nuvem por este fluxo, mas não
garante cobrança zero de todos os recursos da conta.
