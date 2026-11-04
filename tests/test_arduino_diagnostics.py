"""Posições exibidas no editor RoboFlow devem apontar para a entrada real."""
import unittest
from pathlib import Path

from compiler.roboflow import compile_roboflow


EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "carrinho_autonomo.rf"


class ArduinoDiagnosticLocationTests(unittest.TestCase):
    def setUp(self):
        self.source = EXAMPLE.read_text(encoding="utf-8")

    def line_of(self, source, text):
        return next(i for i, line in enumerate(source.splitlines(), 1) if text in line)

    def test_field_error_identifies_the_line_and_column(self):
        source = self.source.replace("stable_samples: 3", "stable_samples: 0")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(source, "stable_samples:"), 9))

    def test_unknown_field_identifies_the_field_not_the_block(self):
        source = self.source.replace("stable_samples: 3", "amostras: 3")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(source, "amostras:"), 9))

    def test_pin_conflict_points_at_the_repeated_pin_and_cites_the_other_field(self):
        source = self.source.replace("right_pins: [13, 14, 23]", "right_pins: [25, 14, 23]")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        error = result.errors[0]
        self.assertEqual((error.line, error.col), (self.line_of(source, "right_pins:"), 9))
        self.assertIn("pinos de motores e sensores devem ser distintos", error.message)
        self.assertIn("GPIO 25", error.message)
        self.assertIn("motors.left_pins", error.message)
        self.assertIn(f"linha {self.line_of(source, 'left_pins:')}", error.message)

    def test_pin_repeated_in_the_same_list_points_at_that_list(self):
        source = self.source.replace("left_pins: [25, 26, 27]", "left_pins: [25, 25, 27]")
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(source, "left_pins:"), 9))
        self.assertIn("mais de uma vez", result.errors[0].message)

    def test_flash_and_input_only_pins_point_at_the_field(self):
        flash = self.source.replace("left_pins: [25, 26, 27]", "left_pins: [25, 7, 27]")
        result = compile_roboflow(flash, target="arduino")
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(flash, "left_pins:"), 9))
        self.assertIn("GPIO 7", result.errors[0].message)

        input_only = self.source.replace("right_pins: [13, 14, 23]", "right_pins: [13, 14, 35]")
        result = compile_roboflow(input_only, target="arduino")
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(input_only, "right_pins:"), 9))
        self.assertIn("GPIO 35", result.errors[0].message)

    def test_robot_id_error_points_at_the_robot_declaration(self):
        source = self.source.replace('robot "RB-01"', 'robot "' + "x" * 65 + '"')
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(source, "robot "), 1))

    def test_every_semantic_error_has_a_position(self):
        replacements = [
            ("profile autonomous_line_v1", "profile outro"),
            ("board esp32", "board esp8266"),
            ('ssid: "SUA_REDE"', 'ssid: ""'),
            ('password: "SUA_SENHA"', 'password: ""'),
            ('token: "SEGREDO_CADASTRADO_NO_BACKEND"', 'token: "curto"'),
            ('backend: "http://192.168.1.10:8080"', 'backend: "http://192.168.1.10:8080/"'),
            ('backend: "http://192.168.1.10:8080"', 'backend: "ftp://x"'),
            ('backend: "http://192.168.1.10:8080"', 'backend: "https://x"'),
            ("left_pins: [25, 26, 27]", "left_pins: [25, 26]"),
            ("left_direction: 1", "left_direction: 0"),
            ("active_level: high", "active_level: medio"),
            ("straight_power: 150", "straight_power: 300"),
            ("interval: 10ms", "interval: 10"),
            ("max_actions: 16", "max_actions: 17"),
            ("max_events: 12", "max_events: 7"),
            ("route_source: backend", "route_source: local"),
            ("require_start_command: true", "require_start_command: false"),
            ("actions: [forward, right, left]", "actions: [forward, back]"),
            ("left_pins: [25, 26, 27]", "left_pins: [25, 26, 26]"),
            ("pins: [32, 34, 33]", "pins: [32, 34, 25]"),
            ("left_pins: [25, 26, 27]", "left_pins: [25, 8, 27]"),
            ("right_pins: [13, 14, 23]", "right_pins: [13, 14, 39]"),
            ("gentle_inner_power: 110", "gentle_inner_power: 150"),
            ("strong_inner_power: 60", "strong_inner_power: 111"),
            ("turn_timeout: 2500ms", "turn_timeout: 180ms"),
            ("segment_timeout: 15000ms", "segment_timeout: 120ms"),
        ]
        for old, new in replacements:
            with self.subTest(new):
                result = compile_roboflow(self.source.replace(old, new), target="arduino")
                self.assertFalse(result.ok)
                self.assertGreater(result.errors[0].line, 0, result.errors[0].message)


