# Especificações Técnicas — AGV Seguidor de Linha Industrial

**Documento Técnico Detalhado**  
**Versão:** 2.0  
**Data:** Agosto 2026

---

## 1. Especificações de Hardware

### 1.1 Computador Principal — Raspberry Pi

| Componente | Especificação |
|---|---|
| **Modelo** | Raspberry Pi 4B (2 GB é suficiente; 4 GB dá folga) |
| **Processador** | ARM Cortex-A72 (4 núcleos) @ 1.5 GHz |
| **RAM** | 2-4 GB |
| **Armazenamento** | microSD 32 GB Class 10 |
| **Alimentação** | USB-C 5V / 3A |
| **SO** | Raspberry Pi OS Lite (sem ambiente gráfico) |
| **Conectividade** | USB (ESP32), I2C/SPI (leitor RFID) |

**Por que essas specs bastam:** o Pi roda só um script Python em loop (`station_runner.py`) mais o driver do leitor de identificação — sem câmera, sem SLAM, sem middleware de robótica. A carga de CPU é trivial; o gargalo real é a latência de I/O da serial, não processamento.

### 1.2 Microcontrolador — ESP32

| Componente | Especificação |
|---|---|
| **Modelo** | ESP32-WROOM-32 |
| **Processador** | Dual Xtensa 32-bit @ 160/240 MHz |
| **RAM** | 520 KB SRAM |
| **ADC** | 12 canais, 12-bit (leitura do array IR) |
| **PWM** | 16 canais |
| **UART** | Comunicação com Raspberry Pi |

**Por que ESP32:** roda a malha de PID a 100 Hz sem esforço, tem ADC suficiente para o array de sensores IR, e mantém o veto de segurança totalmente isolado do que acontece no Raspberry Pi.

### 1.3 Array de Sensores Infravermelho

| Componente | Especificação |
|---|---|
| **Tipo** | Reflexivo, par emissor/receptor IR |
| **Módulo recomendado** | QTR-8A (Pololu) ou 8x TCRT5000 individuais |
| **Quantidade** | 6-8 sensores em linha, sob o chassi |
| **Espaçamento** | ~1.5 cm entre sensores (ajustar à largura da linha) |
| **Saída** | Analógica (QTR-8A) ou digital com potenciômetro (TCRT5000 avulso) |
| **Altura de montagem** | 3-8 mm do chão |

**Cálculo de posição da linha (centroide ponderado):**

```
posição = Σ(peso_i × leitura_i) / Σ(leitura_i)

onde peso_i = índice do sensor (0 a 7) × espaçamento
```

Erro de seguimento = `posição_medida - posição_central_esperada`. Esse erro alimenta o PID.

### 1.4 Sensor de Proximidade (Segurança)

| Componente | Especificação |
|---|---|
| **Tipo** | ToF (VL53L0X) — recomendado pela precisão em curta distância |
| **Alternativa** | Ultrassom HC-SR04 |
| **Posição** | Frontal, centralizado |
| **Range útil** | 5-50 cm |
| **Limite crítico configurado** | 15 cm (ajustável) |

### 1.5 Leitor de Identificação de Estação

**Opção A — RFID (recomendado):**
| Componente | Especificação |
|---|---|
| Módulo | RC522 (MFRC522) |
| Interface | SPI |
| Tags | Cartões/tags passivas MIFARE, uma por estação, fixadas no chão ou em suporte lateral |
| Alcance de leitura | 2-5 cm (exige antena voltada para baixo, próxima ao chão) |

**Opção B — Código de barras/QR:**
| Componente | Especificação |
|---|---|
| Sensor | Câmera USB simples + OpenCV/pyzbar |
| Marcador | QR code impresso ao lado da linha |
| Vantagem | Não precisa de tags físicas RFID, fácil de reimprimir |
| Desvantagem | Mais processamento, sensível a iluminação |

Recomendação: **RFID** para o MVP — mais confiável, menor latência, sem dependência de iluminação.

### 1.6 Motores, Encoders, Ponte H

Mesmas especificações de qualquer plataforma diferencial de pequeno porte:

| Componente | Especificação |
|---|---|
| Motores DC | 2x com redutor, 100-200 RPM, 12V |
| Encoders | 2x ópticos/magnéticos, um por roda |
| Ponte H | L298N (até 2A/canal) ou DRV8833 (mais eficiente) |
| Rodas | 2x motrizes + 1 roda castor |

