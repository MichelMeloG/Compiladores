
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// =============== AJUSTES ===============
constexpr char WIFI_NOME[] = "RoboFlow-Teste";
constexpr char WIFI_SENHA[] = "RoboFlow32";

// true: segue linha automaticamente ao ligar a bateria
// false: inicia parado e aguarda comando pelo celular
constexpr bool INICIAR_SEGUINDO_LINHA = false;

// Ponte H
constexpr uint8_t EN_ESQ = 25;
constexpr uint8_t IN1_ESQ = 26;
constexpr uint8_t IN2_ESQ = 27;

constexpr uint8_t EN_DIR = 13;
constexpr uint8_t IN1_DIR = 14;
constexpr uint8_t IN2_DIR = 23;

constexpr bool INVERTER_ESQ = false;
constexpr bool INVERTER_DIR = false;

// Sensores de linha
constexpr uint8_t LINHA_PINS[3] = {32, 34, 33};

// LED aceso no branco e apagado no preto:
// teste HIGH e altere para LOW se estiver invertido.
constexpr uint8_t NIVEL_PRETO = HIGH;

// Velocidades PWM
constexpr int RETA = 200;
constexpr int CURVA_SUAVE_INTERNO = 155;
constexpr int CURVA_SUAVE_EXTERNO = 255;
constexpr int CURVA_FORTE_RE = 180;
constexpr int CURVA_FORTE_FRENTE = 255;

// Sensor ultrassonico opcional
constexpr uint8_t TRIG = 18;
constexpr uint8_t ECHO = 19;
constexpr int PARAR_CM = 20;
constexpr int LIBERAR_CM = 25;

constexpr uint32_t TEMPO_ULTRA_MS = 100;
constexpr uint32_t TIMEOUT_ECHO_US = 12000;
constexpr uint32_t TEMPO_CONTROLE_MS = 20;
constexpr uint32_t TIMEOUT_JOYSTICK_MS = 500;

WebServer servidor(80);

bool emPreto[3] = {false, false, false};
bool automatico = INICIAR_SEGUINDO_LINHA;
bool ultraAtivado = false;
bool obstaculo = false;
bool distanciaValida = false;

float distanciaCm = 0;

uint32_t ultimoUltra = 0;
uint32_t ultimoControle = 0;
uint32_t ultimoJoystick = 0;

int ultimoPWMEsq = 999;
int ultimoPWMDir = 999;

const char* movimento = "parado";

// =============== INTERFACE WEB ===============
// O HTML fica salvo na memoria do ESP32.
// Nenhuma conexao com a internet e necessaria.

const char PAGINA[] PROGMEM = R"HTML(
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>RoboFlow</title>

