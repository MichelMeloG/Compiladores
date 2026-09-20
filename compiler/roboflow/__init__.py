"""Compilador RoboFlow — front-end (análise léxica e sintática).

Implementa o lexer e o parser descritos em
docs/linguagem/LINGUAGEM_ROBO_COMPILADOR.md (seção 2.1 e 3) e detalhados em
docs/linguagem/COMPILADOR_GERA_CONTROLE.md (Fase 1 e Fase 2). Análise
semântica e geração de código (Fases 3+ do roadmap) não fazem parte deste
pacote ainda.
"""

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
