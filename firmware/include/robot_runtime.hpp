// Contrato entre o codigo gerado pelo compilador RoboFlow (behavior_generated.cpp)
// e o firmware do ESP32. O firmware implementa estas funcoes (robot_runtime.cpp);
// o codigo gerado so chama o que esta declarado aqui, nunca os motores direto.
//
// Nenhuma funcao pode bloquear (sem delay()): elas rodam dentro do loop() e o
// veto de seguranca precisa continuar sendo avaliado a cada volta.
#pragma once

namespace RobotRuntime {

// Acoes. Cada uma so registra o pedido; o firmware decide quando e como executar.
void stop();
bool setSpeed(float value);  // false se o valor for recusado pelo limite fisico
void turnLeft();
void turnRight();
void continueStraight();
void signalBuzzer();
void signalLight();
void log(const char* message);
void resumeLineFollowing();  // devolve o controle ao PID de seguimento de linha

// Eventos externos. Devolve true UMA vez por sinal recebido (consome o sinal).
bool hasSignal(const char* name);

// Variaveis de contexto (ex: next_destination), preenchidas pelo firmware ao
// detectar a estacao. Variavel ausente nunca e igual a nada.
bool contextEquals(const char* key, const char* value);
bool contextKeysEqual(const char* keyA, const char* keyB);

}  // namespace RobotRuntime
