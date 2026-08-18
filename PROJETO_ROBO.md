# Projeto: AGV Seguidor de Linha Industrial com Comportamento de Estação Compilado

**Disciplina:** Linguagens Formais, Autômatos e Compiladores  
**Instituição:** [Sua Universidade]  
**Data de Criação:** Agosto 2026  
**Status:** Fase de Recrutamento e Planejamento

---

## 📋 Sumário Executivo

Este projeto integra **Compiladores com Robótica Embarcada** para criar um **AGV (Automated Guided Vehicle) seguidor de linha**, do tipo usado em fábricas e armazéns para transportar peças entre estações de trabalho.

**Dois problemas de naturezas diferentes, resolvidos em dois níveis:**

1. **Seguir a linha é controle contínuo.** Um array de sensores infravermelho lê o desvio em relação à trilha no chão e um PID no ESP32 corrige a trajetória a ~100 Hz. Isso é robótica clássica — não precisa de linguagem nenhuma, é matemática de controle.

2. **O que fazer em cada estação é lógica de negócio.** Quando o AGV encontra um marcador no chão (RFID, código de barras, ou marca reservada), ele precisa decidir: para e espera descarregar? Vira à esquerda? Sinaliza e segue? Muda de velocidade porque entrou numa zona de pedestres? **Essa lógica é escrita em RoboFlow, uma linguagem de domínio específico, e compilada para C++.**

O compilador prova propriedades de segurança do comportamento antes de gerar código — e um **sensor de proximidade com veto de hardware** garante que, mesmo que o comportamento compilado tenha um erro, o AGV não colide com nada na frente dele.

**Sem ROS 2.** Com apenas dois dispositivos trocando mensagens simples por serial (ESP32 e Raspberry Pi), um middleware de robótica multi-nó como o ROS 2 seria complexidade desnecessária — instalar Ubuntu completo, aprender DDS, tópicos, launch files, tudo isso para no fim trocar duas strings de texto por UART. O Raspberry Pi roda um script Python direto: lê a serial, consulta o comportamento compilado, escreve o comando de volta. Nada além disso.

---

## 🎯 Por Que Seguidor de Linha (e Não SLAM)

Este projeto foi escolhido no lugar de um veículo com localização visual (SLAM) por ser **o que realmente existe na indústria**:

- AGVs seguidores de linha (ou de fita magnética) são o padrão em fábricas há décadas — simples, confiáveis, baratos, previsíveis.
- O desafio interessante não está em "onde estou no espaço" (SLAM), mas em **"o que fazer neste ponto da linha"** — que é exatamente o problema que uma linguagem de comportamento resolve bem.
- É um escopo que cabe em um semestre: a malha de seguimento de linha é um PID bem conhecido; o projeto pode investir o tempo no compilador, que é o objeto de estudo da disciplina.

---

## 🎯 Objetivos

### Objetivo Geral
Desenvolver um AGV seguidor de linha cujo comportamento em cada estação é definido por um programa escrito em RoboFlow, compilado para C++ verificado, e protegido por uma camada de segurança independente em hardware.

### Objetivos Específicos

**Hardware — Seguimento de Linha:**
- Construir plataforma móvel com motores DC e tração diferencial
- Integrar array de 6-8 sensores infravermelho (reflexivos) sob o chassi
- Implementar leitura de encoders para odometria/velocidade

**Hardware — Segurança:**
- Integrar sensor de proximidade frontal (ToF/ultrassom) no ESP32
- Veto de hardware independente do Raspberry Pi

**Firmware ESP32 — Malha Rápida (~100 Hz):**
- Ler array IR continuamente, calcular erro de desvio da linha
- Controlador PID de seguimento (PWM diferencial entre rodas)
- Detectar marcadores de estação (leitura especial no array ou sensor dedicado)
- Rotina de veto: se proximidade < limite crítico, força PWM = 0, sem exceção

**Software — Decisão de Estação (Raspberry Pi):**
- Script Python (sem framework/middleware) lendo a porta serial
- Identificação de estação (RFID/QR/código de barras)
- Execução do comportamento compilado quando estação é detectada

