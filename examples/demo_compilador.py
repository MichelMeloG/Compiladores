"""Demonstração do compilador RoboFlow (alvo ESP32), fase a fase.

Uso:
    python examples/demo_compilador.py [arquivo.rf] [config.json]

Sem argumentos, compila examples/rota_completa.rf sem configuração de pista.
O config.json é opcional e aceita as chaves descritas em
compiler/roboflow/semantic.py (commissioned_stations, max_speed, context_vars).
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compiler.roboflow import CompileError, Lexer, Parser, compile_roboflow

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def banner(title: str) -> None:
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def main() -> None:
    default_path = Path(__file__).resolve().parent / "rota_completa.rf"
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default_path
    config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")) if len(sys.argv) > 2 else {}
    source = source_path.read_text(encoding="utf-8")

    banner(f"🏭 CÓDIGO FONTE ROBOFLOW: {source_path}")
    print(source)

    try:
        tokens = Lexer(source).tokenize()
        banner("✨ FASE 1 — ANÁLISE LÉXICA (TABELA DE TOKENS)")
        for tok in tokens:
            print(tok)

        ast = Parser(tokens).parse()
        banner("🌳 FASE 2 — ANÁLISE SINTÁTICA (AST)")
        print(ast.print_tree())
    except CompileError as exc:
        print(exc)
        sys.exit(1)

    result = compile_roboflow(source, config)

    banner("✅ FASE 3 — ANÁLISE SEMÂNTICA")
    for diag in result.warnings + result.errors:
        print(diag)
    if result.ok and not result.warnings:
        print("Nenhum problema encontrado.")
    if not result.ok:
        sys.exit(1)

    for name, text in result.files.items():
        banner(f"🔧 FASE 4 — CÓDIGO GERADO ({name})")
        print(text)


if __name__ == "__main__":
    main()
