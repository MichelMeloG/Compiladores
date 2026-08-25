# Como o Compilador RoboFlow Gera o Módulo de Decisão de Estação


---

## 📋 Escopo

Este documento detalha as quatro fases do compilador RoboFlow, aplicadas ao problema concreto do projeto: transformar uma descrição de **comportamento de estação** em um módulo Python (`compiled_behavior.py`) que o script `station_runner.py` importa e usa para despachar comandos pela serial.

Importante: o compilador **não gera o código de seguimento de linha** (isso é PID fixo em firmware, fora do escopo da linguagem) e **não usa ROS 2** — o alvo de geração é uma função Python simples por estação, não um nó de middleware.

> **Nota de escopo:** os exemplos de `bifurcacao_A` abaixo usam `if`/`else` e um parâmetro `context` para representar variáveis que o **ESP32 fornece** quando detecta a estação (ex: `next_destination` lido de um sensor). O `context` é um dicionário que `station_runner.py` constrói a partir da mensagem serial `STATION bifurcacao_A next_destination:linha_2` e passa para a função gerada. 
> 
> Para a versão atual, sem condicionais, ver LINGUAGEM_ROBO_COMPILADOR.md, seção 2.1. As estações `handle_carga`, `handle_cruzamento_pedestres` e `handle_default` (sem `if`) já são válidas hoje; `handle_bifurcacao_A` (com `if`) é a extensão futura.

---

## 🎯 Por Que Apenas Um Backend (Python) e Não Dois

Um compilador poderia, em tese, ter múltiplos *backends* de geração de código — a mesma AST alimentando geradores diferentes conforme o alvo de execução (é assim que o LLVM gera para x86, ARM e RISC-V a partir de uma única representação intermediária). Este projeto **decide deliberadamente não fazer isso** e implementa só o backend Python. A justificativa é sobre onde cada linguagem é obrigatória versus onde é escolha:

| Dispositivo | Roda SO? | Linguagem possível | Por que |
|---|---|---|---|
| ESP32 | Não (bare metal/RTOS leve) | **C/C++ obrigatório** | Sem sistema operacional, não há interpretador Python disponível; e a malha de seguimento de linha exige timing de PID confiável a ~100 Hz, que só C/C++ compilado garante nesse hardware |
| Raspberry Pi | Sim (Linux) | **Qualquer uma** — Python, C++, etc. | Tem interpretador, sistema de arquivos, tudo que uma linguagem de alto nível precisa |

A lógica de estação — o que o compilador RoboFlow gera — **roda inteiramente no Raspberry Pi**, nunca no ESP32. O ESP32 só recebe comandos já decididos (`CMD STOP`, `CMD TURN_LEFT`) via serial; ele nunca interpreta RoboFlow nem executa código gerado pelo compilador. Como o único alvo de geração é um dispositivo que roda Linux, e a decisão de estação acontece poucas vezes por minuto (sem exigência de tempo real), não há motivo técnico para pagar o custo de um segundo backend C++: seria mais complexidade no compilador (dois geradores de código para manter e testar) sem ganho de performance real, porque o gargalo nunca é CPU — é a latência da própria serial e do tempo de espera por sinais externos (`wait_signal`).

Se um dia o projeto decidisse que a lógica de estação deveria rodar dentro do próprio ESP32 (por exemplo, para eliminar de vez a dependência do Raspberry Pi), aí sim seria necessário um segundo backend C++ — mas isso mudaria a arquitetura inteira (o ESP32 passaria a interpretar ou executar código gerado, não só obedecer comandos), e não é o caminho escolhido aqui.

O firmware do ESP32 (seguimento de linha + veto de segurança), por sua vez, **não é gerado pelo compilador** — é escrito à mão em C++ uma única vez, porque essa lógica não muda por estação nem por comissionamento de pista; é fixa por design.

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

> ⚠️ **Extensão futura incluída neste Lexer:** os tokens `if`/`else` fazem parte deste exemplo porque ele mostra o compilador **completo e final**, incluindo condicionais. Na versão atual (sem `if`/`else`, pendente de validação com o professor — ver LINGUAGEM_ROBO_COMPILADOR.md seção 2.2), basta remover `'if', 'else'` do conjunto `KEYWORDS` abaixo; o resto do Lexer não muda.

