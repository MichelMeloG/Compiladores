"""Analisador semântico da linguagem RoboFlow.

Verifica sobre a AST as propriedades que a gramática não expressa
(LINGUAGEM_ROBO_COMPILADOR.md, §4). Nunca lança exceção: acumula
`Diagnostic`s em `errors` e `warnings`, para a IDE mostrar todos de uma vez.

Chaves de `config` (todas opcionais; sem a chave, a checagem não roda):
    commissioned_stations  estações físicas da pista -> completude
    max_speed              limite físico do motor -> set_speed(v)
    context_vars           variáveis que o ESP32 envia no `context`; se
                           presente, todo ID de uma condição precisa estar nela
"""

from typing import List, Optional

from .ast_nodes import (
    ASTNode,
    CommandCallNode,
    ConditionNode,
    IdentifierNode,
    IfStmtNode,
    LiteralNode,
    NamedArgNode,
    ProgramNode,
    StationNode,
)
from .diagnostics import Diagnostic
from .tokens import COMMANDS

_TYPE_NAMES = {
    "STRING": "string",
    "NUMBER": "número",
    "DURATION": "duração",
    "NONE": "none",
    "ID": "identificador",
    "TIMEOUT": "'timeout: <duração | none>'",
}


def _arg_type(arg: ASTNode) -> str:
    if isinstance(arg, LiteralNode):
        return arg.type_name
    if isinstance(arg, IdentifierNode):
        return "ID"
    return arg.name.upper()     # NamedArgNode: "timeout" -> "TIMEOUT"


def _is_infinite_wait(cmd: CommandCallNode) -> bool:
    return cmd.name == "wait_signal" and any(
        isinstance(arg, NamedArgNode) and arg.name == "timeout" and arg.value.type_name == "NONE"
        for arg in cmd.args
    )


def _all_paths_terminate(stmts: List[ASTNode]) -> bool:
    """Todo caminho termina em resume_line_following() ou wait_signal(..., timeout: none)?
    Um `if` só termina se os dois ramos terminarem; sem `else`, o caminho
    "condição falsa" segue para depois do `if`."""
    if not stmts:
        return False
    last = stmts[-1]
    if isinstance(last, CommandCallNode):
        return last.name == "resume_line_following" or _is_infinite_wait(last)
    if isinstance(last, IfStmtNode):
        return (
            _all_paths_terminate(last.then_branch)
            and last.else_branch is not None
            and _all_paths_terminate(last.else_branch)
        )
    return False


class SemanticAnalyzer:
    def __init__(self, ast: ProgramNode, config: Optional[dict] = None):
        self.ast = ast
        self.config = config or {}
        self.errors: List[Diagnostic] = []
        self.warnings: List[Diagnostic] = []

    def analyze(self) -> bool:
        stations = self.ast.stations
        self._check_single_default(stations)
        self._check_duplicate_names(stations)
        self._check_completeness(stations)
        for station in stations:
            self._check_stmts(station.body)
            self._check_termination(station)
        return not self.errors

    # -- programa ------------------------------------------------------------

    def _check_single_default(self, stations: List[StationNode]) -> None:
        defaults = [s for s in stations if s.is_default]
        if not defaults:
            self._error("o programa precisa de uma 'station default'", self.ast)
        for extra in defaults[1:]:
            self._error("'station default' declarada mais de uma vez", extra)

    def _check_duplicate_names(self, stations: List[StationNode]) -> None:
        seen = set()
        for station in stations:
            if station.is_default:
                continue
            if station.name in seen:
                self._error(f"estação '{station.name}' definida mais de uma vez", station)
            seen.add(station.name)

    def _check_completeness(self, stations: List[StationNode]) -> None:
        commissioned = self.config.get("commissioned_stations")
        if not commissioned:
            return
        defined = {s.name for s in stations if not s.is_default}
        missing = [name for name in commissioned if name not in defined]
        if not missing:
            return
        if any(s.is_default for s in stations):
            for name in missing:
                self._warning(f"estação '{name}' não tem bloco próprio e usará o comportamento default", self.ast)
        else:
            self._error(f"estações sem comportamento e sem default: {', '.join(missing)}", self.ast)

    def _check_termination(self, station: StationNode) -> None:
        if _all_paths_terminate(station.body):
            return
        label = "default" if station.is_default else f"'{station.name}'"
        self._error(
            f"estação {label}: existe caminho que não termina em resume_line_following() "
            f"nem em wait_signal(..., timeout: none) — o AGV pode travar permanentemente",
            station,
        )

    # -- statements ----------------------------------------------------------

    def _check_stmts(self, stmts: List[ASTNode]) -> None:
        for stmt in stmts:
            if isinstance(stmt, CommandCallNode):
                self._check_command(stmt)
            elif isinstance(stmt, IfStmtNode):
                self._check_condition(stmt.condition)
                self._check_stmts(stmt.then_branch)
                self._check_stmts(stmt.else_branch or [])

    def _check_command(self, cmd: CommandCallNode) -> None:
        signature = COMMANDS.get(cmd.name)
        if signature is None:
            self._error(f"comando desconhecido '{cmd.name}'", cmd)
            return

        arity, expected_types = signature
        if len(cmd.args) != arity:
            self._error(f"'{cmd.name}' espera {arity} argumento(s), recebeu {len(cmd.args)}", cmd)
            return

        types_ok = True
        for i, (arg, expected) in enumerate(zip(cmd.args, expected_types), start=1):
            actual = _arg_type(arg)
            if actual != expected:
                types_ok = False
                self._error(
                    f"argumento {i} de '{cmd.name}' deve ser {_TYPE_NAMES[expected]}, "
                    f"recebeu {_TYPE_NAMES.get(actual, actual)}",
                    arg,
                )

        max_speed = self.config.get("max_speed")
        if cmd.name == "set_speed" and types_ok and max_speed is not None:
            speed = cmd.args[0]
            if speed.value > max_speed:
                self._error(f"velocidade {speed.value} excede o máximo {max_speed}", speed)

    def _check_condition(self, cond: ConditionNode) -> None:
        context_vars = self.config.get("context_vars")
        if context_vars is None:
            return
        for side in (cond.left, cond.right):
            if isinstance(side, IdentifierNode) and side.name not in context_vars:
                self._error(f"variável de contexto '{side.name}' não declarada em context_vars", side)

    # -- diagnósticos --------------------------------------------------------

    def _error(self, message: str, node: ASTNode) -> None:
        self.errors.append(Diagnostic("semantic", "error", message, node.line, node.col))

    def _warning(self, message: str, node: ASTNode) -> None:
        self.warnings.append(Diagnostic("semantic", "warning", message, node.line, node.col))