<style>
*{box-sizing:border-box}
body{
  margin:16px auto;
  padding:0 12px;
  max-width:540px;
  font:16px system-ui,Arial;
  background:#f2f5fa;
  color:#1a2531
}
section{
  background:white;
  border-radius:14px;
  padding:16px;
  margin:12px 0;
  box-shadow:0 1px 4px #0001
}
h2{margin:8px 0 16px}
button{
  border:0;
  border-radius:9px;
  padding:12px;
  font:inherit;
  cursor:pointer;
  background:#dfe7f1;
  color:#183044
}
.buttons{
  display:flex;
  gap:8px;
  margin:10px 0
}
.buttons button{flex:1}
.selected{
  background:#1669a8;
  color:white
}
#stop{
  width:100%;
  background:#ad2525;
  color:white;
  font-weight:700
}
.sensors{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:7px;
  margin:12px 0
}
.sensor{
  padding:12px 3px;
  text-align:center;
  border-radius:9px;
  background:#e9edf2;
  font-size:12px
}
.sensor strong{
  display:block;
  margin:8px 0;
  font-size:12px
}
.sensor.active{
  background:#c8f3d6;
  color:#08622e
}
#pad{
  position:relative;
  touch-action:none;
  width:min(72vw,260px);
  aspect-ratio:1;
  margin:16px auto;
  border-radius:50%;
  background:linear-gradient(#e7eff7,#c7d7e9)
}
#stick{
  position:absolute;
  left:50%;
  top:50%;
  width:30%;
  aspect-ratio:1;
  background:#1769aa;
  border-radius:50%;
  transform:translate(-50%,-50%);
  pointer-events:none
}
small{color:#536373}
#ultra{width:100%}
#info{font-weight:600}
</style>
</head>

<body>
<h2>RoboFlow - ESP32</h2>

<section>
<b>Modo de operacao</b>
<div class="buttons">
  <button id="manual" onclick="modo('manual')">
    Manual
  </button>
  <button id="auto" onclick="modo('auto')">
    Seguir linha
  </button>
</div>
<div id="info">Conectando...</div>
<small>Wi-Fi proprio. Sem computador ou internet.</small>
</section>

<section>
<b>Deteccao da linha preta</b>
<div class="sensors" id="sensors"></div>
<small>
ATIVADO = detectando preto.
DESATIVADO = detectando branco.
</small>
</section>

<section>
<b>Ultrassonico (opcional)</b>
<p id="distance">Desativado</p>
<button id="ultra" onclick="mudarUltra()">
Ativar sensor de obstaculos
</button>
</section>

<section id="manualPanel">
<b>Joystick</b>
<div id="pad">
  <div id="stick"></div>
</div>
<small>
Arraste para movimentar.
Solte para parar.
</small>
</section>

<section>
<button id="stop" onclick="parar()">
PARAR / VOLTAR AO MANUAL
</button>
</section>

<script>
const $ = id => document.getElementById(id);

const pad = $('pad');
const stick = $('stick');

let activeMode = 'manual';
let ultra = false;
let pointer = null;
let x = 0;
let y = 0;
let timer = null;
let busy = false;
let pollBusy = false;

function draw(){
  const d = pad.clientWidth * .35;

  stick.style.transform =
    `translate(-50%,-50%) translate(
      ${d*x/100}px,
      ${-d*y/100}px
    )`;
}

function readPointer(e){
  const r = pad.getBoundingClientRect();
  const limit = r.width * .35;

  let dx =
    (e.clientX-r.left-r.width/2)/limit;

  let dy =
    (r.top+r.height/2-e.clientY)/limit;

  const m = Math.hypot(dx,dy);

  if(m>1){
    dx/=m;
    dy/=m;
  }

  x=Math.round(dx*100);
  y=Math.round(dy*100);

  draw();
}

async function sendMove(){
  if(activeMode!=='manual'||busy)return;

  busy=true;

  try{
    await fetch(
      `/move?x=${x}&y=${y}`,
      {method:'POST',cache:'no-store'}
    );
  }catch(e){
    $('info').textContent='Sem comunicacao';
    release(false);
  }finally{
    busy=false;
  }
}

function release(send=true){
  if(timer){
    clearInterval(timer);
    timer=null;
  }

  pointer=null;
  x=0;
  y=0;

  draw();

  if(send && activeMode==='manual'){
    fetch(
      '/move?x=0&y=0',
      {method:'POST'}
    ).catch(()=>{});
  }
}

pad.addEventListener('pointerdown',e=>{
  if(activeMode!=='manual')return;

  e.preventDefault();

  pointer=e.pointerId;
  pad.setPointerCapture(pointer);

  readPointer(e);
  sendMove();

  if(!timer){
    timer=setInterval(sendMove,120);
  }
});

pad.addEventListener('pointermove',e=>{
  if(pointer===e.pointerId){
    readPointer(e);
  }
});

[
  'pointerup',
  'pointercancel',
  'lostpointercapture'
].forEach(k=>
  pad.addEventListener(k,()=>{
    if(pointer!==null)release();
  })
);

window.addEventListener('blur',()=>{
  if(pointer!==null)release();
});

document.addEventListener('visibilitychange',()=>{
  if(document.hidden && pointer!==null){
    release();
  }
});

function buttons(){
  $('manual').classList.toggle(
    'selected',
    activeMode==='manual'
  );

  $('auto').classList.toggle(
    'selected',
    activeMode==='auto'
  );

  $('manualPanel').style.display =
    activeMode==='manual'?'block':'none';
}

async function modo(m){
  release(false);

  try{
    const r=await fetch(
      '/mode?m='+m,
      {method:'POST'}
    );

    const s=await r.json();

    activeMode=s.mode;
    buttons();

    $('info').textContent=s.message;
  }catch(e){
    $('info').textContent='Sem conexao';
  }
}

async function parar(){
  release(false);

  try{
    const s=await(
      await fetch(
        '/stop',
        {method:'POST'}
      )
    ).json();

    activeMode=s.mode;
    buttons();

    $('info').textContent=s.message;
  }catch(e){
    $('info').textContent='Sem conexao';
  }
}

async function mudarUltra(){
  try{
    const s=await(
      await fetch(
        '/ultra?enabled='+(ultra?'0':'1'),
        {method:'POST'}
      )
    ).json();

    ultra=s.enabled;
  }catch(e){
    $('info').textContent='Sem conexao';
  }
}

async function refresh(){
  if(pollBusy)return;

  pollBusy=true;

  try{
    const s=await(
      await fetch(
        '/status',
        {cache:'no-store'}
      )
    ).json();

    activeMode=s.mode;
    ultra=s.ultrasonicEnabled;

    buttons();

    const names=[
      'ESQUERDA',
      'CENTRO',
      'DIREITA'
    ];

    $('sensors').innerHTML =
      s.sensors.map((v,i)=>`
        <div class="sensor
        ${v.activated?'active':''}">
          <b>${names[i]}</b>
          <p>GPIO ${v.gpio}</p>
          <strong>
          ${v.activated?'ATIVADO':'DESATIVADO'}
          </strong>
        </div>
      `).join('');

    $('distance').textContent =
      !ultra
      ? 'Desativado'
      : !s.distanceValid
      ? 'Sem leitura (nao bloqueia)'
      : `${s.distanceCm.toFixed(1)} cm
      ${s.obstacleBlocked?' - OBSTACULO!':''}`;

    $('ultra').textContent =
      ultra
      ? 'Desativar sensor de obstaculos'
      : 'Ativar sensor de obstaculos';

    if(pointer===null){
      $('info').textContent =
        (activeMode==='auto'
         ?'Automatico'
         :'Manual')+
        ' | '+s.movement;
    }

  }catch(e){
    $('info').textContent='ESP32 sem resposta';
  }finally{
    pollBusy=false;
  }
}

setInterval(refresh,400);
refresh();
</script>
</body>
</html>
)HTML";

