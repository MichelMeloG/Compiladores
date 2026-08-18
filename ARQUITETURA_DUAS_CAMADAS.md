# Arquitetura de Segurança: Veto de Hardware Independente da Decisão de Estação

**Documento Técnico Detalhado**  
**Versão:** 2.0 (Seguidor de Linha Industrial)  
**Data:** Agosto 2026

---

## 📋 Resumo Executivo

O AGV tem três funções rodando em paralelo, com prioridades diferentes:

1. **Seguimento de linha** (ESP32, ~100 Hz) — controle contínuo, sempre ativo
2. **Decisão de estação** (Raspberry Pi + código compilado, sob evento) — lógica discreta, roda só quando um marcador é detectado
3. **Veto de segurança** (ESP32, ~50-100 Hz) — **maior prioridade de todas**, pode interromper as outras duas a qualquer momento

O ponto central deste documento: **o veto nunca passa pelo Raspberry Pi nem pelo código compilado**. Ele é resolvido inteiramente em firmware, no ESP32, antes de qualquer comando (seja da malha PID, seja de `/station_cmd`) chegar ao motor.

```
┌─ SEGUIMENTO DE LINHA (ESP32, contínuo) ───────────┐
│  Array IR → erro → PID → PWM diferencial          │
└─────────────────────┬──────────────────────────────┘
                      ↓
┌─ DECISÃO DE ESTAÇÃO (Pi, sob evento) ─────────────┐
│  station_id → código compilado → /station_cmd     │
└─────────────────────┬──────────────────────────────┘
                      ↓
              Ambos convergem em:
┌─ VETO DE SEGURANÇA (ESP32, sempre, prioridade máxima) ┐
│  proximidade < limite → PWM = 0, sem exceção          │
└──────────────────────────────────────────────────────┘
                      ↓
                   MOTORES
```

---

## 🏗️ Por Que o Veto Fica Fora do Raspberry Pi

Se a checagem de proximidade fosse feita em software no Raspberry Pi (ex: dentro do script `station_runner.py`, ou de qualquer "árbitro" em Python), ela herdaria todas as fragilidades do software de alto nível:

- Se o Raspberry Pi travar, congelar, ou o script Python crashar, a checagem para de rodar junto
- Se o código compilado pelo RoboFlow tiver um bug (por exemplo, o compilador falhar em detectar um caso de monotonicidade), a checagem em software poderia ser contornada
- Latência de um processo Python lendo serial (I/O bloqueante, GIL, agendamento do SO) é maior e menos previsível que uma interrupção de hardware

Colocando o veto em firmware puro, isolado logicamente de tudo que vem do Pi, ele **não pode ser desabilitado por um erro de programação em RoboFlow** — porque a linguagem RoboFlow simplesmente não tem acesso a esse circuito. Não é uma regra que o compilador precisa lembrar de aplicar; é uma limitação física do que pode ser gerado. E como não há middleware nenhum entre o ESP32 e o Pi, não existe camada extra de software onde esse veto poderia "vazar" ou ficar sujeito a bugs de serialização/mensageria.

---

## ⚙️ Implementação do Veto

### Hardware
- Sensor de proximidade (ToF ou ultrassom) frontal, ligado diretamente a pinos do ESP32
- Nenhuma dependência de comunicação serial para funcionar — o veto é resolvido inteiramente dentro do ESP32, mesmo com o cabo serial desconectado

### Firmware (prioridade de execução)

```cpp
void loop() {
    // 1. PRIMEIRO: sempre atualiza o veto, antes de qualquer outra coisa
    updateProximityAndVeto();
    
    // 2. Malha de seguimento de linha (só executa efetivamente se veto == false)
    lineFollowingLoop();
    
    // 3. Comandos vindos do Pi (também bloqueados se veto == true)
    processIncomingCommands();
    
    delay(10);
}

void setMotorPWM(int left, int right) {
    if (veto_active) {
        // Ignora completamente os valores recebidos
        actual_pwm_left = 0;
        actual_pwm_right = 0;
    } else {
        actual_pwm_left = left;
        actual_pwm_right = right;
    }
    analogWrite(MOTOR_L_PIN, actual_pwm_left);
    analogWrite(MOTOR_R_PIN, actual_pwm_right);
}
```

A função `setMotorPWM` é o único ponto de saída para os motores — tanto a malha de seguimento quanto os comandos de estação passam por ela, e ela é quem aplica o veto como filtro final, incondicional.

---

## 🔄 As Três Camadas em Detalhe

