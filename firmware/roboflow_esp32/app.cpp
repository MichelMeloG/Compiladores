#include "app.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <soc/gpio_struct.h>
#include <time.h>
#include "controller.h"
#include "signing.h"
#include "trust_roots.h"

using roboflow::Controller;
using roboflow::Sensors;
using std::string;

namespace {
Controller* rover = nullptr;
SemaphoreHandle_t stateLock;
QueueHandle_t commands;
struct Inbox { uint32_t receivedAt; char json[4096]; };
String wifiName, wifiPass, deviceId, deviceSecret, baseUrl;
String serialInput;
bool provisioning = false;
volatile bool emergency = false;
volatile uint32_t controlBeat = 0;
hw_timer_t* guardTimer = nullptr;
portMUX_TYPE echoLock = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t echoRise = 0, echoWidth = 0;
volatile bool echoReady = false, echoArmed = false, echoHighSeen = false;
uint32_t lastTrigger = 0, triggerUs = 0;
bool waitingEcho = false;
Sensors sensors;
int previousLeft = 999, previousRight = 999;

struct Lock {
  Lock() { xSemaphoreTake(stateLock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(stateLock); }
};

void ARDUINO_ISR_ATTR echoChanged() {
  uint32_t now = micros();
  portENTER_CRITICAL_ISR(&echoLock);
  if (echoArmed) {
    if (digitalRead(ECHO)) { echoRise = now; echoHighSeen = true; }
    else if (echoHighSeen) { echoWidth = now - echoRise; echoReady = true; echoArmed = false; }
  }
  portEXIT_CRITICAL_ISR(&echoLock);
}

void ARDUINO_ISR_ATTR guardMotors() {
  if (uint32_t(xTaskGetTickCountFromISR() - controlBeat) > pdMS_TO_TICKS(200)) {
    emergency = true;
    // Os EN usam LEDC; cortar os quatro IN também elimina o acionamento.
    GPIO.out_w1tc = (1UL << IN1_ESQ) | (1UL << IN2_ESQ) | (1UL << IN1_DIR) | (1UL << IN2_DIR);
  }
}

void motor(uint8_t en, uint8_t a, uint8_t b, int pwm, bool inverted, int& previous) {
  pwm = constrain(pwm, -255, 255);
  if (emergency) pwm = 0;
  if (pwm == previous) return;
  if (previous != 999 && previous != 0 && pwm != 0 && (previous > 0) != (pwm > 0)) {
    analogWrite(en, 0); delayMicroseconds(150);
  }
  if (!pwm) { analogWrite(en, 0); digitalWrite(a, LOW); digitalWrite(b, LOW); }
  else {
    bool forward = (pwm > 0) != inverted;
    digitalWrite(a, forward ? HIGH : LOW); digitalWrite(b, forward ? LOW : HIGH);
    analogWrite(en, abs(pwm));
  }
  previous = pwm;
}

void motors(int left, int right) {
  motor(EN_ESQ, IN1_ESQ, IN2_ESQ, left, INVERTER_ESQ, previousLeft);
  motor(EN_DIR, IN1_DIR, IN2_DIR, right, INVERTER_DIR, previousRight);
}

void readSensors(uint32_t now) {
  for (int i = 0; i < 3; ++i) sensors.line[i] = digitalRead(LINHA_PINS[i]) == NIVEL_PRETO;
  uint32_t width = 0;
  bool ready;
  portENTER_CRITICAL(&echoLock);
  ready = echoReady;
  if (ready) { width = echoWidth; echoReady = false; }
  portEXIT_CRITICAL(&echoLock);
  if (waitingEcho && (ready || uint32_t(micros() - triggerUs) >= ULTRA_TIMEOUT_US)) {
    waitingEcho = false;
    portENTER_CRITICAL(&echoLock); echoArmed = false; portEXIT_CRITICAL(&echoLock);
    sensors.distanceValid = ready && width >= 100 && width <= ULTRA_TIMEOUT_US;
    sensors.distanceCm = sensors.distanceValid ? width * 0.0343f / 2.0f : 0;
    sensors.distanceAt = now; ++sensors.sampleNumber;
  }
  if (!waitingEcho && uint32_t(now - lastTrigger) >= ULTRA_INTERVALO_MS) {
    lastTrigger = now; triggerUs = micros(); waitingEcho = true;
    portENTER_CRITICAL(&echoLock);
    echoArmed = true; echoReady = false; echoHighSeen = false;
    portEXIT_CRITICAL(&echoLock);
    digitalWrite(TRIG, LOW); delayMicroseconds(2);
    digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  }
}

bool validConfiguration(JsonDocument& d) {
  string url = roboflow::str(d["url"]);
  return roboflow::id(d["devid"]) && d["ssid"].is<const char*>() && strlen(d["ssid"]) > 0 &&
    strlen(d["ssid"]) <= 32 && d["wpass"].is<const char*>() && strlen(d["wpass"]) <= 64 &&
    d["secret"].is<const char*>() && strlen(d["secret"]) >= 16 && strlen(d["secret"]) <= 256 &&
    (url.rfind("https://", 0) == 0 || (ALLOW_LOCAL_HTTP && url.rfind("http://", 0) == 0)) &&
    url.find('?', 0) == string::npos && url.find('#', 0) == string::npos;
}

void provisionLine() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (serialInput.length() < 1200) serialInput += c;
      else serialInput = "INVALID";
      continue;
    }
    JsonDocument d;
    auto error = deserializeJson(d, serialInput);
    serialInput = ""; // não imprimir SSID, senha ou segredo
    if (error || !validConfiguration(d)) {
      Serial.println("Configuracao invalida. Envie JSON com ssid,wpass,devid,secret,url."); continue;
    }
    Preferences p; p.begin("roboflow", false);
    bool ok = p.putString("ssid", d["ssid"].as<const char*>()) > 0;
    p.putString("wpass", d["wpass"].as<const char*>());
    ok &= p.putString("devid", d["devid"].as<const char*>()) > 0;
    ok &= p.putString("secret", d["secret"].as<const char*>()) > 0;
    String url = d["url"].as<const char*>(); while (url.endsWith("/")) url.remove(url.length() - 1);
    ok &= p.putString("url", url) > 0;
    p.end();
    Serial.println(ok ? "Configuracao salva. Reiniciando." : "Falha ao salvar NVS.");
    if (ok) { delay(100); ESP.restart(); }
  }
}

