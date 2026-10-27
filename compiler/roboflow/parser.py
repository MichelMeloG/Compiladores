"""Analisador sintático (parser) da linguagem RoboFlow.

Descida recursiva sobre a sintaxe resumida em docs/ARQUITETURA_DOS_COMPONENTES.md, seção 10.1:

    program        ::= station_decl*
    station_decl   ::= "station" (STRING | "default") "{" "on_arrival" "{" stmt_list "}" "}"
    stmt_list      ::= stmt*
    stmt           ::= command_call | if_stmt
    command_call   ::= KEYWORD "(" arg_list? ")"
    arg_list       ::= arg ("," arg)*
    arg            ::= STRING | NUMBER | DURATION | ID | timeout_arg
    timeout_arg    ::= "timeout" ":" (DURATION | "none")
    if_stmt        ::= "if" condition "{" stmt_list "}" ("else" "{" stmt_list "}")?
    condition      ::= ID "==" (STRING | ID)

A gramática é deliberadamente mais permissiva que a linguagem: aceita
qualquer KEYWORD como nome de comando e qualquer quantidade de `default`.
Essas restrições são checadas em semantic.py (RF3001/RF3002/RF3003).

Entrada incompleta (comum quando a IDE compila a cada tecla) nunca gera
IndexError/TypeError: todo erro vira um CompileError com posição.
"""

from typing import List, NoReturn

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
from .diagnostics import CompileError, Diagnostic
from .tokens import Token, TokenType


