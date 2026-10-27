# RoboFlow: A Linguagem de Comportamento de Estação

**Conexão do Projeto com Linguagens Formais e Compiladores**  
**Versão:** (Seguidor de Linha Industrial)  
**Data:** Agosto 2026

---

## 🎯 Escopo da Linguagem

RoboFlow **não é uma linguagem de robótica geral**. Ela resolve um problema específico e delimitado: **descrever o que o AGV faz em cada estação da linha**.

Isso é proposital e é o que torna o projeto viável academicamente:

- Seguir a linha é resolvido por PID em firmware fixo — não há nada para "compilar" ali, é controle contínuo clássico.
- O que precisa de uma linguagem é a **lógica discreta de decisão**: dado que cheguei na estação X, o que eu faço? Isso é naturalmente uma máquina de estados, e máquinas de estados são exatamente autômatos finitos — o assunto central da disciplina.

```
┌───────────────────────────────┐
│  Programador escreve RoboFlow │
│  station "carga" { ... }      │
└───────────────┬───────────────┘
                ↓
      ┌─────────────────────┐
      │  COMPILADOR          │
      │  Lexer → Parser →    │
      │  Semântica → Codegen │
      └─────────────────────┘
                ↓
      ┌─────────────────────┐
      │  C++ gerado           │
      │  (roda no ESP32)     │
      └─────────────────────┘
```

![Fluxo do context: do sensor no ESP32 até o C++ gerado](../imagens/context_flow_diagram.png)

---

## 📖 Sintaxe da Linguagem

### Unidade Básica: `station`

Cada estação da linha é um bloco com um handler `on_arrival`:

```roboflow
station "carga" {
    on_arrival {
        stop()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}
```

### Comandos Disponíveis (Biblioteca Padrão)

| Comando | Efeito | Chamada ao runtime (C++ gerado) |
|---|---|---|
| `stop()` | Para o veículo na estação | `RobotRuntime::stop()` |
| `set_speed(v)` | Define velocidade de seguimento (respeitando limite físico) | `RobotRuntime::setSpeed(v)` |
| `turn_left()` / `turn_right()` / `continue_straight()` | Manobra numa estação — fixa, ou escolhida entre elas via `if`/`else` a partir do `context` (ver seção 2.2) | `RobotRuntime::turnLeft()` etc. |
| `signal_buzzer()` / `signal_light()` | Sinalização para operadores humanos | `RobotRuntime::signalBuzzer()` etc. |
| `wait_signal(nome, timeout)` | Aguarda evento externo (sensor de carga, botão) ou expira | espera não bloqueante por `RobotRuntime::hasSignal("<nome>")`, com prazo `<t>` |
| `log(msg)` | Registro para auditoria | `RobotRuntime::log("<msg>")` |
| `resume_line_following()` | Devolve controle à malha rápida (PID no ESP32) — **obrigatório em todo caminho** | `RobotRuntime::resumeLineFollowing()` |

**O runtime é o contrato com o firmware.** O código gerado nunca toca pinos ou motores: só chama as funções do namespace `RobotRuntime`, declaradas em [`robot_runtime.hpp`](../../firmware/include/robot_runtime.hpp) e implementadas à mão no firmware do ESP32. O firmware decide *como* parar, virar ou sinalizar; o RoboFlow decide *quando*. E como o veto de proximidade não faz parte dessa API, nenhum programa RoboFlow consegue desligá-lo.

### Condicionais

> Condicionais estão implementadas em todas as fases do compilador — léxico (§2.1), gramática
> (§3), análise semântica (§4) e geração de código (§5). A única checagem que ainda depende de
> decisão do professor — garantir que a variável usada na condição (ex: `next_destination`) está
> entre as que o ESP32 envia no `context` — existe, mas é **opcional** (ver §2.2).

```roboflow
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
```

### Estação Padrão (Obrigatória)

Todo programa RoboFlow precisa de uma estação `default`, que trata marcadores não reconhecidos:

```roboflow
station default {
    on_arrival {
        stop()
        log("Estação desconhecida")
        wait_signal("manual_override", timeout: none)
    }
}
```

---

## 🔬 Conexão com os Conceitos da Disciplina

### 1. Autômatos Finitos — O Modelo Natural do Problema

