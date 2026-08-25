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
      │  Módulo Python        │
      │  (roda no Pi)        │
      └─────────────────────┘
```

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

| Comando                                                | Efeito                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `stop()`                                               | Envia `CMD STOP` na serial                                                       |
| `set_speed(v)`                                         | Define velocidade de seguimento (respeitando limite físico)                      |
| `turn_left()` / `turn_right()` / `continue_straight()` | Comando fixo de manobra numa estação (a *escolha automática* entre eles via `if`/`else` está adiada — ver seção 2.2) |
| `wait_signal(nome, timeout)`                           | Aguarda evento externo (ex: sensor de carga, botão) ou expira                    |
| `signal_buzzer()` / `signal_light()`                   | Sinalização para operadores humanos                                              |
| `log(msg)`                                             | Registro para auditoria                                                          |
| `resume_line_following()`                              | Devolve controle à malha rápida (PID no ESP32) — **obrigatório em todo caminho** |

### Condicionais (Adiado — ver seção 2.2)

> Esta parte da linguagem ainda **não está implementada** — depende de um mecanismo (variáveis vindas de fora do programa) que ainda não foi coberto em aula. Fica registrado aqui como próximo passo, não como parte do escopo atual.

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
[KEYWORD:station] [STRING:"carga"] [LBRACE]
[KEYWORD:on_arrival] [LBRACE]
[ID:stop] [LPAREN] [RPAREN]
[RBRACE] [RBRACE]
```

### 2.1 Tabela Completa de Tokens

Como o backend do compilador é Python, cada token da linguagem já nasce com um destino conhecido: ou vira uma construção sintática do próprio Python, ou vira uma chamada para uma função do runtime (`roboflow_runtime.py`) que o `station_runner.py` importa junto com o módulo gerado. Não existe token em RoboFlow sem uma tradução 1:1 definida.

| Categoria                       | Token (lexema)          | Tipo de Token         | Construção Python Gerada                      | Runtime necessário                      | Observações                                                                                                                           |
| ------------------------------- | ----------------------- | --------------------- | --------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Estrutura**                   | `station`               | `KEYWORD`             | `def handle_<nome>(send_cmd, context=None):`  | —                                       | Toda função gerada sempre aceita `context`, mesmo que não use — `station_runner.py` sempre chama `handler(send_cmd, context=context)` |
|                                 | `default`               | `KEYWORD`             | `def handle_default(send_cmd, context=None):` | —                                       | —                                                                                                                                     |
|                                 | `on_arrival`            | `KEYWORD`             | (delimita o corpo — não gera código)          | —                                       | —                                                                                                                                     |
|                                 | `{` `}`                 | `LBRACE` / `RBRACE`   | Indentação de bloco Python (4 espaços)        | —                                       | —                                                                                                                                     |
|                                 | `(` `)`                 | `LPAREN` / `RPAREN`   | Parênteses de chamada de função               | —                                       | —                                                                                                                                     |
| **Comandos de movimento**       | `stop`                  | `KEYWORD`             | `send_cmd('CMD STOP')`                        | `send_cmd(str)`                         | Sem parâmetros                                                                                                                        |
|                                 | `set_speed`             | `KEYWORD`             | `send_cmd(f'CMD SET_SPEED {v}')`              | `send_cmd(str)`                         | Recebe parâmetro numérico `v`                                                                                                         |
|                                 | `turn_left`             | `KEYWORD`             | `send_cmd('CMD TURN_LEFT')`                   | `send_cmd(str)`                         | Sem parâmetros                                                                                                                        |
|                                 | `turn_right`            | `KEYWORD`             | `send_cmd('CMD TURN_RIGHT')`                  | `send_cmd(str)`                         | Sem parâmetros                                                                                                                        |
|                                 | `continue_straight`     | `KEYWORD`             | `send_cmd('CMD CONTINUE_STRAIGHT')`           | `send_cmd(str)`                         | Sem parâmetros                                                                                                                        |
|                                 | `resume_line_following` | `KEYWORD`             | `send_cmd('CMD RESUME_LINE_FOLLOWING')`       | `send_cmd(str)`                         | Obrigatório em todo caminho de execução                                                                                               |
| **Sinalização**                 | `signal_buzzer`         | `KEYWORD`             | `send_cmd('CMD SIGNAL_BUZZER')`               | `send_cmd(str)`                         | —                                                                                                                                     |
|                                 | `signal_light`          | `KEYWORD`             | `send_cmd('CMD SIGNAL_LIGHT')`                | `send_cmd(str)`                         | —                                                                                                                                     |
| **Espera/sincronização**        | `wait_signal`           | `KEYWORD`             | `wait_for_signal('<nome>', timeout=<t>)`      | `wait_for_signal(str, timeout) -> bool` | Bloqueia até sinal ou timeout                                                                                                         |
|                                 | `timeout`               | `KEYWORD`             | Argumento nomeado `timeout=`                  | —                                       | Valor em segundos ou `none` (infinito)                                                                                                |
|                                 | `none`                  | `KEYWORD`             | `None` (literal Python)                       | —                                       | Indica espera infinita                                                                                                                |
| **Diagnóstico**                 | `log`                   | `KEYWORD`             | `log_event('<msg>')`                          | `log_event(str)`                        | Registra em auditoria                                                                                                                 |
| **Literais**                    | `"..."` (string)        | `STRING`              | `'...'` (string Python)                       | —                                       | Nomes de sinais, mensagens, etc                                                                                                       |
|                                 | `0.5`, `30` (número)    | `NUMBER`              | `float`/`int` Python nativo                   | —                                       | Velocidades, timeouts, etc                                                                                                            |
| **Variáveis externas** (futuro) | `identificador`         | `ID`                  | `context.get('<identificador>')`              | `dict` (context)                        | Vem do ESP32 na serial; só com `if`/`else`                                                                                            |
|                                 | `next_destination` (ex) | `ID`                  | `context.get('next_destination')`             | Fornecido pelo ESP32                    | Valor de um sensor/RFID/câmera                                                                                                        |
| **Comentário**                  | `// ...`                | (descartado no lexer) | Não gera código                               | —                                       | —                                                                                                                                     |

