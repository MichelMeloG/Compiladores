"""Compilador RoboFlow: .rf -> C++ para o ESP32.

Fases (docs/linguagem/COMPILADOR_GERA_CONTROLE.md):
    lexer.py          Fase 1 — análise léxica
    parser.py         Fase 2 — análise sintática e AST (ast_nodes.py)
    semantic.py       Fase 3 — análise semântica
    codegen_cpp.py    Fase 4 — geração de C++ (alvo atual: ESP32)
    codegen_python.py Fase 4 — geração de Python (etapa futura com Raspberry Pi)
    compiler.py       compile_roboflow(), que encadeia as quatro
"""

from .ast_nodes import ProgramNode
from .codegen_cpp import CppCodeGenerator
from .codegen_python import PythonCodeGenerator
from .compiler import Result, compile_roboflow
from .diagnostics import CompileError, Diagnostic
from .lexer import Lexer
from .parser import Parser
from .semantic import SemanticAnalyzer
from .tokens import COMMANDS, KEYWORDS, Token, TokenType

__all__ = [
    "compile_roboflow",
    "Result",
    "Diagnostic",
    "CompileError",
    "Lexer",
    "Parser",
    "SemanticAnalyzer",
    "CppCodeGenerator",
    "PythonCodeGenerator",
    "ProgramNode",
    "Token",
    "TokenType",
    "KEYWORDS",
    "COMMANDS",
]
