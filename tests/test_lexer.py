import pytest

from compiler.roboflow import CompileError, Lexer, TokenType


def tokens_of(source):
    return [(t.type, t.value, t.line, t.col) for t in Lexer(source).tokenize()]


def test_tokens_carregam_linha_e_coluna():
    source = 'station "carga" {\n    on_arrival {\n        stop()'
    assert tokens_of(source) == [
        (TokenType.KEYWORD, "station", 1, 1),
        (TokenType.STRING, "carga", 1, 9),
        (TokenType.LBRACE, "{", 1, 17),
        (TokenType.KEYWORD, "on_arrival", 2, 5),
        (TokenType.LBRACE, "{", 2, 16),
        (TokenType.KEYWORD, "stop", 3, 9),
        (TokenType.LPAREN, "(", 3, 13),
        (TokenType.RPAREN, ")", 3, 14),
        (TokenType.EOF, "EOF", 3, 15),
    ]


def test_token_continua_indexavel_como_tupla():
    tok = Lexer("station").tokenize()[0]
    assert tok[0] == "KEYWORD"
    assert tok[1] == "station"


def test_comentario_descartado_ainda_conta_coluna():
    assert tokens_of("stop() // fim") == [
        (TokenType.KEYWORD, "stop", 1, 1),
        (TokenType.LPAREN, "(", 1, 5),
        (TokenType.RPAREN, ")", 1, 6),
        (TokenType.EOF, "EOF", 1, 14),
    ]


def test_duration_vence_number_por_maximal_munch():
    assert tokens_of("30s 0.15 1")[:3] == [
        (TokenType.DURATION, 30.0, 1, 1),
        (TokenType.NUMBER, 0.15, 1, 5),
        (TokenType.NUMBER, 1, 1, 10),
    ]


def test_identificador_fora_da_tabela_vira_id():
    assert tokens_of("next_destination")[0][:2] == (TokenType.ID, "next_destination")


@pytest.mark.parametrize("source, message, line, col", [
    ("stop(@)", "caractere inesperado '@'", 1, 6),
    ('log("abc', "string não terminada", 1, 5),
    ('log("ab\nc")', "string não pode conter quebra de linha", 1, 5),
    ("set_speed(1.2.3)", "múltiplos pontos decimais", 1, 14),
])
def test_erros_lexicos_apontam_posicao(source, message, line, col):
    with pytest.raises(CompileError) as exc:
        Lexer(source).tokenize()
    diag = exc.value.diagnostic
    assert diag.phase == "lexer"
    assert message in diag.message
    assert (diag.line, diag.col) == (line, col)
