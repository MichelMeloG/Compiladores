"""Vocabulário da linguagem RoboFlow: classes de token, catálogo de comandos e
palavras reservadas.

Espelha a especificação léxica formal de
docs/linguagem/LINGUAGEM_ROBO_COMPILADOR.md, seção 2.1: cada classe de
token abaixo corresponde a uma linha da tabela de expressões regulares
daquele documento (WS e COMMENT são descartados pelo lexer e por isso não
viram TokenType).
"""

import enum
from typing import Any, Dict, NamedTuple, Tuple


class TokenType(str, enum.Enum):
    """Herda de `str` para que `TokenType.KEYWORD == "KEYWORD"` seja verdade."""

    KEYWORD = "KEYWORD"      # station, on_arrival, stop, if, timeout, none, ...
    ID = "ID"                # identificadores (ex: next_destination)
    STRING = "STRING"        # "texto entre aspas"
    NUMBER = "NUMBER"        # 0.15, 30
    DURATION = "DURATION"    # 30s (valor em segundos, já convertido p/ float)
    OP = "OP"                # ==
    LBRACE = "LBRACE"        # {
    RBRACE = "RBRACE"        # }
    LPAREN = "LPAREN"        # (
    RPAREN = "RPAREN"        # )
    COLON = "COLON"          # :
    COMMA = "COMMA"          # ,
    EOF = "EOF"


# Biblioteca padrão: nome -> (aridade, tipos dos argumentos, em ordem).
# Tipos são classes de token ("STRING", "NUMBER") ou "TIMEOUT", o argumento
# nomeado `timeout: <duração | none>`. Única fonte de verdade sobre comandos:
# análise semântica, gerador de código e IDE (autocomplete/highlight) leem daqui.
COMMANDS: Dict[str, Tuple[int, Tuple[str, ...]]] = {
    "stop":                  (0, ()),
    "set_speed":             (1, ("NUMBER",)),
    "turn_left":             (0, ()),
    "turn_right":            (0, ()),
    "continue_straight":     (0, ()),
    "signal_buzzer":         (0, ()),
    "signal_light":          (0, ()),
    "wait_signal":           (2, ("STRING", "TIMEOUT")),
    "log":                   (1, ("STRING",)),
    "resume_line_following": (0, ()),
}

# Palavras reservadas (LINGUAGEM_ROBO_COMPILADOR.md, §2.1). Qualquer
# identificador fora desta tabela vira TokenType.ID.
KEYWORDS = {
    "station", "default", "on_arrival",                        # estrutura
    "timeout", "none",                                         # espera
    "if", "else",                                              # condicional
} | set(COMMANDS)                                              # comandos


class Token(NamedTuple):
    type: TokenType
    value: Any
    line: int
    col: int

    def __repr__(self) -> str:
        return f"Token({self.type.name:<8} {self.value!r}, {self.line}:{self.col})"
