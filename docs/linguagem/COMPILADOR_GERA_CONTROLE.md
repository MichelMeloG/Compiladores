# Como o Compilador RoboFlow Gera o Módulo de Decisão de Estação


---

## 📋 Escopo

Este documento detalha as quatro fases do compilador RoboFlow, aplicadas ao problema concreto do projeto: transformar uma descrição de **comportamento de estação** em código **C++ para o ESP32** (`behavior_generated.hpp` e `behavior_generated.cpp`), que o firmware do carrinho compila junto de si e chama a cada volta do `loop()`.

Importante: o compilador **não gera o código de seguimento de linha** (isso é PID fixo em firmware, fora do escopo da linguagem) e **não usa ROS 2** — o alvo de geração é uma máquina de estados C++ simples por estação, não um nó de middleware.

> **Estado da implementação.** As quatro fases estão implementadas no pacote
> [`compiler/roboflow/`](../../compiler/roboflow/), com testes em [`tests/`](../../tests/). Este
> documento explica o que cada fase faz e por quê; o código fica nos arquivos, e cada seção
> aponta para o arquivo correspondente.
>
> **Sobre `bifurcacao_A` e o `context`.** Os exemplos com `if`/`else` usam um parâmetro `context`
> para representar variáveis que o **ESP32 fornece** ao detectar a estação (ex: `next_destination`
> lido de um sensor). O firmware guarda essas variáveis e o código gerado as consulta pelo runtime
> (`RobotRuntime::contextEquals("next_destination", "linha_2")`).
> Esses programas são aceitos, validados e compilados de ponta a ponta. A única checagem que ainda
> depende do professor — se a variável usada na condição estará presente no `context` — existe,
> mas é **opcional**: só roda quando a configuração da pista declara `context_vars` (ver Fase 3 e
> [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md), §2.2).

---

## 🗂️ Onde Está Cada Fase

| Fase | Arquivo | Entrada → saída |
|---|---|---|
| 1. Análise léxica | [`lexer.py`](../../compiler/roboflow/lexer.py), [`tokens.py`](../../compiler/roboflow/tokens.py) | texto → lista de `Token` |
| 2. Análise sintática | [`parser.py`](../../compiler/roboflow/parser.py), [`ast_nodes.py`](../../compiler/roboflow/ast_nodes.py) | tokens → `ProgramNode` (AST) |
| 3. Análise semântica | [`semantic.py`](../../compiler/roboflow/semantic.py) | AST → listas de erros e avisos |
| 4. Geração de código | [`codegen_cpp.py`](../../compiler/roboflow/codegen_cpp.py) | AST → texto de `behavior_generated.hpp` e `.cpp` |
| 4. (alvo futuro) | [`codegen_python.py`](../../compiler/roboflow/codegen_python.py) | AST → `compiled_behavior.py`, para a etapa com Raspberry Pi (`target="python"`) |
| Diagnósticos | [`diagnostics.py`](../../compiler/roboflow/diagnostics.py) | `Diagnostic` e `CompileError`, usados por todas as fases |
| Ponto de entrada | [`compiler.py`](../../compiler/roboflow/compiler.py) | `compile_roboflow(source, config)` → `Result` |

### Usando o compilador

```python
from compiler.roboflow import compile_roboflow

result = compile_roboflow(source, {"commissioned_stations": ["carga"], "max_speed": 200})
if result.ok:
    for name, text in result.files.items():      # behavior_generated.hpp e behavior_generated.cpp
        Path("firmware/include" if name.endswith(".hpp") else "firmware/src", name).write_text(text, encoding="utf-8")
else:
    for diag in result.errors:
        print(diag)          # 3:19: error [semantic] velocidade 300 excede o máximo 200
```

`compile_roboflow` **nunca lança exceção**: foi feito para a IDE chamar a cada tecla, com o código
quase sempre incompleto. O `Result` traz `ok`, `errors`, `warnings`, `tokens` (preenchido mesmo
quando o parser falha, para o highlight continuar funcionando) e `files` (nome do arquivo gerado → conteúdo). Cada `Diagnostic`
tem `phase` (`lexer`, `parser`, `semantic` ou `codegen`), `severity` (`error` ou `warning`),
`message`, `line` e `col`.