// Stream limitado: HTTPClient retira chunked; nunca acumular resposta ilimitada.
class BoundedBody : public Stream {
 public:
  String body;
  bool overflow = false;
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t* p, size_t n) override {
    if (body.length() + n > 8192) { overflow = true; return 0; }
    if (!body.concat(reinterpret_cast<const char*>(p), n)) { overflow = true; return 0; }
    return n;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};

bool enqueue(JsonVariantConst obj, uint32_t now) {
  Inbox msg{}; msg.receivedAt = now;
  if (measureJson(obj) >= sizeof(msg.json)) return false;
  serializeJson(obj, msg.json, sizeof(msg.json));
  return xQueueSend(commands, &msg, 0) == pdTRUE;
}

void networkTask(void*) {
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.setAutoReconnect(true);
  WiFi.begin(wifiName.c_str(), wifiPass.c_str());
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  WiFiClientSecure secure;
  WiFiClient plain;
  secure.setCACert(ROOT_CAS); secure.setHandshakeTimeout(10);
  HTTPClient http;
  http.setReuse(true); http.setConnectTimeout(10000); http.setTimeout(15000);
  uint32_t requestSeq = 0, nextAt = 0, backoff = 1000, reconnectAt = 0;
  uint32_t nextTelemetry = 0, pollMs = 30000;
  bool sessionOpen = false;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(20));
    uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED) {
      if (uint32_t(now - reconnectAt) > 10000) { reconnectAt = now; WiFi.reconnect(); }
      continue;
    }
    if (time(nullptr) < 1700000000 || int32_t(now - nextAt) < 0) continue;
    string body, path, method;
    bool telemetryDue = int32_t(now - nextTelemetry) >= 0;
    {
      Lock lock;
      if (!sessionOpen) { body = roboflow::encode(rover->hello(now)); path = "/device/hello"; }
      else if (rover->pendingCount() || telemetryDue) { body = rover->batch(now, telemetryDue); path = "/device/events"; }
      else path = "/device/poll";
    }
    method = body.empty() ? "GET" : "POST";
    string timestamp = std::to_string(static_cast<long long>(time(nullptr)));
    string signature = roboflow::signRequest(deviceSecret.c_str(), method, path, timestamp, ++requestSeq, body);
    String url = baseUrl + path.c_str();
    bool begun = signature.size() == 64 && (baseUrl.startsWith("https://") ? http.begin(secure, url) :
                  (ALLOW_LOCAL_HTTP && http.begin(plain, url)));
    int status = -1;
    BoundedBody response;
    if (begun) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-Device-Id", deviceId); http.addHeader("X-Session-Id", rover->session.c_str());
      http.addHeader("X-Sequence", String(requestSeq)); http.addHeader("X-Timestamp", timestamp.c_str());
      http.addHeader("X-Signature", signature.c_str());
      status = method == "GET" ? http.GET() : http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(body.data())), body.size());
      if (status > 0 && (http.getSize() > 8192 || http.writeToStream(&response) < 0)) status = -2;
      http.end();
    }
    now = millis();
    JsonDocument parsed;
    auto parseError = deserializeJson(parsed, response.body);
    JsonObjectConst data = parsed["data"].as<JsonObjectConst>();
    bool ok = status == 200 && !parseError && !response.overflow && parsed["success"] == true &&
      roboflow::str(data["sessionId"]) == rover->session && data["ackedSequence"].is<uint32_t>() &&
      data["nextPollMs"].is<uint32_t>() && data["commands"].is<JsonArrayConst>();
    if (ok) {
      bool wasClosed = !sessionOpen;
      sessionOpen = true; backoff = 1000;
      pollMs = constrain(data["nextPollMs"].as<uint32_t>(), 1000U, 60000U);
      {
        Lock lock;
        rover->synchronized(now);
        rover->acknowledge(data["ackedSequence"].as<uint32_t>());
      }
      if ((data["resync"] | false) || (data["reconcileRequired"] | false) || (wasClosed && requestSeq > 1)) {
        JsonDocument sync; sync["type"] = "__snapshot";
        enqueue(sync.as<JsonVariantConst>(), now);
      }
      for (JsonObjectConst c : data["commands"].as<JsonArrayConst>()) {
        // Fila cheia: não confirmar; o backend reenviará o mesmo messageId.
        if (!enqueue(c, now)) break;
      }
      if (data["rejected"].is<JsonArrayConst>() && data["rejected"].size()) {
        Serial.println("Servidor recusou evento; parando para reconciliar.");
        JsonDocument sync; sync["type"] = "__snapshot"; enqueue(sync.as<JsonVariantConst>(), now);
      }
      nextTelemetry = now + pollMs;
      // Eventos críticos podem antecipar o poll, mas mantemos até 2 requests/s.
      nextAt = now + 500;
    } else {
      Serial.printf("Rede: HTTP %d (%s). Nova tentativa em %lu ms.\n", status,
                    parsed["error"].as<const char*>() ? parsed["error"].as<const char*>() : "transporte/JSON", (unsigned long)backoff);
      string error = roboflow::str(parsed["error"]);
      if (error == "CONFLICT_SESSION") sessionOpen = false;
      if (error == "CLOCK_SKEW") configTime(0, 0, "pool.ntp.org", "time.google.com");
      if (error == "REPLAY_DETECTED") requestSeq += 1000;
      if (status == 400 || status == 413 || status == 422) {
        JsonDocument fatal; fatal["type"] = "__protocol_fault"; enqueue(fatal.as<JsonVariantConst>(), now);
      }
      nextAt = now + backoff + esp_random() % 250;
      backoff = std::min<uint32_t>(backoff * 2, 30000);
    }
    // Se nada precisa sair, esperar o prazo ditado pelo servidor.
    if (ok) {
      for (;;) {
        vTaskDelay(pdMS_TO_TICKS(25));
        now = millis();
        bool pending;
        { Lock lock; pending = rover->pendingCount() != 0; }
        if ((pending && int32_t(now - nextAt) >= 0) || int32_t(now - nextTelemetry) >= 0) break;
      }
    }
  }
}
} // namespace

