"""Tokens e palavras reservadas da linguagem RoboFlow. Ver docs/ARQUITETURA_DOS_COMPONENTES.md, seção 10.1."""

import enum
from typing import Any


class TokenType(enum.Enum):
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


# Palavras reservadas da linguagem (ver arquitetura, seção 10.1).
# Qualquer identificador que não esteja nesta tabela vira TokenType.ID.
KEYWORDS = {
    "station", "default", "on_arrival",                        # estrutura
    "stop", "set_speed", "turn_left", "turn_right",
    "continue_straight", "resume_line_following",
    "signal_buzzer", "signal_light", "log",                    # comandos
    "wait_signal", "timeout", "none",                          # espera
    "if", "else",                                              # condicional
}


class Token:
    def __init__(self, type_: TokenType, value: Any, line: int, column: int):
        self.type = type_
        self.value = value
        self.line = line
        self.column = column
