# Provisionamento do dispositivo

Como o carrinho recebe identidade, segredo, Wi-Fi e a confiança no servidor. Tudo aqui é para o POC; os limites de segurança estão na §7 sem enfeite.

## 1. O que o dispositivo precisa saber

| Dado | Origem | Onde fica no ESP32 | Pode ir ao repositório? |
|---|---|---|---|
| `deviceId` (ex.: `RB-01`) | seed do backend (`RB-01` a `RB-04`) | NVS | sim (não é segredo) |
| **Segredo HMAC** | gerado por você, por dispositivo | NVS | **nunca** |
| SSID e senha do Wi-Fi | rede do ensaio | NVS | **nunca** |
| Host do serviço | `roboflow-api-483331439325.us-central1.run.app` | NVS (ou constante) | sim |
| Raízes de certificado (GTS Root R1 a R4) | pública, ver §3 | flash do firmware (constante) | sim |
| Contador de boots | gerado pelo firmware | NVS | não se aplica |

Qual `deviceId` é o carrinho físico ainda não foi decidido (pergunta aberta no README). Sugestão: `RB-01` para o físico e `RB-02` a `RB-04` para simulação; até aqui o simulador usou `RB-03` contra a nuvem.

## 2. Fluxo de provisionamento

1. **Gerar o segredo** do dispositivo, 256 bits em hexadecimal (o backend exige no mínimo 16 caracteres):
   ```powershell
   openssl rand -hex 32
   ```
   Não cole o valor em chat, issue, commit nem documento.
2. **Registrar no backend** (quem administra a infra): o segredo vai para `device_secrets_json` no `terraform.tfvars` que fica **fora do repositório** (`~/.roboflow-infra/terraform.tfvars`) e é aplicado com o Terraform; ele vira a variável de ambiente `DEVICE_SECRETS_JSON` do Cloud Run, no formato `{"RB-01":"<segredo>"}`. A infra não usa Secret Manager (decisão do projeto). O firmware não participa deste passo.
3. **Gravar o firmware** pela Arduino IDE (sem segredos dentro do código).
4. **Gravar a configuração na NVS** por um sketch ou comando de provisionamento separado, sem segredos no código-fonte: o operador digita na serial (115200 8N1) algo como `set wifi.ssid ...`, `set wifi.pass ...`, `set device RB-01`, `set secret ...`, `set host ...`, `save`. Depois de salvar, o firmware **nunca imprime** o segredo. Para confirmar que a gravação está certa, ele pode imprimir apenas os 4 primeiros hex de `SHA-256(segredo)` (um "id da chave") e você compara com o que calculou no passo 1.
5. **Conferir** com `GET /api/devices/RB-01/status` (painel ou API): o dispositivo aparece `online` com `sessionId` e `firmwareVersion` depois do primeiro `hello`.

NVS: namespace `roboflow`; chaves sugeridas `ssid`, `wpass`, `devid`, `secret`, `host`, `boot` (u32 do contador de boots). Limite de valor de string em NVS é de milhares de bytes; os segredos cabem folgados.

## 3. Confiança no servidor: certificado raiz

O Cloud Run serve `*.run.app` com certificado da **Google Trust Services**. Isto foi **observado ao vivo em 26/10/2026**, conectando ao próprio serviço implantado com `openssl s_client`:

| Posição | Certificado | Chave | Validade |
|---|---|---|---|
| 0 (folha) | `CN=*.a.run.app` (SAN com dezenas de domínios regionais, inclusive `*.us-central1.run.app`) | EC P-256 | **84 dias** (28/09/2026 a 21/12/2026) |
| 1 (intermediária) | `WR2` | RSA 2048 | até 20/02/2029 |
| 2 (raiz cruzada) | `GTS Root R1` assinada pela `GlobalSign Root CA` | RSA 4096 | até 28/01/2028 |

Tamanhos DER: folha 3.859 B, intermediária 1.295 B, raiz cruzada 1.382 B; **cadeia ≈ 6,5 KB**. TLS 1.3 e 1.2 são aceitos; o mbedtls das versões usuais do Arduino-ESP32 fala TLS 1.2, e `ECDHE-ECDSA-AES128-GCM-SHA256` foi aceito pelo servidor.

### O que fixar

Fixe **raízes**, não a folha nem a intermediária:

| Opção | Sobrevive à rotação? | Veredito |
|---|---|---|
| Fixar a **folha** ou sua chave pública | Não: renova a cada ~60–90 dias | Rejeitada |
| Fixar a **intermediária** (`WR2`) | Não: o Google emite por intermediárias diferentes (WR1 a WR4, WE*) e as troca | Rejeitada |
| **Âncoras de confiança = GTS Root R1, R2, R3 e R4** | Sim para trocas de folha e de intermediária. Falha só se o Google passar a usar outra raiz fora dessas quatro | **Recomendada** |
| Pacote completo de raízes (ESP-IDF cert bundle / Mozilla) | Sim, mais robusto | Plano B, custa dezenas de KB de flash |
| `setInsecure()` / não verificar | — | **Proibida**, nem em bancada |

