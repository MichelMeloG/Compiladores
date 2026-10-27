# Relação com a linguagem RoboFlow e o compilador

**Nada nesta pasta propõe mudança na gramática, no lexer, no parser, na AST ou nos exemplos `.rf`.** Esta página só registra como o trabalho do carrinho se encaixa no que o compilador deve entregar e quais perguntas a equipe do compilador precisa responder.

## 1. O que continua sendo do compilador

Conforme `compiler/DOCUMENTACAO_COMPILADOR_ROBOFLOW.md` §13 e §14:

| Responsabilidade | Situação |
|---|---|
| Ler `.rf`, gerar tokens e AST | Existe (lexer, parser, AST) |
| Análise semântica, representação intermediária e gerador | A implementar |
| Entregar **um único sketch `.ino` completo** para copiar na Arduino IDE | A implementar |
| `setup()` com motores desligados; `loop()` não bloqueante; função única de saída de motor com supervisor | A implementar (templates) |
| Perfil de hardware (pinos, divisor do ECHO, PWM) | Definido em `docs/ARQUITETURA_DOS_COMPONENTES.md` |

O que **não** é do compilador: planejar rotas, traduzir `(x,y)` em `F/T/D/E`, métricas, alertas, persistência. Isso é do backend, já implementado e implantado (ver [README.md](README.md)).

## 2. Como o cliente de nuvem entraria no sketch gerado

Pelo documento do compilador (§14.1, §14.3), o sketch final combina **templates fixos** (drivers, comunicação, executor) com código derivado da AST. O cliente de nuvem descrito em [FIRMWARE_ESP32.md](FIRMWARE_ESP32.md) é exatamente o tipo de módulo que se encaixa como **template de comunicação**:

| Módulo do firmware | Natureza | Onde vive no sketch gerado |
|---|---|---|
| `wifi`, `clock`, `tls`, `http`, `sign`, `proto`, `evtq`, `session` | Fixo, independente do programa `.rf` | Template de comunicação |
| `sensors`, `crossing`, `motor`, `supervisor`, `watchdog` | Fixo | Templates de drivers e de segurança |
| `executor` (fila de ações `F/D/E/T` recebida) | Fixo | Template de runtime; **a rota nunca é fixada no sketch** |
| Reações por evento (o que fazer ao chegar a uma estação) | Derivado do `.rf` | Código gerado pela AST |
| Segredo do dispositivo, Wi-Fi, host | Configuração | NVS; **não** entram no sketch nem no repositório |

Consequências para o gerador, sem mexer na linguagem:

- O sketch gerado precisa trazer as raízes de certificado públicas (GTS R1 a R4) como constantes, mas **nunca** segredos (item 8 do §14.3 do compilador).
- A configuração de transporte deve ser lida da NVS, com campos claramente identificados; um sketch de provisionamento separado grava esses campos ([PROVISIONAMENTO.md](PROVISIONAMENTO.md)).
- O protocolo é versionado (`protocolVersion` no `hello`, hoje 1). O gerador deve fixar a versão que implementa.

## 3. Divergências entre a documentação do compilador e o que existe agora

| Documento do compilador diz | Estado atual | Vale |
|---|---|---|
| §14.5: "Proposta inicial de transporte: serial USB" | ADR 0001: HTTPS por poll ao Cloud Run | HTTPS por poll |
| §13.2: três sensores de linha (GPIO 32, 34, 33) | `docs/ARQUITETURA_DOS_COMPONENTES.md` já inclui um IR adicional no GPIO 35 | O documento de hardware; o papel do quarto sensor está indefinido |
| §14.5: "handshake... confirmação... mensagens de progresso" | Protocolo concreto em `contracts/` e [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) | O protocolo de `contracts/` |
| Plano antigo: heartbeat e autorização contínua | Removidos (ADR 0002) | Política de perda de comunicação do ADR 0002 |

## 4. Perguntas em aberto para a equipe do compilador

1. **`wait_signal` e `AGUARDANDO_ESTACAO`.** A linguagem prevê esperar um sinal numa estação, mas o protocolo da nuvem não tem estado nem mensagem para isso (os estados são `initializing`, `ready`, `running`, `blocked`, `paused`, `finished`, `fault`). Quando existir, como esse estado é visto pela nuvem (`paused`? `blocked` com um motivo novo?) e quem libera? Qualquer resposta que adicione um estado ou motivo exige mudança em `contracts/`.
2. **Origem do sinal.** `wait_signal("carga_completa", ...)` precisa de uma fonte; hoje não há. O backend poderia emiti-lo como comando novo? Isso é decisão conjunta de contrato.
3. **Estações e nós.** O backend associa a posição lógica `(x,y)` a estações cadastradas no mapa (`kind: "station"`), mas o ESP32 não conhece nomes. Como o `.rf` (`station "carga"`) se liga a um nó do mapa sem o sketch conhecer coordenadas? O backend poderia incluir o nome da estação em cada ação do `load_route`?
4. **`signal_light` e `signal_buzzer`.** Não há LED nem buzzer externo; o documento diz que viram avisos visuais na dashboard. Como o sketch gerado os relata? Como evento `fault` `warning`? Como um tipo de evento novo (mudança de contrato)?
5. **`log(...)`.** Há tipo de evento para texto livre? Hoje o evento mais próximo é `fault` com `severity: warning` (código e mensagem curtos). Precisa de um evento de log dedicado?
6. **`set_speed`.** Deve definir PWM, não velocidade. Qual escala e quais limites o compilador impõe, dado que a faixa útil de PWM depende de medição ([PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md) §7)?
7. **`turn_left`, `turn_right`, `continue_straight`, `resume_line_following`.** Convivem com a fila `F/D/E/T` recebida? O backend é quem decide curvas por rota; o que o `.rf` pode comandar localmente sem violar a regra de que cada ação termina em um cruzamento?
8. **Um sensor IR adicional (GPIO 35).** O perfil de hardware do compilador (§13.2) precisa dele? Depende da decisão em [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md) §3.
9. **Dependências e versão do core.** O §14.3 pede informar as dependências e a versão do core ESP32 validadas. Este trabalho sugere Arduino-ESP32 3.x, ArduinoJson 7.x e um esquema de partição com mais espaço; precisa de confirmação na primeira compilação real.