Para ver as saídas intermediárias das quatro fases:

```bash
python examples/demo_compilador.py examples/rota_completa.rf
```

---

## 🎯 Por Que o Alvo é C++ no ESP32

Toda a lógica de estação roda **dentro do ESP32**, junto do seguimento de linha e do veto de segurança. O carrinho não depende de computador nenhum a bordo, e o Raspberry Pi — que identificaria estações e despacharia comandos pela serial — fica para uma etapa futura.

| Dispositivo | Roda SO? | Linguagem | Por que |
|---|---|---|---|
| ESP32 | Não (bare metal/RTOS leve) | **C/C++ obrigatório** | Sem sistema operacional, não há interpretador Python; e a malha de seguimento de linha exige timing de PID confiável a ~100 Hz, que só C/C++ compilado garante nesse hardware |

Duas consequências moldam o código gerado:

- **Nada pode bloquear.** O `loop()` do ESP32 precisa atender sensores, PID e veto de proximidade a cada volta; um `delay()` ou um laço de espera dentro de uma estação congelaria tudo isso. Por isso `wait_signal` não espera: cada estação vira uma **máquina de estados** que o `loop()` avança aos poucos, e sem o sinal ela apenas devolve o controle.
- **O código gerado não toca o hardware.** Ele só chama a API de [`robot_runtime.hpp`](../../firmware/include/robot_runtime.hpp) (`stop()`, `setSpeed()`, `hasSignal()`...), escrita à mão no firmware. Como o veto de proximidade vive fora dessa API, nenhum programa RoboFlow consegue desligá-lo — nem por engano.

O firmware-base (seguimento de linha, veto, drivers, o `loop()`) **não é gerado pelo compilador**: é escrito à mão em C++ uma única vez, porque essa lógica não muda por estação nem por comissionamento de pista.

O gerador de Python (`target="python"`) continua no repositório para a etapa com Raspberry Pi, mas não é o alvo padrão e não tem relação com o firmware.

---

## 🔄 Exemplo Completo: Do RoboFlow ao C++

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

**Implementação:** classe `Lexer` em [`lexer.py`](../../compiler/roboflow/lexer.py); classes de
token, palavras reservadas e catálogo de comandos em
[`tokens.py`](../../compiler/roboflow/tokens.py). O lexer reconhece exatamente as classes
especificadas em [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md), seção 2.1 —
incluindo `if`, `else` e `==`, que já fazem parte do léxico fechado.

**É uma varredura caractere a caractere, não uma avaliação de expressões regulares.** A tabela de
ERs do §2.1 continua sendo a especificação normativa; o que o código faz é implementar à mão o AFD
que resulta dela. Não há `import re` no lexer. A vantagem dessa escolha é o controle preciso de
**linha e coluna** em cada token, que é o que permite mensagens de erro apontando a posição exata
— e mensagens de erro boas são metade do valor de um compilador de configuração industrial.

**Tokens.** Cada token é um `Token(type, value, line, col)`. Por ser um `NamedTuple`, ele também
pode ser lido como tupla (`tok[0]`, `tok[1]`). `TokenType` é um `enum` que herda de `str`, então
`tok.type == "KEYWORD"` é verdadeiro. As palavras reservadas (`KEYWORDS`) são as palavras de
estrutura (`station`, `if`, `timeout`...) somadas aos nomes da tabela `COMMANDS` — a mesma tabela
que a análise semântica usa para validar os comandos (Fase 3), e que a IDE pode usar para
autocomplete e highlight.

**O laço principal** (`Lexer.tokenize`) despacha pelo caractere inicial. Cada ramo corresponde a
uma transição do autômato de volta ao estado inicial, já tendo emitido (ou descartado) um lexema:

