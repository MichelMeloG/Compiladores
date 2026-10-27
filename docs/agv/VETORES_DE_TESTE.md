# Vetores de teste do protocolo

O firmware valida a **própria** implementação de HMAC e de serialização contra estes vetores **antes** de falar com qualquer servidor. Todos foram gerados em 26/10/2026 rodando o código real de `contracts` (`contracts/dist/signing.js`) e conferidos por uma segunda implementação independente (Python: `hashlib` + `hmac`, 7 de 7 idênticos).

> O segredo destes arquivos, `segredo-de-teste-0123456789abcdef`, é **fictício**. O segredo real dos dispositivos nunca entra em documento, vetor ou repositório (ver [PROVISIONAMENTO.md](PROVISIONAMENTO.md)).

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| [`vetores/hmac-positivos.json`](vetores/hmac-positivos.json) | 7 casos: entradas, SHA-256 do corpo, string-to-sign, assinatura esperada e cabeçalhos prontos |
| [`vetores/hmac-negativos.json`](vetores/hmac-negativos.json) | 11 casos do que o **servidor** responde a uma requisição adulterada ou fora de prazo (resultado de `verifyRequest`) |
| [`vetores/mensagens.json`](vetores/mensagens.json) | Mensagens de exemplo (`hello`, lotes de eventos, os 5 comandos, respostas de poll e hello) e o resultado da validação delas contra os schemas |

## Casos positivos

Segredo, `deviceId` `RB-01`, `sessionId` `boot-7-lq3k9z`. A coluna "Corpo" é o tamanho em **bytes UTF-8**.

| Id | Método e caminho | `X-Timestamp` | `X-Sequence` | Corpo | O que o caso pega |
|---|---|---:|---:|---:|---|
| v1-poll-corpo-vazio | `GET /device/poll` | 1790000000 | 2 | 0 | Quinta linha com o hash do vazio (`e3b0c442...b855`) |
| v2-hello | `POST /device/hello` | 1790000000 | 1 | 274 | Hello típico, primeira requisição da sessão |
| v3-events-ack | `POST /device/events` | 1790000003 | 3 | 224 | Lote com um `ack` |
| v4-events-progresso | `POST /device/events` | 1790000010 | 4 | 446 | Lote com dois eventos |
| v5-events-utf8 | `POST /device/events` | 1790000044 | 5 | 286 | Caracteres não ASCII (`—`, `á`): o hash é dos **bytes UTF-8** enviados, não do número de caracteres |
| v6-64bits | `GET /device/poll` | 2200000000 | 70000 | 0 | Timestamp acima de 2^31 e sequência acima de 2^16: pega `int32` com sinal ou `uint16` |
| v7-query-string | `GET /device/poll?x=1` | 1790000100 | 6 | 0 | O caminho entra **com a query**, como enviado |

Exemplo completo (v1):

```
string-to-sign (5 linhas, LF, sem LF no fim):
GET
/device/poll
1790000000
2
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

X-Signature = 934f5cf363f5a475a68427519c51b24e9d56fc8b124609d8fd96d4706287c92e
```

As assinaturas dos outros seis casos estão no JSON (`signatureHex`), junto com o corpo exato (`body`), o `bodySha256Hex` e o `stringToSign`.

## Casos negativos (comportamento do servidor)

Base: o caso `v3-events-ack`. Tolerância de relógio 120 s. Útil para testes de integração do firmware (provocar cada erro de propósito e conferir a reação descrita em [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) §9) e para entender a ordem de checagem.

| Id | Alteração | Resultado |
|---|---|---|
| n0-controle | nenhuma | aceito |
| n1-corpo-adulterado | corpo com um espaço a mais depois de assinar | `SIGNATURE_INVALID` |
| n2-segredo-errado | servidor com outro segredo | `SIGNATURE_INVALID` |
| n3-relogio-servidor-adiantado | servidor 121 s à frente do timestamp | `CLOCK_SKEW` |
| n4-relogio-dispositivo-adiantado | dispositivo 121 s à frente do servidor | `CLOCK_SKEW` |
| n4b-limite-da-tolerancia | exatamente 120 s de diferença | aceito |
| n5-replay | `X-Sequence` igual à última aceita | `REPLAY_DETECTED` |
| n6-sequencia-antiga | `X-Sequence` menor que a última aceita | `REPLAY_DETECTED` |
| n7-sem-assinatura | sem `X-Signature` | `SIGNATURE_INVALID` |
| n8-assinatura-maiuscula | assinatura em hex maiúsculo | aceito (o servidor converte) |
| n9-timestamp-decimal | `X-Timestamp: 1790000003.5` | `SIGNATURE_INVALID` |

## Como o firmware usa os vetores

1. **Teste de unidade no host/placa (marco M0).** Um sketch de teste lê `hmac-positivos.json` (ou uma cópia em constantes), monta a string-to-sign de cada caso, calcula o HMAC com `mbedtls_md` e compara com `signatureHex`. Critério: 7 de 7 idênticos. Imprima o primeiro byte diferente quando falhar.
2. **Serialização.** Para cada `body`, o firmware deve produzir **exatamente** os mesmos bytes ao serializar a mesma mensagem (mesma ordem de campos, sem espaços). Se o ArduinoJson usar outra ordem, o importante é que o firmware assine os bytes que realmente envia; a ordem só precisa bater nestes vetores se você quiser comparar byte a byte. O servidor não exige ordem.
3. **Regressão.** Rode a mesma verificação a cada mudança na camada de assinatura. O cálculo de `int64` do caso `v6` é o mais fácil de quebrar.

## Reconferir os vetores com outra ferramenta

Qualquer linguagem serve. Exemplo em Python (sem dependências):

```python
import json, hmac, hashlib
d = json.load(open('docs/agv/vetores/hmac-positivos.json', encoding='utf-8'))
for v in d['vetores']:
    h = hashlib.sha256(v['body'].encode('utf-8')).hexdigest()
    s = "\n".join([v['method'], v['path'], str(v['timestamp']), str(v['sequence']), h])
    assert hmac.new(v['secret'].encode(), s.encode(), hashlib.sha256).hexdigest() == v['signatureHex'], v['id']
print("ok")
```

## Como foram gerados

Com `contracts/dist/signing.js` (`sha256Hex`, `stringToSign`, `sign`, `buildSignedHeaders`, `verifyRequest`) e os schemas de `contracts/dist/index.js`. O script gerador é temporário e não está no repositório. Se `contracts` mudar a assinatura (`contracts/CHANGELOG.md`), gere os vetores de novo e atualize este documento.

Resultado da validação das mensagens de `mensagens.json` contra os schemas: `HelloMessageSchema`, `DeviceEventsRequestSchema` (3 lotes), `DeviceCommandMessageSchema` (5 comandos), `DeviceSyncResponseSchema` e `DeviceHelloResponseSchema`: **11 de 11 válidos**.
