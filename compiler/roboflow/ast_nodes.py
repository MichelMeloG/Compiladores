"""Nós da AST (Árvore de Sintaxe Abstrata) da linguagem RoboFlow.

Espelha a gramática BNF de docs/linguagem/LINGUAGEM_ROBO_COMPILADOR.md,
seção 3, detalhada (arg_list / timeout_arg) em
docs/linguagem/COMPILADOR_GERA_CONTROLE.md, Fase 2.

Todo nó carrega `line`/`col` do token que o inicia, para que a análise
semântica aponte o erro no ponto exato do código-fonte.
"""

from dataclasses import dataclass
from typing import Any, List, Optional


def _branch(indent: str, is_last: bool) -> str:
    return indent + ("└── " if is_last else "├── ")


def _child_indent(indent: str, is_last: bool) -> str:
    return indent + ("    " if is_last else "│   ")


class ASTNode:
    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        raise NotImplementedError


@dataclass
class LiteralNode(ASTNode):
    value: Any
    type_name: str      # "STRING" | "NUMBER" | "DURATION" | "NONE"
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        return f"{_branch(indent, is_last)}💎 {self.type_name}: {self.value!r}\n"


@dataclass
class IdentifierNode(ASTNode):
    """Referência a uma variável de contexto (ex: next_destination)."""

    name: str
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        return f"{_branch(indent, is_last)}🔖 ID: {self.name}\n"


@dataclass
class NamedArgNode(ASTNode):
    """Argumento nomeado de um comando (hoje, só `timeout: <valor>`)."""

    name: str
    value: LiteralNode
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}🏷️ {self.name}:\n"
        res += self.value.print_tree(_child_indent(indent, is_last), True)
        return res


@dataclass
class CommandCallNode(ASTNode):
    name: str
    args: List[ASTNode]
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}⚙️ COMMAND: {self.name}()\n"
        new_indent = _child_indent(indent, is_last)
        for i, arg in enumerate(self.args):
            res += arg.print_tree(new_indent, i == len(self.args) - 1)
        return res


@dataclass
class ConditionNode(ASTNode):
    left: IdentifierNode
    op: str
    right: ASTNode      # LiteralNode (STRING) ou IdentifierNode
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}⚖️ ({self.op})\n"
        new_indent = _child_indent(indent, is_last)
        res += self.left.print_tree(new_indent, False)
        res += self.right.print_tree(new_indent, True)
        return res


@dataclass
class IfStmtNode(ASTNode):
    condition: ConditionNode
    then_branch: List[ASTNode]
    else_branch: Optional[List[ASTNode]]
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}🚦 IF\n"
        new_indent = _child_indent(indent, is_last)
        has_else = bool(self.else_branch)

        res += f"{new_indent}├── ❓ Condition:\n"
        res += self.condition.print_tree(new_indent + "│   ", True)

        then_marker = "├── " if has_else else "└── "
        res += f"{new_indent}{then_marker}✅ Then:\n"
        then_indent = new_indent + ("│   " if has_else else "    ")
        for i, stmt in enumerate(self.then_branch):
            res += stmt.print_tree(then_indent, i == len(self.then_branch) - 1)

        if has_else:
            res += f"{new_indent}└── 🔀 Else:\n"
            else_indent = new_indent + "    "
            for i, stmt in enumerate(self.else_branch):
                res += stmt.print_tree(else_indent, i == len(self.else_branch) - 1)
        return res


@dataclass
class StationNode(ASTNode):
    name: Optional[str]     # None quando is_default
    is_default: bool
    body: List[ASTNode]
    line: int
    col: int

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        label = "🎯 STATION default" if self.is_default else f'🏭 STATION "{self.name}"'
        res = f"{_branch(indent, is_last)}{label}\n"
        new_indent = _child_indent(indent, is_last)
        if not self.body:
            res += f"{new_indent}└── (bloco vazio)\n"
        for i, stmt in enumerate(self.body):
            res += stmt.print_tree(new_indent, i == len(self.body) - 1)
        return res


@dataclass
class ProgramNode(ASTNode):
    """Todas as estações na ordem do código, `default` inclusive — quantas
    `default` existem é verificado na análise semântica (RF3002)."""

    stations: List[StationNode]
    line: int = 1
    col: int = 1

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}📄 PROGRAM\n"
        new_indent = _child_indent(indent, is_last)
        for i, station in enumerate(self.stations):
            res += station.print_tree(new_indent, i == len(self.stations) - 1)
        return res