| Caractere inicial | Classe reconhecida | Método |
|---|---|---|
| quebra de linha, espaço, tab | `WS` — descartado; a quebra soma 1 à linha e volta a coluna para 1 | `tokenize` |
| `//` | `COMMENT` — descartado até o fim da linha | `tokenize` |
| `==` | `OP` | `tokenize` |
| `{` `}` `(` `)` `:` `,` | delimitadores | `tokenize` |
| `"` | `STRING` | `_read_string` |
| dígito | `NUMBER` ou `DURATION` | `_read_number` |
| letra ou `_` | `KEYWORD` ou `ID` | `_read_identifier` |
| qualquer outro | erro léxico | `_error` |

Espaços e comentários descartados também avançam a coluna. Sem isso, o `EOF` — e qualquer erro
depois de um comentário — apontaria para a posição errada.

**Onde as duas regras de desambiguação do §2.1 aparecem no código.** *Maximal munch* está em
`_read_number`: depois de consumir os dígitos, o lexer olha um caractere à frente e, se for `s`,
emite `DURATION` em vez de `NUMBER` — é o que impede `30s` de virar `NUMBER(30)` + `ID(s)`.
*Palavra reservada × identificador* está em `_read_identifier`: o lexer lê o identificador
completo e só então consulta `KEYWORDS`, de modo que `stop` sai como `KEYWORD` e
`next_destination` sai como `ID`, sem precisar ordenar expressões regulares.

Repare que `NUMBER` preserva `int` quando não há parte decimal — `set_speed(1)` gera `1`, não
`1.0`. `DURATION` é sempre `float`.

**Erros léxicos** param a compilação com um `CompileError` de fase `lexer`, em vez de o caractere
ser silenciosamente ignorado:

| Situação | Exemplo | Posição apontada |
|---|---|---|
| Caractere fora do alfabeto | `log(@)` | o próprio caractere |
| String não terminada | `log("abc` | a aspa de abertura |
| Quebra de linha dentro de string | `log("ab` + quebra + `c")` | a aspa de abertura |
| Número com dois pontos | `set_speed(1.2.3)` | o segundo ponto |

```
4:13: error [lexer] caractere inesperado '@'
```

> Dois casos-limite em que o lexer atual é mais permissivo que a especificação (`30.` aceito como
> número, e `30segundos` lido como `DURATION` + `ID`) estão registrados em
> [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md), §2.1, em "Desvios conhecidos da
> implementação atual".

**Tokens gerados para `station "carga" {`:**
```
[KEYWORD:station] [STRING:carga] [LBRACE]
```

---

## 🌳 Fase 2: Análise Sintática

**Implementação:** classe `Parser` em [`parser.py`](../../compiler/roboflow/parser.py); nós da
AST em [`ast_nodes.py`](../../compiler/roboflow/ast_nodes.py). O parser cobre a gramática
inteira, **incluindo `if`/`else`**.

### Gramática BNF

Idêntica à publicada em [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md), §3 — os
nomes em maiúsculas são classes de token vindas do lexer:

```bnf
program        ::= station_decl*

station_decl   ::= "station" (STRING | "default") "{" "on_arrival" "{" stmt_list "}" "}"

stmt_list      ::= stmt*

stmt           ::= command_call | if_stmt

command_call   ::= KEYWORD "(" arg_list? ")"

arg_list       ::= arg ("," arg)*

arg            ::= STRING | NUMBER | DURATION | ID | timeout_arg

timeout_arg    ::= "timeout" ":" (DURATION | "none")

if_stmt        ::= "if" condition "{" stmt_list "}" ("else" "{" stmt_list "}")?

condition      ::= ID "==" (STRING | ID)
```

Dois detalhes da gramática que vêm direto do lexer: `timeout_arg` recebe um `DURATION` inteiro
(`30s` já chega como **um** token, não como `NUMBER` seguido de `"s"`), e `command_call` começa
com `KEYWORD` porque todos os comandos da biblioteca padrão são palavras reservadas. Isso faz o
parser **rejeitar** `foo()` e **aceitar** `stop()` — e também aceitar `station()`, que é
sintaticamente válido e é barrado na análise semântica (`RF3003`). As três notas da §3 do
documento de linguagem explicam a fronteira entre o que a gramática captura e o que sobra para a
fase seguinte.