Implementação dirigida diretamente pela especificação de expressões regulares (ver LINGUAGEM_ROBO_COMPILADOR.md, seção 2.1). A ordem da lista `ESPEC` **importa**: `DURATION` vem antes de `NUMBER` para que `30s` case por inteiro, em vez de virar `NUMBER(30)` + `ID(s)`.

```python
import re

class Lexer:
    KEYWORDS = {'station', 'default', 'on_arrival', 'if', 'else',
                'stop', 'set_speed', 'turn_left', 'turn_right',
                'continue_straight', 'resume_line_following',
                'signal_buzzer', 'signal_light', 'log',
                'wait_signal', 'timeout', 'none'}

    # (nome_do_token, expressão regular) — ordem = prioridade
    ESPEC = [
        ('WS',       r'[ \t\r\n]+'),
        ('COMMENT',  r'//[^\n]*'),
        ('STRING',   r'"[^"\n]*"'),
        ('DURATION', r'[0-9]+(\.[0-9]+)?s'),   # antes de NUMBER!
        ('NUMBER',   r'[0-9]+(\.[0-9]+)?'),
        ('ID',       r'[a-zA-Z_][a-zA-Z0-9_]*'),
        ('OP',       r'=='),                    # ⚠️ extensão futura (if/else)
        ('LBRACE',   r'\{'),
        ('RBRACE',   r'\}'),
        ('LPAREN',   r'\('),
        ('RPAREN',   r'\)'),
        ('COLON',    r':'),
        ('COMMA',    r','),
    ]

    def __init__(self, text):
        self.text = text
        self.pos = 0
        self.regras = [(nome, re.compile(p)) for nome, p in self.ESPEC]

    def tokenize(self):
        tokens = []
        while self.pos < len(self.text):
            for nome, regex in self.regras:
                m = regex.match(self.text, self.pos)
                if not m:
                    continue

                lexema = m.group(0)
                self.pos = m.end()

                if nome in ('WS', 'COMMENT'):
                    pass                                   # descarta
                elif nome == 'STRING':
                    tokens.append(('STRING', lexema[1:-1]))  # tira as aspas
                elif nome == 'DURATION':
                    tokens.append(('DURATION', float(lexema[:-1])))  # tira o 's'
                elif nome == 'NUMBER':
                    tokens.append(('NUMBER', float(lexema)))
                elif nome == 'ID':
                    # Palavra reservada x identificador: consulta a tabela
                    tipo = 'KEYWORD' if lexema in self.KEYWORDS else 'ID'
                    tokens.append((tipo, lexema))
                else:
                    tokens.append((nome, lexema))
                break
            else:
                ch = self.text[self.pos]
                raise SyntaxError(f"Caractere inesperado {ch!r} na posição {self.pos}")
        return tokens
```

Diferente de um lexer que varre caractere a caractere, esta versão é uma tradução literal da tabela de ERs — se a especificação mudar, muda só a lista `ESPEC`. Note também que caracteres não reconhecidos agora geram **erro léxico explícito**, em vez de serem silenciosamente ignorados.

**Tokens gerados para `station "carga" {`:**
```
[KEYWORD:station] [STRING:carga] [LBRACE]
```

---

## 🌳 Fase 2: Análise Sintática

> ⚠️ **Extensão futura incluída nesta gramática:** a produção `if_stmt` faz parte da versão completa/final do compilador. Na versão atual (sem condicionais), a regra `stmt` se reduz a `stmt ::= command_call`, e as produções `if_stmt`/`condition` abaixo não existem ainda — ver a gramática "escopo atual" em LINGUAGEM_ROBO_COMPILADOR.md, seção 3.

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
        self.expect('LBRACE')
        self.expect('KEYWORD', 'on_arrival')
        self.expect('LBRACE')
        stmts = self.parse_stmt_list()
        self.expect('RBRACE')
        self.expect('RBRACE')
        return ('Station', name, stmts)
    
    def parse_default(self):
        self.expect('KEYWORD', 'station')
        self.expect('KEYWORD', 'default')
        self.expect('LBRACE')
        self.expect('KEYWORD', 'on_arrival')
        self.expect('LBRACE')
        stmts = self.parse_stmt_list()
        self.expect('RBRACE')
        self.expect('RBRACE')
        return ('Default', stmts)
    
    def parse_stmt_list(self):
        stmts = []
        while self.peek() and not (self.peek()[0] == 'RBRACE'):
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
        self.expect('LBRACE')
        true_branch = self.parse_stmt_list()
        self.expect('RBRACE')
        false_branch = []
        if self.peek() and self.peek()[1] == 'else':
            self.pos += 1
            self.expect('LBRACE')
            false_branch = self.parse_stmt_list()
            self.expect('RBRACE')
        return ('If', ('Condition', left, right), true_branch, false_branch)
    
    def parse_command(self):
        name = self.expect('KEYWORD')[1]
        self.expect('LPAREN')
        args = []
        while not (self.peek()[0] == 'RPAREN'):
            args.append(self.peek())
            self.pos += 1
        self.expect('RPAREN')
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

