#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

namespace {

constexpr char AP_SSID[] = "RoboFlow-Teste";
constexpr char AP_PASSWORD[] = "RoboFlow32";
constexpr uint8_t MOTOR_LEFT_EN = 25;
constexpr uint8_t MOTOR_LEFT_IN1 = 26;
constexpr uint8_t MOTOR_LEFT_IN2 = 27;
constexpr uint8_t MOTOR_RIGHT_IN1 = 14;
constexpr uint8_t MOTOR_RIGHT_IN2 = 23;
constexpr uint8_t MOTOR_RIGHT_EN = 13;
constexpr uint8_t LINE_PINS[] = {32, 34, 33, 35};
constexpr uint8_t ULTRASONIC_TRIG = 18;
constexpr uint8_t ULTRASONIC_ECHO = 19;
constexpr uint8_t MOTOR_PWM = 120;
constexpr uint16_t OBSTACLE_STOP_CM = 20;
constexpr uint16_t OBSTACLE_CLEAR_CM = 25;
constexpr uint8_t CLEAR_READINGS_REQUIRED = 3;
constexpr uint32_t ULTRASONIC_INTERVAL_MS = 70;
constexpr uint32_t ULTRASONIC_TIMEOUT_US = 25000;
constexpr uint32_t ULTRASONIC_STALE_MS = 250;
constexpr uint32_t COMMAND_TIMEOUT_MS = 450;

constexpr bool LEFT_MOTOR_INVERTED = false;
constexpr bool RIGHT_MOTOR_INVERTED = false;

WebServer server(80);
uint16_t lineAnalog[4] = {};
uint8_t lineDigital[4] = {};
float distanceCm = 0;
bool distanceValid = false;
bool obstacleBlocked = true;
uint8_t clearReadings = 0;
uint32_t lastUltrasonicAt = 0;
uint32_t lastCommandAt = 0;
String activeDirection = "stop";

const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste do RoboFlow</title><style>
body{font:16px system-ui;max-width:560px;margin:20px auto;padding:0 14px;background:#f4f6f8;color:#18212b}
section{background:white;padding:16px;margin:12px 0;border-radius:12px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
button{font-size:20px;padding:18px;border:0;border-radius:10px;background:#1769aa;color:white;touch-action:none}
#stop{background:#b42318;width:100%;margin-top:8px}.sensor{display:inline-block;width:48%;padding:8px 0}
.safe{color:#147d34}.blocked{color:#b42318;font-weight:bold}
</style><h2>Teste de bancada ESP32</h2>
<section><b>HC-SR04:</b> <span id="distance">lendo...</span><br><span id="safety"></span>
<p>O movimento fica bloqueado se o eco for inválido/antigo ou houver obstáculo a menos de 20 cm. Libera após 3 leituras acima de 25 cm.</p></section>
<section><b>Sensores de linha (GPIO 32, 34, 33, 35)</b><div id="sensors"></div>
<small>ADC bruto e nível digital. Para módulos digitais, use DO; para analógicos, AO. Os valores não controlam o carrinho.</small></section>
<section><b>Comando manual (mantenha pressionado)</b><div class="grid">
<button data-dir="forward">▲ Frente</button><button data-dir="left">◀ Esquerda</button>
<button data-dir="right">Direita ▶</button></div>
<button id="stop">PARAR</button><p id="state">Parado</p></section>
<script>
let timer=null, dir=null, busy=false;
async function command(d){try{const r=await fetch('/move?dir='+d,{method:'POST'});const x=await r.json();document.querySelector('#state').textContent=x.message;if(!x.moving)stopSending()}catch(e){document.querySelector('#state').textContent='Sem conexão; o temporizador local do ESP32 deve parar os motores.';stopSending()}}
function start(d){if(dir===d)return;if(timer){clearInterval(timer);timer=null}dir=d;command(d);timer=setInterval(()=>{if(!busy){busy=true;command(d).finally(()=>busy=false)}},150)}
function stopSending(){if(timer){clearInterval(timer);timer=null}dir=null;fetch('/move?dir=stop',{method:'POST'}).catch(()=>{})}
document.querySelectorAll('[data-dir]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();start(b.dataset.dir)});['pointerup','pointercancel','pointerleave'].forEach(ev=>b.addEventListener(ev,stopSending))});
document.querySelector('#stop').addEventListener('click',stopSending);
window.addEventListener('blur',stopSending);document.addEventListener('visibilitychange',()=>{if(document.hidden)stopSending()});
async function refresh(){try{const s=await(await fetch('/status')).json();
document.querySelector('#distance').textContent=s.distanceValid?s.distanceCm.toFixed(1)+' cm':'sem leitura válida';
const safe=!s.obstacleBlocked&&s.distanceFresh;document.querySelector('#safety').textContent=safe?'Liberado para teste manual':'BLOQUEADO — confira distância/eco';document.querySelector('#safety').className=safe?'safe':'blocked';
document.querySelector('#sensors').innerHTML=s.sensors.map((v,i)=>'<span class="sensor">S'+(i+1)+' GPIO '+v.gpio+': ADC '+v.analog+' / '+(v.digital?'HIGH':'LOW')+'</span>').join('');
if(s.activeDirection==='stop'&&!dir)document.querySelector('#state').textContent='Parado';
}catch(e){document.querySelector('#distance').textContent='sem conexão'}}
setInterval(refresh,200);refresh();
</script></html>
)HTML";

void stopMotors() {
  analogWrite(MOTOR_LEFT_EN, 0);
  analogWrite(MOTOR_RIGHT_EN, 0);
  digitalWrite(MOTOR_LEFT_IN1, LOW);
  digitalWrite(MOTOR_LEFT_IN2, LOW);
  digitalWrite(MOTOR_RIGHT_IN1, LOW);
  digitalWrite(MOTOR_RIGHT_IN2, LOW);
  activeDirection = "stop";
}

void setMotor(uint8_t in1, uint8_t in2, bool forward, bool inverted) {
  const bool level = forward != inverted;
  digitalWrite(in1, level ? HIGH : LOW);
  digitalWrite(in2, level ? LOW : HIGH);
}

bool ultrasonicFresh() {
  return lastUltrasonicAt != 0 &&
         millis() - lastUltrasonicAt <= ULTRASONIC_STALE_MS;
}

void updateObstacleSensor() {
  const uint32_t now = millis();
  if (now - lastUltrasonicAt < ULTRASONIC_INTERVAL_MS) return;

  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  const unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, ULTRASONIC_TIMEOUT_US);
  lastUltrasonicAt = millis();
  distanceValid = duration > 0;

  if (!distanceValid) {
    obstacleBlocked = true;
    clearReadings = 0;
    return;
  }

  distanceCm = duration * 0.0343f / 2.0f;
  if (distanceCm <= OBSTACLE_STOP_CM) {
    obstacleBlocked = true;
    clearReadings = 0;
  } else if (distanceCm >= OBSTACLE_CLEAR_CM && obstacleBlocked) {
    if (++clearReadings >= CLEAR_READINGS_REQUIRED) {
      obstacleBlocked = false;
      clearReadings = 0;
    }
  } else if (obstacleBlocked) {
    clearReadings = 0;
  }
}

void readLineSensors() {
  for (uint8_t i = 0; i < 4; ++i) {
    lineAnalog[i] = analogRead(LINE_PINS[i]);
    lineDigital[i] = digitalRead(LINE_PINS[i]);
  }
}

String makeStatusJson() {
  String json;
  json.reserve(300);
  json = "{\"distanceValid\":";
  json += distanceValid ? "true" : "false";
  json += ",\"distanceFresh\":";
  json += ultrasonicFresh() ? "true" : "false";
  json += ",\"distanceCm\":";
  json += String(distanceCm, 1);
  json += ",\"obstacleBlocked\":";
  json += obstacleBlocked ? "true" : "false";
  json += ",\"activeDirection\":\"";
  json += activeDirection;
  json += "\",\"sensors\":[";
  for (uint8_t i = 0; i < 4; ++i) {
    if (i > 0) json += ',';
    json += "{\"gpio\":";
    json += LINE_PINS[i];
    json += ",\"analog\":";
    json += lineAnalog[i];
    json += ",\"digital\":";
    json += lineDigital[i] ? "true" : "false";
    json += '}';
  }
  json += "]}";
  return json;
}

void handleMove() {
  const String direction = server.arg("dir");
  if (direction == "stop") {
    stopMotors();
    server.send(200, "application/json", "{\"moving\":false,\"message\":\"Parado\"}");
    return;
  }

  if (direction != "forward" && direction != "left" && direction != "right") {
    stopMotors();
    server.send(400, "application/json", "{\"moving\":false,\"message\":\"Comando inválido; motores parados\"}");
    return;
  }

  if (!distanceValid || !ultrasonicFresh() || obstacleBlocked) {
    stopMotors();
    server.send(200, "application/json", "{\"moving\":false,\"message\":\"Bloqueado: verifique o HC-SR04 e a distância\"}");
    return;
  }

  bool leftForward = true;
  bool rightForward = true;
  if (direction == "left") {
    leftForward = false;
  } else if (direction == "right") {
    rightForward = false;
  }

  setMotor(MOTOR_LEFT_IN1, MOTOR_LEFT_IN2, leftForward, LEFT_MOTOR_INVERTED);
  setMotor(MOTOR_RIGHT_IN1, MOTOR_RIGHT_IN2, rightForward, RIGHT_MOTOR_INVERTED);
  analogWrite(MOTOR_LEFT_EN, MOTOR_PWM);
  analogWrite(MOTOR_RIGHT_EN, MOTOR_PWM);
  activeDirection = direction;
  lastCommandAt = millis();
  server.send(200, "application/json", "{\"moving\":true,\"message\":\"Movendo: " + direction + "\"}");
}

}  // namespace

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (uint8_t pin : LINE_PINS) pinMode(pin, INPUT);

  pinMode(MOTOR_LEFT_EN, OUTPUT);
  pinMode(MOTOR_LEFT_IN1, OUTPUT);
  pinMode(MOTOR_LEFT_IN2, OUTPUT);
  pinMode(MOTOR_RIGHT_IN1, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2, OUTPUT);
  stopMotors();

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) {
    Serial.println("Falha ao iniciar o ponto de acesso Wi-Fi.");
    return;
  }
  Serial.print("Wi-Fi: ");
  Serial.println(AP_SSID);
  Serial.print("IP: ");
  Serial.println(WiFi.softAPIP());

  server.on("/", HTTP_GET, []() {
    server.send_P(200, "text/html; charset=utf-8", PAGE);
  });
  server.on("/status", HTTP_GET, []() {
    readLineSensors();
    server.send(200, "application/json", makeStatusJson());
  });
  server.on("/move", HTTP_POST, handleMove);
  server.onNotFound([]() {
    server.send(404, "text/plain", "Nao encontrado");
  });
  server.begin();
}

void loop() {
  server.handleClient();
  updateObstacleSensor();

  if (activeDirection != "stop" &&
      (millis() - lastCommandAt > COMMAND_TIMEOUT_MS ||
       !distanceValid || !ultrasonicFresh() || obstacleBlocked)) {
    stopMotors();
  }
  readLineSensors();
}
