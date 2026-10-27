"""Testes do gerador C++.

Os testes `compiled_*` compilam o C++ gerado de verdade (-std=c++11 -Wall -Wextra
-Werror) contra o robot_runtime.hpp real, com um runtime falso (tests/cpp/harness.cpp),
e o executam em cenários. Precisam de um compilador C++: g++/clang++/c++ no PATH,
ou o comando completo na variável ROBOFLOW_CXX (ex: "python -m ziglang c++").
Sem compilador, esses testes são pulados.
"""

import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest

from compiler.roboflow import CompileError, CppCodeGenerator, Lexer, Parser, compile_roboflow

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"
DEFAULT = 'station default { on_arrival { stop() wait_signal("manual_override", timeout: none) } }\n'


def find_compiler():
    if os.environ.get("ROBOFLOW_CXX"):
        return shlex.split(os.environ["ROBOFLOW_CXX"])
    for name in ("g++", "clang++", "c++"):
        if shutil.which(name):
            return [name]
    return None


needs_compiler = pytest.mark.skipif(find_compiler() is None, reason="sem compilador C++ (defina ROBOFLOW_CXX)")


def generate(source):
    result = compile_roboflow(source)
    assert result.ok, [str(e) for e in result.errors]
    return result.files


@pytest.fixture
def run_scenario(tmp_path):
    """Compila o código gerado com o harness e devolve a saída da execução."""
    def run(source, script):
        files = generate(source)
        for name, text in files.items():
            (tmp_path / name).write_text(text, encoding="utf-8")
        exe = tmp_path / "harness.exe"
        subprocess.run(
            [*find_compiler(), "-std=c++11", "-Wall", "-Wextra", "-Werror",
             "-I", str(ROOT / "firmware" / "include"), "-I", str(tmp_path),
             str(ROOT / "tests" / "cpp" / "harness.cpp"), str(tmp_path / "behavior_generated.cpp"),
             "-o", str(exe)],
            check=True, capture_output=True, text=True,
        )
        out = subprocess.run([str(exe)], input=script, capture_output=True, text=True, check=True)
        return out.stdout.splitlines()
    return run


# -- estrutura do código gerado (não precisa de compilador) --------------------------

