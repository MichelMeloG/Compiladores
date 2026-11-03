const source = document.querySelector('#source');
const lines = document.querySelector('#lines');
const count = document.querySelector('#count');
const file = document.querySelector('#file');
const message = document.querySelector('#message');
const example = `// Exemplo de comportamento em RoboFlow
station "carga" {
    on_arrival {
        stop()
        signal_light()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}

station default {
    on_arrival {
        stop()
        log("Estacao desconhecida")
        wait_signal("manual_override", timeout: none)
    }
}
`;
let timer;
function toast(text) { message.textContent = text; message.classList.add('show'); clearTimeout(timer); timer = setTimeout(() => message.classList.remove('show'), 3000); }
function update() { const n = source.value.split('\n').length; lines.textContent = Array.from({length:n}, (_, i) => i + 1).join('\n'); count.textContent = `${n} ${n === 1 ? 'linha' : 'linhas'}`; }
source.addEventListener('input', update);
source.addEventListener('scroll', () => { lines.scrollTop = source.scrollTop; });
source.addEventListener('keydown', (event) => { if (event.key === 'Tab') { event.preventDefault(); const {selectionStart:start, selectionEnd:end} = source; source.setRangeText('    ', start, end, 'end'); update(); } });
document.querySelector('#example').addEventListener('click', () => { if (source.value.trim() && !confirm('Substituir o código atual pelo exemplo?')) return; source.value = example; update(); });
file.addEventListener('change', async () => { const selected = file.files[0]; if (!selected) return; if (source.value.trim() && !confirm('Substituir o código atual pelo arquivo selecionado?')) { file.value = ''; return; } try { source.value = await selected.text(); update(); toast('Arquivo aberto.'); } catch { toast('Não foi possível abrir o arquivo.'); } file.value = ''; });
document.querySelector('#save').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([source.value], {type:'text/plain;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = 'programa.rf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Arquivo .rf salvo.'); });
source.value = example;
update();