class Parser:
    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.current = 0

    # -- utilitários de navegação ------------------------------------------

    def peek(self) -> Token:
        return self.tokens[self.current]

    def previous(self) -> Token:
        return self.tokens[self.current - 1]

    def is_at_end(self) -> bool:
        return self.peek().type == TokenType.EOF

    def advance(self) -> Token:
        if not self.is_at_end():
            self.current += 1
        return self.previous()

    def check(self, type_: TokenType, value=None) -> bool:
        if self.is_at_end():
            return False
        tok = self.peek()
        if tok.type != type_:
            return False
        return value is None or tok.value == value

    def match(self, type_: TokenType, value=None) -> bool:
        if self.check(type_, value):
            self.advance()
            return True
        return False

    def consume(self, type_: TokenType, value=None, message: str = "") -> Token:
        if self.check(type_, value):
            return self.advance()
        expected = type_.name if value is None else f"{type_.name} {value!r}"
        self._error(message or f"esperado {expected}")

    def _error(self, message: str) -> NoReturn:
        tok = self.peek()
        if tok.type == TokenType.EOF and self.current > 0:
            # O EOF fica depois de espaços e comentários finais; o último token
            # real é onde o programador parou de digitar.
            last = self.tokens[self.current - 1]
            raise CompileError(Diagnostic(
                "parser", "error", f"fim de arquivo inesperado: {message}", last.line, last.col,
            ))
        raise CompileError(Diagnostic(
            "parser", "error", f"{message} (encontrado {tok.value!r})", tok.line, tok.col,
        ))

    # -- gramática -----------------------------------------------------------

    def parse(self) -> ProgramNode:
        stations: List[StationNode] = []
        while not self.is_at_end():
            stations.append(self.station_decl())
        return ProgramNode(stations)

    def station_decl(self) -> StationNode:
        kw = self.consume(TokenType.KEYWORD, "station", "esperado 'station'")

        is_default = self.match(TokenType.KEYWORD, "default")
        name = None
        if not is_default:
            name = self.consume(TokenType.STRING, message="esperado o nome da estação (string)").value

        self.consume(TokenType.LBRACE, message="esperado '{' após o cabeçalho da estação")
        self.consume(TokenType.KEYWORD, "on_arrival", "esperado 'on_arrival'")
        self.consume(TokenType.LBRACE, message="esperado '{' para o bloco on_arrival")

        body = self.stmt_list()

        self.consume(TokenType.RBRACE, message="esperado '}' para fechar on_arrival")
        self.consume(TokenType.RBRACE, message="esperado '}' para fechar a estação")

        return StationNode(name, is_default, body, kw.line, kw.col)

    def stmt_list(self) -> List[ASTNode]:
        stmts: List[ASTNode] = []
        while not self.check(TokenType.RBRACE) and not self.is_at_end():
            stmts.append(self.stmt())
        return stmts

    def stmt(self) -> ASTNode:
        if self.check(TokenType.KEYWORD, "if"):
            return self.if_stmt()
        return self.command_call()

    def command_call(self) -> CommandCallNode:
        name_tok = self.consume(TokenType.KEYWORD, message="esperado o nome de um comando")

        self.consume(TokenType.LPAREN, message=f"esperado '(' após '{name_tok.value}'")
        args: List[ASTNode] = []
        if not self.check(TokenType.RPAREN):
            args.append(self.arg())
            while self.match(TokenType.COMMA):
                args.append(self.arg())
        self.consume(TokenType.RPAREN, message=f"esperado ')' para fechar '{name_tok.value}'")

        return CommandCallNode(name_tok.value, args, name_tok.line, name_tok.col)

    def arg(self) -> ASTNode:
        if self.check(TokenType.KEYWORD, "timeout"):
            return self.timeout_arg()
        for type_ in (TokenType.STRING, TokenType.NUMBER, TokenType.DURATION):
            if self.match(type_):
                tok = self.previous()
                return LiteralNode(tok.value, type_.value, tok.line, tok.col)
        if self.match(TokenType.ID):
            tok = self.previous()
            return IdentifierNode(tok.value, tok.line, tok.col)
        self._error("argumento inválido")

    def timeout_arg(self) -> NamedArgNode:
        kw = self.consume(TokenType.KEYWORD, "timeout")
        self.consume(TokenType.COLON, message="esperado ':' após 'timeout'")

        if self.match(TokenType.DURATION):
            tok = self.previous()
            value = LiteralNode(tok.value, "DURATION", tok.line, tok.col)
        elif self.match(TokenType.KEYWORD, "none"):
            tok = self.previous()
            value = LiteralNode(None, "NONE", tok.line, tok.col)
        else:
            self._error("esperado uma duração (ex: 30s) ou 'none' após 'timeout:'")

        return NamedArgNode("timeout", value, kw.line, kw.col)

    def if_stmt(self) -> IfStmtNode:
        kw = self.consume(TokenType.KEYWORD, "if")
        condition = self.condition()

        self.consume(TokenType.LBRACE, message="esperado '{' após a condição do if")
        then_branch = self.stmt_list()
        self.consume(TokenType.RBRACE, message="esperado '}' para fechar o bloco if")

        else_branch = None
        if self.match(TokenType.KEYWORD, "else"):
            self.consume(TokenType.LBRACE, message="esperado '{' após 'else'")
            else_branch = self.stmt_list()
            self.consume(TokenType.RBRACE, message="esperado '}' para fechar o bloco else")

        return IfStmtNode(condition, then_branch, else_branch, kw.line, kw.col)

    def condition(self) -> ConditionNode:
        left_tok = self.consume(TokenType.ID, message="esperado identificador na condição")
        self.consume(TokenType.OP, "==", "esperado '==' na condição")

        if self.match(TokenType.STRING):
            tok = self.previous()
            right: ASTNode = LiteralNode(tok.value, "STRING", tok.line, tok.col)
        elif self.match(TokenType.ID):
            tok = self.previous()
            right = IdentifierNode(tok.value, tok.line, tok.col)
        else:
            self._error("a condição precisa comparar com uma string ou um identificador")

        left = IdentifierNode(left_tok.value, left_tok.line, left_tok.col)
        return ConditionNode(left, "==", right, left_tok.line, left_tok.col)