**Compilador RoboFlow:**
- Lexer, Parser, Análise Semântica, Code Generator
- Linguagem descreve **o que fazer em cada estação**, não como seguir a linha
- Gera código Python (função por estação, chamada por um despachante simples)
- Validações: toda estação conhecida tem comportamento definido, sem ambiguidade entre regras, sem comandos que ignorem o veto de segurança

**Integração:**
- ESP32 escreve evento de estação na serial → script Python no Pi lê, consulta comportamento compilado, escreve comando de volta na serial
- Sensor de proximidade pode vetar a qualquer momento, inclusive durante execução de comportamento de estação — e essa checagem nunca passa pelo Pi

---

## 🏗️ Conceito: Dois Ritmos, Duas Responsabilidades

```
┌─ MALHA RÁPIDA (ESP32, ~100 Hz) ───────────────────┐
│                                                    │
│  Array IR → erro de desvio → PID → PWM diferencial│
│                                                    │
│  ✓ Sempre ativa, hardware simples e confiável     │
│  ✓ Não depende de lógica de alto nível            │
│  ✓ É o "trilho físico" do AGV                      │
└────────────────────────────────────────────────────┘
                        ↓
          Marcador de estação detectado
                        ↓
┌─ DECISÃO DE ESTAÇÃO (Raspberry Pi, ~5-10 Hz) ─────┐
│                                                    │
│  station_id → Comportamento Compilado (RoboFlow)  │
│      → parar / virar / esperar / sinalizar /      │
│        mudar velocidade                           │
│                                                    │
│  ✓ Aqui mora a lógica de negócio                  │
│  ✓ Compilador garante propriedades de segurança   │
└────────────────────────────────────────────────────┘
                        ↓
          Sempre filtrado por:
┌─ SEGURANÇA (ESP32, veto de hardware) ─────────────┐
│                                                    │
│  Proximidade < limite → força PWM = 0 (~20 ms)    │
│                                                    │
│  ✓ Sobrepõe qualquer comando, inclusive bugs       │
│  ✓ Funciona mesmo se Raspberry Pi travar           │
└────────────────────────────────────────────────────┘
```

**Vantagens:**
- ✅ Separação limpa: controle contínuo (matemática) vs. decisão discreta (lógica/linguagem)
- ✅ Compilador tem um propósito claro e delimitado — não precisa "resolver robótica", só "resolver o roteiro da estação"
- ✅ Sem internet ou nuvem — tudo roda local (Edge Computing)
- ✅ Segurança crítica nunca depende do software de alto nível

---

## 🔧 Arquitetura de Hardware

### Raspberry Pi — Decisão de Estação
**Responsabilidades:**
- Executar Raspberry Pi OS (Lite, sem necessidade de ambiente gráfico)
- Rodar um script Python (`station_runner.py`) em loop contínuo, sem framework
- Ler evento de estação da porta serial (formato texto simples)
- Chamar a função gerada pelo compilador correspondente ao `station_id`
- Escrever comando de volta na serial
- Logging de decisões em arquivo local (CSV ou texto)

**Especificações:**
- Processador: ARM Cortex-A72 (4 núcleos) — folgado para essa carga
- RAM: 1-2 GB já seriam suficientes; 2-4 GB dá margem confortável
- Conectividade: USB/Serial para ESP32
- Leitor de identificação de estação: módulo RFID (ex: RC522) ou câmera simples para código de barras/QR

Como não há middleware nem múltiplos processos coordenados, até um Raspberry Pi Zero 2 W seria suficiente — a escolha do modelo 4B é só por facilidade de desenvolvimento (mais fácil debugar com teclado/HDMI conectado durante o projeto).

### ESP32 — Malha Rápida + Segurança
**Responsabilidades — Seguimento de Linha (sempre ativo):**
- Ler array de 6-8 sensores IR (~100 Hz)
- Calcular erro de posição em relação à linha (posição do centroide dos sensores ativados)
- Controlador PID: ajusta PWM diferencial entre motor esquerdo e direito
- Detectar marcador de estação (padrão especial no array, ex: todos sensores ativados, ou sensor dedicado lateral)
- Escrever linha `STATION <id>` na serial quando detecta marcador

