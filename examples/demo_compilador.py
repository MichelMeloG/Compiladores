"""Demonstração do front-end do compilador RoboFlow (léxico + sintático).

Uso:
    python examples/demo_compilador.py examples/rota_basica.rf
    python examples/demo_compilador.py examples/rota_completa.rf

Sem argumentos, roda examples/rota_completa.rf por padrão.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from compiler.roboflow import Lexer, LexerError, Parser, ParserError


def main() -> None:
    default_path = Path(__file__).resolve().parent / "rota_completa.rf"
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default_path
    source = source_path.read_text(encoding="utf-8")

    print("=" * 70)
    print(f"🏭 CÓDIGO FONTE ROBOFLOW: {source_path}")
    print("=" * 70)
    print(source)

    try:
        tokens = Lexer(source).tokenize()
    except LexerError as exc:
        print(exc)
        sys.exit(1)

    print("=" * 70)
    print("✨ ANÁLISE LÉXICA — TABELA DE TOKENS")
    print("=" * 70)
    for tok in tokens:
        print(tok)

    try:
        ast = Parser(tokens).parse()
    except ParserError as exc:
        print(exc)
        sys.exit(1)

    print("\n" + "=" * 70)
    print("🌳 ANÁLISE SINTÁTICA — ÁRVORE DE SINTAXE ABSTRATA (AST)")
    print("=" * 70)
    print(ast.print_tree())


if __name__ == "__main__":
    main()
