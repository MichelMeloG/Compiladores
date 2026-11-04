"""Posições exibidas no editor RoboFlow devem apontar para a entrada real."""
import unittest
from pathlib import Path

from compiler.roboflow import compile_roboflow


EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "carrinho_autonomo.rf"


class ArduinoDiagnosticLocationTests(unittest.TestCase):
    def setUp(self):
        self.source = EXAMPLE.read_text(encoding="utf-8")

    def test_field_error_identifies_the_line_and_column(self):
        source = self.source.replace("stable_samples: 3", "stable_samples: 0")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        expected_line = next(i for i, line in enumerate(source.splitlines(), 1) if "stable_samples:" in line)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (expected_line, 9))

    def test_unknown_field_identifies_the_field_not_the_block(self):
        source = self.source.replace("stable_samples: 3", "amostras: 3")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        expected_line = next(i for i, line in enumerate(source.splitlines(), 1) if "amostras:" in line)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (expected_line, 9))

    def test_cross_field_error_does_not_claim_a_specific_line(self):
        source = self.source.replace("right_pins: [13, 14, 23]", "right_pins: [25, 14, 23]")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (0, 0))


if __name__ == "__main__":
    unittest.main()