**Responsabilidades — Segurança (sempre ativo, maior prioridade):**
- Ler sensor de proximidade frontal continuamente
- Se distância < limite crítico (ex: 15 cm): força PWM = 0 imediatamente
- Veto não pode ser sobreposto por comando vindo do Raspberry Pi
- LED de aviso durante veto

**Responsabilidades — Execução de Comandos de Estação:**
- Recebe linha `CMD <ação> <parâmetros>` do Raspberry Pi via serial
- Executa respeitando sempre o veto de segurança
- Retorna ao seguimento de linha normal após concluir comando

**Especificações:**
- Processador: Dual-core Xtensa 32-bit
- Interfaces: ADC (array IR), UART (Raspberry Pi), GPIO (sensor de proximidade, LED)

### Componentes de Hardware

| Componente | Especificação | Função |
|---|---|---|
| Array de sensores IR | 6-8x TCRT5000 ou módulo pronto (ex: QTR-8A) | Leitura de linha |
| Sensor de proximidade | ToF (VL53L0X) ou ultrassom (HC-SR04) | Segurança (veto) |
| Leitor de estação | RFID RC522 ou câmera + QR/barcode | Identificação de estação |
| Motores DC | 2x com redutor, 100-200 RPM | Tração diferencial |
| Encoders | 2x ópticos/magnéticos | Odometria/velocidade |
| Ponte H | L298N ou DRV8833 | Driver de motor |
| Raspberry Pi | 4B (2-4GB) | Decisão de estação |
| ESP32 | WROOM-32 | Malha rápida + segurança |
| Bateria | LiPo 11.1V | Alimentação |

---

## 💻 Arquitetura de Software

### Protocolo Serial (Substitui Tópicos ROS 2)

Todo o software se comunica por um protocolo texto simples via UART, 115200 baud. Sem middleware, sem serialização binária, sem descoberta de nós — só linhas de texto terminadas em `\n`, fáceis de ler até no monitor serial da Arduino IDE durante debug.

**Da malha rápida (ESP32) para o Pi:**
```
STATION <id>              # marcador de estação detectado
LINE <status>              # ON_TRACK | LOST | VEERING
PROX <distance_cm>          # telemetria do sensor de proximidade
VETO <0|1>                  # estado atual do veto
ODOM <encoder_L> <encoder_R># telemetria de odometria
```

**Do Pi (script Python) para o ESP32:**
```
CMD STOP
CMD SET_SPEED <valor>
CMD TURN_LEFT
CMD TURN_RIGHT
CMD CONTINUE_STRAIGHT
CMD RESUME_LINE_FOLLOWING
```

**Resolvido inteiramente dentro do ESP32, nunca trafega na serial:**
- Veto de segurança (prioridade máxima, resolvido em firmware puro, antes de qualquer `CMD` ser aplicado ao motor)

### Script Python no Raspberry Pi (`station_runner.py`)

```python
import serial
from compiled_behavior import STATION_HANDLERS, DEFAULT_HANDLER

ser = serial.Serial('/dev/ttyUSB0', 115200, timeout=1)

def send_cmd(cmd: str):
    ser.write((cmd + '\n').encode())

while True:
    line = ser.readline().decode().strip()
    if not line:
        continue

    if line.startswith('STATION'):
        station_id = line.split(' ', 1)[1]
        handler = STATION_HANDLERS.get(station_id, DEFAULT_HANDLER)
        handler(send_cmd)   # função gerada pelo compilador para essa estação

    elif line.startswith('PROX') or line.startswith('VETO') or line.startswith('ODOM'):
        log_telemetry(line)  # grava em arquivo local para auditoria
```

Não há framework nenhum aqui — é um loop `while True` com `pyserial`. O compilador gera `compiled_behavior.py`, um dicionário `STATION_HANDLERS` mapeando `station_id` para uma função Python (uma opção equivalente é gerar C++ standalone, mas Python mantém o projeto mais simples de depurar e é suficiente para a taxa de eventos envolvida).

