const API = 'http://127.0.0.1:8765';
const $ = (selector) => document.querySelector(selector);
const source = $('#source');
const lines = $('#lines');
const highlight = $('#highlight');
const highlightCode = highlight.querySelector('code');
const generated = $('#generated');
const compileButton = $('#compile');
const downloadButton = $('#download');
const copyButton = $('#copy');
const compileStatus = $('#compile-status');
const placeholder = $('#output-placeholder');
const apiStatus = $('#api-status');
const connection = $('#connection');
const diagnostics = $('#diagnostics');
const panels = $('#panels');
const workspace = $('#workspace');
const tabs = { source: $('#tab-source'), output: $('#tab-output') };
const file = $('#file');
const message = $('#message');
const outputFilename = $('#output-filename');

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

let toastTimer;
let compiledSource = null;
let errorLines = new Set();
let busy = false;
let apiConnected = false;
let fontSize = 14;

function toast(text) {
  message.textContent = text;
  message.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => message.classList.remove('show'), 3500);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
}

function renderHighlight(text) {
  const token = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?(?:ms|s)?\b|\b(?:robot|profile|board|network|motors|line_sensors|movement|execution|station|default|on_arrival|if|else|true|false|high|low|none)\b/g;
  let html = '';
  let previous = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(previous, match.index));
    const value = match[0];
    const kind = value.startsWith('//') ? 'comment' : value.startsWith('"') ? 'string' : /^\d/.test(value) ? 'number' : 'keyword';
    html += `<span class="token-${kind}">${escapeHtml(value)}</span>`;
    previous = match.index + value.length;
  }
  highlightCode.innerHTML = html + escapeHtml(text.slice(previous)) + '\n';
}

function syncScroll() {
  lines.scrollTop = source.scrollTop;
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
}

function updateEditor() {
  const count = source.value.split('\n').length;
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= count; number++) {
    const line = document.createElement('span');
    line.textContent = number;
    if (errorLines.has(number)) line.className = 'line-error';
    fragment.append(line);
  }
  lines.replaceChildren(fragment);
  $('#count').textContent = `${count} ${count === 1 ? 'linha' : 'linhas'}`;
  renderHighlight(source.value);
  syncScroll();
}

function resultIsCurrent() {
  return compiledSource !== null && source.value === compiledSource;
}

function updateResultState() {
  const current = resultIsCurrent();
  downloadButton.disabled = !current;
  copyButton.disabled = !current;
  if (compiledSource !== null && !current) {
    compileStatus.textContent = 'O código mudou. Compile novamente para atualizar o resultado.';
    compileStatus.className = 'status-line status-warning';
    $('#output-description').textContent = 'Resultado desatualizado';
  } else if (current && !busy) {
    compileStatus.textContent = 'Sketch atualizado e pronto para baixar.';
    compileStatus.className = 'status-line status-success';
    $('#output-description').textContent = 'Sketch gerado com sucesso';
  }
}

function clearDiagnostics() {
  diagnostics.hidden = true;
  diagnostics.replaceChildren();
  errorLines = new Set();
}

function showDiagnostics(items) {
  clearDiagnostics();
  const heading = document.createElement('strong');
  heading.textContent = items.length === 1 ? 'Encontramos um problema' : `Encontramos ${items.length} problemas`;
  diagnostics.append(heading);
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'diagnostic-item';
    const location = Number.isInteger(item.line) && item.line > 0 ? `Linha ${item.line}${item.col ? `, coluna ${item.col}` : ''}: ` : '';
    row.textContent = location + (item.message || 'Não foi possível compilar.');
    if (location) {
      errorLines.add(item.line);
      row.addEventListener('click', () => {
        selectTab('source');
        const sourceLines = source.value.split('\n');
        const index = Math.min(item.line - 1, sourceLines.length - 1);
        const position = sourceLines.slice(0, index).reduce((total, line) => total + line.length + 1, 0) + Math.max(0, (item.col || 1) - 1);
        source.focus();
        source.setSelectionRange(position, position);
        source.scrollTop = Math.max(0, index * parseFloat(getComputedStyle(source).lineHeight) - source.clientHeight / 3);
        syncScroll();
      });
    } else row.disabled = true;
    diagnostics.append(row);
  }
  diagnostics.hidden = false;
  updateEditor();
}

