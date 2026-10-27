from pathlib import Path

import pytest

from compiler.roboflow import CompileError, Lexer, Parser, PythonCodeGenerator, compile_roboflow

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
DEFAULT = 'station default { on_arrival { stop() wait_signal("manual_override", timeout: none) } }\n'


def load_module(python_code):
    """Executa o Python gerado com um runtime falso e devolve (namespace, chamadas)."""
    calls = []
    namespace = {
        "wait_for_signal": lambda name, timeout: calls.append(("wait", name, timeout)),
        "log_event": lambda msg: calls.append(("log", msg)),
    }
    exec(compile(python_code, "compiled_behavior.py", "exec"), namespace)
    return namespace, calls


def generate(source):
    result = compile_roboflow(source, target="python")
    assert result.ok, [str(e) for e in result.errors]
    return result.files["compiled_behavior.py"]


@pytest.mark.parametrize("example", ["rota_basica.rf", "rota_completa.rf"])
def test_exemplos_geram_python_valido(example):
    code = generate((EXAMPLES / example).read_text(encoding="utf-8"))
    namespace, _ = load_module(code)
    assert callable(namespace["DEFAULT_HANDLER"])


def test_condicao_sem_context_nao_quebra_em_runtime():
    code = generate((EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8"))
    namespace, _ = load_module(code)
    handler = namespace["STATION_HANDLERS"]["bifurcacao_A"]

    sent = []
    handler(sent.append)                                        # sem context
    assert sent == ["CMD CONTINUE_STRAIGHT", "CMD RESUME_LINE_FOLLOWING"]

    sent = []
    handler(sent.append, context={"next_destination": "linha_2"})
    assert sent == ["CMD TURN_RIGHT", "CMD RESUME_LINE_FOLLOWING"]


def test_lado_direito_id_vira_consulta_ao_context():
    code = generate(
        'station "x" { on_arrival { if destino == origem { stop() } resume_line_following() } }\n' + DEFAULT
    )
    assert "if context.get('destino') == context.get('origem'):" in code

    namespace, _ = load_module(code)
    sent = []
    namespace["STATION_HANDLERS"]["x"](sent.append, context={"destino": "a", "origem": "a"})
    assert sent == ["CMD STOP", "CMD RESUME_LINE_FOLLOWING"]


def test_signal_light_e_mapeado():
    code = generate('station "x" { on_arrival { signal_light() resume_line_following() } }\n' + DEFAULT)
    assert "send_cmd('CMD SIGNAL_LIGHT')" in code


def test_string_com_aspas_gera_python_valido():
    code = generate('station default { on_arrival { log("it\'s \\ ok") wait_signal("o\'k", timeout: none) } }')
    namespace, calls = load_module(code)
    namespace["DEFAULT_HANDLER"](lambda cmd: None)
    assert calls == [("log", "it's \\ ok"), ("wait", "o'k", None)]


def test_nome_de_estacao_vira_identificador_python_unico():
    code = generate(
        'station "default" { on_arrival { resume_line_following() } }\n'
        'station "linha-2" { on_arrival { resume_line_following() } }\n'
        'station "linha 2" { on_arrival { resume_line_following() } }\n' + DEFAULT
    )
    namespace, _ = load_module(code)
    handlers = namespace["STATION_HANDLERS"]
    assert handlers["default"].__name__ == "handle_default_2"
    assert handlers["linha-2"].__name__ == "handle_linha_2"
    assert handlers["linha 2"].__name__ == "handle_linha_2_2"
    assert namespace["DEFAULT_HANDLER"].__name__ == "handle_default"


def test_comando_sem_traducao_levanta_erro():
    # Sem passar pela semântica, para exercitar a defesa do próprio gerador.
    ast = Parser(Lexer('station "x" { on_arrival { station() } }').tokenize()).parse()
    with pytest.raises(CompileError) as exc:
        PythonCodeGenerator(ast).generate()
    diag = exc.value.diagnostic
    assert diag.phase == "codegen"
    assert "'station'" in diag.message
    assert (diag.line, diag.col) == (1, 28)
