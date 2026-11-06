"""Segredos do carrinho podem vir do ambiente, sem entrar no .rf versionado."""
import os
import unittest
from pathlib import Path
from unittest import mock

from compiler.roboflow import compile_roboflow

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "carrinho_autonomo.rf"


class EnvSecretsTests(unittest.TestCase):
    def test_variaveis_de_ambiente_substituem_os_placeholders(self):
        env = {"ROBOFLOW_TOKEN": "t" * 40, "ROBOFLOW_SSID": "RedeReal", "ROBOFLOW_PASSWORD": "senha-real-123"}
        with mock.patch.dict(os.environ, env):
            result = compile_roboflow(EXAMPLE.read_text(encoding="utf-8"), target="arduino")
        self.assertTrue(result.ok, result.errors)
        code = next(iter(result.files.values())) if hasattr(result, "files") else str(result)
        self.assertIn("t" * 40, code)
        self.assertNotIn("SEGREDO_CADASTRADO_NO_BACKEND", code)

    def test_token_curto_do_ambiente_e_recusado(self):
        with mock.patch.dict(os.environ, {"ROBOFLOW_TOKEN": "curto"}):
            result = compile_roboflow(EXAMPLE.read_text(encoding="utf-8"), target="arduino")
        self.assertFalse(result.ok)


if __name__ == "__main__":
    unittest.main()
