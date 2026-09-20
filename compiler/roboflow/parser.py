"""Analisador sintático (parser) da linguagem RoboFlow.

Descida recursiva (recursive descent) sobre a gramática BNF de
docs/linguagem/LINGUAGEM_ROBO_COMPILADOR.md, seção 3, detalhada
(arg_list / timeout_arg) em docs/linguagem/COMPILADOR_GERA_CONTROLE.md,
Fase 2:

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

Escopo desta fase (só léxico + sintático): o parser aceita qualquer
KEYWORD como nome de comando e não valida se uma estação `default` existe,
se é única, ou se cada comando pertence à biblioteca padrão — essas
checagens são análise semântica (catálogo RF3001/RF3002/RF3003 do
roadmap) e ficam para uma fase futura, não implementada aqui.
"""

from typing import List, NoReturn, Optional

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
from .tokens import Token, TokenType


class ParserError(SyntaxError):
    pass


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
        raise ParserError(
            f"[Erro sintático] linha {tok.line}, coluna {tok.column}, "
            f"perto de {tok.value!r}: {message}"
        )

    # -- gramática -----------------------------------------------------------

    def parse(self) -> ProgramNode:
        stations: List[StationNode] = []
        default: Optional[StationNode] = None

        while not self.is_at_end():
            station = self.station_decl()
            if station.is_default:
                default = station
            else:
                stations.append(station)

        return ProgramNode(stations, default)

    def station_decl(self) -> StationNode:
        self.consume(TokenType.KEYWORD, "station", "esperado 'station'")

        is_default = self.match(TokenType.KEYWORD, "default")
        name = None
        if not is_default:
            name_tok = self.consume(TokenType.STRING, message="esperado o nome da estação (string)")
            name = name_tok.value

        self.consume(TokenType.LBRACE, message="esperado '{' após o cabeçalho da estação")
        self.consume(TokenType.KEYWORD, "on_arrival", "esperado 'on_arrival'")
        self.consume(TokenType.LBRACE, message="esperado '{' para o bloco on_arrival")

        body = self.stmt_list()

        self.consume(TokenType.RBRACE, message="esperado '}' para fechar on_arrival")
        self.consume(TokenType.RBRACE, message="esperado '}' para fechar a estação")

        return StationNode(name, is_default, body)

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

        return CommandCallNode(name_tok.value, args)

    def arg(self) -> ASTNode:
        if self.check(TokenType.KEYWORD, "timeout"):
            return self.timeout_arg()
        if self.match(TokenType.STRING):
            return LiteralNode(self.previous().value, "STRING")
        if self.match(TokenType.NUMBER):
            return LiteralNode(self.previous().value, "NUMBER")
        if self.match(TokenType.DURATION):
            return LiteralNode(self.previous().value, "DURATION")
        if self.match(TokenType.ID):
            return IdentifierNode(self.previous().value)
        self._error("argumento inválido")

    def timeout_arg(self) -> NamedArgNode:
        self.consume(TokenType.KEYWORD, "timeout")
        self.consume(TokenType.COLON, message="esperado ':' após 'timeout'")

        if self.match(TokenType.DURATION):
            value: ASTNode = LiteralNode(self.previous().value, "DURATION")
        elif self.match(TokenType.KEYWORD, "none"):
            value = LiteralNode(None, "NONE")
        else:
            self._error("esperado uma duração (ex: 30s) ou 'none' após 'timeout:'")

        return NamedArgNode("timeout", value)

    def if_stmt(self) -> IfStmtNode:
        self.consume(TokenType.KEYWORD, "if")
        condition = self.condition()

        self.consume(TokenType.LBRACE, message="esperado '{' após a condição do if")
        then_branch = self.stmt_list()
        self.consume(TokenType.RBRACE, message="esperado '}' para fechar o bloco if")

        else_branch = None
        if self.match(TokenType.KEYWORD, "else"):
            self.consume(TokenType.LBRACE, message="esperado '{' após 'else'")
            else_branch = self.stmt_list()
            self.consume(TokenType.RBRACE, message="esperado '}' para fechar o bloco else")

        return IfStmtNode(condition, then_branch, else_branch)

    def condition(self) -> ConditionNode:
        left_tok = self.consume(TokenType.ID, message="esperado identificador na condição")
        self.consume(TokenType.OP, "==", "esperado '==' na condição")

        if self.match(TokenType.STRING):
            right: ASTNode = LiteralNode(self.previous().value, "STRING")
        elif self.match(TokenType.ID):
            right = IdentifierNode(self.previous().value)
        else:
            self._error("condição precisa comparar com uma string ou identificador")

        return ConditionNode(IdentifierNode(left_tok.value), "==", right)