// =============== MOTORES ===============

void motor(
  uint8_t en,
  uint8_t in1,
  uint8_t in2,
  int pwm,
  bool invertido,
  int& anterior
){
  pwm=constrain(pwm,-255,255);

  // Evita atualizar a ponte H sem necessidade
  if(pwm==anterior)return;

  // Corta PWM antes de inverter o motor
  if(
    anterior!=999 &&
    anterior!=0 &&
    pwm!=0 &&
    ((anterior>0)!=(pwm>0))
  ){
    analogWrite(en,0);
    delayMicroseconds(150);
  }

  if(pwm==0){
    analogWrite(en,0);
    digitalWrite(in1,LOW);
    digitalWrite(in2,LOW);
  }else{
    bool frente=((pwm>0)!=invertido);

    digitalWrite(
      in1,
      frente?HIGH:LOW
    );

    digitalWrite(
      in2,
      frente?LOW:HIGH
    );

    analogWrite(en,abs(pwm));
  }

  anterior=pwm;
}

void pararMotores(){
  motor(
    EN_ESQ,IN1_ESQ,IN2_ESQ,
    0,INVERTER_ESQ,ultimoPWMEsq
  );

  motor(
    EN_DIR,IN1_DIR,IN2_DIR,
    0,INVERTER_DIR,ultimoPWMDir
  );

  movimento="parado";
}

void mover(
  int esq,
  int dir,
  const char* nome
){
  if(ultraAtivado && obstaculo){
    pararMotores();
    return;
  }

  motor(
    EN_ESQ,IN1_ESQ,IN2_ESQ,
    esq,INVERTER_ESQ,ultimoPWMEsq
  );

  motor(
    EN_DIR,IN1_DIR,IN2_DIR,
    dir,INVERTER_DIR,ultimoPWMDir
  );

  movimento=nome;
}

// =============== SENSORES ===============