**Por que a coluna "Runtime necessário" importa:** todo `KEYWORD` de comando (`stop`, `set_speed`, `turn_left`, etc.) se resolve na mesma função Python, `send_cmd(str)` — a única coisa que muda é a string enviada. O gerador de código não precisa de uma função Python diferente por comando: ele produz sempre `send_cmd('CMD <AÇÃO> <parâmetros>')`, e quem interpreta essa string é o firmware do ESP32, não o Python. As únicas funções de runtime que o `station_runner.py` precisa fornecer são três: `send_cmd`, `wait_for_signal` e `log_event`.

**Nota Importante sobre Identificadores e Escopo (Extensão Futura com `if`/`else`):**

Quando a linguagem suportar `if`/`else`, identificadores como `next_destination` serão acessados via `context.get('next_destination')` — um dicionário Python que o `station_runner.py` constrói a partir de variáveis que o **ESP32 envia na mensagem serial**. 

Exemplo:
```
Mensagem serial do ESP32:
STATION bifurcacao_A next_destination:linha_2 urgency:high

station_runner.py extrai:
context = {"next_destination": "linha_2", "urgency": "high"}

Compilador gera:
if context.get('next_destination') == 'linha_2':
    send_cmd('CMD TURN_RIGHT')
```

Essa clareza sobre origem das variáveis (vêm do ESP32, não são definidas no RoboFlow) é importante para a análise semântica futura: o compilador poderá validar que toda variável usada num `if` vai estar presente no `context` em tempo de execução.

> **Nesta versão atual da linguagem, cada estação executa uma sequência fixa de comandos, sem decisão condicional.** A estação `bifurcacao_A` (que usaria `if`/`else`) fica de fora por enquanto — depende do mecanismo de `context` que está documentado na seção 2.2 abaixo, mas ainda não foi validado com o professor.

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

**De onde vem `next_destination`?** Não é definida no RoboFlow. É uma informação que o **ESP32 lê de um sensor** (câmera que identifica o tipo de peça, código de barras, RFID, etc) e **fornece junto com o evento de estação**.

#### Como Funciona

1. **ESP32 detecta marcador** e lê a variável via sensor
2. **ESP32 escreve na serial:**
   ```
   STATION bifurcacao_A next_destination:linha_2 urgency:high
   ```
3. **`station_runner.py` parseia** a mensagem:
   ```
   station_id = "bifurcacao_A"
   context = {"next_destination": "linha_2", "urgency": "high"}
   ```
4. **Compilador gerou:**
   ```python
   def handle_bifurcacao_A(send_cmd, context=None):
       if context.get('next_destination') == 'linha_2':
           send_cmd('CMD TURN_RIGHT')
       else:
           send_cmd('CMD CONTINUE_STRAIGHT')
       send_cmd('CMD RESUME_LINE_FOLLOWING')
   ```
5. **`station_runner.py` chama** com o `context`:
   ```python
   handler(send_cmd, context=context)
   ```

#### Por Que Está Adiado?

Isso ainda **não está implementado** por duas razões:

1. **Análise Semântica:** o compilador precisa validar que toda variável usada em um `if` (ex: `next_destination`) vai estar presente no `context` em tempo de execução — isso é "checagem de escopo", um tópico da disciplina que seu professor vai cobrir.

2. **Definição de Escopo:** há várias formas de passar variáveis entre escopo externo e funções geradas (dicionário, argumentos nomeados, variáveis globais, objetos). Qual seu professor prefere? Melhor perguntar antes de implementar.

#### Status

