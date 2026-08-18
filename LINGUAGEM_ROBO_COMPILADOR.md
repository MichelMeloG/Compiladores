# RoboFlow: A Linguagem de Comportamento de Estação

**Conexão do Projeto com Linguagens Formais e Compiladores**  
**Versão:** 2.0 (Seguidor de Linha Industrial)  
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
      │  Módulo Python        │
      │  (roda no Pi)        │
      └─────────────────────┘
```

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

| Comando                                                | Efeito                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `stop()`                                               | Publica `/station_cmd = STOP`                                                    |
| `set_speed(v)`                                         | Define velocidade de seguimento (respeitando limite físico)                      |
| `turn_left()` / `turn_right()` / `continue_straight()` | Escolha de ramal em bifurcação                                                   |
| `wait_signal(nome, timeout)`                           | Aguarda evento externo (ex: sensor de carga, botão) ou expira                    |
| `signal_buzzer()` / `signal_light()`                   | Sinalização para operadores humanos                                              |
| `log(msg)`                                             | Registro para auditoria                                                          |
| `resume_line_following()`                              | Devolve controle à malha rápida (PID no ESP32) — **obrigatório em todo caminho** |

### Condicionais

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

### 3. Análise Sintática — Gramática (BNF simplificada)

```bnf
program        ::= station_decl+ default_decl

station_decl   ::= "station" string "{" "on_arrival" "{" stmt_list "}" "}"

default_decl   ::= "station" "default" "{" "on_arrival" "{" stmt_list "}" "}"

stmt_list      ::= stmt*

stmt           ::= command_call | if_stmt

command_call   ::= identifier "(" arg_list ")"

if_stmt        ::= "if" condition "{" stmt_list "}" ("else" "{" stmt_list "}")?

condition      ::= identifier "==" (string | identifier)
```

### 4. Análise Semântica — As Validações Que Importam Aqui

Diferente de um compilador genérico, aqui as validações **são a parte interessante do projeto**, porque cada uma corresponde a uma propriedade de segurança real de um AGV industrial:

**Completude:** toda `station_id` que pode aparecer fisicamente na pista precisa ter um bloco correspondente (ou cair no `default`). O compilador recebe a lista de estações comissionadas (arquivo de configuração da pista) e cruza com os blocos definidos.

```
❌ ERRO: Estação "descarga" existe na pista mas não tem bloco RoboFlow
```

**Determinismo:** duas definições para a mesma estação, ou duas condições de `if` que se sobrepõem, são erro de compilação — não faz sentido o AGV ter duas respostas possíveis para a mesma situação.

**Terminação / Ausência de Deadlock:** todo caminho de execução dentro de `on_arrival` precisa terminar em `resume_line_following()` (ou em `wait_signal(..., timeout: none)`, que é uma espera deliberada e explícita). Um caminho que "esquece" de retomar a linha trava o AGV para sempre — isso é检testável estaticamente percorrendo a árvore de statements.

```
❌ ERRO: station "bifurcacao_A" tem um caminho (else) sem resume_line_following()
```

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
    ok = wait_for_signal('carga_completa', timeout=30)
    if not ok:
        log_event('timeout em carga_completa')
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
