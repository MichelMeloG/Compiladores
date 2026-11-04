"""CLI mínima: python -m compiler.roboflow compile input.rf --output sketch.ino"""
import argparse
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys

from .compiler import compile_roboflow


def _serve(host: str, port: int) -> int:
    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            origin = self.headers.get("Origin", "")
            if origin in ("http://localhost:3000", "http://127.0.0.1:3000"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self):
            self.send_response(204); self._cors()
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            if self.path != "/health":
                self.send_error(404); return
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers(); self.wfile.write(b'{"ok":true}')

        def do_POST(self):
            if self.path != "/compile":
                self.send_error(404); return
            origin = self.headers.get("Origin", "")
            if origin not in ("http://localhost:3000", "http://127.0.0.1:3000"):
                self.send_error(403, "Origem não permitida"); return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 512 * 1024: raise ValueError("requisição deve ter até 512 KiB")
                payload = json.loads(self.rfile.read(size))
                source = payload.get("source")
                if not isinstance(source, str): raise ValueError("campo source deve ser texto")
                result = compile_roboflow(source, target="arduino")
                response = {"ok": result.ok, "errors": [str(e) for e in result.errors],
                            "diagnostics": [asdict(e) for e in result.errors], "files": result.files}
                body = json.dumps(response, ensure_ascii=False).encode("utf-8")
                self.send_response(200 if result.ok else 422)
            except (ValueError, json.JSONDecodeError) as exc:
                body = json.dumps({"ok": False, "errors": [str(exc)], "files": {}}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
            self._cors(); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, fmt, *args):
            # Não imprimir corpos, que podem conter credenciais.
            print(f"[roboflow-api] {self.address_string()} {args[0]}")

    server = ThreadingHTTPServer((host, port), Handler)
    print(f"API do compilador RoboFlow em http://{host}:{port} (Ctrl+C para encerrar)")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="roboflow")
    commands = parser.add_subparsers(dest="command", required=True)
    compile_cmd = commands.add_parser("compile", help="compila um programa RoboFlow")
    compile_cmd.add_argument("source", type=Path)
    compile_cmd.add_argument("--target", choices=("arduino", "cpp", "python"), default="arduino")
    compile_cmd.add_argument("--output", type=Path)
    serve_cmd = commands.add_parser("serve", help="inicia a API local usada pela interface web")
    serve_cmd.add_argument("--host", default="127.0.0.1")
    serve_cmd.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.command == "serve":
        return _serve(args.host, args.port)
    if args.source.suffix.lower() != ".rf":
        print("erro: a entrada deve ter extensão .rf", file=sys.stderr)
        return 2
    try:
        source = args.source.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        print(f"erro ao ler {args.source}: {exc}", file=sys.stderr)
        return 2
    result = compile_roboflow(source, target=args.target)
    if not result.ok:
        for diagnostic in result.errors:
            print(f"{diagnostic.phase}:{diagnostic.line}:{diagnostic.col}: {diagnostic.message}", file=sys.stderr)
        return 1
    for name, content in result.files.items():
        destination = args.output or (Path("build/carrinho_autonomo/carrinho_autonomo.ino") if args.target == "arduino" else Path("build") / name)
        if args.output and len(result.files) > 1:
            destination.mkdir(parents=True, exist_ok=True)
            destination = destination / name
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8", newline="\n")
        except OSError as exc:
            print(f"erro ao gravar {destination}: {exc}", file=sys.stderr)
            return 2
        print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
