# Como o Compilador RoboFlow Gera o Módulo de Decisão de Estação

**Documento Técnico Detalhado**  
**Versão:** 3.0 (Seguidor de Linha Industrial, sem ROS 2)  
**Data:** Agosto 2026

---

## 📋 Escopo

Este documento detalha as quatro fases do compilador RoboFlow, aplicadas ao problema concreto do projeto: transformar uma descrição de **comportamento de estação** em um módulo Python (`compiled_behavior.py`) que o script `station_runner.py` importa e usa para despachar comandos pela serial.

Importante: o compilador **não gera o código de seguimento de linha** (isso é PID fixo em firmware, fora do escopo da linguagem) e **não usa ROS 2** — o alvo de geração é uma função Python simples por estação, não um nó de middleware.

---

## 🔄 Exemplo Completo: Do RoboFlow ao Módulo Python

### Entrada: Programa RoboFlow

```roboflow
station "carga" {
    on_arrival {
        stop()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}

station "cruzamento_pedestres" {
    on_arrival {
        set_speed(0.15)
        signal_buzzer()
        resume_line_following()
    }
}

station "bifurcacao_A" {
    on_arrival {
        if next_destination == "linha_2" {
            turn_right()
        } else {
            continue_straight()
        }
        resume_line_following()
    }
}

station default {
    on_arrival {
        stop()
        log("Estação desconhecida")
        wait_signal("manual_override", timeout: none)
    }
}
```

---

## 🔨 Fase 1: Análise Léxica

```python
class Lexer:
    KEYWORDS = {'station', 'default', 'on_arrival', 'if', 'else',
                'stop', 'set_speed', 'turn_left', 'turn_right',
                'continue_straight', 'wait_signal', 'signal_buzzer',
                'signal_light', 'log', 'resume_line_following', 'timeout'}
    
    def __init__(self, text):
        self.text = text
        self.pos = 0
    
    def tokenize(self):
        tokens = []
        while self.pos < len(self.text):
            ch = self.text[self.pos]
            if ch.isspace():
                self.pos += 1
            elif self.text[self.pos:self.pos+2] == '//':
                while self.pos < len(self.text) and self.text[self.pos] != '\n':
                    self.pos += 1
            elif ch == '"':
                self.pos += 1
                start = self.pos
                while self.text[self.pos] != '"':
                    self.pos += 1
                tokens.append(('STRING', self.text[start:self.pos]))
                self.pos += 1
            elif ch in '{}()':
                tokens.append(('BRACE', ch))
                self.pos += 1
            elif ch == '=' and self.text[self.pos:self.pos+2] == '==':
                tokens.append(('OP', '=='))
                self.pos += 2
            elif ch.isdigit():
                start = self.pos
                while self.pos < len(self.text) and (self.text[self.pos].isdigit() or self.text[self.pos] == '.'):
                    self.pos += 1
                tokens.append(('NUMBER', float(self.text[start:self.pos])))
            elif ch.isalpha() or ch == '_':
                start = self.pos
                while self.pos < len(self.text) and (self.text[self.pos].isalnum() or self.text[self.pos] == '_'):
                    self.pos += 1
                word = self.text[start:self.pos]
                tokens.append(('KEYWORD', word) if word in self.KEYWORDS else ('ID', word))
            else:
                self.pos += 1
        return tokens
```

**Tokens gerados para `station "carga" {`:**
```
[KEYWORD:station] [STRING:carga] [BRACE:{]
```

---

## 🌳 Fase 2: Análise Sintática

### Gramática BNF

```bnf
program        ::= station_decl+ default_decl

station_decl   ::= "station" STRING "{" "on_arrival" "{" stmt_list "}" "}"

default_decl   ::= "station" "default" "{" "on_arrival" "{" stmt_list "}" "}"

stmt_list      ::= stmt*

stmt           ::= command_call | if_stmt

command_call   ::= identifier "(" arg_list? ")"

arg_list       ::= arg ("," arg)*

arg            ::= STRING | NUMBER | identifier | timeout_arg

timeout_arg    ::= "timeout" ":" (NUMBER "s" | "none")

if_stmt        ::= "if" condition "{" stmt_list "}" ("else" "{" stmt_list "}")?

condition      ::= identifier "==" (STRING | identifier)
```

### Parser (Recursivo Descendente)

