"""Ponto de entrada do compilador: código-fonte RoboFlow -> `Result`.

Feito para ser chamado a cada tecla pela IDE: nunca lança exceção por causa do
código-fonte, sempre devolve um `Result` com os diagnósticos da fase em que parou.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .codegen_cpp import CppCodeGenerator
from .codegen_python import PythonCodeGenerator
from .diagnostics import CompileError, Diagnostic
from .lexer import Lexer
from .parser import Parser
from .semantic import SemanticAnalyzer
from .tokens import Token

PYTHON_FILE = "compiled_behavior.py"

TARGETS = ("cpp", "python")


@dataclass
class Result:
    ok: bool
    errors: List[Diagnostic] = field(default_factory=list)
    warnings: List[Diagnostic] = field(default_factory=list)
    tokens: List[Token] = field(default_factory=list)
    files: Dict[str, str] = field(default_factory=dict)     # nome do arquivo -> conteúdo


def compile_roboflow(source: str, config: Optional[dict] = None, target: str = "cpp") -> Result:
    """`target="cpp"` gera behavior_generated.hpp/.cpp para o ESP32;
    `target="python"` gera compiled_behavior.py (etapa futura com Raspberry Pi)."""
    if target not in TARGETS:
        raise ValueError(f"alvo desconhecido {target!r}; use um de {TARGETS}")

    try:
        tokens = Lexer(source).tokenize()
    except CompileError as exc:
        return Result(ok=False, errors=[exc.diagnostic])

    try:
        ast = Parser(tokens).parse()
    except CompileError as exc:
        return Result(ok=False, errors=[exc.diagnostic], tokens=tokens)

    analyzer = SemanticAnalyzer(ast, config)
    if not analyzer.analyze():
        return Result(ok=False, errors=analyzer.errors, warnings=analyzer.warnings, tokens=tokens)

    try:
        if target == "cpp":
            files = CppCodeGenerator(ast).generate()
        else:
            files = {PYTHON_FILE: PythonCodeGenerator(ast).generate()}
    except CompileError as exc:
        return Result(ok=False, errors=[exc.diagnostic], warnings=analyzer.warnings, tokens=tokens)

    return Result(ok=True, warnings=analyzer.warnings, tokens=tokens, files=files)