def test_gera_header_e_source():
    files = generate((EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8"))
    assert set(files) == {"behavior_generated.hpp", "behavior_generated.cpp"}
    assert "STATION_BIFURCACAO_A," in files["behavior_generated.hpp"]
    assert files["behavior_generated.hpp"].rstrip().endswith("bool stationBehaviorActive();")


def test_saida_e_deterministica():
    source = (EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8")
    assert generate(source) == generate(source)


def test_codigo_gerado_nao_bloqueia_nem_toca_hardware():
    cpp = generate((EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8"))["behavior_generated.cpp"]
    for forbidden in ("delay", "digitalWrite", "analogWrite", "ledc", "Serial"):
        assert forbidden not in cpp


def test_strings_viram_literais_ascii_escapados():
    cpp = generate(
        'station default { on_arrival { log("ação \\ ?? x") wait_signal("o\'k", timeout: none) } }'
    )["behavior_generated.cpp"]
    assert cpp.isascii()
    assert 'RobotRuntime::log("a\\303\\247\\303\\243o \\\\ \\?\\? x");' in cpp


def test_nomes_de_estacao_viram_enum_unico():
    header = generate(
        'station "default" { on_arrival { resume_line_following() } }\n'
        'station "linha-2" { on_arrival { resume_line_following() } }\n'
        'station "Linha 2" { on_arrival { resume_line_following() } }\n' + DEFAULT
    )["behavior_generated.hpp"]
    for name in ("STATION_DEFAULT_2,", "STATION_LINHA_2,", "STATION_LINHA_2_2,", "STATION_DEFAULT,"):
        assert name in header


def test_so_default_gera_lookup_sem_tabela_vazia():
    cpp = generate(DEFAULT)["behavior_generated.cpp"]
    assert "StationId stationIdFromName(const char*) {" in cpp
    assert "kNames" not in cpp


def test_timeout_acima_do_limite_levanta_erro():
    result = compile_roboflow(
        'station default { on_arrival { wait_signal("x", timeout: 3000000s) resume_line_following() } }'
    )
    assert not result.ok
    assert (result.errors[0].phase, result.errors[0].line, result.errors[0].col) == ("codegen", 1, 58)
    assert "excede o máximo" in result.errors[0].message

    assert compile_roboflow(
        'station default { on_arrival { wait_signal("x", timeout: 2000000s) resume_line_following() } }'
    ).ok


def test_comando_sem_traducao_levanta_erro():
    ast = Parser(Lexer('station "x" { on_arrival { station() } }\nstation default { on_arrival { } }').tokenize()).parse()
    with pytest.raises(CompileError) as exc:
        CppCodeGenerator(ast).generate()
    assert exc.value.diagnostic.phase == "codegen"
    assert (exc.value.diagnostic.line, exc.value.diagnostic.col) == (1, 28)


# -- C++ compilado e executado ---------------------------------------------------

@needs_compiler
def test_compiled_exemplos_compilam_sem_warnings(run_scenario):
    for example in ("rota_basica.rf", "rota_completa.rf"):
        run_scenario((EXAMPLES / example).read_text(encoding="utf-8"), "")


@needs_compiler
def test_compiled_wait_signal_nao_bloqueia_e_segue_quando_o_sinal_chega(run_scenario):
    source = (EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8")
    assert run_scenario(source, "start carga\ntick 0\ntick 10\nsignal carga_completa\ntick 20\ntick 30\n") == [
        "stop", "signalLight", "-- t=0 active=1",
        "-- t=10 active=1",
        "resumeLineFollowing", "-- t=20 active=0",
        "-- t=30 active=0",
    ]


@needs_compiler
def test_compiled_timeout_expira_e_segue(run_scenario):
    source = (EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8")
    assert run_scenario(source, "start carga\ntick 100\ntick 30099\ntick 30100\n") == [
        "stop", "signalLight", "-- t=100 active=1",
        "-- t=30099 active=1",
        "resumeLineFollowing", "-- t=30100 active=0",
    ]


@needs_compiler
def test_compiled_timeout_none_espera_para_sempre_ate_o_sinal(run_scenario):
    source = (EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8")
    script = "start marcador_desconhecido\ntick 0\ntick 4000000000\nsignal manual_override\ntick 4000000001\n"
    assert run_scenario(source, script) == [
        "stop", "log Estacao desconhecida", "-- t=0 active=1",
        "-- t=4000000000 active=1",
        "-- t=4000000001 active=0",
    ]


@needs_compiler
@pytest.mark.parametrize("context, expected", [
    ("ctx next_destination linha_2\n", ["turnRight"]),
    ("ctx next_destination linha_9\n", ["continueStraight"]),
    ("", ["continueStraight"]),                                  # sem a variável: cai no else
])
def test_compiled_if_else_escolhe_o_ramo_pelo_contexto(run_scenario, context, expected):
    source = (EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8")
    out = run_scenario(source, context + "start bifurcacao_A\ntick 0\n")
    assert out == [*expected, "resumeLineFollowing", "-- t=0 active=0"]


@needs_compiler
def test_compiled_if_aninhado_sem_else_e_comparacao_entre_variaveis(run_scenario):
    source = (
        'station "x" { on_arrival {\n'
        '  if a == b { if a == "v" { signalLight_placeholder } }\n'
        '  resume_line_following()\n'
        '} }\n' + DEFAULT
    ).replace("signalLight_placeholder", "signal_light()")
    run = lambda ctx: run_scenario(source, ctx + "start x\ntick 0\n")
    assert run("ctx a v\nctx b v\n") == ["signalLight", "resumeLineFollowing", "-- t=0 active=0"]
    assert run("ctx a v\nctx b w\n") == ["resumeLineFollowing", "-- t=0 active=0"]
    assert run("ctx a v\n") == ["resumeLineFollowing", "-- t=0 active=0"]       # b ausente
    assert run("ctx a w\nctx b w\n") == ["resumeLineFollowing", "-- t=0 active=0"]


@needs_compiler
def test_compiled_comandos_sao_traduzidos(run_scenario):
    source = (
        'station "x" { on_arrival { set_speed(1) set_speed(0.15) turn_left() signal_buzzer() '
        'log("it\'s") resume_line_following() } }\n' + DEFAULT
    )
    assert run_scenario(source, "start x\ntick 0\n") == [
        "setSpeed 1", "setSpeed 0.15", "turnLeft", "signalBuzzer", "log it's",
        "resumeLineFollowing", "-- t=0 active=0",
    ]


@needs_compiler
def test_compiled_nova_estacao_substitui_a_que_estava_rodando(run_scenario):
    source = (EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8")
    out = run_scenario(source, "start carga\ntick 0\nstart descarga\nsignal descarga_completa\ntick 5\n")
    assert out == [
        "stop", "signalLight", "-- t=0 active=1",
        "stop", "resumeLineFollowing", "-- t=5 active=0",
    ]
