const API = 'http://127.0.0.1:8765';
const source = document.querySelector('#source');
const lines = document.querySelector('#lines');
const count = document.querySelector('#count');
const file = document.querySelector('#file');
const message = document.querySelector('#message');
const generated = document.querySelector('#generated');
const compileButton = document.querySelector('#compile');
const downloadButton = document.querySelector('#download');
const compileStatus = document.querySelector('#compile-status');
const placeholder = document.querySelector('#output-placeholder');
const apiStatus = document.querySelector('#api-status');

const example = `// Perfil do carrinho autônomo ESP32. Substitua credenciais antes de gerar.
robot "RB-01" {
    profile autonomous_line_v1
    board esp32

    network {
        ssid: "SUA_REDE"
        password: "SUA_SENHA"
        backend: "http://192.168.1.10:8080"
        token: "SEGREDO_CADASTRADO_NO_BACKEND"
        ca_certificate: ""
        ntp: "pool.ntp.org"
    }

    motors {
        left_pins: [25, 26, 27]
        right_pins: [13, 14, 23]
        left_direction: 1
        right_direction: 1
    }

    line_sensors {
        pins: [32, 34, 33]
        active_level: high
        stable_samples: 3
        interval: 10ms
    }

    movement {
        straight_power: 150
        outer_power: 150
        gentle_inner_power: 110
        strong_inner_power: 60
        alignment: 120ms
        minimum_turn: 180ms
        turn_timeout: 2500ms
        segment_timeout: 15000ms
    }

    execution {
        startup_delay: 3000ms
        communication_timeout: 30000ms
        max_actions: 16
        max_events: 12
        route_source: backend
        actions: [forward, right, left]
        require_start_command: true
    }
}
`;
let timer;
function toast(text) { message.textContent = text; message.classList.add('show'); clearTimeout(timer); timer = setTimeout(() => message.classList.remove('show'), 3500); }
function update() { const n = source.value.split('\n').length; lines.textContent = Array.from({length:n}, (_, i) => i + 1).join('\n'); count.textContent = `${n} ${n === 1 ? 'linha' : 'linhas'}`; }
function showError(text) {
  generated.hidden = true; placeholder.hidden = false;
  placeholder.innerHTML = '';
  const title = document.createElement('h3'); title.textContent = 'Não foi possível compilar';
  const detail = document.createElement('pre'); detail.className = 'compile-error'; detail.textContent = text;
  placeholder.append(title, detail); downloadButton.disabled = true;
}
async function checkApi() {
  try {
    const response = await fetch(`${API}/health`, {signal: AbortSignal.timeout(1200)});
    if (!response.ok) throw new Error();
    apiStatus.textContent = 'API LOCAL CONECTADA'; apiStatus.classList.add('connected');
    compileStatus.textContent = 'A compilação acontece neste computador.';
  } catch {
    apiStatus.textContent = 'API DESCONECTADA'; apiStatus.classList.remove('connected');
    compileStatus.textContent = 'Inicie a API local: python -m compiler.roboflow serve';
  }
}
source.addEventListener('input', update);
source.addEventListener('scroll', () => { lines.scrollTop = source.scrollTop; });
source.addEventListener('keydown', (event) => { if (event.key === 'Tab') { event.preventDefault(); const {selectionStart:start, selectionEnd:end} = source; source.setRangeText('    ', start, end, 'end'); update(); } });
document.querySelector('#example').addEventListener('click', () => { if (source.value.trim() && !confirm('Substituir o código atual pelo exemplo?')) return; source.value = example; update(); });
file.addEventListener('change', async () => { const selected = file.files[0]; if (!selected) return; if (source.value.trim() && !confirm('Substituir o código atual pelo arquivo selecionado?')) { file.value = ''; return; } try { source.value = await selected.text(); update(); toast('Arquivo aberto.'); } catch { toast('Não foi possível abrir o arquivo.'); } file.value = ''; });
document.querySelector('#save').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([source.value], {type:'text/plain;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = 'programa.rf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Arquivo .rf salvo.'); });
compileButton.addEventListener('click', async () => {
  compileButton.disabled = true; compileButton.textContent = 'Compilando…';
  compileStatus.textContent = 'Compilando localmente…';
  try {
    const response = await fetch(`${API}/compile`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source:source.value})});
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const errors = (result.errors || ['Erro desconhecido']).join('\n');
      showError(errors); compileStatus.textContent = 'Corrija os erros e tente novamente.'; return;
    }
    generated.value = result.files['carrinho_autonomo.ino'];
    generated.hidden = false; placeholder.hidden = true; downloadButton.disabled = false;
    compileStatus.textContent = 'Compilação concluída. O sketch contém as configurações preenchidas no .rf.';
    document.querySelector('#output-description').textContent = 'carrinho_autonomo.ino gerado com sucesso';
    toast('Sketch .ino gerado.');
  } catch {
    showError('Não foi possível acessar a API local. Inicie-a com: python -m compiler.roboflow serve');
    compileStatus.textContent = 'API local indisponível.';
  } finally { compileButton.disabled = false; compileButton.innerHTML = '↗ &nbsp; Gerar código .ino'; }
});
downloadButton.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([generated.value], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = 'carrinho_autonomo.ino'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
source.value = example;
update();
checkApi();
setInterval(checkApi, 5000);