```python
class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0
    
    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None
    
    def expect(self, ttype, tvalue=None):
        tok = self.peek()
        if tok is None or tok[0] != ttype or (tvalue and tok[1] != tvalue):
            raise SyntaxError(f"Esperado {ttype}:{tvalue}, encontrado {tok}")
        self.pos += 1
        return tok
    
    def parse_program(self):
        stations = []
        default = None
        while self.peek():
            if self.peek()[1] == 'station' and self.tokens[self.pos+1][1] == 'default':
                default = self.parse_default()
            else:
                stations.append(self.parse_station())
        return ('Program', stations, default)
    
    def parse_station(self):
        self.expect('KEYWORD', 'station')
        name = self.expect('STRING')[1]
        self.expect('BRACE', '{')
        self.expect('KEYWORD', 'on_arrival')
        self.expect('BRACE', '{')
        stmts = self.parse_stmt_list()
        self.expect('BRACE', '}')
        self.expect('BRACE', '}')
        return ('Station', name, stmts)
    
    def parse_default(self):
        self.expect('KEYWORD', 'station')
        self.expect('KEYWORD', 'default')
        self.expect('BRACE', '{')
        self.expect('KEYWORD', 'on_arrival')
        self.expect('BRACE', '{')
        stmts = self.parse_stmt_list()
        self.expect('BRACE', '}')
        self.expect('BRACE', '}')
        return ('Default', stmts)
    
    def parse_stmt_list(self):
        stmts = []
        while self.peek() and not (self.peek()[0] == 'BRACE' and self.peek()[1] == '}'):
            if self.peek()[1] == 'if':
                stmts.append(self.parse_if())
            else:
                stmts.append(self.parse_command())
        return stmts
    
    def parse_if(self):
        self.expect('KEYWORD', 'if')
        left = self.expect('ID')[1]
        self.expect('OP', '==')
        right_tok = self.peek()
        right = right_tok[1]
        self.pos += 1
        self.expect('BRACE', '{')
        true_branch = self.parse_stmt_list()
        self.expect('BRACE', '}')
        false_branch = []
        if self.peek() and self.peek()[1] == 'else':
            self.pos += 1
            self.expect('BRACE', '{')
            false_branch = self.parse_stmt_list()
            self.expect('BRACE', '}')
        return ('If', ('Condition', left, right), true_branch, false_branch)
    
    def parse_command(self):
        name = self.expect('KEYWORD')[1]
        self.expect('BRACE', '(')
        args = []
        while not (self.peek()[0] == 'BRACE' and self.peek()[1] == ')'):
            args.append(self.peek())
            self.pos += 1
        self.expect('BRACE', ')')
        return ('Command', name, args)
```

### AST Resultante (Estação "carga")

```
Station(
  name="carga",
  stmts=[
    Command("stop", []),
    Command("wait_signal", [STRING:"carga_completa", timeout: 30s]),
    Command("resume_line_following", [])
  ]
)
```

---

## ✅ Fase 3: Análise Semântica

Aqui está o núcleo do valor acadêmico do projeto: cada validação corresponde a uma propriedade de segurança física do AGV.

```python
class SemanticAnalyzer:
    def __init__(self, ast, commissioned_stations):
        self.ast = ast
        self.commissioned_stations = commissioned_stations  # lista de station_id da pista real
        self.errors = []
    
    def analyze(self):
        _, stations, default = self.ast
        
        self._check_completeness(stations, default)
        self._check_determinism(stations)
        for station in stations:
            self._check_termination(station)
        if default:
            self._check_default_termination(default)
        
        return len(self.errors) == 0
    
    def _check_completeness(self, stations, default):
        """Toda estação comissionada na pista tem bloco correspondente, ou existe default."""
        defined = {s[1] for s in stations}
        missing = set(self.commissioned_stations) - defined
        if missing and default is None:
            self.errors.append(f"Estações sem comportamento e sem default: {missing}")
        elif missing:
            # OK: cairão no default, mas avisar
            self.warnings = getattr(self, 'warnings', [])
            self.warnings.append(f"Estações {missing} usarão comportamento default")
    
    def _check_determinism(self, stations):
        """Nenhuma estação definida duas vezes."""
        seen = {}
        for _, name, _ in stations:
            if name in seen:
                self.errors.append(f"Estação '{name}' definida mais de uma vez")
            seen[name] = True
    
    def _check_termination(self, station):
        """Todo caminho de execução dentro de on_arrival termina em
           resume_line_following() ou em wait_signal(..., timeout: none)."""
        _, name, stmts = station
        if not self._all_paths_terminate(stmts):
            self.errors.append(
                f"Estação '{name}': existe caminho sem resume_line_following() "
                f"nem wait_signal(timeout: none) — o AGV pode travar permanentemente"
            )
    
    def _all_paths_terminate(self, stmts):
        """Percorre a lista de statements. Se o último for resume_line_following()
           ou wait_signal com timeout none, o caminho termina corretamente.
           Se for um If, AMBOS os ramos precisam terminar (ou o fluxo continuar
           depois do if, sendo o restante responsável por terminar)."""
        if not stmts:
            return False
        
        last = stmts[-1]
        if last[0] == 'Command':
            cmd_name = last[1]
            if cmd_name == 'resume_line_following':
                return True
            if cmd_name == 'wait_signal':
                args = last[2]
                for arg in args:
                    if arg == ('KEYWORD', 'none'):
                        return True
                return False  # wait_signal com timeout numérico não é terminal por si só
        
        if last[0] == 'If':
            _, _, true_branch, false_branch = last
            true_ok = self._all_paths_terminate(true_branch)
            false_ok = self._all_paths_terminate(false_branch) if false_branch else False
            return true_ok and false_ok
        
        return False
    
    def _check_default_termination(self, default):
        _, stmts = default
        if not self._all_paths_terminate(stmts):
            self.errors.append(
                "Estação 'default': precisa terminar em resume_line_following() "
                "ou wait_signal(timeout: none)"
            )

# Uso
commissioned = ["carga", "cruzamento_pedestres", "bifurcacao_A", "descarga"]
analyzer = SemanticAnalyzer(ast, commissioned)
if analyzer.analyze():
    print("Análise semântica passou")
else:
    for e in analyzer.errors:
        print(f"ERRO: {e}")
```