void lerLinha(){
  for(uint8_t i=0;i<3;i++){
    emPreto[i]=(
      digitalRead(LINHA_PINS[i])==
      NIVEL_PRETO
    );
  }
}

void lerUltrassonico(){
  if(!ultraAtivado)return;

  if(
    millis()-ultimoUltra <
    TEMPO_ULTRA_MS
  )return;

  ultimoUltra=millis();

  digitalWrite(TRIG,LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG,HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG,LOW);

  unsigned long eco=pulseIn(
    ECHO,
    HIGH,
    TIMEOUT_ECHO_US
  );

  if(eco==0){
    distanciaValida=false;
    obstaculo=false;
    return;
  }

  distanciaCm=eco*0.0343f/2.0f;
  distanciaValida=true;

  if(distanciaCm<=PARAR_CM){
    obstaculo=true;
  }
  else if(distanciaCm>=LIBERAR_CM){
    obstaculo=false;
  }
}

// =============== SEGUIDOR DE LINHA ===============

void seguirLinha(){
  bool E=emPreto[0];
  bool C=emPreto[1];
  bool D=emPreto[2];

  if(C && !E && !D){
    mover(RETA,RETA,"em frente");
  }
  else if(E && C && !D){
    mover(
      CURVA_SUAVE_INTERNO,
      CURVA_SUAVE_EXTERNO,
      "suave esquerda"
    );
  }
  else if(D && C && !E){
    mover(
      CURVA_SUAVE_EXTERNO,
      CURVA_SUAVE_INTERNO,
      "suave direita"
    );
  }
  else if(E && !C && !D){
    mover(
      -CURVA_FORTE_RE,
      CURVA_FORTE_FRENTE,
      "forte esquerda"
    );
  }
  else if(D && !C && !E){
    mover(
      CURVA_FORTE_FRENTE,
      -CURVA_FORTE_RE,
      "forte direita"
    );
  }
  else if(E && D){
    mover(
      RETA,RETA,
      "cruzamento"
    );
  }
  else{
    pararMotores();
  }
}

// =============== SERVIDOR WEB ===============

void statusJSON(){
  char json[520];

  snprintf(
    json,
    sizeof(json),
    "{\"mode\":\"%s\","
    "\"movement\":\"%s\","
    "\"ultrasonicEnabled\":%s,"
    "\"distanceValid\":%s,"
    "\"distanceCm\":%d,"
    "\"obstacleBlocked\":%s,"
    "\"sensors\":["
    "{\"gpio\":32,\"activated\":%s},"
    "{\"gpio\":34,\"activated\":%s},"
    "{\"gpio\":33,\"activated\":%s}"
    "]}",
    automatico?"auto":"manual",
    movimento,
    ultraAtivado?"true":"false",
    distanciaValida?"true":"false",
    (int)roundf(distanciaCm),
    (ultraAtivado&&obstaculo)?"true":"false",
    emPreto[0]?"true":"false",
    emPreto[1]?"true":"false",
    emPreto[2]?"true":"false"
  );

  servidor.send(
    200,
    "application/json",
    json
  );
}

void comandoJoystick(){
  if(automatico){
    servidor.send(
      409,
      "application/json",
      "{\"moving\":false}"
    );
    return;
  }

  if(
    !servidor.hasArg("x") ||
    !servidor.hasArg("y")
  ){
    pararMotores();

    servidor.send(
      400,
      "application/json",
      "{\"moving\":false}"
    );
    return;
  }

  int x=constrain(
    servidor.arg("x").toInt(),
    -100,100
  );

  int y=constrain(
    servidor.arg("y").toInt(),
    -100,100
  );

  if(abs(x)<8)x=0;
  if(abs(y)<8)y=0;

  int esq=y+x;
  int dir=y-x;

  int maior=max(
    abs(esq),
    abs(dir)
  );

  if(maior>100){
    esq=esq*100/maior;
    dir=dir*100/maior;
  }

  if(abs(esq)<8)esq=0;
  if(abs(dir)<8)dir=0;

  ultimoJoystick=millis();

  if(esq==0 && dir==0){
    pararMotores();
  }
  else{
    mover(
      esq*255/100,
      dir*255/100,
      y>0?"frente":
      y<0?"re":
      x>0?"direita":"esquerda"
    );
  }

  servidor.send(
    200,
    "application/json",
    "{\"moving\":true}"
  );
}