function selectTab(name) {
  if (workspace.dataset.expanded && workspace.dataset.expanded !== name) expandPanel(workspace.dataset.expanded);
  panels.dataset.tab = name;
  for (const [key, button] of Object.entries(tabs)) {
    const active = key === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
}

function expandPanel(name) {
  const next = workspace.dataset.expanded === name ? '' : name;
  workspace.dataset.expanded = next;
  for (const panelName of ['source', 'output']) {
    const button = $(`#expand-${panelName}`);
    const active = next === panelName;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'Restaurar painéis' : `Ampliar ${panelName === 'source' ? 'editor' : 'resultado'}`);
    button.title = active ? 'Restaurar painéis' : `Ampliar ${panelName === 'source' ? 'editor' : 'resultado'}`;
    button.textContent = active ? '⤡' : '⤢';
  }
  if (next) selectTab(next);
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function checkApi() {
  try {
    const response = await fetch(`${API}/health`, {signal: AbortSignal.timeout(1800)});
    if (!response.ok) throw new Error('API indisponível');
    apiConnected = true;
    connection.dataset.state = 'connected';
    apiStatus.textContent = 'Compilador conectado';
    if (!busy && compiledSource === null && diagnostics.hidden) {
      compileStatus.textContent = 'Pronto para compilar no seu computador.';
      compileStatus.className = 'status-line';
    }
  } catch {
    apiConnected = false;
    connection.dataset.state = 'disconnected';
    apiStatus.textContent = 'Compilador desconectado';
    if (!busy && compiledSource === null && diagnostics.hidden) {
      compileStatus.textContent = 'Inicie a API local: python -m compiler.roboflow serve';
      compileStatus.className = 'status-line status-warning';
    }
  }
}

source.addEventListener('input', () => {
  clearDiagnostics();
  updateEditor();
  updateResultState();
  if (compiledSource === null && !busy) {
    compileStatus.textContent = apiConnected ? 'Pronto para compilar no seu computador.' : 'Compilador desconectado. Inicie a API local.';
    compileStatus.className = apiConnected ? 'status-line' : 'status-line status-warning';
  }
});
source.addEventListener('scroll', syncScroll);
source.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    source.setRangeText('    ', source.selectionStart, source.selectionEnd, 'end');
    source.dispatchEvent(new Event('input', {bubbles:true}));
  }
});

$('#font-down').addEventListener('click', () => setFontSize(fontSize - 1));
$('#font-up').addEventListener('click', () => setFontSize(fontSize + 1));
function setFontSize(size) {
  fontSize = Math.max(12, Math.min(20, size));
  workspace.style.setProperty('--code-size', `${fontSize}px`);
  $('#font-size').textContent = fontSize;
  $('#font-down').disabled = fontSize === 12;
  $('#font-up').disabled = fontSize === 20;
  syncScroll();
}

for (const name of ['source', 'output']) {
  tabs[name].addEventListener('click', () => selectTab(name));
  tabs[name].addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const other = name === 'source' ? 'output' : 'source';
      selectTab(other); tabs[other].focus();
    }
  });
  $(`#expand-${name}`).addEventListener('click', () => expandPanel(name));
}

$('#example').addEventListener('click', () => {
  if (source.value.trim() && source.value !== example && !confirm('Substituir o código atual pelo exemplo?')) return;
  source.value = example;
  $('#source-filename').textContent = $('#editor-filename').textContent = 'programa.rf';
  outputFilename.value = 'programa.ino';
  source.dispatchEvent(new Event('input', {bubbles:true}));
});
$('#open').addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const selected = file.files[0];
  if (!selected) return;
  if (source.value.trim() && source.value !== example && !confirm('Substituir o código atual pelo arquivo selecionado?')) { file.value = ''; return; }
  try {
    source.value = await selected.text();
    $('#source-filename').textContent = $('#editor-filename').textContent = selected.name;
    outputFilename.value = selected.name.replace(/\.rf$/i, '') + '.ino';
    source.dispatchEvent(new Event('input', {bubbles:true}));
    toast('Arquivo aberto.');
  } catch { toast('Não foi possível abrir o arquivo.'); }
  file.value = '';
});
$('#save').addEventListener('click', () => { download(source.value, 'programa.rf'); toast('Arquivo .rf salvo.'); });

