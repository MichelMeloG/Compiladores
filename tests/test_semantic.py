import pytest

from compiler.roboflow import compile_roboflow

DEFAULT = 'station default { on_arrival { stop() wait_signal("manual_override", timeout: none) } }\n'


def station(body, name="x"):
    """Estação de uma linha cujo corpo começa na coluna 28."""
    return f'station "{name}" {{ on_arrival {{ {body} }} }}\n'


def messages(result):
    return [e.message for e in result.errors]


# -- testes originais de COMPILADOR_GERA_CONTROLE.md -------------------------

def test_rejeita_estacao_sem_terminacao():
    src = '''station "bifurcacao_A" {
    on_arrival {
        if next_destination == "linha_2" {
            turn_right()
            resume_line_following()
        } else {
            continue_straight()
        }
    }
}
''' + DEFAULT
    result = compile_roboflow(src, {"commissioned_stations": ["bifurcacao_A"]})
    assert not result.ok
    assert "'bifurcacao_A'" in result.errors[0].message
    assert "não termina em resume_line_following()" in result.errors[0].message
    assert (result.errors[0].line, result.errors[0].col) == (1, 1)


def test_rejeita_estacao_faltando():
    src = station("stop() resume_line_following()", name="carga")
    result = compile_roboflow(src, {"commissioned_stations": ["carga", "descarga"]})
    assert not result.ok
    assert any("descarga" in m for m in messages(result))


def test_aceita_programa_valido():
    src = station('stop() wait_signal("carga_completa", timeout: 30s) resume_line_following()', "carga") + DEFAULT
    result = compile_roboflow(src, {"commissioned_stations": ["carga"]})
    assert result.ok, messages(result)
    assert result.errors == []
    assert "STATION_CARGA" in result.files["behavior_generated.hpp"]
    assert "step_carga" in result.files["behavior_generated.cpp"]
    assert "carga_completa" in result.files["behavior_generated.cpp"]


# -- catálogo de comandos -----------------------------------------------------

@pytest.mark.parametrize("body, message, col", [
    ("station() resume_line_following()", "comando desconhecido 'station'", 28),
    ("stop(1) resume_line_following()", "'stop' espera 0 argumento(s), recebeu 1", 28),
    ('set_speed("a") resume_line_following()', "argumento 1 de 'set_speed' deve ser número, recebeu string", 38),
    ('wait_signal("a", 30s) resume_line_following()',
     "argumento 2 de 'wait_signal' deve ser 'timeout: <duração | none>', recebeu duração", 45),
    ("log(destino) resume_line_following()", "argumento 1 de 'log' deve ser string, recebeu identificador", 32),
])
def test_valida_comando_aridade_e_tipos(body, message, col):
    result = compile_roboflow(station(body) + DEFAULT)
    assert not result.ok
    assert result.errors[0].message == message
    assert (result.errors[0].phase, result.errors[0].line, result.errors[0].col) == ("semantic", 1, col)


def test_set_speed_respeita_limite_fisico():
    src = station("set_speed(300) resume_line_following()") + DEFAULT
    result = compile_roboflow(src, {"max_speed": 200})
    assert messages(result) == ["velocidade 300 excede o máximo 200"]
    assert (result.errors[0].line, result.errors[0].col) == (1, 38)

    assert compile_roboflow(src, {"max_speed": 300}).ok
    assert compile_roboflow(src).ok


# -- station default ----------------------------------------------------------

def test_exige_station_default():
    result = compile_roboflow(station("resume_line_following()"))
    assert messages(result) == ["o programa precisa de uma 'station default'"]


def test_rejeita_station_default_duplicada():
    result = compile_roboflow(DEFAULT + DEFAULT)
    assert messages(result) == ["'station default' declarada mais de uma vez"]
    assert (result.errors[0].line, result.errors[0].col) == (2, 1)


def test_rejeita_estacao_duplicada():
    src = station("resume_line_following()") + station("resume_line_following()") + DEFAULT
    result = compile_roboflow(src)
    assert messages(result) == ["estação 'x' definida mais de uma vez"]
    assert result.errors[0].line == 2


def test_estacao_comissionada_sem_bloco_usa_default_com_aviso():
    src = station("resume_line_following()", name="carga") + DEFAULT
    result = compile_roboflow(src, {"commissioned_stations": ["carga", "descarga"]})
    assert result.ok
    assert [w.message for w in result.warnings] == [
        "estação 'descarga' não tem bloco próprio e usará o comportamento default"
    ]


# -- variáveis de contexto ----------------------------------------------------

def test_context_vars_valida_identificadores_da_condicao():
    src = station('if destino == origem { stop() } resume_line_following()') + DEFAULT
    result = compile_roboflow(src, {"context_vars": ["destino"]})
    assert messages(result) == ["variável de contexto 'origem' não declarada em context_vars"]
    assert (result.errors[0].line, result.errors[0].col) == (1, 42)

    assert compile_roboflow(src, {"context_vars": ["destino", "origem"]}).ok
    assert compile_roboflow(src).ok   # sem context_vars, a checagem não roda
