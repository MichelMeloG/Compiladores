import pytest

from compiler.roboflow import CompileError, Lexer, Parser
from compiler.roboflow.ast_nodes import (
    CommandCallNode,
    IdentifierNode,
    IfStmtNode,
    LiteralNode,
    NamedArgNode,
)


def parse(source):
    return Parser(Lexer(source).tokenize()).parse()


def parse_error(source):
    with pytest.raises(CompileError) as exc:
        parse(source)
    return exc.value.diagnostic


def test_nos_da_ast_carregam_posicao():
    program = parse(
        'station "carga" {\n'
        '    on_arrival {\n'
        '        wait_signal("ok", timeout: 30s)\n'
        '    }\n'
        '}\n'
    )
    station = program.stations[0]
    assert (station.name, station.line, station.col) == ("carga", 1, 1)

    cmd = station.body[0]
    assert isinstance(cmd, CommandCallNode)
    assert (cmd.name, cmd.line, cmd.col) == ("wait_signal", 3, 9)

    signal, timeout = cmd.args
    assert signal == LiteralNode("ok", "STRING", 3, 21)
    assert timeout == NamedArgNode("timeout", LiteralNode(30.0, "DURATION", 3, 36), 3, 27)


def test_if_else_e_condicao():
    program = parse(
        'station "b" { on_arrival {\n'
        '    if destino == outro { turn_right() } else { continue_straight() }\n'
        '} }'
    )
    stmt = program.stations[0].body[0]
    assert isinstance(stmt, IfStmtNode)
    assert (stmt.line, stmt.col) == (2, 5)
    assert stmt.condition.left == IdentifierNode("destino", 2, 8)
    assert stmt.condition.right == IdentifierNode("outro", 2, 19)
    assert [c.name for c in stmt.then_branch] == ["turn_right"]
    assert [c.name for c in stmt.else_branch] == ["continue_straight"]


def test_dois_defaults_nao_se_sobrescrevem():
    program = parse(
        "station default { on_arrival { stop() } }\n"
        "station default { on_arrival { log(\"x\") } }"
    )
    defaults = [s for s in program.stations if s.is_default]
    assert [s.line for s in defaults] == [1, 2]


@pytest.mark.parametrize("source", [
    "station",
    'station "x"',
    'station "x" {',
    'station "x" { on_arrival { stop(',
    'station "x" { on_arrival { wait_signal("a", timeout:',
    'station "x" { on_arrival { if x ==',
    'station "x" { on_arrival { if x == "a" { stop() }',
    'station "x" { on_arrival { stop() }   // comentário no fim\n\n',
])
def test_fim_de_arquivo_inesperado_aponta_ultimo_token(source):
    diag = parse_error(source)
    last_real = Lexer(source).tokenize()[-2]
    assert diag.phase == "parser"
    assert diag.message.startswith("fim de arquivo inesperado")
    assert (diag.line, diag.col) == (last_real.line, last_real.col)


def test_lado_direito_da_condicao_precisa_ser_string_ou_id():
    diag = parse_error('station "x" { on_arrival { if x == 30 { stop() } } }')
    assert "string ou um identificador" in diag.message
    assert (diag.line, diag.col) == (1, 36)


def test_erro_no_meio_aponta_o_token_encontrado():
    diag = parse_error('station "x" { stop() }')
    assert "on_arrival" in diag.message
    assert (diag.line, diag.col) == (1, 15)