### Parser (Recursivo Descendente)

Cada não-terminal da gramática vira um método do `Parser`, e o corpo de cada método lê como a
produção que ele implementa:

| Produção | Método |
|---|---|
| `program` | `parse` |
| `station_decl` | `station_decl` |
| `stmt_list` | `stmt_list` |
| `stmt` | `stmt` |
| `command_call` e `arg_list` | `command_call` |
| `arg` | `arg` |
| `timeout_arg` | `timeout_arg` |
| `if_stmt` | `if_stmt` |
| `condition` | `condition` |

Sobre eles, três utilitários de navegação: `check` (olha sem consumir), `match` (consome se casar,
devolvendo `bool`) e `consume` (exige casar, ou lança erro com linha e coluna).

A escolha de produção em `stmt` é feita com **um único token de lookahead** (`check` não consome):
se o próximo token é a palavra `if`, deriva `if_stmt`; caso contrário, `command_call`. Não há
ambiguidade nem necessidade de backtracking em nenhum ponto da gramática — é o que caracteriza um
parser **LL(1)**, e é por isso que a descida recursiva funciona aqui sem nenhuma tabela.

O mesmo vale para `arg`, que decide pelo tipo do token atual e trata `timeout:` como caso especial
por ser o único argumento nomeado da linguagem. E `condition` só aceita `STRING` ou `ID` do lado
direito do `==`; qualquer outro token é erro sintático.

O `if_stmt` consome `if`, a condição, o bloco `then`, e um bloco `else` opcional. Como `stmt_list`
dentro do `else` chama `stmt`, que por sua vez pode chamar `if_stmt`, o **aninhamento de
condicionais funciona sem nenhuma regra extra** — é recursão mútua, de graça.

**`parse` guarda todas as estações numa lista só**, na ordem do código e com `default` inclusive.
O parser não decide quantas `default` são permitidas (nota 3 da §3 do documento de linguagem): ele
preserva todas para que a análise semântica possa apontar a segunda como duplicada. Se o parser
guardasse só uma, a outra desapareceria sem aviso.

**Posições na AST.** Os nós são `dataclass`es, e todos carregam `line`/`col` do token que os
inicia: a estação guarda a posição da palavra `station`; o comando, a do nome do comando; o
argumento, a do próprio literal. É isso que permite à análise semântica apontar o `300` de
`set_speed(300)`, e não só a estação inteira.

**Erros sintáticos** param a compilação com um `CompileError` de fase `parser`, apontando o token
encontrado no lugar do esperado:

```
5:5: error [parser] esperado ')' para fechar 'wait_signal' (encontrado '}')
```

Código incompleto — o estado normal enquanto se digita na IDE — nunca derruba o parser com
`IndexError` ou `TypeError`: o lexer sempre termina a lista com `EOF`, e um `EOF` onde se esperava
outra coisa vira "fim de arquivo inesperado". O erro aponta para o **último token real** (onde o
programador parou de digitar), não para o fim do arquivo, que pode estar várias linhas em branco
abaixo. Para `station "carga" {`, `on_arrival {`, `stop()` em três linhas, sem fechar nada:

```
3:14: error [parser] fim de arquivo inesperado: esperado '}' para fechar on_arrival
```

### AST Resultante (Estação "carga")

Saída real de `ProgramNode.print_tree()` para a estação `carga` do programa de entrada acima:

```
└── 📄 PROGRAM
    └── 🏭 STATION "carga"
        ├── ⚙️ COMMAND: stop()
        ├── ⚙️ COMMAND: wait_signal()
        │   ├── 💎 STRING: 'carga_completa'
        │   └── 🏷️ timeout:
        │       └── 💎 DURATION: 30.0
        └── ⚙️ COMMAND: resume_line_following()
```

Note que `timeout: 30s` aparece como um **`NamedArgNode`** (`🏷️`) contendo um literal, distinto
dos argumentos posicionais (`💎`) — é essa distinção que o gerador de código usa depois para emitir
o prazo em milissegundos (`30000UL`) separado do nome do sinal.

