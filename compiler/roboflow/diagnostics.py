"""Diagnósticos estruturados, compartilhados por todas as fases do compilador.

Lexer, parser e gerador de código param no primeiro erro e lançam
`CompileError`; o analisador semântico acumula vários `Diagnostic` sem lançar.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Diagnostic:
    phase: str       # "lexer" | "parser" | "semantic" | "codegen"
    severity: str    # "error" | "warning"
    message: str
    line: int
    col: int

    def __str__(self) -> str:
        return f"{self.line}:{self.col}: {self.severity} [{self.phase}] {self.message}"


class CompileError(Exception):
    def __init__(self, diagnostic: Diagnostic):
        super().__init__(str(diagnostic))
        self.diagnostic = diagnostic