**Verificado:** com a conexão ao serviço real, validar usando **somente a GTS Root R1** como âncora resultou em `Verify return code: 0 (ok)`. R2, R3 e R4 sozinhas **não** validam hoje (`unable to get local issuer certificate`); as quatro juntas validam. Hoje a cadeia termina em R1; R2, R3 e R4 estão no pacote como **reserva** para o dia em que o Google emitir a partir de outra raiz GTS. Não foi possível confirmar essa política em documento oficial (a consulta ao site de PKI do Google falhou por limite de sessão); a lista de raízes foi baixada de `https://pki.goog/roots.pem` e é a fonte pública da Google.

A cadeia que o servidor envia traz a `GTS Root R1` **cruzada** (assinada pela GlobalSign). Com a R1 **autoassinada** (a que vai no firmware) como âncora, o OpenSSL aceitou. O mbedtls costuma escolher o pai confiável pelo nome do emissor e aceitar, mas **isso não foi testado no ESP32** e é critério do marco M2.

### As quatro raízes

| Raiz | Chave | DER | PEM | Validade | SHA-256 do certificado |
|---|---|---:|---:|---|---|
| GTS Root R1 | RSA 4096 | 1.371 B | 1.911 B | até 22/06/2036 | `D9:47:43:2A:BD:E7:B7:FA:90:FC:2E:6B:59:10:1B:12:80:E0:E1:C7:E4:E4:0F:A3:C6:88:7F:FF:57:A7:F4:CF` |
| GTS Root R2 | RSA 4096 | 1.371 B | 1.911 B | até 22/06/2036 | `8D:25:CD:97:22:9D:BF:70:35:6B:DA:4E:B3:CC:73:40:31:E2:4C:F0:0F:AF:CF:D3:2D:C7:6E:B5:84:1C:7E:A8` |
| GTS Root R3 | ECC P-384 | 525 B | 765 B | até 22/06/2036 | `34:D8:A7:3E:E2:08:D9:BC:DB:0D:95:65:20:93:4B:4E:40:E6:94:82:59:6E:8B:6F:73:C8:42:6B:01:0A:6F:48` |
| GTS Root R4 | ECC P-384 | 525 B | 765 B | até 22/06/2036 | `34:9D:FA:40:58:C5:E2:63:12:3B:39:8A:E7:95:57:3C:4E:13:13:C8:3F:E6:8F:93:55:6C:D5:E8:03:1B:3C:7D` |

Como obter e conferir (confirme as impressões digitais acima antes de embutir; não confie cegamente no download):

```bash
curl -sS https://pki.goog/roots.pem -o roots.pem          # 21 raízes; as 4 primeiras são GTS R1..R4
# separe os 4 primeiros certificados e confira cada impressão digital:
openssl x509 -in gtsr1.pem -noout -subject -fingerprint -sha256
```

Embuta as quatro como uma constante em PEM no firmware (`const char kRootCAs[] PROGMEM = "-----BEGIN CERTIFICATE-----\n...";` concatenadas, terminadas em `\0`).

### Custo no ESP32 (estimativas a medir no M2)

| Recurso | R1 sozinha | R1 a R4 (recomendado) | Pacote completo (plano B) |
|---|---:|---:|---:|
| Flash para os certificados | 1,9 KB (PEM) | **5,3 KB** (PEM) ou 3,8 KB (DER) | da ordem de dezenas de KB (~60 KB para o pacote do Mozilla) |
| RAM enquanto conectado (certificados interpretados pelo mbedtls) | ~3 KB | **~8 a 10 KB** | pequena (o bundle do ESP-IDF interpreta sob demanda) |

A RAM é estimativa: cada raiz RSA-4096 interpretada ocupa cerca de 3 KB (cópia DER + estrutura + inteiros grandes) e cada ECC P-384 cerca de 1,5 KB. Como a conexão é mantida (keep-alive), esses KB ficam retidos enquanto a conexão existir. Medir com `ESP.getFreeHeap()` antes e depois de `connect()` e registrar o `ESP.getMinFreeHeap()` ao longo de 1 h.

**Atenção, buffer de recebimento do TLS.** A cadeia do servidor tem ~6,5 KB e o mbedtls precisa receber a mensagem de certificados inteira em um buffer. **Não reduza** o buffer de entrada do TLS abaixo de ~8 KB (o padrão do Arduino-ESP32 de 16 KB serve). O pico de heap de um handshake completo costuma ficar entre 40 e 60 KB; registre o valor medido.