> ⚠️ **Extensão futura incluída aqui:** a lógica de `_all_paths_terminate` abaixo já trata o nó `If` (ambos os ramos precisam terminar). Na versão atual sem condicionais, essa checagem é mais simples — só olha se o último statement da lista é `resume_line_following()` ou `wait_signal(..., timeout: none)`, sem precisar percorrer ramos de `if`/`else`.

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

> ⚠️ **Extensão futura incluída aqui:** `_emit_if` e o tratamento de nós `If` no `CodeGenerator` abaixo pertencem à versão completa/final do compilador. Na versão atual (sem condicionais), o gerador só precisa de `_emit_stmts` chamando `_emit_command` — sem nunca encontrar um nó `If` na AST, já que o Parser da versão atual não produz esse nó (ver ressalva na Fase 2).

O alvo de geração é `compiled_behavior.py`: um módulo Python com uma função por estação e um dicionário `STATION_HANDLERS` que o `station_runner.py` consulta. Cada função sempre recebe `send_cmd` (a função que escreve na serial) e `context` (dicionário vindo do ESP32 — usado apenas pelas estações com `if`, mas presente em toda função gerada, por consistência de assinatura).

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
            if arg[0] == 'DURATION':      # ex: 30s  -> 30.0
                return arg[1]
            if arg[0] == 'KEYWORD' and arg[1] == 'none':
                return 'None'             # espera infinita
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

Abaixo, `handle_carga`, `handle_cruzamento_pedestres` e `handle_default` já são válidas hoje (não usam `if`). **`handle_bifurcacao_A` está marcada separadamente** por depender de `if`/`context`, que é extensão futura — ela só entraria em `STATION_HANDLERS` quando essa parte da linguagem for implementada.

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

def handle_default(send_cmd, context=None):
    send_cmd('CMD STOP')
    log_event('Estação desconhecida')
    wait_for_signal('manual_override', timeout=None)

STATION_HANDLERS = {
    'carga': handle_carga,
    'cruzamento_pedestres': handle_cruzamento_pedestres,
}

DEFAULT_HANDLER = handle_default


# ⚠️ EXTENSÃO FUTURA — só existe quando if/else + context forem implementados.
# Ver LINGUAGEM_ROBO_COMPILADOR.md, seção 2.2.
def handle_bifurcacao_A(send_cmd, context=None):
    if context.get('next_destination') == 'linha_2':
        send_cmd('CMD TURN_RIGHT')
    else:
        send_cmd('CMD CONTINUE_STRAIGHT')
    send_cmd('CMD RESUME_LINE_FOLLOWING')

# Quando implementado, seria adicionado assim:
# STATION_HANDLERS['bifurcacao_A'] = handle_bifurcacao_A
```

Esse módulo é importado diretamente pelo `station_runner.py` (visto em HARDWARE.md) — não há passo de compilação/linking, é Python interpretado normalmente.

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

> ⚠️ **`test_rejeita_estacao_sem_terminacao` abaixo usa `if`/`else`, extensão futura ainda não implementada.** Ele só passaria a valer quando o Parser/Semântica dessa parte da linguagem existir. Os outros dois testes (`test_rejeita_estacao_faltando`, `test_aceita_programa_valido`) já são válidos hoje, sem depender de condicionais.

```python
# ⚠️ Depende de if/else (extensão futura) — ver nota acima
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