### Exemplos de Rejeição

```roboflow
// ❌ ERRO: falta resume_line_following() no ramo else
station "bifurcacao_A" {
    on_arrival {
        if next_destination == "linha_2" {
            turn_right()
            resume_line_following()
        } else {
            continue_straight()
            // esqueceu resume_line_following() aqui!
        }
    }
}
```
```
ERRO: Estação 'bifurcacao_A': existe caminho sem resume_line_following()
      nem wait_signal(timeout: none) — o AGV pode travar permanentemente
```

```roboflow
// ❌ ERRO: estação comissionada "descarga" não tem bloco e não há default
station "carga" { on_arrival { stop() resume_line_following() } }
// fim do arquivo, sem "descarga" e sem "default"
```
```
ERRO: Estações sem comportamento e sem default: {'descarga'}
```

```roboflow
// ❌ ERRO: estação duplicada
station "carga" { on_arrival { stop() resume_line_following() } }
station "carga" { on_arrival { set_speed(0.1) resume_line_following() } }
```
```
ERRO: Estação 'carga' definida mais de uma vez
```

---

## 🔧 Fase 4: Geração de Código

O alvo de geração é `compiled_behavior.py`: um módulo Python com uma função por estação e um dicionário `STATION_HANDLERS` que o `station_runner.py` consulta. Cada função recebe `send_cmd` (a função que escreve na serial) e, quando precisa de contexto externo (como `next_destination`), recebe também um dicionário de contexto.

```python
class CodeGenerator:
    def __init__(self, ast):
        self.ast = ast
        self.lines = []
    
    def generate(self):
        self._emit_header()
        _, stations, default = self.ast
        
        for _, name, stmts in stations:
            self._emit_function(name, stmts)
        
        if default:
            _, stmts = default
            self._emit_function('default', stmts, is_default=True)
        
        self._emit_dispatch_table(stations, default)
        return '\n'.join(self.lines)
    
    def _emit_header(self):
        self.lines += [
            '"""Gerado automaticamente pelo compilador RoboFlow. Não editar manualmente."""',
            '',
        ]
    
    def _function_name(self, station_id, is_default=False):
        if is_default:
            return 'handle_default'
        safe = station_id.replace(' ', '_').replace('-', '_')
        return f'handle_{safe}'
    
    def _emit_function(self, station_id, stmts, is_default=False):
        fname = self._function_name(station_id, is_default)
        self.lines.append(f'def {fname}(send_cmd, context=None):')
        if not stmts:
            self.lines.append('    pass')
        else:
            self._emit_stmts(stmts, indent='    ')
        self.lines.append('')
    
    def _emit_stmts(self, stmts, indent):
        for stmt in stmts:
            if stmt[0] == 'Command':
                self._emit_command(stmt, indent)
            elif stmt[0] == 'If':
                self._emit_if(stmt, indent)
    
    def _emit_command(self, stmt, indent):
        _, name, args = stmt
        mapping = {
            'stop': "send_cmd('CMD STOP')",
            'resume_line_following': "send_cmd('CMD RESUME_LINE_FOLLOWING')",
            'turn_left': "send_cmd('CMD TURN_LEFT')",
            'turn_right': "send_cmd('CMD TURN_RIGHT')",
            'continue_straight': "send_cmd('CMD CONTINUE_STRAIGHT')",
            'signal_buzzer': "send_cmd('CMD SIGNAL_BUZZER')",
        }
        if name in mapping:
            self.lines.append(indent + mapping[name])
        elif name == 'set_speed':
            speed = args[0][1]
            self.lines.append(indent + f"send_cmd('CMD SET_SPEED {speed}')")
        elif name == 'wait_signal':
            signal_name = args[0][1]
            timeout = self._extract_timeout(args)
            self.lines.append(indent + f"wait_for_signal('{signal_name}', timeout={timeout})")
        elif name == 'log':
            msg = args[0][1]
            self.lines.append(indent + f"log_event('{msg}')")
    
    def _extract_timeout(self, args):
        for arg in args:
            if arg[0] == 'NUMBER':
                return arg[1]
            if arg[0] == 'KEYWORD' and arg[1] == 'none':
                return 'None'
        return 'None'
    
    def _emit_if(self, stmt, indent):
        _, cond, true_b, false_b = stmt
        _, var, val = cond
        self.lines.append(indent + f"if context.get('{var}') == '{val}':")
        self._emit_stmts(true_b, indent + '    ')
        if false_b:
            self.lines.append(indent + 'else:')
            self._emit_stmts(false_b, indent + '    ')
    
    def _emit_dispatch_table(self, stations, default):
        self.lines.append('STATION_HANDLERS = {')
        for _, name, _ in stations:
            fname = self._function_name(name)
            self.lines.append(f"    '{name}': {fname},")
        self.lines.append('}')
        self.lines.append('')
        if default:
            self.lines.append('DEFAULT_HANDLER = handle_default')
```

