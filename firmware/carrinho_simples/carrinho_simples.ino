// ESP32: lê sensores, envia ao backend local e aplica a saída dos motores.
// Dependências: pacote ESP32 e biblioteca ArduinoJson 7 na Arduino IDE.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char *SSID = "SUA_REDE", *SENHA = "SUA_SENHA";
const char *URL = "http://192.168.1.10:8080/device/sensors";
const char *ROBO = "RB-01", *TOKEN = "SEGREDO_CADASTRADO_NO_BACKEND";
const int MOTOR_E[3] = {25, 26, 27};  // EN, IN1, IN2
const int MOTOR_D[3] = {13, 14, 23};
const int SENSORES[3] = {32, 34, 33}; // Esquerda, centro, direita; HIGH = ativo.
String boot;
unsigned long sequencia = 0, aplicada = 0;

void motor(const int pinos[3], int potencia) {
  potencia = constrain(potencia, -255, 255);
  analogWrite(pinos[0], 0);
  digitalWrite(pinos[1], potencia > 0);
  digitalWrite(pinos[2], potencia < 0);
  analogWrite(pinos[0], abs(potencia));
}

void mover(int esquerda, int direita) {
  motor(MOTOR_E, esquerda);
  motor(MOTOR_D, direita);
}

void setup() {
  for (int i = 0; i < 3; i++) {
    pinMode(MOTOR_E[i], OUTPUT); pinMode(MOTOR_D[i], OUTPUT);
    pinMode(SENSORES[i], INPUT);
  }
  mover(0, 0);
  boot = String(esp_random(), HEX) + String(esp_random(), HEX);
  WiFi.setAutoReconnect(true);
  WiFi.begin(SSID, SENHA);
}

void loop() {
  mover(0, 0); // Fica parado enquanto aguarda uma resposta nova do backend.
  if (WiFi.status() == WL_CONNECTED) {
    JsonDocument dados;
    for (int pino : SENSORES) dados["line"].add(digitalRead(pino) == HIGH ? 1 : 0);
    dados["boot"] = boot;
    dados["sequence"] = ++sequencia;
    dados["applied"] = aplicada;
    String corpo;
    serializeJson(dados, corpo);

    WiFiClient cliente;
    HTTPClient http;
    http.setConnectTimeout(250); http.setTimeout(250);
    if (http.begin(cliente, URL)) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-Device-Id", ROBO);
      http.addHeader("Authorization", String("Bearer ") + TOKEN);
      int status = http.POST(corpo);
      JsonDocument resposta;
      if (status == 200 && !deserializeJson(resposta, http.getString()) &&
          resposta["success"] == true && resposta["data"]["sequence"] == sequencia &&
          resposta["data"]["left"].is<int>() && resposta["data"]["right"].is<int>()) {
        mover(resposta["data"]["left"], resposta["data"]["right"]);
        aplicada = sequencia;
      }
    }
    http.end();
  }
  delay(50);
}