- **Sem `if`/`else`:** ✅ Pronto pra usar hoje
- **Com `if`/`else` e `context`:** ⏳ Estrutura básica pronta (ESP32 → serial → `station_runner.py` → dicionário), mas análise semântica ainda adiada

### 3. Análise Sintática — Gramática (BNF simplificada, escopo atual)

Gramática da linguagem sem condicionais — reflete o que já pode ser implementado com o conteúdo visto até agora:

```bnf
program        ::= station_decl+ default_decl

station_decl   ::= "station" string "{" "on_arrival" "{" stmt_list "}" "}"

default_decl   ::= "station" "default" "{" "on_arrival" "{" stmt_list "}" "}"

stmt_list      ::= stmt*

stmt           ::= command_call

command_call   ::= identifier "(" arg_list ")"
```

**Extensão futura (não implementada ainda — depende de aula sobre escopo/ambiente de variáveis):**
```bnf
stmt           ::= command_call | if_stmt

if_stmt        ::= "if" condition "{" stmt_list "}" ("else" "{" stmt_list "}")?

condition      ::= identifier "==" (string | identifier)
```

### 4. Análise Semântica — As Validações Que Importam Aqui

Diferente de um compilador genérico, aqui as validações **são a parte interessante do projeto**, porque cada uma corresponde a uma propriedade de segurança real de um AGV industrial:

**Completude:** toda `station_id` que pode aparecer fisicamente na pista precisa ter um bloco correspondente (ou cair no `default`). O compilador recebe a lista de estações comissionadas (arquivo de configuração da pista) e cruza com os blocos definidos.

```
❌ ERRO: Estação "descarga" existe na pista mas não tem bloco RoboFlow
```

**Determinismo:** duas definições para a mesma estação são erro de compilação — não faz sentido o AGV ter duas respostas possíveis para a mesma situação. (Quando `if`/`else` for implementado — seção 2.2 — essa checagem se estende para condições de `if` que se sobrepõem.)

**Terminação / Ausência de Deadlock:** todo caminho de execução dentro de `on_arrival` precisa terminar em `resume_line_following()` (ou em `wait_signal(..., timeout: none)`, que é uma espera deliberada e explícita). Um caminho que "esquece" de retomar a linha trava o AGV para sempre — isso é testável estaticamente percorrendo a árvore de statements.

```
❌ ERRO (exemplo, válido só quando if/else existir): station "bifurcacao_A" tem um
   caminho (else) sem resume_line_following()
```

No escopo atual (sem `if`/`else`), essa checagem é mais simples: basta verificar se a última instrução de cada `station { on_arrival { ... } }` é `resume_line_following()` ou `wait_signal(..., timeout: none)`.

**Limite Físico:** `set_speed(v)` não pode exceder a velocidade máxima do motor real — validação de tipo/faixa, configurável por hardware.

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

**Saída Python (função gerada, simplificada):**
```python
def handle_carga(send_cmd, context=None):
    send_cmd('CMD STOP')
    wait_for_signal('carga_completa', timeout=30)
    send_cmd('CMD RESUME_LINE_FOLLOWING')

# ... outras estações geram uma função cada, registradas em STATION_HANDLERS ...

def handle_default(send_cmd, context=None):
    send_cmd('CMD STOP')
    log_event('Estação desconhecida')
    wait_for_signal('manual_override', timeout=None)
```

Note que não há framework de robótica envolvido — o compilador gera funções Python simples, despachadas por um dicionário (`STATION_HANDLERS`) no script que lê a serial do ESP32. Ver COMPILADOR_GERA_CONTROLE.md para o gerador completo.

---

## 📊 Matriz de Correlação com a Disciplina

| Conceito | Aplicação Concreta no Projeto |
|---|---|
| Análise Léxica | Tokenizar `station`, `on_arrival`, comandos, strings |
| Análise Sintática | Gramática BNF de `station { on_arrival { ... } }` |
| Análise Semântica | Completude de estações, determinismo, terminação garantida |
| Autômatos Finitos | O comportamento do AGV modelado como FSM; RoboFlow compila para essa FSM |
| Geração de Código | Módulo Python (funções por estação) a partir da AST |
| Linguagens Formais | Definição formal da gramática, prova de propriedades sobre a FSM gerada |

---

## 💼 Por Que Isso é Comercialmente Relevante

Integradores de automação industrial vendem exatamente este tipo de ferramenta: uma **linguagem de configuração de comportamento de estação** para AGVs, para que o cliente (a fábrica) programe o roteiro de produção sem tocar em firmware ou em detalhes de comunicação serial. O valor de mercado está em: reduzir erro humano (validações do compilador), reduzir tempo de comissionamento (reprogramar estações é editar um arquivo texto e re-executar o compilador, não recompilar firmware do zero) e dar auditabilidade (log de decisões).

---

**Este documento substitui a versão anterior baseada em navegação livre com SLAM.**