void setupRoboFlow() {
  for (uint8_t p : {EN_ESQ, EN_DIR, IN1_ESQ, IN2_ESQ, IN1_DIR, IN2_DIR}) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  motors(0, 0);
  for (uint8_t p : LINHA_PINS) pinMode(p, INPUT);
  pinMode(TRIG, OUTPUT); digitalWrite(TRIG, LOW); pinMode(ECHO, INPUT);
  attachInterrupt(digitalPinToInterrupt(ECHO), echoChanged, CHANGE);
  Serial.begin(115200);
  Serial.println("RoboFlow ESP32. Digite config nos proximos 5 s para configurar (motores parados).");
  uint32_t until = millis() + 5000;
  while (int32_t(millis() - until) < 0) {
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\n') { serialInput.trim(); if (serialInput == "config") provisioning = true; serialInput = ""; }
      else if (serialInput.length() < 32) serialInput += c;
    }
    delay(10);
  }
  Preferences p; p.begin("roboflow", false);
  wifiName = p.getString("ssid"); wifiPass = p.getString("wpass"); deviceId = p.getString("devid");
  deviceSecret = p.getString("secret"); baseUrl = p.getString("url");
  uint32_t boot = p.getUInt("boot", 0) + 1; p.putUInt("boot", boot); p.end();
  if (wifiName.isEmpty() || deviceId.isEmpty() || deviceSecret.length() < 16 ||
      (!baseUrl.startsWith("https://") && !(ALLOW_LOCAL_HTTP && baseUrl.startsWith("http://")))) provisioning = true;
  if (provisioning) {
    Serial.println("Envie uma linha JSON: ssid,wpass,devid,secret,url. Credenciais nao serao impressas."); return;
  }
  char sid[48]; snprintf(sid, sizeof(sid), "boot-%lu-%08lx%08lx", (unsigned long)boot, (unsigned long)esp_random(), (unsigned long)esp_random());
  rover = new Controller(deviceId.c_str(), sid);
  stateLock = xSemaphoreCreateMutex(); commands = xQueueCreate(4, sizeof(Inbox));
  if (!stateLock || !commands) { emergency = true; Serial.println("Falha de memoria."); return; }
  // Autoteste HMAC com vetor do contrato, sem usar segredo do dispositivo.
  if (roboflow::signRequest("segredo-de-teste-0123456789abcdef", "GET", "/device/poll", "1790000000", 2, "") !=
      "934f5cf363f5a475a68427519c51b24e9d56fc8b124609d8fd96d4706287c92e") {
    emergency = true; Serial.println("Autoteste HMAC falhou."); return;
  }
  controlBeat = xTaskGetTickCount();
  guardTimer = timerBegin(1000000);
  if (!guardTimer) { emergency = true; return; }
  timerAttachInterrupt(guardTimer, guardMotors); timerAlarm(guardTimer, 50000, true, 0);
  esp_task_wdt_config_t wd = { .timeout_ms = 1000, .idle_core_mask = 0, .trigger_panic = true };
  if (esp_task_wdt_init(&wd) == ESP_ERR_INVALID_STATE) esp_task_wdt_reconfigure(&wd);
  esp_task_wdt_add(nullptr);
  if (xTaskCreatePinnedToCore(networkTask, "roboflow-net", 16384, nullptr, 1, nullptr, 0) != pdPASS) emergency = true;
  Serial.printf("Dispositivo %s, sessao %s. Aguardando backend.\n", deviceId.c_str(), sid);
}

