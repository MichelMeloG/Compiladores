from pathlib import Path

import pytest

from compiler.roboflow import compile_roboflow

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def test_nunca_lanca_excecao_em_codigo_incompleto():
    # Simula a IDE compilando a cada tecla: todo prefixo do arquivo precisa
    # devolver um Result, nunca IndexError/TypeError/AttributeError.
    source = (EXAMPLES / "rota_completa.rf").read_text(encoding="utf-8")
    for end in range(len(source) + 1):
        result = compile_roboflow(source[:end])
        if not result.ok:
            assert result.errors, f"prefixo de {end} caracteres falhou sem diagnóstico"


def test_resultado_por_fase():
    lexer_err = compile_roboflow("stop(@)")
    assert (lexer_err.ok, lexer_err.errors[0].phase, lexer_err.tokens) == (False, "lexer", [])

    parser_err = compile_roboflow('station "x" {')
    assert (parser_err.ok, parser_err.errors[0].phase) == (False, "parser")
    assert parser_err.tokens            # o lexer rodou; a IDE pode colorir mesmo com erro

    semantic_err = compile_roboflow('station "x" { on_arrival { stop() } }')
    assert {e.phase for e in semantic_err.errors} == {"semantic"}
    assert semantic_err.files == {}

    ok = compile_roboflow((EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8"))
    assert ok.ok and ok.errors == [] and set(ok.files) == {"behavior_generated.hpp", "behavior_generated.cpp"}


def test_alvo_python_continua_disponivel():
    source = (EXAMPLES / "rota_basica.rf").read_text(encoding="utf-8")
    result = compile_roboflow(source, target="python")
    assert result.ok and set(result.files) == {"compiled_behavior.py"}


def test_alvo_desconhecido_e_erro_de_programacao():
    with pytest.raises(ValueError):
        compile_roboflow("", target="rust")