void trocarModo(){
  String novo=servidor.arg("m");

  if(novo!="manual" && novo!="auto"){
    servidor.send(
      400,
      "application/json",
      "{\"message\":\"Modo invalido\"}"
    );
    return;
  }

  pararMotores();

  automatico=(novo=="auto");
  ultimoControle=0;

  servidor.send(
    200,
    "application/json",
    automatico
      ? "{\"mode\":\"auto\",\"message\":\"Seguidor ativo\"}"
      : "{\"mode\":\"manual\",\"message\":\"Manual ativo\"}"
  );
}

void parar(){
  automatico=false;
  pararMotores();

  servidor.send(
    200,
    "application/json",
    "{\"mode\":\"manual\",\"message\":\"Parado\"}"
  );
}

void mudarUltra(){
  ultraAtivado=(
    servidor.arg("enabled")=="1"
  );

  obstaculo=false;
  distanciaValida=false;
  ultimoUltra=0;

  servidor.send(
    200,
    "application/json",
    ultraAtivado
      ? "{\"enabled\":true}"
      : "{\"enabled\":false}"
  );
}

// =============== INICIALIZACAO ===============

void setup(){

  // Inicializacao segura dos motores
  pinMode(EN_ESQ,OUTPUT);
  pinMode(EN_DIR,OUTPUT);

  digitalWrite(EN_ESQ,LOW);
  digitalWrite(EN_DIR,LOW);

  pinMode(IN1_ESQ,OUTPUT);
  pinMode(IN2_ESQ,OUTPUT);

  pinMode(IN1_DIR,OUTPUT);
  pinMode(IN2_DIR,OUTPUT);

  pararMotores();

  // Sensores de linha
  for(uint8_t p:LINHA_PINS){
    pinMode(p,INPUT);
  }

  // Ultrassonico
  pinMode(TRIG,OUTPUT);
  pinMode(ECHO,INPUT);
  digitalWrite(TRIG,LOW);

  lerLinha();

  // Serial somente para depuracao
  // Nao precisa estar conectada
  Serial.begin(115200);

  // Wi-Fi independente
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);

  WiFi.softAPConfig(
    IPAddress(192,168,4,1),
    IPAddress(192,168,4,1),
    IPAddress(255,255,255,0)
  );

  WiFi.softAP(
    WIFI_NOME,
    WIFI_SENHA
  );

  // Rotas do servidor
  servidor.on("/",HTTP_GET,[](){
    servidor.send_P(
      200,
      "text/html; charset=utf-8",
      PAGINA
    );
  });

  servidor.on(
    "/status",
    HTTP_GET,
    statusJSON
  );

  servidor.on(
    "/move",
    HTTP_POST,
    comandoJoystick
  );

  servidor.on(
    "/mode",
    HTTP_POST,
    trocarModo
  );

  servidor.on(
    "/stop",
    HTTP_POST,
    parar
  );

  servidor.on(
    "/ultra",
    HTTP_POST,
    mudarUltra
  );

  servidor.begin();

  Serial.println(
    "RoboFlow: http://192.168.4.1"
  );
}

// =============== LOOP PRINCIPAL ===============

void loop(){

  servidor.handleClient();

  lerLinha();
  lerUltrassonico();

  // Bloqueio opcional de obstaculos
  if(
    ultraAtivado &&
    obstaculo &&
    (
      ultimoPWMEsq!=0 ||
      ultimoPWMDir!=0
    )
  ){
    pararMotores();
  }

  // Modo automatico
  if(automatico){
    if(
      millis()-ultimoControle >=
      TEMPO_CONTROLE_MS
    ){
      ultimoControle=millis();
      seguirLinha();
    }
  }

  // Protecao do controle manual
  else if(
    (
      ultimoPWMEsq!=0 ||
      ultimoPWMDir!=0
    ) &&
    millis()-ultimoJoystick >
    TIMEOUT_JOYSTICK_MS
  ){
    pararMotores();
  }
}