### O Que o Compilador RoboFlow Controla

O RoboFlow **não descreve como seguir a linha** (isso é PID, fixo em firmware). Ele descreve **o roteiro de decisão em cada estação** — o equivalente a programar os pontos de parada de uma linha de montagem.

```roboflow
// Comportamento do AGV nas estações da linha de produção

station "carga" {
    on_arrival {
        stop()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}

station "cruzamento_pedestres" {
    on_arrival {
        set_speed(0.15)   // reduz velocidade na zona de pedestres
        signal_buzzer()
        resume_line_following()
    }
}

station "bifurcacao_A" {
    on_arrival {
        if next_destination == "linha_2" {
            turn_right()
        } else {
            continue_straight()
        }
        resume_line_following()
    }
}

station "descarga" {
    on_arrival {
        stop()
        wait_signal("descarga_completa", timeout: 60s)
        set_speed(default_speed)
        resume_line_following()
    }
}

// Fallback obrigatório: toda estação não reconhecida
station default {
    on_arrival {
        stop()
        log("Estação desconhecida — aguardando intervenção")
        wait_signal("manual_override", timeout: none)
    }
}
```

**O compilador recusa compilar se:**
- Alguma estação mencionada no comissionamento não tem comportamento definido (falta de completude)
- Duas regras conflitam para a mesma estação (falta de determinismo)
- Existe caminho de execução sem `resume_line_following()` ou equivalente (o AGV ficaria travado para sempre)
- Um comportamento tenta definir velocidade acima do limite físico do veículo

---

## ⚠️ Segurança: Veto de Hardware

Independente do que o comportamento compilado decidir, o sensor de proximidade frontal tem autoridade máxima:

```
Sensor de proximidade lê continuamente (~50-100 Hz)
    ↓
Distância < limite crítico (ex: 15 cm)?
    │
    ├─ SIM → VETO IMEDIATO
    │   ├─ Força PWM = 0 (independente de /station_cmd)
    │   ├─ LED de aviso
    │   └─ ~20 ms de latência
    │
    └─ NÃO → Segue executando comando normal (linha ou estação)
```

**Por que isso importa:** numa fábrica real, uma pessoa pode pisar na frente do AGV, uma caixa pode cair na trilha. O comportamento compilado pode ter um bug ou simplesmente não prever esse caso — o veto de hardware garante que isso não vira colisão.

### Fail-Safe

| Falha | Malha Rápida (ESP32) | Decisão (Pi) | Resultado |
|---|---|---|---|
| Raspberry Pi cai | ✓ Segue a linha normalmente | ✗ Cai | AGV continua na linha, mas ignora estações (para com segurança se marcador exigir decisão e não houver resposta) |
| Perde a linha (sensores não veem trilha) | Detecta `line_status = lost` | — | Para o veículo (fail-safe padrão de seguidor de linha) |
| Sensor de proximidade falha | Veto indisponível | Funciona | Risco aumentado — deve ser alarme de manutenção prioritário |
| Comunicação serial cai | ✓ Segue linha e mantém veto | ✗ Sem decisões de estação | Para no próximo marcador sem resposta, aguarda |
| Script Python trava/crasha | ✓ Segue linha e mantém veto | ✗ Cai | Idêntico ao caso "Pi cai" — sem processo supervisor por enquanto, é ponto de melhoria futura (ex: `systemd` reiniciando o script) |

---

## 📊 Desenvolvimento Incremental

### Etapa 1: Hardware Base
**Duração:** 2 semanas
- Chassi, motores, rodas, encoders montados
- Array de sensores IR fixado sob o chassi
- Sensor de proximidade frontal instalado

### Etapa 2: Firmware ESP32 — Seguimento de Linha
**Duração:** 2-3 semanas
- Leitura do array IR e cálculo de erro de desvio
- Controlador PID ajustado (tuning) para seguir linha em curvas e retas
- Testes em pista de teste (fita preta em piso claro, ou linha branca em piso escuro)