O comportamento do AGV **é** um autômato finito:
- **Estados:** `SEGUINDO_LINHA`, `PARADO_AGUARDANDO`, `EXECUTANDO_ESTACAO`, `VETO_SEGURANCA`
- **Alfabeto de entrada:** eventos como `station_event(id)`, `signal_recebido(nome)`, `timeout`, `proximidade_critica`
- **Transições:** definidas implicitamente por cada bloco `station { on_arrival { ... } }`

```
SEGUINDO_LINHA
    --[station_event("carga")]--> EXECUTANDO_ESTACAO(carga)
EXECUTANDO_ESTACAO(carga)
    --[wait_signal("carga_completa") ok]--> SEGUINDO_LINHA
EXECUTANDO_ESTACAO(carga)
    --[timeout 30s]--> ESTADO_ERRO
QUALQUER_ESTADO
    --[proximidade_critica]--> VETO_SEGURANCA   // transição de prioridade máxima, não programável
```

Essa é a ponte direta com **Autômatos**: o compilador pode (e deve) construir esse autômato a partir do programa RoboFlow e verificar propriedades sobre ele — é análise estática clássica de sistemas de estados finitos.

### 2. Análise Léxica

```
Entrada: station "carga" { on_arrival { stop() } }

Tokens:
[KEYWORD:station] [STRING:carga] [LBRACE]
[KEYWORD:on_arrival] [LBRACE]
[KEYWORD:stop] [LPAREN] [RPAREN]
[RBRACE] [RBRACE]
```

> `stop` é **`KEYWORD`, não `ID`** — todos os comandos da biblioteca padrão são palavras
> reservadas (ver a tabela de `KEYWORD (comando)` em §2.1). Só sobra `ID` para identificadores que
> *não* estão reservados, como `next_destination` numa condição de `if`. Repare também que a
> `STRING` já vem **sem as aspas**: o lexer as consome como delimitador e guarda só o conteúdo.

### 2.1 Especificação Léxica (Definição por Expressões Regulares)

O analisador léxico é definido formalmente por um conjunto de **expressões regulares**, uma para cada classe de token. Essa é a especificação completa do lexer: qualquer implementação que reconheça exatamente estas ERs é um lexer válido para RoboFlow.

Cada ER abaixo pode ser convertida em AFN (construção de Thompson), depois em AFD (construção de subconjuntos) e minimizada — o caminho teórico padrão da disciplina. A união de todas elas forma o autômato finito que varre o código-fonte.

| Classe de Token                       | Expressão Regular                                                                                                    | Exemplo de lexema     | Ação do lexer                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------- |
| `WS`                                  | `[ \t\r\n]+`                                                                                                         | (espaço, tab, quebra) | **Descarta**                            |
| `COMMENT`                             | `//[^\n]*`                                                                                                           | `// aguarda esteira`  | **Descarta**                            |
| `KEYWORD` (estrutura)                 | `station\|default\|on_arrival`                                                                                       | `station`             | Devolve `(KEYWORD, lexema)`             |
| `KEYWORD` (comando)                   | `stop\|set_speed\|turn_left\|turn_right\|continue_straight\|resume_line_following\|signal_buzzer\|signal_light\|log` | `turn_right`          | Devolve `(KEYWORD, lexema)`             |
| `KEYWORD` (espera)                    | `wait_signal\|timeout\|none`                                                                                         | `timeout`             | Devolve `(KEYWORD, lexema)`             |
| `STRING`                              | `"[^"\n]*"`                                                                                                          | `"carga_completa"`    | Devolve `(STRING, conteúdo sem aspas)`  |
| `DURATION`                            | `[0-9]+(\.[0-9]+)?s`                                                                                                 | `30s`                 | Devolve `(DURATION, segundos como float)` — `30s` → `30.0` |
| `NUMBER`                              | `[0-9]+(\.[0-9]+)?`                                                                                                  | `0.15`                | Devolve `(NUMBER, int)` se não houver parte decimal, `(NUMBER, float)` se houver |
| `ID`                                  | `[a-zA-Z_][a-zA-Z0-9_]*`                                                                                             | `next_destination`    | Devolve `(ID, lexema)`                  |
| `LBRACE`                              | `\{`                                                                                                                 | `{`                   | Devolve `(LBRACE, "{")`                 |
| `RBRACE`                              | `\}`                                                                                                                 | `}`                   | Devolve `(RBRACE, "}")`                 |
| `LPAREN`                              | `\(`                                                                                                                 | `(`                   | Devolve `(LPAREN, "(")`                 |
| `RPAREN`                              | `\)`                                                                                                                 | `)`                   | Devolve `(RPAREN, ")")`                 |
| `COLON`                               | `:`                                                                                                                  | `:`                   | Devolve `(COLON, ":")`                  |
| `COMMA`                               | `,`                                                                                                                  | `,`                   | Devolve `(COMMA, ",")`                  |
| `OP` | `==` | `==` | Devolve `(OP, "==")` |
| `KEYWORD` (condicional) | `if\|else` | `if` | Devolve `(KEYWORD, lexema)` |