### 1.7 Alimentação

```
Bateria LiPo 11.1V (3S)
    ├─ Ponte H → Motores (12V direto)
    └─ Regulador 5V
        ├─ Raspberry Pi (via USB ou pino 5V)
        ├─ ESP32 (via regulador 3.3V)
        ├─ Array de sensores IR
        └─ Leitor RFID
```

---

## 2. Comunicação Raspberry Pi ↔ ESP32

### 2.1 Protocolo Serial

```
Velocidade: 115200 baud
Formato de mensagem: <TAG> <payload>\n

ESP32 → Pi:
STATION <id> <timestamp>          // marcador de estação detectado
LINE <status>                     // ON_TRACK | LOST | VEERING
PROX <distance_cm>                // telemetria do sensor de proximidade
VETO <0|1>                        // estado atual do veto de segurança
ODOM <encoder_L> <encoder_R>      // telemetria de odometria

Pi → ESP32:
CMD STOP
CMD SET_SPEED <valor>
CMD TURN_LEFT
CMD TURN_RIGHT
CMD CONTINUE_STRAIGHT
CMD RESUME_LINE_FOLLOWING
```

**Regra de ouro do firmware:** toda `CMD` recebida do Pi passa primeiro pela checagem de veto. Se `VETO == 1`, o comando é descartado (não executado, não enfileirado) e o motor permanece em PWM = 0.

### 2.2 Lado Raspberry Pi — `station_runner.py`

```python
import serial
import csv
from datetime import datetime
from compiled_behavior import STATION_HANDLERS, DEFAULT_HANDLER

ser = serial.Serial('/dev/ttyUSB0', 115200, timeout=1)
log_file = open('decision_log.csv', 'a', newline='')
logger = csv.writer(log_file)

def send_cmd(cmd: str):
    ser.write((cmd + '\n').encode())
    logger.writerow([datetime.now().isoformat(), 'CMD_SENT', cmd])
    log_file.flush()

def main_loop():
    while True:
        line = ser.readline().decode(errors='ignore').strip()
        if not line:
            continue

        tag, *rest = line.split(' ', 1)
        payload = rest[0] if rest else ''

        if tag == 'STATION':
            station_id = payload
            logger.writerow([datetime.now().isoformat(), 'STATION', station_id])
            handler = STATION_HANDLERS.get(station_id, DEFAULT_HANDLER)
            handler(send_cmd)

        elif tag in ('PROX', 'VETO', 'LINE', 'ODOM'):
            logger.writerow([datetime.now().isoformat(), tag, payload])
            # sem ação — é só telemetria para auditoria

if __name__ == '__main__':
    main_loop()
```

Isso substitui inteiramente o que seria feito com nós e tópicos ROS 2: um processo, uma porta serial, um arquivo de log. Para rodar como serviço persistente (reiniciar sozinho se cair), basta um `systemd unit` simples — não é necessário `roslaunch` nem gerenciador de processos de robótica.

---

## 3. Firmware ESP32 — Malha de Seguimento (Pseudocódigo)