---

## ✅ Fase 3: Análise Semântica

**Implementação:** classe `SemanticAnalyzer` em
[`semantic.py`](../../compiler/roboflow/semantic.py).

Aqui está o núcleo do valor acadêmico do projeto: cada validação corresponde a uma propriedade de segurança física do AGV.

Diferente do lexer e do parser, o analisador **não para no primeiro problema**: percorre a AST
inteira e acumula `Diagnostic`s em `errors` e `warnings`, para que a IDE mostre todos de uma vez.
O programa só segue para a geração de código se `errors` estiver vazia.

### As Validações

| Validação | Mensagem | Posição apontada |
|---|---|---|
| Existe uma `default` | `o programa precisa de uma 'station default'` | início do arquivo |
| A `default` é única | `'station default' declarada mais de uma vez` | a segunda `default` |
| Determinismo | `estação 'carga' definida mais de uma vez` | a repetição |
| Completude, havendo `default` | aviso: `estação 'descarga' não tem bloco próprio e usará o comportamento default` | início do arquivo |
| Completude, sem `default` | `estações sem comportamento e sem default: descarga` | início do arquivo |
| Comando existe | `comando desconhecido 'station'` | o comando |
| Quantidade de argumentos | `'stop' espera 0 argumento(s), recebeu 1` | o comando |
| Tipo dos argumentos | `argumento 1 de 'set_speed' deve ser número, recebeu string` | o argumento |
| Limite físico | `velocidade 300 excede o máximo 200` | o argumento |
| Variável de contexto declarada (opcional) | `variável de contexto 'urgencia' não declarada em context_vars` | o identificador |
| Terminação | `estação 'bifurcacao_A': existe caminho que não termina em resume_line_following() nem em wait_signal(..., timeout: none) — o AGV pode travar permanentemente` | a estação |

**O catálogo de comandos.** Existência, quantidade e tipo dos argumentos vêm de uma tabela única,
`COMMANDS`, em [`tokens.py`](../../compiler/roboflow/tokens.py): `nome → (aridade, tipos dos
argumentos)`. Por exemplo, `set_speed` é `(1, ("NUMBER",))` e `wait_signal` é
`(2, ("STRING", "TIMEOUT"))`, onde `TIMEOUT` é o argumento nomeado `timeout: <duração | none>`.
Acrescentar um comando à linguagem começa por essa tabela: dela saem a palavra reservada no lexer
e a validação aqui, e o gerador recusa qualquer comando que não saiba traduzir.

**Terminação.** A última instrução de cada bloco precisa ser `resume_line_following()` ou
`wait_signal(..., timeout: none)`. Se a última instrução for um `if`, os **dois ramos** precisam
terminar assim — e um `if` sem `else` nunca termina por si só, porque o caminho "condição falsa"
segue adiante sem retomar a linha.

### Configuração da Pista

O segundo argumento de `compile_roboflow` é um dicionário, tipicamente lido de um JSON da pista.
Todas as chaves são opcionais; sem a chave, a validação correspondente simplesmente não roda:

```json
{
  "commissioned_stations": ["carga", "cruzamento_pedestres", "bifurcacao_A", "descarga"],
  "max_speed": 200,
  "context_vars": ["next_destination", "urgency"]
}
```

| Chave | Validação que liga |
|---|---|
| `commissioned_stations` | Completude: toda estação da pista tem bloco próprio ou cai no `default` |
| `max_speed` | Limite físico: `set_speed(v)` com `v` acima do máximo é erro |
| `context_vars` | Todo identificador numa condição de `if` precisa estar nesta lista |

> `context_vars` é a proposta para fechar a pendência do `context`
> ([LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md), §2.2), e por isso é opcional:
> confirme com o professor antes de ligá-la na configuração real da pista.

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
1:1: error [semantic] estação 'bifurcacao_A': existe caminho que não termina em
     resume_line_following() nem em wait_signal(..., timeout: none) — o AGV pode travar permanentemente