As duas últimas linhas fecham o vocabulário léxico necessário para condicionais (`if`/`else`/`==`).

#### Regras de Desambiguação

Um mesmo trecho de entrada pode casar com mais de uma ER. Duas regras clássicas resolvem todo conflito:

**1. Maximal munch (casamento mais longo):** o lexer sempre escolhe o maior lexema possível a partir da posição atual.

```
Entrada: 30s
  → NUMBER casaria com "30" (2 caracteres)
  → DURATION casa com "30s"  (3 caracteres)  ✅ vence
```

Sem essa regra, `30s` seria lido erradamente como `NUMBER(30)` seguido de `ID(s)`.

> **Detalhe de implementação:** geradores como o `lex`/`flex` aplicam maximal munch
> automaticamente. Um lexer que avalie as ERs em sequência obtém o mesmo resultado **listando
> `DURATION` antes de `NUMBER`** na especificação — a primeira ER que casar vence.
> O lexer deste projeto ([`lexer.py`](../../compiler/roboflow/lexer.py)) usa uma terceira via, equivalente às duas:
> ele **não avalia expressões regulares em tempo de execução**. Lê a sequência de dígitos e, ao
> terminá-la, olha o próximo caractere; se for `s`, emite `DURATION` em vez de `NUMBER`. É o AFD
> resultante das ERs, escrito à mão. As três estratégias reconhecem a mesma linguagem.

**2. Prioridade por ordem (empate no comprimento):** quando duas ERs casam o *mesmo* número de caracteres, vence a que aparece primeiro na especificação. Isso resolve o conflito clássico **palavra reservada × identificador**:

```
Entrada: stop
  → KEYWORD casa com "stop" (4 caracteres)
  → ID      casa com "stop" (4 caracteres)   ← empate!
  → KEYWORD está listada antes → vence  ✅
```

```
Entrada: next_destination
  → KEYWORD não casa (não está na lista de reservadas)
  → ID casa  ✅
```

**Implementação equivalente (a usada no projeto):** em vez de ordenar as ERs, o lexer lê o
identificador inteiro — letras, dígitos e `_` — e só depois consulta a tabela de palavras
reservadas: se o lexema estiver em `KEYWORDS`, o token é `KEYWORD`; senão, `ID`. É o método
`_read_identifier` em [`lexer.py`](../../compiler/roboflow/lexer.py).

As duas abordagens reconhecem exatamente a mesma linguagem — a segunda é mais simples de escrever
à mão e dispensa manter a ordem das ERs como invariante. Ela é a que está implementada; ver
[COMPILADOR_GERA_CONTROLE.md](COMPILADOR_GERA_CONTROLE.md), Fase 1.

A tabela `KEYWORDS` fica em [`tokens.py`](../../compiler/roboflow/tokens.py) e contém exatamente
as palavras das linhas `KEYWORD` da tabela de ERs acima. Ela é montada a partir de duas partes: as
palavras de estrutura, espera e condicional (`station`, `default`, `on_arrival`, `timeout`,
`none`, `if`, `else`) e os nomes da tabela `COMMANDS`, o catálogo da biblioteca padrão. Assim, um
comando novo vira palavra reservada automaticamente ao entrar no catálogo. O único operador, `==`,
é reconhecido diretamente no laço do lexer.

#### Desvios conhecidos da implementação atual

A tabela de ERs acima é a **especificação normativa**. O lexer implementado a cumpre em todos os
casos que aparecem nos programas de exemplo, mas há dois casos-limite em que ele é **mais
permissivo que a especificação**. Ficam registrados aqui porque a diferença entre "o que a ER
define" e "o que o autômato implementado aceita" é justamente o tipo de propriedade que se verifica
numa disciplina de linguagens formais — e porque ambos são corrigíveis sem mexer na gramática.