### Camada A — Seguimento de Linha (a "espinha física")

- Não tem noção de "estação" nem de "comportamento" — só sabe seguir a trilha
- Roda sempre, exceto quando um marcador de estação é detectado (nesse momento, aguarda comando) ou quando o veto está ativo
- Falha característica: perder a linha (`line_status = LOST`) → o AGV para, porque não há mais referência para o PID corrigir

### Camada B — Decisão de Estação (o "roteiro programável")

- Só entra em ação quando o ESP32 escreve `STATION <id>` na serial e o `station_runner.py` lê essa linha
- Executa a função compilada do RoboFlow correspondente àquele `station_id` (via `STATION_HANDLERS`)
- Escreve `CMD ...` de volta na serial, obedecido pelo ESP32 **se e somente se** o veto não estiver ativo
- Falha característica: Raspberry Pi cai → AGV chega numa estação, não recebe comando, e (por design do firmware) para e aguarda — nunca atravessa uma estação sem instrução

### Camada C — Veto de Segurança (o "freio de emergência")

- Não sabe o que é uma linha nem uma estação — só sabe distância
- Roda continuamente, independente do estado das outras duas camadas
- É a única camada que pode interromper as outras duas

---

## 🔬 Matriz de Falhas

| Falha | Camada A (linha) | Camada B (estação) | Camada C (veto) | Resultado |
|---|---|---|---|---|
| Tudo ok | ✓ | ✓ | ✓ (inativo) | Operação normal |
| Raspberry Pi trava | ✓ | ✗ | ✓ | AGV segue a linha, mas para em qualquer marcador de estação (sem resposta) |
| Bug no código compilado (hipotético) | ✓ | ✗ ou comportamento errado | ✓ | Pior caso: comando errado é enviado, mas veto ainda impede colisão |
| Comunicação serial cai | ✓ | ✗ | ✓ | AGV para no próximo marcador; veto continua ativo |
| Sensor de proximidade falha | ✓ | ✓ | ✗ | **Risco real** — deve gerar alarme de manutenção prioritário, não é aceitável em produção |
| Perda de linha | ✗ (para) | — | ✓ | AGV para (fail-safe da própria malha PID) |

A única falha verdadeiramente perigosa é a falha do próprio sensor de proximidade — porque aí a Camada C, que é a rede de segurança de tudo, deixa de existir. Por isso ele deve ter monitoramento de integridade (ex: heartbeat, leitura fora de faixa esperada aciona alarme) tratado como prioridade de projeto.

---

## 🧪 Testes de Validação

```cpp
TEST(Veto, LatenciaMenorQue20ms) {
    auto start = millis();
    mock_distance_cm = 10; // abaixo do limite crítico
    delay(5);
    ASSERT_TRUE(veto_active);
    ASSERT_LT(millis() - start, 20);
}

TEST(Veto, SobrepoeComandoDeEstacao) {
    veto_active = true;
    receive_command("CMD SET_SPEED 0.3");
    ASSERT_EQ(actual_pwm_left, 0);
    ASSERT_EQ(actual_pwm_right, 0);
}

TEST(Veto, SobrepoeSeguimentoDeLinha) {
    veto_active = true;
    int readings[8] = {0,0,900,900,0,0,0,0}; // linha centralizada, PID pediria movimento
    lineFollowingLoop();
    ASSERT_EQ(actual_pwm_left, 0);
    ASSERT_EQ(actual_pwm_right, 0);
}

TEST(Veto, FuncionaSemRaspberryPi) {
    // Simula Pi desconectado (sem leitura de serial)
    disconnect_serial();
    mock_distance_cm = 10;
    delay(5);
    ASSERT_TRUE(veto_active);
    ASSERT_EQ(actual_pwm_left, 0);
}
```

---

## 📚 Paralelo com Padrões Industriais

Esta separação — controle contínuo de baixo nível, decisão discreta de alto nível, e parada de emergência isolada em hardware — é o mesmo padrão usado em:

- **Categorias de parada de emergência (IEC 60204-1):** a parada de emergência de uma máquina industrial nunca depende do CLP de aplicação, é um circuito de segurança à parte
- **AGVs comerciais (ex: linhas Kiva/Amazon Robotics, Seegrid):** navegação e planejamento rodam em um computador de bordo; a parada por obstáculo é resolvida por um subsistema de segurança dedicado, com certificação própria

O projeto reproduz esse princípio em escala de protótipo acadêmico.

---

**Documento técnico complementar a PROJETO_ROBO.md.**
