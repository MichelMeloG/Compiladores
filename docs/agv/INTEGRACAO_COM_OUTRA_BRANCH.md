# Integração com o firmware que evolui em outra branch

O sketch do carrinho está sendo alterado em paralelo para funcionar na pista. Para a junção não virar conflito,
as mudanças de nuvem foram mantidas **pequenas, isoladas e reaplicáveis**.

## O que o backend exige do firmware (contrato, não muda)
- `POST /device/hello` e `POST /device/events`, cabeçalhos `X-Device-Id`, `X-Session-Id`, `X-Timestamp` (s), `X-Sequence`, `X-Signature`.
- HMAC-SHA256 sobre `POST\n<path>\n<ts>\n<seq>\n<sha256(corpo)>` (igual a `contracts/src/signing.ts`).
- Qualquer sketch novo continua compatível se mantiver isso e o formato dos eventos.

## O que foi acrescentado ao template (só a camada de rede + segurança)
Patch pronto: `docs/agv/patches/firmware-rede-resiliente.patch` (`git apply` sobre `compiler/roboflow/runtime/carrinho_autonomo.ino.template`;
o mesmo vale para `firmware/carrinho_autonomo/carrinho_autonomo.ino`). Mudanças:
1. **Backoff exponencial com jitter** em erro HTTP (antes: 1,5 s fixo) e espera de 30 s em `429`.
2. **Timeouts de HTTPS** 6 s/8 s (TLS e cold start do Cloud Run passam de 1,2 s).
3. **401 repetido** (3x) ressincroniza o NTP e refaz o `hello`.
4. **Parada por perda de comunicação** (`LIMITE_PARADA_SEM_REDE_MS`, 8 s): se estiver `EXECUTANDO` sem contato, bloqueia com `stop_requested`.
5. **Watchdog** (`esp_task_wdt`) no `loop`.

Ao juntar com a outra branch: aplique o patch; se um trecho conflitar, só a lógica acima precisa sobreviver. Itens 1–3 vivem
dentro de `comunicarBackend()`; 4 e 5 em `loop()`/`setup()`. Não há mudança em pinos, motores, sensores ou máquina de estados.

## Segredos e credenciais
Não grave Wi-Fi/segredo no `.rf` versionado. Use variáveis de ambiente na hora de compilar (têm prioridade sobre o `.rf`):
`ROBOFLOW_SSID`, `ROBOFLOW_PASSWORD`, `ROBOFLOW_BACKEND`, `ROBOFLOW_TOKEN`, `ROBOFLOW_CA_CERT`. Arquivos `*.local.rf` são ignorados pelo git.
Os segredos dos robôs RB-01..RB-04 estão no Secret Manager (`roboflow-device-secrets`) e numa cópia local fora do repositório.

## HTTPS direto
O firmware só fala HTTPS com `CA_CERT` (PEM). Para o Cloud Run use a raiz que assina `*.run.app` (obtenha com
`openssl s_client -showcerts -connect roboflow-api-483331439325.us-central1.run.app:443` e use o último certificado da cadeia).
Teste primeiro na bancada, com as rodas suspensas.