### Etapa 3: Firmware ESP32 — Segurança e Detecção de Estação
**Duração:** 1-2 semanas
- Veto de proximidade implementado e testado (latência < 20 ms)
- Detecção de marcador de estação
- Publicação de `/station_event` via serial

### Etapa 4: Script Python + Identificação de Estação
**Duração:** 1 semana
- `station_runner.py` lendo/escrevendo a serial do ESP32
- Leitor RFID/QR integrado, mapeamento `station_id` → nome da estação
- Logging de telemetria em arquivo local

### Etapa 5: Compilador RoboFlow — Infraestrutura
**Duração:** 2-3 semanas
- Lexer, Parser, AST para a gramática de `station { on_arrival { ... } }`
- Tabela de símbolos, tipos de dados

### Etapa 6: Compilador RoboFlow — Análise Semântica
**Duração:** 2 semanas
- Validação de completude (toda estação usada tem comportamento)
- Validação de determinismo (sem regras conflitantes)
- Validação de terminação (todo caminho retoma o seguimento de linha)

### Etapa 7: Compilador RoboFlow — Geração de Código
**Duração:** 2 semanas
- Gera `compiled_behavior.py` (dicionário `station_id` → função)
- Testes de código gerado com estações simuladas (sem hardware, só serial mockada)

### Etapa 8: Integração e Testes de Pista
**Duração:** 2 semanas
- Pista de teste com múltiplas estações reais
- Testes de fail-safe (obstáculo, perda de linha, Pi desligado)
- Medição de latência do veto
- Documentação final e demonstração

**Cronograma Total:** 4 meses (uma etapa a menos e mais rápida que com ROS 2)

---

## 🛠️ Stack Tecnológico

| Camada | Tecnologia | Justificativa |
|---|---|---|
| SO Embarcado | Raspberry Pi OS Lite | Leve, sem necessidade de ambiente gráfico ou ROS |
| Comunicação | Serial (UART, texto simples) via `pyserial` | Suficiente para a taxa de eventos, fácil de depurar |
| Firmware | C/C++ (ESP32, Arduino ou ESP-IDF) | Controle em tempo real |
| Compilador | Python (implementação do RoboFlow) | Prototipagem ágil do lexer/parser |
| Código gerado | Python (funções por estação) | Simplicidade — sem etapa extra de compilação C++/linking no Pi |
| Runtime no Pi | Script Python (`station_runner.py`) | Sem framework — um loop de leitura/despacho |
| Identificação de estação | RFID (RC522) ou visão simples (OpenCV) | Baixo custo, confiável |

**Nota sobre a escolha Python vs. C++ no código gerado:** como o Raspberry Pi só processa eventos de estação (baixa frequência, ~1 evento a cada alguns segundos), não há ganho de performance relevante em gerar C++ compilado. Python é mais simples de gerar, testar e depurar, e mantém o foco do projeto no compilador em si — não em toolchain de build C++.

---

## 👥 Perfis Procurados

**Eletrônica e Hardware:** motores DC, array de sensores IR, montagem de chassi  
**Programação Embarcada:** C/C++, ESP32, controle PID, interrupções  
**Robótica/Integração:** Python, comunicação serial, protocolos simples  
**Linguagens e Compiladores:** lexer/parser, análise semântica, geração de código

Não é necessário dominar tudo — o importante é disposição para aprender.

---

## ✅ Critérios de Sucesso (MVP)

- [ ] AGV segue a linha de forma estável em pista com curvas
- [ ] AGV reconhece marcadores de estação corretamente
- [ ] Comportamento compilado executa a ação correta em cada estação
- [ ] Sensor de proximidade para o veículo antes de colidir, mesmo com comportamento compilado tentando mover
- [ ] Compilador recusa compilar comportamento incompleto ou ambíguo
- [ ] Tudo funciona offline

---

## 🚀 Aplicações Práticas

Este é exatamente o modelo usado em:
- AGVs de piso de fábrica (transporte de peças entre estações de montagem)
- Carrinhos de armazém em rota fixa
- Linhas de produção com pontos de decisão (desviar para linha A ou B conforme destino)

---

**Última atualização:** Agosto 2026