| Caso | ER diz | Implementação hoje | Efeito |
|---|---|---|---|
| `30.` | `[0-9]+(\.[0-9]+)?` exige dígito **depois** do ponto, então `30.` não é `NUMBER` | Aceita e devolve `(NUMBER, 30.0)` | Deveria ser erro léxico (`RF1003`) |
| `30segundos` | `[0-9]+(\.[0-9]+)?s` casa `30s`, mas maximal munch sobre a entrada inteira prefere o identificador | Devolve `(DURATION, 30.0)` + `(ID, 'egundos')` | O `s` é consumido do meio da palavra |

O segundo caso é o mais interessante teoricamente: o AFD escrito à mão decide o sufixo `s` olhando
**um único caractere à frente**, sem verificar se o identificador continua. Um AFD gerado
mecanicamente a partir da união das ERs não teria esse comportamento, porque compararia o
comprimento total dos dois casamentos possíveis antes de escolher. A correção é uma condição a
mais — só emitir `DURATION` se o caractere seguinte ao `s` não for alfanumérico nem `_` — e está
prevista, mas ainda **não aplicada** ao código.

#### Exemplo de Tokenização Completa

```
Entrada:
    station "carga" {          // ponto de carga
        on_arrival {
            set_speed(0.15)
            wait_signal("ok", timeout: 30s)
        }
    }

Sequência de tokens produzida:
    (KEYWORD, station) (STRING, carga) (LBRACE)
    (KEYWORD, on_arrival) (LBRACE)
    (KEYWORD, set_speed) (LPAREN) (NUMBER, 0.15) (RPAREN)
    (KEYWORD, wait_signal) (LPAREN) (STRING, ok) (COMMA)
        (KEYWORD, timeout) (COLON) (DURATION, 30.0) (RPAREN)
    (RBRACE) (RBRACE)

Descartados: 1 comentário, todos os espaços e quebras de linha
```

> A tradução de cada comando para C++ está na tabela **Comandos Disponíveis** (início deste documento); as regras completas do gerador estão em [COMPILADOR_GERA_CONTROLE.md](COMPILADOR_GERA_CONTROLE.md), Fase 4.

### 2.2 Condicionais e Variáveis Externas — O Mecanismo de `context`

A ideia original incluía uma estação com decisão condicional:

```roboflow
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
```

**Tokenização do trecho acima** (mesmo formato do §2.1):

```
(KEYWORD, if) (ID, next_destination) (OP, ==) (STRING, linha_2) (LBRACE)
    (KEYWORD, turn_right) (LPAREN) (RPAREN)
(RBRACE) (KEYWORD, else) (LBRACE)
    (KEYWORD, continue_straight) (LPAREN) (RPAREN)
(RBRACE)
```

`next_destination` não está na tabela de reservadas, então vira `(ID, next_destination)` — é justamente esse token que o compilador traduz para `RobotRuntime::contextEquals("next_destination", ...)` na geração de código (ver Fase 4 em COMPILADOR_GERA_CONTROLE.md).

**De onde vem `next_destination`?** Não é definida no RoboFlow. É uma informação que o **ESP32 lê de um sensor** (câmera que identifica o tipo de peça, código de barras, RFID, etc) e **fornece junto com o evento de estação**.

#### Como Funciona

1. **O firmware detecta o marcador** e lê a variável via sensor.
2. **O firmware guarda o contexto** (`next_destination = "linha_2"`, `urgency = "high"`) onde o seu
   `RobotRuntime::contextEquals` possa consultá-lo — por exemplo, uma tabela de pares chave/valor.
3. **O firmware inicia a estação:**
   ```cpp
   startStationBehavior(stationIdFromName("bifurcacao_A"));
   ```
4. **A cada volta do `loop()`**, `updateStationBehavior(millis())` avança a máquina de estados que o
   compilador gerou. A decisão do `if` é a primeira instrução da estação:
   ```cpp
   case 0:
       f.pc = RobotRuntime::contextEquals("next_destination", "linha_2") ? 1 : 3;
       break;
   ```

Variável ausente nunca é igual a nada: sem `next_destination` no contexto, o `else` é tomado.

#### O Que Depende do Professor

O `if`/`else` passa por todas as fases do compilador. Duas decisões sobre o `context`, porém,
continuam em aberto:

1. **Checagem de escopo:** validar que toda variável usada em um `if` (ex: `next_destination`) vai
   estar presente no `context` é "checagem de escopo", um tópico da disciplina que o professor vai
   cobrir. O analisador semântico já tem uma proposta implementada: a configuração da pista declara
   `"context_vars": ["next_destination", "urgency"]`, e todo identificador de condição fora dessa
   lista vira erro. Ela é **opcional** — só roda se `context_vars` estiver na configuração — até
   o professor confirmar o mecanismo.

