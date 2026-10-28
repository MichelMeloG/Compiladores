#pragma once
#include <stdint.h>

// Pinagem e polaridade do codigoteste.ino. 1 na telemetria significa PRETO.
constexpr uint8_t EN_ESQ = 25, IN1_ESQ = 26, IN2_ESQ = 27;
constexpr uint8_t EN_DIR = 13, IN1_DIR = 14, IN2_DIR = 23;
constexpr uint8_t LINHA_PINS[3] = {32, 34, 33};
constexpr uint8_t NIVEL_PRETO = 1;
constexpr bool INVERTER_ESQ = false, INVERTER_DIR = false;
constexpr uint8_t TRIG = 18, ECHO = 19;
constexpr uint32_t CONTROLE_MS = 10, ULTRA_INTERVALO_MS = 70;
constexpr uint32_t ULTRA_TIMEOUT_US = 25000;

// Valores iniciais, NÃO uma calibração física. Ajuste com o robô na pista.
struct MotionSettings {
  int straight = 200;
  int inner = 155;
  int outer = 255;
  int correctionReverse = 180;
  int turnPwm = 180;
  uint32_t centerBeforeTurnMs = 120;  // avanço para levar o eixo ao cruzamento
  uint32_t turnMinimumMs = 180;      // ignora a linha original durante o giro
  uint32_t turnTimeoutMs = 2500;
  uint32_t leaveTimeoutMs = 3000;
  uint32_t actionTimeoutMs = 15000;
  uint32_t minimumSegmentMs = 180;
  uint8_t stableSamples = 4;         // 4 amostras de 10 ms
  bool crossingRequiresCenter = false; // false: 101 ou 111; true: só 111
  float stopCm = 20, clearCm = 25;
  uint8_t clearReadings = 3;
  uint32_t sensorMaxAgeMs = 200;
  bool ultrasonicRequired = false; // pedido do usuário: sem eco não bloqueia
  uint32_t communicationHoldMs = 30000;
};

// HTTP sem TLS somente para backend local de bancada, explicitamente habilitado.
constexpr bool ALLOW_LOCAL_HTTP = false;