### Como detectar uma rotação que quebre o POC

O serviço pode passar a usar uma raiz fora das quatro sem aviso. Rode periodicamente (semanal, manual ou em um agendador gratuito) e aborte o ensaio se falhar:

```bash
H=roboflow-api-483331439325.us-central1.run.app
cat gtsr1.pem gtsr2.pem gtsr3.pem gtsr4.pem > gts4.pem
echo | openssl s_client -connect $H:443 -servername $H -no-CAfile -no-CApath -no-CAstore \
  -CAfile gts4.pem -verify_return_error 2>&1 | grep "Verify return code"
# esperado: Verify return code: 0 (ok)
```

No firmware, registre o motivo da falha de verificação do mbedtls separadamente (`NOT_TRUSTED`, `EXPIRED`, `FUTURE`, `CN_MISMATCH`): "expirado/futuro" quase sempre é relógio errado, não ataque.

**Risco assumido:** se o Google mudar para outra raiz, todos os carrinhos deixam de conectar até serem regravados (não há OTA no POC). Datas a lembrar: as quatro raízes GTS expiram em 22/06/2036; a cruzada GlobalSign usada na cadeia atual expira em 28/01/2028 (não afeta quem ancora na R1 autoassinada).

## 4. Relógio

O `X-Timestamp` precisa estar em ±120 s do servidor (e a validade dos certificados depende do relógio). O ESP32 não tem hora sem rede.

- Antes de qualquer TLS, sincronize via SNTP (UDP 123): `configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com")`. Espere `time(nullptr) > 1700000000` (ano 2023 ou depois) por até ~15 s; se não sincronizar, **não tente falar com o servidor** e tente de novo em 10 s.
- Re-sincronização automática do SNTP do lwIP (padrão 1 h) é suficiente: a tolerância é de dois minutos.
- Um deslocamento de relógio é pego pelo servidor como `CLOCK_SKEW` (401); o firmware reage re-sincronizando.
- Uma checagem barata de sanidade: compare `serverTime` das respostas com o relógio local; diferença > 60 s deve gerar log e nova sincronização.
- Redes que bloqueiam UDP 123 impedem o NTP; use o ponto de acesso do celular na bancada.

## 5. Rotação de segredo (sem derrubar o carrinho)

O backend aceita uma **lista** de segredos por dispositivo (`DEVICE_SECRETS_JSON` = `{"RB-01":["novo","antigo"]}`), tentando cada um.

1. Gere o novo segredo (`openssl rand -hex 32`).
2. No `terraform.tfvars` externo, passe `RB-01` para a lista `["novo","antigo"]` e aplique (quem administra a infra).
3. Reprovisione o carrinho com o novo (§2, passo 4) e confirme que ele autentica.
4. Retire o antigo da lista e aplique de novo.

Também rotacione se o aparelho for perdido, emprestado ou se o segredo vazar em log.

## 6. Perdi o segredo

Não há recuperação. O segredo existe só no `terraform.tfvars` externo e na NVS do carrinho. Se ambos se perderam, gere um novo, grave no tfvars, aplique e reprovisione os aparelhos. Faça backup do `tfvars` **fora do OneDrive** (o repositório deste projeto está dentro do OneDrive; os segredos não devem estar).

## 7. Limites honestos de segurança do POC

| Fato | Consequência |
|---|---|
| Segredo em texto claro na NVS, e a flash pode ser lida pela USB (`esptool read_flash`) | Quem tiver o aparelho consegue o segredo **daquele** dispositivo e passa a se passar por ele (falsificar progresso, confirmar comandos, ler comandos). Não consegue se passar por outros (segredos por dispositivo) |
| Sem criptografia de flash nem secure boot (exigem queimar eFuse, irreversível) | Fora do escopo do POC; mencionar no artigo como trabalho futuro |
| Respostas do servidor não são assinadas | Dependem inteiramente do TLS com raiz fixada; sem verificação de certificado, qualquer um na rede poderia injetar comandos |
| Wi-Fi com senha também na NVS | Mesmo risco acima |
| O segredo está também na configuração do Cloud Run (variável de ambiente) e no state local do Terraform | Visível a quem tem acesso ao projeto GCP e ao disco do administrador |
| Stop/abort remotos são "melhor esforço" | Não são dispositivo de segurança (ADR 0002); a segurança é o veto local e a chave física |

Mitigações baratas: um segredo por dispositivo, 256 bits, rotação ao menor sinal de vazamento, `max-instances` e limite de taxa no servidor, e nunca habilitar `AUTH_MODE=off` em produção (o backend recusa).