2. **Definição de escopo:** há várias formas de passar variáveis entre escopo externo e funções
   geradas (dicionário, argumentos nomeados, variáveis globais, objetos). O gerador hoje consulta o
   runtime (`RobotRuntime::contextEquals`). Qual o professor prefere? Trocar o mecanismo afeta só o
   gerador, não a linguagem.

#### Status

- **Léxico + Sintático (`if`/`else`/`==`, gramática do `if_stmt`):** ✅ Pronto — ver §2.1 e §3
- **Semântico (terminação nos dois ramos):** ✅ Pronto — ver §4
- **Geração de código (`contextEquals` / `contextKeysEqual`):** ✅ Pronto — ver §5; falta o firmware implementá-los
- **Semântico (`context`, checagem de escopo):** ⏳ Implementado como opção (`context_vars`), aguardando o professor confirmar o mecanismo

### 3. Análise Sintática — Gramática (BNF)

Gramática completa da linguagem, já incluindo condicionais — léxico e sintaxe fechados (ver §2.1).
Os nomes em maiúsculas (`STRING`, `NUMBER`, `DURATION`, `ID`, `KEYWORD`) são **classes de token**
produzidas pelo lexer, definidas na tabela de ERs do §2.1; os termos entre aspas são lexemas
literais. O parser é de **descida recursiva**, com uma função por produção não-terminal:

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

Esta é a gramática que o parser ([`parser.py`](../../compiler/roboflow/parser.py)) implementa, produção por produção.
Três pontos dela costumam surpreender quem lê rápido, e cada um corresponde a uma decisão
deliberada sobre **a fronteira entre análise sintática e análise semântica**.

**1. `command_call` começa com `KEYWORD`, não com `ID`.** Todos os comandos da biblioteca padrão
são palavras reservadas (§2.1), então `stop` chega ao parser como `KEYWORD`. A consequência
prática é que `foo()` — um identificador de verdade — é **rejeitado na análise sintática**,
enquanto `stop()` é aceito. O inverso do que a intuição sugere.

**2. A gramática é deliberadamente mais permissiva que a linguagem.** Como qualquer `KEYWORD`
satisfaz `command_call`, construções como `station()` ou `timeout()` são **sintaticamente
válidas** e passam pelo parser sem erro. Restringir isso ao catálogo real de dez comandos é
trabalho da análise semântica (`RF3003` — "comando desconhecido"), não da gramática. Separar as
duas coisas é o que permite que o parser continue sendo LL(1) e livre de contexto: a lista de
comandos válidos é informação de tabela de símbolos, não de estrutura.

**3. `default` é uma alternativa de `station_decl`, e não há `default_decl` obrigatório.**
`program ::= station_decl*` aceita zero estações, aceita um programa sem nenhum `default`, aceita
`default` antes das estações nomeadas e aceita dois blocos `default`. Nada disso é erro de
sintaxe. As três garantias que a linguagem promete — **existe** um `default`, ele é **único**, e
cada estação é definida **uma só vez** — são restrições semânticas (`RF3001` e `RF3002`), porque
exigem contar e comparar ocorrências ao longo do programa inteiro. Uma gramática livre de contexto
não expressa "exatamente uma ocorrência em qualquer posição" sem inflar a cardinalidade das
produções; é exatamente o tipo de propriedade que se empurra para a fase seguinte.

> Condicionais encadeados (`else { if ... }`) já são uma frase válida desta gramática sem nenhuma
> regra extra: como `stmt_list` dentro do `else` aceita `stmt`, e `stmt` já inclui `if_stmt`, o
> aninhamento vem de graça.

O que ainda depende de conteúdo futuro de aula não é a gramática — é a decisão sobre a checagem de escopo da `condition` (checar que o identificador sempre existe no `context` em tempo de execução, ver §2.2).

### 4. Análise Semântica — As Validações Que Importam Aqui

> **Implementação:** [`semantic.py`](../../compiler/roboflow/semantic.py). É ela que barra o que
> as três notas da §3 deixam passar pela gramática: programa sem `default`, `default` duplicado,
> estação duplicada e comando fora do catálogo. A lista completa de validações, com a mensagem
> exata de cada uma, está em [COMPILADOR_GERA_CONTROLE.md](COMPILADOR_GERA_CONTROLE.md), Fase 3.