```

```roboflow
// ❌ ERRO: estação comissionada "descarga" não tem bloco e não há default
station "carga" { on_arrival { stop() resume_line_following() } }
// fim do arquivo, sem "descarga" e sem "default"
```
```
1:1: error [semantic] o programa precisa de uma 'station default'
1:1: error [semantic] estações sem comportamento e sem default: descarga
```

```roboflow
// ❌ ERRO: estação duplicada
station "carga" { on_arrival { stop() resume_line_following() } }
station "carga" { on_arrival { set_speed(0.1) resume_line_following() } }
```
```
2:1: error [semantic] estação 'carga' definida mais de uma vez
```

---

## 🔧 Fase 4: Geração de Código

**Implementação:** classe `CppCodeGenerator` em
[`codegen_cpp.py`](../../compiler/roboflow/codegen_cpp.py). Só roda se a análise semântica não
encontrou erros, então pode supor que quantidade e tipo dos argumentos já foram validados. Gera dois
arquivos, `behavior_generated.hpp` e `behavior_generated.cpp`, sempre iguais para a mesma entrada.

### Interface com o firmware

O firmware usa quatro funções, declaradas no `.hpp` gerado:

| Função | Quando o firmware a chama |
|---|---|
| `stationIdFromName(nome)` | ao ler o marcador da estação; nome desconhecido devolve `STATION_DEFAULT` |
| `startStationBehavior(id)` | uma vez, ao chegar na estação (substitui o que estiver rodando) |
| `updateStationBehavior(millis())` | **a cada volta do `loop()`**, enquanto a estação roda |
| `stationBehaviorActive()` | para saber se o comportamento já terminou |

E o código gerado, por sua vez, só chama o runtime que o firmware implementa
([`robot_runtime.hpp`](../../firmware/include/robot_runtime.hpp)). Esse arquivo é o **contrato**
entre compilador e firmware; o compilador nunca emite acesso a pinos ou motores.

### Uma estação = uma máquina de estados

Cada `station` vira uma função `step_<estação>` com um `switch` sobre o contador `pc`; cada `case` é
uma instrução. A função devolve `true` quando a estação terminou e `false` quando precisa esperar:

```cpp
// station "carga"
bool step_carga(StationFrame& f, unsigned long nowMs) {
    for (;;) {
        switch (f.pc) {
        case 0:
            RobotRuntime::stop();
            f.pc = 1;
            break;
        case 1:
            if (!f.waiting) {
                f.waiting = true;
                f.deadlineMs = nowMs + 30000UL;
            }
            if (RobotRuntime::hasSignal("carga_completa")) {
                f.waiting = false;
                f.pc = 2;
                break;
            }
            if (static_cast<long>(nowMs - f.deadlineMs) >= 0) {
                f.waiting = false;
                f.pc = 2;
                break;
            }
            return false;
        case 2:
            RobotRuntime::resumeLineFollowing();
            f.pc = 3;
            break;
        default:
            return true;
        }
    }
}
```

Instruções comuns (`stop`, `set_speed`...) avançam o `pc` e o laço `for (;;)` executa a seguinte
na mesma chamada. Só o `wait_signal` devolve `false`: guarda o prazo em `deadlineMs` na primeira
vez que passa por ali e, nas voltas seguintes, retoma do mesmo `case`.

O `if` vira desvio entre `case`s — o `case 0` escolhe entre o ramo `then` e o `else`, e o fim do
`then` pula o `else`:

```cpp
// station "bifurcacao_A"
bool step_bifurcacao_a(StationFrame& f, unsigned long /*nowMs*/) {
    for (;;) {
        switch (f.pc) {
        case 0:
            f.pc = RobotRuntime::contextEquals("next_destination", "linha_2") ? 1 : 3;
            break;
        case 1:
            RobotRuntime::turnRight();
            f.pc = 2;
            break;
        case 2:
            f.pc = 4;
            break;
        case 3:
            RobotRuntime::continueStraight();
            f.pc = 4;
            break;
        case 4:
            RobotRuntime::resumeLineFollowing();
            f.pc = 5;
            break;
        default:
            return true;
        }
    }
}
```

### Regras de Tradução

| RoboFlow | C++ gerado |
|---|---|
| `stop()`, `turn_left()`, `turn_right()`, `continue_straight()`, `signal_buzzer()`, `signal_light()`, `resume_line_following()` | `RobotRuntime::stop();`, `turnLeft`, `turnRight`, `continueStraight`, `signalBuzzer`, `signalLight`, `resumeLineFollowing` |
| `set_speed(0.15)` | `RobotRuntime::setSpeed(0.15f);` |
| `log("msg")` | `RobotRuntime::log("msg");` |
| `wait_signal("x", timeout: 30s)` | espera por `RobotRuntime::hasSignal("x")` com prazo de `30000UL` ms |
| `wait_signal("x", timeout: none)` | a mesma espera, sem prazo |
| `if v == "s" Ellipsis` | `RobotRuntime::contextEquals("v", "s")` |
| `if v == w Ellipsis` | `RobotRuntime::contextKeysEqual("v", "w")` |

**O que acontece quando o prazo expira?** O `wait_signal` termina do mesmo jeito que se o sinal
tivesse chegado, e a estação segue para a próxima instrução — é o que "aguarda ou expira" significa
na tabela de comandos. Se a estação não deveria prosseguir sem o sinal, o programa deve usar
`timeout: none`. (O diagrama de autômato de [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md)
mostra o timeout levando a um `ESTADO_ERRO`; esse estado ainda não existe na linguagem.)

Detalhes que evitam gerar C++ inválido ou que falha no carrinho:

- **Strings viram literais ASCII puros.** Bytes UTF-8 (`ç`, `ã`) saem como escapes octais de três
  dígitos (`\303\247`), que não se confundem com o caractere seguinte; `\`, `"` e `?` também são
  escapados (`??` seria lido como trígrafo por alguns compiladores).
