"""Parser de configuração e gerador do sketch autônomo ESP32."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Tuple

from .diagnostics import CompileError, Diagnostic

INO_FILE = "carrinho_autonomo.ino"
_RUNTIME = Path(__file__).parent / "runtime" / "carrinho_autonomo.ino.template"


def _error(message: str, source: str, pos: int = 0, phase: str = "parser"):
    line = source.count("\n", 0, pos) + 1
    col = pos - source.rfind("\n", 0, pos)
    raise CompileError(Diagnostic(phase, "error", message, line, col))


def _strip_comments(source: str) -> str:
    chars = list(source); i = 0; quoted = False; escaped = False
    while i < len(chars):
        ch = chars[i]
        if quoted:
            if escaped: escaped = False
            elif ch == "\\": escaped = True
            elif ch == '"': quoted = False
        elif ch == '"': quoted = True
        elif ch == "/" and i + 1 < len(chars) and chars[i + 1] == "/":
            while i < len(chars) and chars[i] != "\n":
                chars[i] = " "
                i += 1
            continue
        i += 1
    return "".join(chars)


def _blocks(source: str) -> Tuple[str, Dict[str, str]]:
    clean = _strip_comments(source)
    robot = re.search(r'\brobot\s+"([^"\n]+)"\s*\{', clean)
    if not robot:
        _error('esperado robot "ID" {', source)
    # Read balanced blocks so nested braces and quoted strings remain intact.
    def body_after(match, text=clean):
        start = match.end(); depth = 1; quoted = False; escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if quoted:
                if escaped: escaped = False
                elif ch == "\\": escaped = True
                elif ch == '"': quoted = False
            elif ch == '"': quoted = True
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0: return text[start:i], i + 1
        _error("bloco sem chave de fechamento", source, match.start())
    root, end = body_after(robot)
    if clean[end:].strip(): _error("conteúdo depois do bloco robot", source, end)
    props: Dict[str, str] = {"robot_id": robot.group(1)}
    allowed = {
        "network": {"ssid", "password", "backend", "token", "ca_certificate", "ntp"},
        "motors": {"left_pins", "right_pins", "left_direction", "right_direction"},
        "line_sensors": {"pins", "active_level", "stable_samples", "interval"},
        "movement": {"straight_power", "outer_power", "gentle_inner_power", "strong_inner_power", "alignment", "minimum_turn", "turn_timeout", "segment_timeout"},
        "execution": {"startup_delay", "communication_timeout", "max_actions", "max_events", "route_source", "actions", "require_start_command"},
    }
    seen_blocks = set()
    for name in re.findall(r'\b(network|motors|line_sensors|movement|execution)\s*\{', root):
        m = re.search(r'\b' + name + r'\s*\{', root)
        block, _ = body_after(m, root)
        if name in seen_blocks: _error(f"bloco {name} duplicado", source, m.start(), "semantic")
        seen_blocks.add(name)
        declarations = re.findall(r'(?m)^\s*([a-z_]+)\s*:', block)
        for key in declarations:
            if key not in allowed[name]: _error(f"propriedade desconhecida {name}.{key}", source, m.start(), "semantic")
        parsed = re.findall(r'(?m)^\s*([a-z_]+)\s*:\s*(\[[^\]]*\]|"(?:\\.|[^"\\])*"|[^\s,}]+)\s*$', block)
        if len(parsed) != len(declarations): _error(f"valor inválido no bloco {name}", source, m.start(), "parser")
        for key, value in parsed:
            qualified = f"{name}.{key}"
            if qualified in props: _error(f"propriedade {qualified} duplicada", source, m.start(), "semantic")
            props[qualified] = value.strip()
    # profile and board use positional syntax.
    for key, value in re.findall(r'\b(profile|board)\s+([A-Za-z_][A-Za-z_0-9]*)', root):
        if key in props: _error(f"{key} declarado mais de uma vez", source, robot.start(), "semantic")
        props[key] = value
    residual = re.sub(r'\b(?:profile|board)\s+[A-Za-z_][A-Za-z_0-9]*', '', root)
    residual = re.sub(r'\b(?:network|motors|line_sensors|movement|execution)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', '', residual)
    if residual.strip(): _error("declaração desconhecida no bloco robot", source, robot.start(), "parser")
    return robot.group(1), props


def _value(props, key, default=None):
    return props.get(key, default)


def _string(raw, key):
    if raw is None: raise ValueError(f"campo obrigatório ausente: {key}")
    try:
        value = json.loads(raw)
    except Exception: raise ValueError(f"{key} deve ser uma string entre aspas")
    if not isinstance(value, str): raise ValueError(f"{key} deve ser uma string")
    return value


def _int(raw, key, low, high):
    try: value = int(raw)
    except Exception: raise ValueError(f"{key} deve ser inteiro")
    if not low <= value <= high: raise ValueError(f"{key} deve estar entre {low} e {high}")
    return value


def _list(raw, key, length):
    try: result = json.loads(raw)
    except Exception: raise ValueError(f"{key} deve ser uma lista [a, b, c]")
    if not isinstance(result, list) or len(result) != length: raise ValueError(f"{key} precisa ter {length} itens")
    return [_int(str(x), key, 0, 39) for x in result]


def compile_arduino(source: str) -> Dict[str, str]:
    robot_id, p = _blocks(source)
    try:
        if p.get("profile") != "autonomous_line_v1": raise ValueError("profile deve ser autonomous_line_v1")
        if p.get("board") != "esp32": raise ValueError("board deve ser esp32")
        vals = {
            "SSID": _string(_value(p, "network.ssid"), "network.ssid"),
            "SENHA": _string(_value(p, "network.password"), "network.password"),
            "URL": _string(_value(p, "network.backend"), "network.backend"),
            "TOKEN": _string(_value(p, "network.token"), "network.token"),
            "CA_CERT": _string(_value(p, "network.ca_certificate", '""'), "network.ca_certificate"),
            "SERVIDOR_NTP": _string(_value(p, "network.ntp", '"pool.ntp.org"'), "network.ntp"),
        }
        vals["ROBO"] = robot_id
        if not vals["SSID"] or not vals["SENHA"]: raise ValueError("SSID e senha não podem ser vazios")
        if len(vals["SSID"].encode("utf-8")) > 32: raise ValueError("SSID excede o limite de 32 bytes")
        if len(vals["TOKEN"]) < 16: raise ValueError("network.token precisa ter pelo menos 16 caracteres")
        if not robot_id or len(robot_id) > 64: raise ValueError("ID do robô deve ter de 1 a 64 caracteres")
        url = vals["URL"]
        if not (url.startswith("http://") or url.startswith("https://")) or url.endswith("/") or "/api" in url:
            raise ValueError("network.backend deve ser URL http(s), sem barra final e sem /api")
        if url.startswith("https://") and not vals["CA_CERT"]: raise ValueError("HTTPS exige network.ca_certificate")
        pins_e = _list(_value(p, "motors.left_pins"), "motors.left_pins", 3)
        pins_d = _list(_value(p, "motors.right_pins"), "motors.right_pins", 3)
        sensors = _list(_value(p, "line_sensors.pins"), "line_sensors.pins", 3)
        if len(set(pins_e + pins_d + sensors)) != 9: raise ValueError("pinos de motores e sensores devem ser distintos")
        if any(pin in {6,7,8,9,10,11} for pin in pins_e + pins_d + sensors):
            raise ValueError("GPIO 6–11 são reservados à memória flash no ESP32 clássico")
        vals["MOTOR_E"] = pins_e; vals["MOTOR_D"] = pins_d; vals["SENSORES"] = sensors
        outputs = set(pins_e + pins_d)
        if any(pin in {6, 7, 8, 9, 10, 11, 34, 35, 36, 37, 38, 39} for pin in outputs):
            raise ValueError("pinos de motor usam GPIO sem saída compatível no ESP32 clássico")
        for prop, const in [("left_direction", "SENTIDO_E"), ("right_direction", "SENTIDO_D")]:
            v = _int(_value(p, "motors." + prop, "1"), prop, -1, 1)
            if v == 0: raise ValueError(f"motors.{prop} aceita apenas -1 ou 1")
            vals[const] = v
        level = _value(p, "line_sensors.active_level", "high")
        if level not in ("high", "low"): raise ValueError("line_sensors.active_level deve ser high ou low")
        vals["NIVEL_LINHA"] = "HIGH" if level == "high" else "LOW"
        for prop, const in [("straight_power","POTENCIA_RETA"),("outer_power","POTENCIA_EXTERNA"),("gentle_inner_power","POTENCIA_INTERNA_SUAVE"),("strong_inner_power","POTENCIA_INTERNA_FORTE")]:
            vals[const] = _int(_value(p, "movement."+prop, "150"), prop, 0, 255)
        vals["AMOSTRAS_ESTAVEIS"] = _int(_value(p,"line_sensors.stable_samples","3"),"stable_samples",1,100)
        for block, prop, const, default in [
            ("line_sensors","interval","INTERVALO_LEITURA_MS","10ms"),
            ("movement","alignment","ALINHAMENTO_MS","120ms"),("movement","minimum_turn","CURVA_MINIMA_MS","180ms"),
            ("movement","turn_timeout","LIMITE_CURVA_MS","2500ms"),("movement","segment_timeout","LIMITE_TRECHO_MS","15000ms"),
            ("execution","startup_delay","ESPERA_INICIAL_MS","3000ms"),("execution","communication_timeout","LIMITE_COMUNICACAO_MS","30000ms")]:
            raw = _value(p, block+"."+prop, default); m = re.fullmatch(r"(\d+)ms", raw)
            if not m: raise ValueError(f"{block}.{prop} deve usar milissegundos, ex.: 10ms")
            vals[const] = _int(m.group(1), prop, 1, 2147483647)
        vals["MAX_ACOES"] = _int(_value(p,"execution.max_actions","16"),"max_actions",1,16)
        vals["MAX_EVENTOS"] = _int(_value(p,"execution.max_events","12"),"max_events",8,64)
        if _value(p,"execution.route_source","backend") != "backend": raise ValueError("route_source deve ser backend")
        if _value(p,"execution.require_start_command","true") != "true": raise ValueError("require_start_command deve ser true")
        actions = _value(p,"execution.actions","[forward, right, left]")
        if not re.fullmatch(r"\[\s*(forward|right|left)(\s*,\s*(forward|right|left))*\s*\]", actions): raise ValueError("actions aceita apenas forward, right e left")
        actions = re.findall(r"forward|right|left", actions)
        if not actions: raise ValueError("actions não pode ser vazia")
        vals["ACTIONS"] = actions
        vals["ALLOW_F"] = "true" if "forward" in actions else "false"
        vals["ALLOW_D"] = "true" if "right" in actions else "false"
        vals["ALLOW_E"] = "true" if "left" in actions else "false"
    except ValueError as exc:
        _error(str(exc), source, 0, "semantic")
    try:
        try:
            template = _RUNTIME.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            # O firmware legado contém alguns comentários em Windows-1252.
            template = _RUNTIME.read_text(encoding="cp1252")
    except OSError as exc:
        raise CompileError(Diagnostic("codegen", "error", f"runtime ESP32 indisponível: {exc}", 1, 1)) from exc
    substitutions = {
        "SSID": json.dumps(vals["SSID"], ensure_ascii=True), "SENHA": json.dumps(vals["SENHA"], ensure_ascii=True),
        "URL": json.dumps(vals["URL"], ensure_ascii=True), "ROBO": json.dumps(vals["ROBO"], ensure_ascii=True),
        "TOKEN": json.dumps(vals["TOKEN"], ensure_ascii=True), "CA_CERT": json.dumps(vals["CA_CERT"], ensure_ascii=True),
        "SERVIDOR_NTP": json.dumps(vals["SERVIDOR_NTP"], ensure_ascii=True),
        "MOTOR_E": "{" + ", ".join(map(str, vals["MOTOR_E"])) + "}", "MOTOR_D": "{" + ", ".join(map(str, vals["MOTOR_D"])) + "}",
        "SENSORES": "{" + ", ".join(map(str, vals["SENSORES"])) + "}",
        "ALLOW_F": vals["ALLOW_F"], "ALLOW_D": vals["ALLOW_D"], "ALLOW_E": vals["ALLOW_E"],
    }
    for name in ("SENTIDO_E","SENTIDO_D","NIVEL_LINHA","POTENCIA_RETA","POTENCIA_EXTERNA","POTENCIA_INTERNA_SUAVE","POTENCIA_INTERNA_FORTE","AMOSTRAS_ESTAVEIS","INTERVALO_LEITURA_MS","ESPERA_INICIAL_MS","ALINHAMENTO_MS","CURVA_MINIMA_MS","LIMITE_CURVA_MS","LIMITE_TRECHO_MS","LIMITE_COMUNICACAO_MS","MAX_ACOES","MAX_EVENTOS","ALLOW_F","ALLOW_D","ALLOW_E"):
        substitutions[name] = str(vals[name])
    for name, value in substitutions.items():
        pattern = rf'(?m)^(const\s+[^;\n]*?\b{name}(?:\[[^\]]+\])?\s*=\s*)([^;]+)(;.*)$'
        template, n = re.subn(pattern, lambda m: m.group(1)+value+m.group(3), template, count=1)
        if n != 1: raise CompileError(Diagnostic("codegen", "error", f"template não contém constante {name}", 1, 1))
    template = template.replace("// ESP32: recebe a rota", f"// RoboFlow profile autonomous_line_v1 | robô {robot_id}\n// ESP32: recebe a rota", 1)
    return {INO_FILE: template}
