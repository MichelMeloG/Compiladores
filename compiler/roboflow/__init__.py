"""Compilador RoboFlow: front-end léxico e sintático. Ver docs/ARQUITETURA_DOS_COMPONENTES.md, seção 10. Análise semântica e geração de código ainda não estão implementadas."""

from .lexer import Lexer, LexerError
from .parser import Parser, ParserError
from .tokens import KEYWORDS, Token, TokenType

__all__ = [
    "Lexer",
    "LexerError",
    "Parser",
    "ParserError",
    "Token",
    "TokenType",
    "KEYWORDS",
]