- **Prazos comparam com subtração com sinal** (`static_cast<long>(nowMs - deadlineMs) >= 0`), o que
  continua certo quando `millis()` estoura a cada ~49 dias. Por isso o prazo máximo é 2³¹ ms (~24,8
  dias); acima disso o gerador recusa o programa (erro `codegen`, apontando o valor).
- **Nomes de estação viram identificadores únicos.** `"bifurcacao_A"` vira `STATION_BIFURCACAO_A`;
  caracteres fora de `[A-Za-z0-9_]` viram `_`, maiúsculas e minúsculas não distinguem, e colisões
  ganham `_2`. O prefixo `STATION_` também evita os macros do Arduino (`HIGH`, `LOW`, `INPUT`...).
- **Comando sem tradução levanta erro** (fase `codegen`) em vez de ser omitido: um comando que some
  do código gerado sem aviso é exatamente o tipo de defeito que um compilador de segurança não pode
  ter.
- **O C++ gerado é C++11**, o mínimo aceito pelo núcleo Arduino-ESP32.

### Saída Gerada

Para o programa de entrada acima. O `.hpp` completo:

```cpp
// Gerado automaticamente pelo compilador RoboFlow. Nao editar manualmente.
#pragma once

#include <stdint.h>

enum class StationId : uint8_t {
    STATION_CARGA,
    STATION_CRUZAMENTO_PEDESTRES,
    STATION_BIFURCACAO_A,
    STATION_DEFAULT,
};

// Nome do marcador -> estacao. Nome desconhecido devolve STATION_DEFAULT.
StationId stationIdFromName(const char* name);

// Inicia o on_arrival da estacao (substitui o que estiver rodando).
void startStationBehavior(StationId station);

// Avanca o comportamento sem bloquear. Chamar a cada volta do loop().
void updateStationBehavior(unsigned long nowMs);

// true enquanto o comportamento iniciado ainda nao terminou.
bool stationBehaviorActive();
```

E, do `.cpp`, a estação `default`, que espera para sempre (`timeout: none`) e por isso nunca usa `deadlineMs`:

