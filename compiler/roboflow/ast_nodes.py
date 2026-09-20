"""Nós da AST (Árvore de Sintaxe Abstrata) da linguagem RoboFlow.

Espelha a gramática BNF de docs/linguagem/LINGUAGEM_ROBO_COMPILADOR.md,
seção 3, detalhada (arg_list / timeout_arg) em
docs/linguagem/COMPILADOR_GERA_CONTROLE.md, Fase 2.
"""

from typing import Any, List, Optional


def _branch(indent: str, is_last: bool) -> str:
    return indent + ("└── " if is_last else "├── ")


def _child_indent(indent: str, is_last: bool) -> str:
    return indent + ("    " if is_last else "│   ")


class ASTNode:
    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        raise NotImplementedError


class LiteralNode(ASTNode):
    """STRING, NUMBER, DURATION ou NONE (o "none" de timeout: none)."""

    def __init__(self, value: Any, type_name: str):
        self.value = value
        self.type_name = type_name

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        return f"{_branch(indent, is_last)}💎 {self.type_name}: {self.value!r}\n"


class IdentifierNode(ASTNode):
    """Referência a uma variável de contexto (ex: next_destination)."""

    def __init__(self, name: str):
        self.name = name

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        return f"{_branch(indent, is_last)}🔖 ID: {self.name}\n"


class NamedArgNode(ASTNode):
    """Argumento nomeado de um comando (hoje, só `timeout: <valor>`)."""

    def __init__(self, name: str, value: ASTNode):
        self.name = name
        self.value = value

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}🏷️ {self.name}:\n"
        new_indent = _child_indent(indent, is_last)
        res += self.value.print_tree(new_indent, True)
        return res


class CommandCallNode(ASTNode):
    def __init__(self, name: str, args: List[ASTNode]):
        self.name = name
        self.args = args

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}⚙️ COMMAND: {self.name}()\n"
        new_indent = _child_indent(indent, is_last)
        for i, arg in enumerate(self.args):
            res += arg.print_tree(new_indent, i == len(self.args) - 1)
        return res


class ConditionNode(ASTNode):
    def __init__(self, left: IdentifierNode, op: str, right: ASTNode):
        self.left = left
        self.op = op
        self.right = right

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}⚖️ ({self.op})\n"
        new_indent = _child_indent(indent, is_last)
        res += self.left.print_tree(new_indent, False)
        res += self.right.print_tree(new_indent, True)
        return res


class IfStmtNode(ASTNode):
    def __init__(
        self,
        condition: ConditionNode,
        then_branch: List[ASTNode],
        else_branch: Optional[List[ASTNode]],
    ):
        self.condition = condition
        self.then_branch = then_branch
        self.else_branch = else_branch

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


class StationNode(ASTNode):
    def __init__(self, name: Optional[str], is_default: bool, body: List[ASTNode]):
        self.name = name
        self.is_default = is_default
        self.body = body

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        label = "🎯 STATION default" if self.is_default else f'🏭 STATION "{self.name}"'
        res = f"{_branch(indent, is_last)}{label}\n"
        new_indent = _child_indent(indent, is_last)
        if not self.body:
            res += f"{new_indent}└── (bloco vazio)\n"
        for i, stmt in enumerate(self.body):
            res += stmt.print_tree(new_indent, i == len(self.body) - 1)
        return res


class ProgramNode(ASTNode):
    def __init__(self, stations: List[StationNode], default: Optional[StationNode]):
        self.stations = stations
        self.default = default

    def print_tree(self, indent: str = "", is_last: bool = True) -> str:
        res = f"{_branch(indent, is_last)}📄 PROGRAM\n"
        new_indent = _child_indent(indent, is_last)
        children: List[StationNode] = list(self.stations)
        if self.default is not None:
            children.append(self.default)
        for i, child in enumerate(children):
            res += child.print_tree(new_indent, i == len(children) - 1)
        return res