```cpp
#define NUM_SENSORS 8
#define CRITICAL_DISTANCE_CM 15
#define STATION_MARKER_THRESHOLD 7  // nº mínimo de sensores "pretos" simultâneos = marcador

int sensor_pins[NUM_SENSORS] = {32, 33, 34, 35, 36, 39, 25, 26};
volatile bool veto_active = false;

// PID
float Kp = 0.5, Ki = 0.0, Kd = 0.2;
float integral = 0, last_error = 0;
const int BASE_SPEED = 150; // PWM base (0-255)

void readLineSensors(int readings[NUM_SENSORS]) {
    for (int i = 0; i < NUM_SENSORS; i++) {
        readings[i] = analogRead(sensor_pins[i]);
    }
}

float computeLineError(int readings[NUM_SENSORS]) {
    long weighted_sum = 0;
    long sum = 0;
    for (int i = 0; i < NUM_SENSORS; i++) {
        weighted_sum += (long)readings[i] * i;
        sum += readings[i];
    }
    if (sum == 0) return last_error; // linha perdida, mantém última correção
    float position = (float)weighted_sum / sum;
    float center = (NUM_SENSORS - 1) / 2.0;
    return position - center;
}

bool detectStationMarker(int readings[NUM_SENSORS]) {
    int dark_count = 0;
    for (int i = 0; i < NUM_SENSORS; i++) {
        if (readings[i] > 800) dark_count++; // limiar de "linha detectada"
    }
    return dark_count >= STATION_MARKER_THRESHOLD;
}

void updateProximityAndVeto() {
    float distance_cm = readToFSensor();
    Serial.print("PROX "); Serial.println(distance_cm);
    
    if (distance_cm < CRITICAL_DISTANCE_CM) {
        veto_active = true;
        setMotorPWM(0, 0);
        digitalWrite(LED_PIN, HIGH);
    } else {
        veto_active = false;
        digitalWrite(LED_PIN, LOW);
    }
    Serial.print("VETO "); Serial.println(veto_active ? 1 : 0);
}

void lineFollowingLoop() {
    int readings[NUM_SENSORS];
    readLineSensors(readings);
    
    if (detectStationMarker(readings)) {
        Serial.print("STATION "); Serial.println(readRFID());
        // Aguarda comando do Pi antes de prosseguir, mas continua monitorando veto
        return;
    }
    
    float error = computeLineError(readings);
    integral += error;
    float derivative = error - last_error;
    float correction = Kp * error + Ki * integral + Kd * derivative;
    last_error = error;
    
    int left_speed = BASE_SPEED + correction;
    int right_speed = BASE_SPEED - correction;
    
    if (!veto_active) {
        setMotorPWM(constrain(left_speed, 0, 255), constrain(right_speed, 0, 255));
    } else {
        setMotorPWM(0, 0); // veto sobrepõe tudo
    }
}

void loop() {
    updateProximityAndVeto();  // sempre primeiro, maior prioridade
    lineFollowingLoop();
    processIncomingCommands(); // lê /station_cmd do Pi, mas respeita veto_active
    delay(10); // ~100 Hz
}
```

---

## 4. Requisitos de Performance

| Métrica | Alvo | Crítico |
|---|---|---|
| Latência do veto de proximidade | < 20 ms | Sim |
| Taxa da malha de seguimento (PID) | ~100 Hz | Sim |
| Taxa de leitura de proximidade | ~50-100 Hz | Sim |
| Latência de decisão de estação (Pi) | < 300 ms | Não (AGV já está parado nesse momento; script Python + I/O serial é suficientemente rápido) |
| Precisão de leitura RFID | > 99% | Sim (falha = AGV para e aguarda) |

---

## 5. Testes de Calibração

### 5.1 Tuning do PID
1. Começar só com `Kp`, ajustar até o AGV seguir reta sem oscilar
2. Adicionar `Kd` para amortecer oscilação em curvas
3. Adicionar `Ki` pequeno só se houver erro residual constante (raro em seguidor de linha)

### 5.2 Calibração do Array IR
```python
# Rotina de calibração: passar o array sobre linha e fundo
# Registrar min/max de cada sensor para normalizar leitura (0-1000)
for sensor in sensors:
    white_value = read_over_background()
    black_value = read_over_line()
    # normalizar leituras subsequentes entre esses limites
```

### 5.3 Teste do Veto
```
1. Aproximar objeto lentamente até sensor detectar < 15 cm
2. Cronometrar tempo até motor = 0
3. Esperado: < 20 ms
4. Repetir com Raspberry Pi desligado — comportamento deve ser idêntico
```

---

## 6. Checklist de Implementação

- [ ] Chassi montado com array IR calibrado
- [ ] PID ajustado, AGV segue linha reta e curvas
- [ ] Sensor de proximidade com veto testado e validado (< 20 ms, independente do Pi)
- [ ] Leitor RFID lendo tags de estação corretamente
- [ ] `station_runner.py` rodando no Pi, lendo/escrevendo serial corretamente
- [ ] Compilador RoboFlow gerando `compiled_behavior.py`
- [ ] Testes de pista com múltiplas estações reais
- [ ] Documentação e vídeo de demonstração

---

**Consulte PROJETO_ROBO.md para visão geral e LINGUAGEM_ROBO_COMPILADOR.md para a linguagem RoboFlow.**