```cpp
// station default
bool step_default(StationFrame& f, unsigned long /*nowMs*/) {
    for (;;) {
        switch (f.pc) {
        case 0:
            RobotRuntime::stop();
            f.pc = 1;
            break;
        case 1:
            RobotRuntime::log("Esta\303\247\303\243o desconhecida");
            f.pc = 2;
            break;
        case 2:
            if (RobotRuntime::hasSignal("manual_override")) {
                f.pc = 3;
                break;
            }
            return false;
        default:
            return true;
        }
    }
}
```

O `context` do `if` é o `(ID, next_destination)` que o lexer produziu: identificadores não
reservados viram o primeiro argumento de `contextEquals`. Variável ausente nunca é igual a nada, então
sem `next_destination` o `else` é tomado. Declarar `context_vars` na configuração faz o compilador
recusar condições sobre variáveis que o firmware não preenche, mas não garante, em tempo de
execução, que ele as preencha em todo evento.

---

## 🎯 Propriedades Provadas Antes de Gerar Código

| Propriedade | O que garante fisicamente |
|---|---|
| Completude | Todo marcador que existe na pista real tem resposta programada |
| Determinismo | Nenhuma estação tem comportamento ambíguo |
| Terminação | O AGV nunca fica travado numa estação por esquecimento de programação |
| Limite físico | Nenhum programa pede ao motor uma velocidade acima da que ele suporta |
| Fora do escopo do compilador (por design) | Nenhum programa RoboFlow pode desabilitar o veto de proximidade — o comando simplesmente não existe na linguagem |

---

## 🧪 Testes do Compilador

Os testes ficam em [`tests/`](../../tests/) e rodam com `pytest` a partir da raiz do repositório:

```bash
python -m pytest
```

| Arquivo | O que cobre |
|---|---|
| [`test_lexer.py`](../../tests/test_lexer.py) | Linha e coluna de cada token, maximal munch, comentários descartados, erros léxicos |
| [`test_parser.py`](../../tests/test_parser.py) | Posição dos nós, `if`/`else`, várias `default` preservadas, fim de arquivo inesperado em vários pontos |
| [`test_semantic.py`](../../tests/test_semantic.py) | Cada validação da Fase 3, com mensagem e posição |
| [`test_codegen_cpp.py`](../../tests/test_codegen_cpp.py) | Estrutura do C++ gerado; e, com compilador C++, **compila o código (`-std=c++11 -Wall -Wextra -Werror`) e o executa** contra um runtime falso: `wait_signal` sem bloquear, timeout, `if`/`else` pelo contexto, troca de estação |
| [`test_codegen_python.py`](../../tests/test_codegen_python.py) | O gerador Python da etapa futura |
| [`test_compiler.py`](../../tests/test_compiler.py) | `compile_roboflow` nunca lança exceção em nenhum prefixo de `rota_completa.rf`; resultado de cada fase; alvos |

Os testes que compilam C++ precisam de um compilador: `g++`, `clang++` ou `c++` no `PATH`, ou o
comando completo em `ROBOFLOW_CXX` (por exemplo `ROBOFLOW_CXX="python -m ziglang c++"`, com
`pip install ziglang`). Sem compilador eles são pulados, não falham. O runtime falso e o simulador de
`loop()` estão em [`tests/cpp/harness.cpp`](../../tests/cpp/harness.cpp).

Os três testes que este documento especificava — `test_rejeita_estacao_sem_terminacao`,
`test_rejeita_estacao_faltando` e `test_aceita_programa_valido` — estão em `test_semantic.py`,
lendo `result.errors[0].message` em vez das antigas funções globais `get_errors()` e
`get_generated_code()`.

---

**Consulte [PROJETO_ROBO.md](../projeto/PROJETO_ROBO.md), [LINGUAGEM_ROBO_COMPILADOR.md](LINGUAGEM_ROBO_COMPILADOR.md) e [ARQUITETURA_DUAS_CAMADAS.md](../arquitetura/ARQUITETURA_DUAS_CAMADAS.md) para o restante da documentação.**