Diferente de um compilador genérico, aqui as validações **são a parte interessante do projeto**, porque cada uma corresponde a uma propriedade de segurança real de um AGV industrial:

**Completude:** toda `station_id` que pode aparecer fisicamente na pista precisa ter um bloco correspondente (ou cair no `default`). O compilador recebe a lista de estações comissionadas (arquivo de configuração da pista) e cruza com os blocos definidos.

Se a estação faltante pode cair no `default`, o compilador apenas avisa; se não há `default`, é erro:

```
⚠️ AVISO: estação 'descarga' não tem bloco próprio e usará o comportamento default
❌ ERRO: estações sem comportamento e sem default: descarga
```

**Determinismo:** duas definições para a mesma estação são erro de compilação — não faz sentido o AGV ter duas respostas possíveis para a mesma situação. Uma extensão possível, ainda não implementada, é estender essa checagem para condições de `if` que se sobrepõem.

**Terminação / Ausência de Deadlock:** todo caminho de execução dentro de `on_arrival` precisa terminar em `resume_line_following()` (ou em `wait_signal(..., timeout: none)`, que é uma espera deliberada e explícita). Um caminho que "esquece" de retomar a linha trava o AGV para sempre — isso é testável estaticamente percorrendo a árvore de statements.

```
❌ ERRO: estação 'bifurcacao_A': existe caminho que não termina em resume_line_following()
   nem em wait_signal(..., timeout: none) — o AGV pode travar permanentemente
```

O algoritmo olha a última instrução de cada bloco. Se ela for um `if`, exige a terminação nos
**dois ramos** (`then` e `else`); um `if` sem `else` nunca termina por si só, porque o caminho
"condição falsa" segue adiante.

**Limite Físico:** `set_speed(v)` não pode exceder a velocidade máxima do motor real — validação de tipo/faixa, configurável por hardware através da chave `max_speed` da configuração da pista.

```
❌ ERRO: velocidade 300 excede o máximo 200
```

**Não-Interferência com Segurança:** a linguagem **não tem** nenhum comando capaz de desabilitar o veto de proximidade. Isso não é uma validação em tempo de compilação — é uma escolha de design: o veto simplesmente não está no espaço de comandos que RoboFlow pode gerar. É uma prova por construção, mais forte que uma checagem.

### 5. Geração de Código

**Entrada RoboFlow:**
```roboflow
station "carga" {
    on_arrival {
        stop()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}
```

**Saída C++ (função gerada para a estação):**
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

Cada estação vira uma máquina de estados: `wait_signal` não bloqueia, devolve o controle ao
`loop()` do firmware e retoma do mesmo ponto na volta seguinte. O gerador está em
[`codegen_cpp.py`](../../compiler/roboflow/codegen_cpp.py); a interface com o firmware, as regras de
tradução e a saída completa estão em [COMPILADOR_GERA_CONTROLE.md](COMPILADOR_GERA_CONTROLE.md), Fase 4.

---

## 📊 Matriz de Correlação com a Disciplina

| Conceito | Aplicação Concreta no Projeto |
|---|---|
| Análise Léxica | Tokenizar `station`, `on_arrival`, comandos, strings |
| Análise Sintática | Gramática BNF de `station { on_arrival { ... } }` |
| Análise Semântica | Completude de estações, determinismo, terminação garantida |
| Autômatos Finitos | O comportamento do AGV modelado como FSM; RoboFlow compila para essa FSM |
| Geração de Código | C++ para o ESP32 (uma máquina de estados por estação) a partir da AST |
| Linguagens Formais | Definição formal da gramática, prova de propriedades sobre a FSM gerada |

---

## 💼 Por Que Isso é Comercialmente Relevante

Integradores de automação industrial vendem exatamente este tipo de ferramenta: uma **linguagem de configuração de comportamento de estação** para AGVs, para que o cliente (a fábrica) programe o roteiro de produção sem tocar em firmware ou em detalhes de comunicação serial. O valor de mercado está em: reduzir erro humano (validações do compilador), reduzir tempo de comissionamento (reprogramar estações é editar um arquivo texto e re-executar o compilador, sem escrever nem alterar código de firmware — só rebuild e regravação) e dar auditabilidade (log de decisões).

---

**Este documento substitui a versão anterior baseada em navegação livre com SLAM.**
