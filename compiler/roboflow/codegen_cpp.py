"""Gerador de código C++ (ESP32): AST -> behavior_generated.hpp / .cpp.

Cada `station` vira uma função `step_<estação>` que é uma máquina de estados:
um `switch` sobre um contador `pc`, onde cada `case` é uma instrução. O `if`
vira desvio entre `case`s. `wait_signal` NÃO bloqueia: sem o sinal, a função
devolve `false` e o `loop()` do firmware segue (sensores, PID e veto de
segurança continuam rodando); na volta seguinte retoma do mesmo `case`.

O código gerado só chama a API declarada em firmware/include/robot_runtime.hpp
— nunca pinos ou motores. Compila como C++11, o mínimo do núcleo Arduino-ESP32.

Semântica de `wait_signal(nome, timeout: t)`: segue para a próxima instrução
quando o sinal chega ou quando `t` expira; com `timeout: none` espera para
sempre. Pressupõe uma AST aprovada pela análise semântica.
"""

import re
from typing import Dict, List, Set, Tuple

from .ast_nodes import ASTNode, CommandCallNode, IdentifierNode, IfStmtNode, ProgramNode, StationNode
from .diagnostics import CompileError, Diagnostic

HEADER_FILE = "behavior_generated.hpp"
SOURCE_FILE = "behavior_generated.cpp"

_BANNER = "// Gerado automaticamente pelo compilador RoboFlow. Nao editar manualmente."

_RUNTIME_CALLS = {
    "stop": "stop",
    "turn_left": "turnLeft",
    "turn_right": "turnRight",
    "continue_straight": "continueStraight",
    "signal_buzzer": "signalBuzzer",
    "signal_light": "signalLight",
    "resume_line_following": "resumeLineFollowing",
}

# A comparação de prazos usa subtração com sinal (imune ao estouro de millis()),
# o que só vale para esperas menores que 2^31 ms (~24,8 dias).
_MAX_WAIT_MS = 0x7FFFFFFF

_Op = Tuple  # ("do", [linhas]) | ("wait", sinal, ms|None) | ("branch", cond, rótulo) | ("jump", rótulo) | ("label", rótulo)


def _cpp_string(text: str) -> str:
    """Literal C++ em ASCII puro: bytes UTF-8 viram escapes octais (3 dígitos,
    sem ambiguidade com o caractere seguinte) e `?` é escapado contra trigrafos."""
    out = []
    for byte in text.encode("utf-8"):
        char = chr(byte)
        if char in '\\"?':
            out.append("\\" + char)
        elif 32 <= byte < 127:
            out.append(char)
        else:
            out.append(f"\\{byte:03o}")
    return '"' + "".join(out) + '"'


def _cpp_float(value) -> str:
    return f"{float(value)!r}f"