compileButton.addEventListener('click', async () => {
  const submittedSource = source.value;
  busy = true;
  compileButton.disabled = true;
  compileButton.textContent = 'Compilando…';
  compileStatus.textContent = 'Compilando no seu computador…';
  compileStatus.className = 'status-line';
  clearDiagnostics();
  updateEditor();
  try {
    const response = await fetch(`${API}/compile`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source:submittedSource})});
    const result = await response.json();
    if (!response.ok || !result.ok) {
      compiledSource = null;
      downloadButton.disabled = copyButton.disabled = true;
      generated.hidden = true; placeholder.hidden = false;
      $('#output-count').textContent = 'Sem resultado';
      $('#output-description').textContent = 'Corrija o código e tente novamente';
      if (source.value === submittedSource) {
        const items = result.diagnostics?.length ? result.diagnostics : (result.errors || ['Erro desconhecido']).map((error) => {
          const match = /^(\d+):(\d+):\s*(?:error|erro)\s*\[[^\]]+\]\s*(.*)$/i.exec(error);
          return match ? {line:Number(match[1]), col:Number(match[2]), message:match[3]} : {message:error};
        });
        showDiagnostics(items);
        selectTab('source');
        compileStatus.textContent = 'Corrija os problemas destacados no código.';
      } else {
        compileStatus.textContent = 'O código mudou durante a compilação. Compile novamente.';
      }
      compileStatus.className = 'status-line status-error';
      return;
    }
    const sketch = result.files?.['carrinho_autonomo.ino'];
    if (typeof sketch !== 'string') throw new Error('O compilador não retornou o arquivo .ino.');
    generated.value = sketch;
    compiledSource = submittedSource;
    generated.hidden = false; placeholder.hidden = true;
    const count = sketch.split('\n').length;
    $('#output-count').textContent = `${count} ${count === 1 ? 'linha' : 'linhas'}`;
    if (window.matchMedia('(max-width: 900px)').matches && resultIsCurrent()) selectTab('output');
    toast(resultIsCurrent() ? 'Sketch .ino gerado.' : 'Código alterado. Compile novamente.');
  } catch (error) {
    compiledSource = null;
    downloadButton.disabled = copyButton.disabled = true;
    generated.hidden = true; placeholder.hidden = false;
    $('#output-count').textContent = 'Sem resultado';
    $('#output-description').textContent = 'Não foi possível gerar o sketch';
    compileStatus.textContent = apiConnected && error instanceof Error && error.message.includes('.ino') ? error.message : 'Não foi possível conectar ao compilador. Inicie a API local e tente novamente.';
    compileStatus.className = 'status-line status-error';
    checkApi();
  } finally {
    busy = false;
    compileButton.disabled = false;
    compileButton.innerHTML = '<span aria-hidden="true">↗</span> Compilar para .ino';
    updateResultState();
  }
});

downloadButton.addEventListener('click', () => {
  if (!resultIsCurrent()) return;
  let name = outputFilename.value.trim();
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    compileStatus.textContent = 'Informe um nome de arquivo válido, sem barras ou caracteres especiais.';
    compileStatus.className = 'status-line status-error';
    outputFilename.focus();
    return;
  }
  if (!/\.ino$/i.test(name)) name += '.ino';
  outputFilename.value = name;
  download(generated.value, name);
  toast('Arquivo .ino baixado.');
});
copyButton.addEventListener('click', async () => {
  if (!resultIsCurrent()) return;
  try {
    await navigator.clipboard.writeText(generated.value);
    toast('Código copiado.');
  } catch { toast('Não foi possível copiar. Selecione o código e copie manualmente.'); }
});

source.value = example;
document.documentElement.classList.add('has-highlighting');
selectTab('source');
setFontSize(fontSize);
updateEditor();
checkApi();
setInterval(checkApi, 5000);
