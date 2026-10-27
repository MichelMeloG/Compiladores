// Runtime falso + simulador de loop() para testar o C++ gerado sem hardware.
// Le comandos de stdin e imprime cada chamada que o codigo gerado faz ao runtime.
//
//   start <marcador>      startStationBehavior(stationIdFromName(marcador))
//   signal <nome>         o sinal passa a estar disponivel (consumido por hasSignal)
//   ctx <chave> <valor>   define uma variavel de contexto
//   tick <ms>             updateStationBehavior(ms) com o relogio em <ms>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>

#include "behavior_generated.hpp"
#include "robot_runtime.hpp"

namespace {
std::set<std::string> g_signals;
std::map<std::string, std::string> g_context;
}  // namespace

namespace RobotRuntime {
void stop() { std::cout << "stop\n"; }
bool setSpeed(float value) { std::cout << "setSpeed " << value << "\n"; return true; }
void turnLeft() { std::cout << "turnLeft\n"; }
void turnRight() { std::cout << "turnRight\n"; }
void continueStraight() { std::cout << "continueStraight\n"; }
void signalBuzzer() { std::cout << "signalBuzzer\n"; }
void signalLight() { std::cout << "signalLight\n"; }
void log(const char* message) { std::cout << "log " << message << "\n"; }
void resumeLineFollowing() { std::cout << "resumeLineFollowing\n"; }

bool hasSignal(const char* name) { return g_signals.erase(name) > 0; }

bool contextEquals(const char* key, const char* value) {
    auto it = g_context.find(key);
    return it != g_context.end() && it->second == value;
}

bool contextKeysEqual(const char* keyA, const char* keyB) {
    auto a = g_context.find(keyA);
    auto b = g_context.find(keyB);
    return a != g_context.end() && b != g_context.end() && a->second == b->second;
}
}  // namespace RobotRuntime

int main() {
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string command, a, b;
        in >> command >> a >> b;
        if (command == "start") {
            startStationBehavior(stationIdFromName(a.c_str()));
        } else if (command == "signal") {
            g_signals.insert(a);
        } else if (command == "ctx") {
            g_context[a] = b;
        } else if (command == "tick") {
            updateStationBehavior(std::stoul(a));
            std::cout << "-- t=" << a << " active=" << stationBehaviorActive() << "\n";
        }
    }
    return 0;
}