void loopRoboFlow() {
  if (provisioning) { motors(0, 0); provisionLine(); delay(10); return; }
  if (!rover || !stateLock || !commands) { motors(0, 0); delay(10); return; }
  uint32_t now = millis();
  readSensors(now);
  {
    Lock lock;
    // Amostra atual antes de admitir start/resume; motores só escritos ao final.
    rover->sensors = sensors;
    Inbox incoming;
    while (xQueueReceive(commands, &incoming, 0) == pdTRUE) {
      JsonDocument d;
      if (deserializeJson(d, incoming.json)) { rover->fail("MALFORMED_COMMAND", now); continue; }
      string type = roboflow::str(d["type"]);
      if (type == "__snapshot") rover->reconcile(now);
      else if (type == "__protocol_fault") rover->fail("PROTOCOL_ERROR", now);
      else rover->apply(d.as<JsonObjectConst>(), incoming.receivedAt, now);
    }
    if (emergency) rover->fail("CONTROL_WATCHDOG", now);
    rover->tick(sensors, now);
    motors(rover->left, rover->right);
  }
  controlBeat = xTaskGetTickCount(); esp_task_wdt_reset();
  static TickType_t wake = xTaskGetTickCount();
  vTaskDelayUntil(&wake, pdMS_TO_TICKS(CONTROLE_MS));
}