### Saída Python Gerada (`compiled_behavior.py`, trecho)

```python
"""Gerado automaticamente pelo compilador RoboFlow. Não editar manualmente."""

def handle_carga(send_cmd, context=None):
    send_cmd('CMD STOP')
    wait_for_signal('carga_completa', timeout=30)
    send_cmd('CMD RESUME_LINE_FOLLOWING')

def handle_cruzamento_pedestres(send_cmd, context=None):
    send_cmd('CMD SET_SPEED 0.15')
    send_cmd('CMD SIGNAL_BUZZER')
    send_cmd('CMD RESUME_LINE_FOLLOWING')

def handle_bifurcacao_A(send_cmd, context=None):
    if context.get('next_destination') == 'linha_2':
        send_cmd('CMD TURN_RIGHT')
    else:
        send_cmd('CMD CONTINUE_STRAIGHT')
    send_cmd('CMD RESUME_LINE_FOLLOWING')

def handle_default(send_cmd, context=None):
    send_cmd('CMD STOP')
    log_event('Estação desconhecida')
    wait_for_signal('manual_override', timeout=None)

STATION_HANDLERS = {
    'carga': handle_carga,
    'cruzamento_pedestres': handle_cruzamento_pedestres,
    'bifurcacao_A': handle_bifurcacao_A,
}

DEFAULT_HANDLER = handle_default
```

Esse módulo é importado diretamente pelo `station_runner.py` (visto em PROJETO_ROBO_SLAM_TECNICO.md) — não há passo de compilação/linking, é Python interpretado normalmente.

---

## 🎯 Propriedades Provadas Antes de Gerar Código

| Propriedade | O que garante fisicamente |
|---|---|
| Completude | Todo marcador que existe na pista real tem resposta programada |
| Determinismo | Nenhuma estação tem comportamento ambíguo |
| Terminação | O AGV nunca fica travado numa estação por esquecimento de programação |
| Fora do escopo do compilador (por design) | Nenhum programa RoboFlow pode desabilitar o veto de proximidade — o comando simplesmente não existe na linguagem |

---

## 🧪 Testes do Compilador

```python
def test_rejeita_estacao_sem_terminacao():
    src = '''
    station "bifurcacao_A" {
        on_arrival {
            if next_destination == "linha_2" {
                turn_right()
                resume_line_following()
            } else {
                continue_straight()
            }
        }
    }
    station default {
        on_arrival { stop() wait_signal("manual_override", timeout: none) }
    }
    '''
    ok = compile_roboflow(src, commissioned=["bifurcacao_A"])
    assert not ok
    assert "sem resume_line_following" in get_errors()[0]

def test_rejeita_estacao_faltando():
    src = '''
    station "carga" {
        on_arrival { stop() resume_line_following() }
    }
    '''
    ok = compile_roboflow(src, commissioned=["carga", "descarga"])
    assert not ok
    assert "descarga" in get_errors()[0]

def test_aceita_programa_valido():
    src = '''
    station "carga" {
        on_arrival { stop() wait_signal("carga_completa", timeout: 30s) resume_line_following() }
    }
    station default {
        on_arrival { stop() wait_signal("manual_override", timeout: none) }
    }
    '''
    ok = compile_roboflow(src, commissioned=["carga"])
    assert ok
    generated = get_generated_code()
    assert "STATION_HANDLERS" in generated
    assert "handle_carga" in generated
    assert "carga_completa" in generated
```

---

**Consulte PROJETO_ROBO.md, LINGUAGEM_ROBO_COMPILADOR.md e ARQUITETURA_DUAS_CAMADAS.md para o restante da documentação.**
