"""Analisador léxico da linguagem RoboFlow.

Varredura caractere a caractere (com rastreio de linha/coluna) que
reconhece exatamente as classes de token especificadas em
docs/ARQUITETURA_DOS_COMPONENTES.md, seção 10.1:

    WS COMMENT KEYWORD STRING DURATION NUMBER ID
    OP LBRACE RBRACE LPAREN RPAREN COLON COMMA

Regras de desambiguação seguidas à risca (ver implementação abaixo):

- Maximal munch: dígitos seguidos de 's' formam DURATION, nunca
  NUMBER + ID (ex: "30s" é um único token, não "30" e "s").
- Palavra reservada x identificador: o lexer sempre reconhece um
  identificador primeiro e só depois consulta a tabela KEYWORDS — é a
  "implementação equivalente" descrita no documento, não a alternativa de
  ordenar expressões regulares por prioridade.
"""

from typing import List

from .tokens import KEYWORDS, Token, TokenType


class LexerError(SyntaxError):
    pass


class Lexer:
    def __init__(self, source: str):
        self.source = source
        self.pos = 0
        self.line = 1
        self.column = 1
        self.tokens: List[Token] = []

    def tokenize(self) -> List[Token]:
        while self.pos < len(self.source):
            char = self.source[self.pos]

            if char == "\n":
                self.line += 1
                self.column = 1
                self.pos += 1
                continue
            if char.isspace():
                self._advance()
                continue

            # Comentário de linha: // até o fim da linha (descartado)
            if char == "/" and self._peek() == "/":
                while self.pos < len(self.source) and self.source[self.pos] != "\n":
                    self.pos += 1
                continue

            if char == "=" and self._peek() == "=":
                self._emit(TokenType.OP, "==")
                self._advance(2)
                continue

            single_char_tokens = {
                "{": TokenType.LBRACE,
                "}": TokenType.RBRACE,
                "(": TokenType.LPAREN,
                ")": TokenType.RPAREN,
                ":": TokenType.COLON,
                ",": TokenType.COMMA,
            }
            if char in single_char_tokens:
                self._emit(single_char_tokens[char], char)
                self._advance()
                continue

            if char == '"':
                self._read_string()
                continue

            if char.isdigit():
                self._read_number()
                continue

            if char.isalpha() or char == "_":
                self._read_identifier()
                continue

            self._error(f"caractere inesperado {char!r}")

        self.tokens.append(Token(TokenType.EOF, "EOF", self.line, self.column))
        return self.tokens

    # -- leitores de lexema ------------------------------------------------

    def _read_string(self) -> None:
        start_line, start_col = self.line, self.column
        self._advance()  # consome a aspa de abertura
        value = ""
        while self.pos < len(self.source) and self.source[self.pos] != '"':
            if self.source[self.pos] == "\n":
                self._error("string não pode conter quebra de linha (Cometa sem cauda!)")
            value += self.source[self.pos]
            self._advance()
        if self.pos >= len(self.source):
            self._error("string não terminada")
        self._advance()  # consome a aspa de fechamento
        self.tokens.append(Token(TokenType.STRING, value, start_line, start_col))

    def _read_number(self) -> None:
        start_line, start_col = self.line, self.column
        num_str = ""
        is_float = False
        while self.pos < len(self.source) and (
            self.source[self.pos].isdigit() or self.source[self.pos] == "."
        ):
            if self.source[self.pos] == ".":
                if is_float:
                    self._error("número malformado com múltiplos pontos decimais")
                is_float = True
            num_str += self.source[self.pos]
            self._advance()

        # Maximal munch: "30s" vira DURATION, não NUMBER(30) + ID(s).
        if self.pos < len(self.source) and self.source[self.pos] == "s":
            self._advance()
            self.tokens.append(Token(TokenType.DURATION, float(num_str), start_line, start_col))
            return

        value = float(num_str) if is_float else int(num_str)
        self.tokens.append(Token(TokenType.NUMBER, value, start_line, start_col))

    def _read_identifier(self) -> None:
        start_line, start_col = self.line, self.column
        ident = ""
        while self.pos < len(self.source) and (
            self.source[self.pos].isalnum() or self.source[self.pos] == "_"
        ):
            ident += self.source[self.pos]
            self._advance()

        token_type = TokenType.KEYWORD if ident in KEYWORDS else TokenType.ID
        self.tokens.append(Token(token_type, ident, start_line, start_col))

    # -- utilitários de varredura -------------------------------------------

    def _peek(self, offset: int = 1) -> str:
        idx = self.pos + offset
        return self.source[idx] if idx < len(self.source) else ""

    def _advance(self, step: int = 1) -> None:
        self.pos += step
        self.column += step

    def _emit(self, type_: TokenType, value) -> None:
        self.tokens.append(Token(type_, value, self.line, self.column))

    def _error(self, message: str) -> None:
        raise LexerError(f"[Erro léxico] linha {self.line}, coluna {self.column}: {message}")
