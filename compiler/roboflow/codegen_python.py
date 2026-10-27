"""Gerador de código Python: AST -> módulo `compiled_behavior.py`.

Alvo da etapa futura com Raspberry Pi. O alvo atual é o ESP32, gerado por
codegen_cpp.py.

Uma função `handle_<estação>(send_cmd, context=None)` por bloco `station`,
mais o despacho `STATION_HANDLERS` / `DEFAULT_HANDLER` que o
`station_runner.py` consulta (COMPILADOR_GERA_CONTROLE.md, Fase 4).

Pressupõe uma AST aprovada pela análise semântica (aridade e tipos dos
argumentos já validados).
"""

import re
from typing import List, Set

from .ast_nodes import (
    ASTNode,
    CommandCallNode,
    IdentifierNode,
    IfStmtNode,
    NamedArgNode,
    ProgramNode,
)
from .diagnostics import CompileError, Diagnostic
from .tokens import COMMANDS

_HEADER = '"""Gerado automaticamente pelo compilador RoboFlow. Não editar manualmente."""'


def _uses_context(body: List[ASTNode]) -> bool:
    # Só condições leem o context, e um if aninhado sempre está dentro de outro
    # if do corpo — então basta olhar o primeiro nível.
    return any(isinstance(stmt, IfStmtNode) for stmt in body)


class PythonCodeGenerator:
    def __init__(self, ast: ProgramNode):
        self.ast = ast
        self.lines: List[str] = []

    def generate(self) -> str:
        self.lines = [_HEADER, ""]
        used_names: Set[str] = {"handle_default"}
        handlers = []

        for station in self.ast.stations:
            if not station.is_default:
                fname = self._function_name(station.name, used_names)
                self._emit_function(fname, station.body)
                handlers.append((station.name, fname))

        default = next((s for s in self.ast.stations if s.is_default), None)
        if default is not None:
            self._emit_function("handle_default", default.body)

        self.lines.append("STATION_HANDLERS = {")
        for station_id, fname in handlers:
            self.lines.append(f"    {station_id!r}: {fname},")
        self.lines.append("}")
        if default is not None:
            self.lines += ["", "DEFAULT_HANDLER = handle_default"]
        return "\n".join(self.lines) + "\n"

    @staticmethod
    def _function_name(station_id: str, used_names: Set[str]) -> str:
        # O nome da estação é uma string livre ("bifurcação A", "default"...);
        # o da função precisa ser um identificador Python válido e único.
        base = "handle_" + re.sub(r"\W", "_", station_id, flags=re.ASCII)
        fname, n = base, 2
        while fname in used_names:
            fname, n = f"{base}_{n}", n + 1
        used_names.add(fname)
        return fname

    def _emit_function(self, fname: str, body: List[ASTNode]) -> None:
        self.lines.append(f"def {fname}(send_cmd, context=None):")
        if _uses_context(body):
            self.lines.append("    context = context or {}")
        self._emit_stmts(body, "    ")
        self.lines.append("")

    def _emit_stmts(self, stmts: List[ASTNode], indent: str) -> None:
        if not stmts:
            self.lines.append(f"{indent}pass")
        for stmt in stmts:
            if isinstance(stmt, IfStmtNode):
                self._emit_if(stmt, indent)
            else:
                self._emit_command(stmt, indent)

    def _emit_command(self, cmd: CommandCallNode, indent: str) -> None:
        if cmd.name == "set_speed":
            serial_cmd = f"CMD SET_SPEED {cmd.args[0].value}"
            line = f"send_cmd({serial_cmd!r})"
        elif cmd.name == "wait_signal":
            signal, timeout = cmd.args
            line = f"wait_for_signal({signal.value!r}, timeout={self._timeout_value(timeout)})"
        elif cmd.name == "log":
            line = f"log_event({cmd.args[0].value!r})"
        elif cmd.name in COMMANDS and COMMANDS[cmd.name][0] == 0:
            serial_cmd = f"CMD {cmd.name.upper()}"
            line = f"send_cmd({serial_cmd!r})"
        else:
            raise CompileError(Diagnostic(
                "codegen", "error", f"comando sem tradução para Python: '{cmd.name}'", cmd.line, cmd.col,
            ))
        self.lines.append(indent + line)

    @staticmethod
    def _timeout_value(arg: NamedArgNode) -> str:
        if arg.value.type_name == "NONE":
            return "None"
        return repr(arg.value.value)

    def _emit_if(self, stmt: IfStmtNode, indent: str) -> None:
        cond = stmt.condition
        left = f"context.get({cond.left.name!r})"
        if isinstance(cond.right, IdentifierNode):
            right = f"context.get({cond.right.name!r})"
        else:
            right = repr(cond.right.value)

        self.lines.append(f"{indent}if {left} {cond.op} {right}:")
        self._emit_stmts(stmt.then_branch, indent + "    ")
        if stmt.else_branch:
            self.lines.append(f"{indent}else:")
            self._emit_stmts(stmt.else_branch, indent + "    ")