class ArduinoCrossFieldTests(unittest.TestCase):
    """Valores que passam sozinhos, mas que o runtime não consegue executar juntos."""

    def setUp(self):
        self.source = EXAMPLE.read_text(encoding="utf-8")

    def compile(self, *replacements):
        source = self.source
        for old, new in replacements:
            self.assertIn(old, source)
            source = source.replace(old, new)
        return source, compile_roboflow(source, target="arduino")

    def line_of(self, source, text):
        return next(i for i, line in enumerate(source.splitlines(), 1) if text in line)

    def test_reference_example_and_boundary_values_compile(self):
        for label, replacements in {
            "exemplo": [],
            "interna suave logo abaixo da externa": [("gentle_inner_power: 110", "gentle_inner_power: 149")],
            "forte igual à suave": [("strong_inner_power: 60", "strong_inner_power: 110")],
            "curva com limite logo acima do mínimo": [("turn_timeout: 2500ms", "turn_timeout: 181ms")],
            "trecho com limite logo acima do alinhamento": [("segment_timeout: 15000ms", "segment_timeout: 121ms")],
        }.items():
            with self.subTest(label):
                _, result = self.compile(*replacements)
                self.assertTrue(result.ok, [str(e) for e in result.errors])

    def test_inner_wheel_must_be_slower_than_outer_wheel(self):
        for label, new in {"igual": "gentle_inner_power: 150", "maior": "gentle_inner_power: 200"}.items():
            with self.subTest(label):
                source, result = self.compile(("gentle_inner_power: 110", new))
                self.assertFalse(result.ok)
                error = result.errors[0]
                self.assertEqual((error.line, error.col), (self.line_of(source, "gentle_inner_power:"), 9))
                self.assertIn("movement.outer_power", error.message)
                self.assertIn(f"linha {self.line_of(source, 'outer_power:')}", error.message)

    def test_strong_correction_cannot_be_weaker_than_gentle(self):
        source, result = self.compile(("strong_inner_power: 60", "strong_inner_power: 200"))
        self.assertFalse(result.ok)
        self.assertEqual((result.errors[0].line, result.errors[0].col), (self.line_of(source, "strong_inner_power:"), 9))
        self.assertIn("movement.gentle_inner_power", result.errors[0].message)

    def test_turn_timeout_must_exceed_minimum_turn(self):
        for label, new in {"menor": "turn_timeout: 150ms", "igual": "turn_timeout: 180ms"}.items():
            with self.subTest(label):
                source, result = self.compile(("turn_timeout: 2500ms", new))
                self.assertFalse(result.ok)
                error = result.errors[0]
                self.assertEqual((error.line, error.col), (self.line_of(source, "turn_timeout:"), 9))
                self.assertIn("movement.minimum_turn", error.message)

    def test_segment_timeout_must_exceed_alignment(self):
        source, result = self.compile(("segment_timeout: 15000ms", "segment_timeout: 100ms"))
        self.assertFalse(result.ok)
        error = result.errors[0]
        self.assertEqual((error.line, error.col), (self.line_of(source, "segment_timeout:"), 9))
        self.assertIn("movement.alignment", error.message)
        self.assertIn(f"linha {self.line_of(source, 'alignment:')}", error.message)

    def test_conflict_with_an_omitted_default_points_at_the_field_that_exists(self):
        source = self.source.replace("        gentle_inner_power: 110\n", "").replace("outer_power: 150", "outer_power: 100")
        self.assertNotIn("gentle_inner_power", source)
        result = compile_roboflow(source, target="arduino")
        self.assertFalse(result.ok)
        error = result.errors[0]
        self.assertEqual((error.line, error.col), (self.line_of(source, "outer_power:"), 9))
        self.assertIn("valor padrão", error.message)


if __name__ == "__main__":
    unittest.main()