class CppCodeGenerator:
    def __init__(self, ast: ProgramNode):
        self.ast = ast
        self._ops: List[_Op] = []
        self._label_count = 0

    def generate(self) -> Dict[str, str]:
        default = next((s for s in self.ast.stations if s.is_default), None)
        if default is None:
            raise CompileError(Diagnostic("codegen", "error", "programa sem 'station default'", 1, 1))

        used = {"DEFAULT"}
        stations: List[Tuple[StationNode, str]] = [
            (s, self._unique_key(s.name, used)) for s in self.ast.stations if not s.is_default
        ]
        stations.append((default, "DEFAULT"))

        return {
            HEADER_FILE: self._header(stations),
            SOURCE_FILE: self._source(stations),
        }

    @staticmethod
    def _unique_key(station_name: str, used: Set[str]) -> str:
        # O nome da estação é uma string livre; o do enum precisa ser um
        # identificador C++ válido e único (sem diferenciar maiúsculas).
        base = re.sub(r"\W", "_", station_name, flags=re.ASCII).upper()
        key, n = base, 2
        while key in used:
            key, n = f"{base}_{n}", n + 1
        used.add(key)
        return key

    # -- arquivos ------------------------------------------------------------

    def _header(self, stations: List[Tuple[StationNode, str]]) -> str:
        lines = [
            _BANNER,
            "#pragma once",
            "",
            "#include <stdint.h>",
            "",
            "enum class StationId : uint8_t {",
            *[f"    STATION_{key}," for _, key in stations],
            "};",
            "",
            "// Nome do marcador -> estacao. Nome desconhecido devolve STATION_DEFAULT.",
            "StationId stationIdFromName(const char* name);",
            "",
            "// Inicia o on_arrival da estacao (substitui o que estiver rodando).",
            "void startStationBehavior(StationId station);",
            "",
            "// Avanca o comportamento sem bloquear. Chamar a cada volta do loop().",
            "void updateStationBehavior(unsigned long nowMs);",
            "",
            "// true enquanto o comportamento iniciado ainda nao terminou.",
            "bool stationBehaviorActive();",
        ]
        return "\n".join(lines) + "\n"

    def _source(self, stations: List[Tuple[StationNode, str]]) -> str:
        lines = [
            _BANNER,
            f'#include "{HEADER_FILE}"',
            "",
            "#include <string.h>",
            "",
            '#include "robot_runtime.hpp"',
            "",
            "namespace {",
            "",
            "struct StationFrame {",
            "    uint16_t pc;",
            "    bool waiting;",
            "    unsigned long deadlineMs;",
            "};",
            "",
            "typedef bool (*StepFn)(StationFrame&, unsigned long);",
            "",
        ]
        for station, key in stations:
            lines += self._step_function(station, key)

        lines += ["const StepFn kSteps[] = {"]
        lines += [f"    step_{key.lower()}," for _, key in stations]
        lines += [
            "};",
            "",
            "StationFrame g_frame = {0, false, 0};",
            "StationId g_current = StationId::STATION_DEFAULT;",
            "bool g_active = false;",
            "",
            "}  // namespace",
            "",
        ]
        lines += self._name_lookup(stations)
        lines += [
            "",
            "void startStationBehavior(StationId station) {",
            "    g_current = station;",
            "    g_frame = StationFrame{0, false, 0};",
            "    g_active = true;",
            "}",
            "",
            "void updateStationBehavior(unsigned long nowMs) {",
            "    if (!g_active) {",
            "        return;",
            "    }",
            "    if (kSteps[static_cast<uint8_t>(g_current)](g_frame, nowMs)) {",
            "        g_active = false;",
            "    }",
            "}",
            "",
            "bool stationBehaviorActive() {",
            "    return g_active;",
            "}",
        ]
        return "\n".join(lines) + "\n"

    @staticmethod
    def _name_lookup(stations: List[Tuple[StationNode, str]]) -> List[str]:
        named = [(s, key) for s, key in stations if not s.is_default]
        if not named:
            return ["StationId stationIdFromName(const char*) {", "    return StationId::STATION_DEFAULT;", "}"]
        return [
            "StationId stationIdFromName(const char* name) {",
            "    static const struct {",
            "        const char* name;",
            "        StationId id;",
            "    } kNames[] = {",
            *[f"        {{{_cpp_string(s.name)}, StationId::STATION_{key}}}," for s, key in named],
            "    };",
            "    if (name == nullptr) {",
            "        return StationId::STATION_DEFAULT;",
            "    }",
            "    for (const auto& entry : kNames) {",
            "        if (strcmp(entry.name, name) == 0) {",
            "            return entry.id;",
            "        }",
            "    }",
            "    return StationId::STATION_DEFAULT;",
            "}",
        ]

    # -- uma estação: AST -> instruções -> switch ---------------------------------

    def _step_function(self, station: StationNode, key: str) -> List[str]:
        self._ops = []
        self._label_count = 0
        self._flatten(station.body)

        # Rótulo -> índice (pc) da próxima instrução de verdade.
        targets: Dict[int, int] = {}
        pc = 0
        for op in self._ops:
            if op[0] == "label":
                targets[op[1]] = pc
            else:
                pc += 1

        uses_time = any(op[0] == "wait" and op[2] is not None for op in self._ops)
        title = "default" if station.is_default else _cpp_string(station.name)
        lines = [
            f"// station {title}",
            f"bool step_{key.lower()}(StationFrame& f, unsigned long {'nowMs' if uses_time else '/*nowMs*/'}) {{",
            "    for (;;) {",
            "        switch (f.pc) {",
        ]
        pc = 0
        for op in self._ops:
            if op[0] == "label":
                continue
            lines.append(f"        case {pc}:")
            lines += ["            " + line for line in self._case_body(op, pc, targets)]
            pc += 1
        lines += ["        default:", "            return true;", "        }", "    }", "}", ""]
        return lines

    @staticmethod
    def _case_body(op: _Op, pc: int, targets: Dict[int, int]) -> List[str]:
        kind = op[0]
        if kind == "do":
            return [*op[1], f"f.pc = {pc + 1};", "break;"]
        if kind == "jump":
            return [f"f.pc = {targets[op[1]]};", "break;"]
        if kind == "branch":
            return [f"f.pc = {op[1]} ? {pc + 1} : {targets[op[2]]};", "break;"]

        _, signal, timeout_ms = op
        lines = []
        if timeout_ms is not None:
            lines += [
                "if (!f.waiting) {",
                "    f.waiting = true;",
                f"    f.deadlineMs = nowMs + {timeout_ms}UL;",
                "}",
            ]
        resume = [f"f.pc = {pc + 1};", "break;"]
        if timeout_ms is not None:
            resume.insert(0, "f.waiting = false;")
        lines += [f"if (RobotRuntime::hasSignal({_cpp_string(signal)})) {{", *["    " + l for l in resume], "}"]
        if timeout_ms is not None:
            lines += ["if (static_cast<long>(nowMs - f.deadlineMs) >= 0) {", *["    " + l for l in resume], "}"]
        lines.append("return false;")
        return lines

    def _flatten(self, stmts: List[ASTNode]) -> None:
        for stmt in stmts:
            if isinstance(stmt, IfStmtNode):
                self._flatten_if(stmt)
            elif stmt.name == "wait_signal":
                self._ops.append(self._wait_op(stmt))
            else:
                self._ops.append(("do", [self._call(stmt)]))

    def _flatten_if(self, stmt: IfStmtNode) -> None:
        has_else = bool(stmt.else_branch)
        else_label, end_label = self._new_label(), self._new_label()

        self._ops.append(("branch", self._condition(stmt), else_label if has_else else end_label))
        self._flatten(stmt.then_branch)
        if has_else:
            self._ops.append(("jump", end_label))
            self._ops.append(("label", else_label))
            self._flatten(stmt.else_branch)
        self._ops.append(("label", end_label))

    def _new_label(self) -> int:
        self._label_count += 1
        return self._label_count

    @staticmethod
    def _condition(stmt: IfStmtNode) -> str:
        cond = stmt.condition
        key = _cpp_string(cond.left.name)
        if isinstance(cond.right, IdentifierNode):
            return f"RobotRuntime::contextKeysEqual({key}, {_cpp_string(cond.right.name)})"
        return f"RobotRuntime::contextEquals({key}, {_cpp_string(cond.right.value)})"

    @staticmethod
    def _wait_op(cmd: CommandCallNode) -> _Op:
        signal, timeout = cmd.args
        literal = timeout.value
        if literal.type_name == "NONE":
            return ("wait", signal.value, None)

        timeout_ms = round(literal.value * 1000)
        if timeout_ms > _MAX_WAIT_MS:
            raise CompileError(Diagnostic(
                "codegen", "error",
                f"timeout de {literal.value}s excede o máximo de {_MAX_WAIT_MS // 1000}s",
                literal.line, literal.col,
            ))
        return ("wait", signal.value, timeout_ms)

    @staticmethod
    def _call(cmd: CommandCallNode) -> str:
        if cmd.name in _RUNTIME_CALLS:
            return f"RobotRuntime::{_RUNTIME_CALLS[cmd.name]}();"
        if cmd.name == "set_speed":
            return f"RobotRuntime::setSpeed({_cpp_float(cmd.args[0].value)});"
        if cmd.name == "log":
            return f"RobotRuntime::log({_cpp_string(cmd.args[0].value)});"
        raise CompileError(Diagnostic(
            "codegen", "error", f"comando sem tradução para C++: '{cmd.name}'", cmd.line, cmd.col,
        ))
