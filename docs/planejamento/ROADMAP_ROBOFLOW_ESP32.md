# Roadmap — Linguagem RoboFlow e Compilador para ESP32

## 1. Objetivo do projeto

Construir uma linguagem de domínio específico chamada **RoboFlow** e um compilador capaz de transformar programas de comportamento de um AGV em código C++ compatível com ESP32.

```text
programa.rf
    ↓
Lexer → Parser → AST → Análise Semântica → IR → Gerador C++
    ↓
behavior_generated.hpp/.cpp
    ↓
Firmware-base + PlatformIO
    ↓
firmware.bin → ESP32
```

O compilador será implementado em Python. O código gerado será integrado a um firmware-base escrito manualmente em C++/Arduino.

### Decisão arquitetural principal

O compilador não deve gerar todo o firmware. Ele gera somente a parte variável do sistema:

- cadastro das estações;
- ações executadas em cada estação;
- transições da máquina de estados;
- parâmetros permitidos, como velocidade e tempos de espera.

Continuam fixos e escritos manualmente no firmware-base:

- drivers de motores e sensores;
- controle PID;
- comunicação serial;
- temporização do sistema;
- parada de emergência e veto de proximidade;
- inicialização do ESP32.

Essa divisão evita que um programa RoboFlow consiga remover mecanismos críticos de segurança.

## 2. Escopo das versões

### Versão 0.1 — MVP acadêmico/AP1

- Blocos `station` e `on_arrival`.
- Comandos sem condicionais.
- Lexer com tabela de tokens e erros com linha/coluna.
- Parser e AST.
- Geração de C++ para ESP32.
- Compilação automática do código gerado com PlatformIO.
- Testes sem hardware usando funções simuladas.

### Versão 0.2 — AP2

- Análise semântica completa.
- Tabela de símbolos e catálogo de estações.
- Condicionais `if/else` com variáveis externas tipadas.
- Tabela de erros léxicos, sintáticos e semânticos.
- Integração com firmware e hardware.
- Testes do AGV em pista.
- Front-end simples para editar, validar e compilar RoboFlow.

### Versão 1.0 — Entrega final estável

- Linguagem e gramática congeladas.
- CLI documentada.
- Diagnósticos amigáveis.
- Suíte completa de testes.
- Firmware reproduzível.
- Exemplos, tutorial, artigo IEEE e demonstração final.

## 3. Sintaxe inicial da linguagem

Extensão sugerida: `.rf`.

```roboflow
station "carga" {
    on_arrival {
        stop()
        signal_light()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}

station "descarga" {
    on_arrival {
        stop()
        wait_signal("descarga_completa", timeout: 60s)
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

### Comandos do MVP

| Comando | Parâmetros | Resultado no ESP32 |
|---|---|---|
| `stop()` | nenhum | Para a movimentação normal |
| `set_speed(v)` | número | Define a velocidade-base permitida |
| `turn_left()` | nenhum | Solicita manobra à esquerda |
| `turn_right()` | nenhum | Solicita manobra à direita |
| `continue_straight()` | nenhum | Solicita continuação em frente |
| `wait_signal(nome, timeout: t)` | string e duração/`none` | Inicia espera não bloqueante |
| `signal_buzzer()` | nenhum | Aciona sinal sonoro |
| `signal_light()` | nenhum | Aciona sinal luminoso |
| `log(msg)` | string | Emite evento de log pela serial |
| `resume_line_following()` | nenhum | Retorna ao controle PID da linha |

## 4. Arquitetura do compilador

### 4.1 Entrada e diagnósticos

Responsabilidades:

- ler arquivo `.rf` em UTF-8;
- preservar nome do arquivo, linha e coluna;
- apresentar erros no formato `arquivo:linha:coluna: categoria: mensagem`;
- retornar código de saída diferente de zero quando houver erro.

Exemplo:

```text
rota.rf:8:9: erro semântico RF3004: velocidade 300 excede o máximo 200
```

### 4.2 Lexer

Entrada: caracteres. Saída: sequência de tokens.

Entregáveis:

- enumeração `TokenType`;
- estrutura `Token(type, lexeme, literal, line, column)`;
- tabela formal de tokens e expressões regulares;
- descarte de espaços e comentários;
- regra do casamento mais longo;
- prioridade de palavras reservadas sobre identificadores;
- erros para caracteres, strings e números inválidos.

Tokens mínimos:

```text
STATION ON_ARRIVAL DEFAULT
IDENTIFIER STRING NUMBER DURATION NONE
LBRACE RBRACE LPAREN RPAREN COMMA COLON
EOF
```

### 4.3 Parser

Estratégia recomendada: **descida recursiva preditiva**, suficiente para a gramática inicial e fácil de apresentar na disciplina.

Gramática mínima:

```bnf
program       ::= station_decl* default_decl EOF
station_decl  ::= "station" STRING station_body
default_decl  ::= "station" "default" station_body
station_body  ::= "{" "on_arrival" "{" stmt* "}" "}"
stmt          ::= command_call
command_call  ::= IDENTIFIER "(" arguments? ")"
arguments     ::= argument ("," argument)*
argument      ::= STRING
                | NUMBER
                | DURATION
                | "none"
                | IDENTIFIER ":" value
value         ::= STRING | NUMBER | DURATION | "none"
```

Entregáveis:

- parser que consome tokens;
- recuperação simples após erros;
- mensagens de token esperado/encontrado;
- testes positivos e negativos para cada produção.

### 4.4 AST

Nós mínimos:

```text
Program
└── StationDecl[]
    ├── name
    └── statements[]
        └── CommandCall
            ├── name
            ├── positional_args[]
            └── named_args{}
```

Cada nó deve preservar sua posição no código-fonte para que erros semânticos indiquem linha e coluna.

Entregáveis:

- classes/dataclasses da AST;
- impressor textual da árvore;
- exportação opcional para JSON;
- exemplo de AST documentado.

### 4.5 Análise semântica

A análise ocorre sobre a AST antes da geração de C++.

Validações obrigatórias:

1. Existe exatamente uma estação `default`.
2. Nomes de estações não se repetem.
3. Todo comando pertence à biblioteca padrão.
4. Quantidade, nome e tipo dos argumentos estão corretos.
5. `set_speed` respeita a faixa física configurada.
6. Durações não podem ser negativas.
7. A última ação de uma estação deve retomar a linha ou declarar espera infinita segura.
8. Estações configuradas para a pista possuem tratamento.
9. Comandos proibidos não podem acessar diretamente motores ou desativar o veto.

Estruturas necessárias:

- tabela de símbolos de estações;
- assinaturas dos comandos nativos;
- configuração física do alvo;
- catálogo opcional das estações existentes na pista.

### 4.6 Representação intermediária

Mesmo sendo simples, o projeto deve separar AST e C++ usando uma IR pequena. Isso permite testar o compilador sem depender do texto gerado.

Exemplo conceitual:

```text
StationIR(
  id="carga",
  instructions=[
    STOP,
    SIGNAL_LIGHT,
    WAIT_SIGNAL("carga_completa", 30000),
    RESUME_LINE
  ]
)
```

Entregáveis:

- classes da IR;
- conversor AST → IR;
- normalização de segundos para milissegundos;
- enumeração fechada de operações suportadas.

### 4.7 Backend C++ para ESP32

O backend deve gerar arquivos determinísticos:

```text
behavior_generated.hpp
behavior_generated.cpp
```

Interface sugerida:

```cpp
// Gerado automaticamente. Não editar.
enum class StationId {
    CARGA,
    DESCARGA,
    DEFAULT_STATION
};

void startStationBehavior(StationId station);
void updateStationBehavior(unsigned long nowMs);
```

Regras do gerador:

- nunca emitir acesso direto aos pinos dos motores;
- chamar somente a API segura oferecida pelo runtime;
- escapar corretamente strings C++;
- gerar nomes C++ válidos para identificadores RoboFlow;
- usar máquina de estados não bloqueante para esperas;
- incluir comentário com versão do compilador e hash da entrada;
- produzir sempre a mesma saída para a mesma entrada.

### 4.8 Runtime e firmware-base

API segura que o código gerado pode utilizar:

```cpp
namespace RobotRuntime {
    void stop();
    bool setSpeed(float value);
    void turnLeft();
    void turnRight();
    void continueStraight();
    bool hasSignal(const char* name);
    void signalBuzzer();
    void signalLight();
    void log(const char* message);
    void resumeLineFollowing();
}
```

O firmware-base deve chamar continuamente:

```cpp
void loop() {
    safety.update();              // prioridade máxima
    sensors.update();
    serialProtocol.update();
    updateStationBehavior(millis());
    lineFollower.update();
    motors.applyWithSafetyVeto();
}
```

`wait_signal` não poderá usar `delay()` nem laço bloqueante. O gerador deverá criar estados internos e retornar ao `loop()` a cada atualização.

## 5. Estrutura planejada do repositório

```text
Compiladores/
├── compiler/
│   └── roboflow/
│       ├── __init__.py
│       ├── cli.py
│       ├── diagnostics.py
│       ├── tokens.py
│       ├── lexer.py
│       ├── ast_nodes.py
│       ├── parser.py
│       ├── semantic.py
│       ├── symbols.py
│       ├── ir.py
│       └── codegen_cpp.py
├── firmware/
│   ├── platformio.ini
│   ├── include/
│   │   ├── robot_runtime.hpp
│   │   └── behavior_generated.hpp
│   ├── src/
│   │   ├── main.cpp
│   │   ├── robot_runtime.cpp
│   │   └── behavior_generated.cpp
│   └── test/
├── examples/
│   ├── rota_basica.rf
│   └── rota_completa.rf
├── config/
│   ├── target_esp32.json
│   └── track_stations.json
├── tests/
│   ├── lexer/
│   ├── parser/
│   ├── semantic/
│   ├── codegen/
│   └── integration/
├── docs/
│   ├── lexical_spec.md
│   ├── grammar.md
│   ├── ast.md
│   ├── semantic_rules.md
│   ├── error_catalog.md
│   └── generated_code.md
├── pyproject.toml
└── README.md
```

## 6. Roadmap de execução

### Fase 0 — Congelamento de escopo e arquitetura

**Duração:** 2 a 3 dias.

Tarefas:

- confirmar o nome RoboFlow e a extensão `.rf`;
- definir que o alvo principal é C++/ESP32;
- escolher Arduino Framework com PlatformIO;
- separar comportamento gerado de firmware fixo;
- definir hardware e limites físicos iniciais;
- remover contradições entre os documentos antigos.

Critério de conclusão:

- uma especificação curta, sem decisões arquiteturais conflitantes, aprovada pela equipe.

### Fase 1 — Especificação formal da linguagem

**Duração:** 1 semana.

Tarefas:

- escrever tabela de tokens e regex;
- escrever gramática EBNF/BNF;
- definir precedência futura de operadores;
- definir comandos, tipos e assinaturas;
- criar cinco programas válidos e cinco inválidos;
- numerar os erros previstos.

Critério de conclusão:

- cada exemplo pode ser classificado manualmente como válido ou inválido com base na especificação.

### Fase 2 — Lexer

**Duração:** 1 semana.

Tarefas:

- implementar tokens e posições;
- reconhecer palavras reservadas, identificadores, números, durações e strings;
- ignorar espaços e comentários;
- implementar erros léxicos;
- criar testes unitários;
- gerar uma tabela de tokens para a documentação da AP1.

Critério de conclusão:

- 100% dos exemplos léxicos passam e nenhum caractere inválido é ignorado silenciosamente.

### Fase 3 — Parser e AST

**Duração:** 1 a 2 semanas.

Tarefas:

- implementar nós da AST;
- implementar parser de descida recursiva;
- validar delimitadores e argumentos;
- implementar recuperação básica de erro;
- criar impressor da AST;
- criar testes por produção da gramática.

Critério de conclusão:

- exemplos válidos geram a AST esperada; exemplos inválidos informam linha, coluna e token responsável.

### Fase 4 — Backend C++ mínimo

**Duração:** 1 semana.

Tarefas:

- converter AST para IR;
- gerar enum de estações;
- gerar despacho por estação;
- traduzir comandos simples;
- integrar com um runtime simulado em C++;
- verificar sintaxe C++ no computador.

Critério de conclusão:

- `rota_basica.rf` gera C++ que compila e executa em teste simulado.

### Marco AP1 — Front-end e backend demonstráveis

Entregáveis:

- pitch;
- especificação léxica e tabela de tokens;
- gramática e AST;
- código-fonte do compilador;
- backend mínimo funcionando;
- demonstração `.rf → AST → C++`;
- cronograma, orçamento, identidade visual e Git organizados.

### Fase 5 — Análise semântica

**Duração:** 1 a 2 semanas.

Tarefas:

- tabela de símbolos;
- validação de estações duplicadas e `default`;
- assinaturas e tipos dos comandos;
- validações de faixa física;
- catálogo de erros semânticos;
- análise do término seguro das estações;
- testes negativos para cada regra.

Critério de conclusão:

- nenhum programa semanticamente inválido chega ao gerador de código.

### Fase 6 — Runtime não bloqueante do ESP32

**Duração:** 2 semanas.

Tarefas:

- implementar API segura do runtime;
- criar máquina de estados para ações e esperas;
- integrar detecção de estação;
- integrar PID fixo;
- integrar veto de segurança;
- criar protocolo serial de diagnóstico;
- medir uso de memória e tempo de ciclo.

Critério de conclusão:

- o código gerado roda no ESP32 sem bloquear o loop e o veto interrompe qualquer ação.

### Fase 7 — Condicionais e contexto externo

**Duração:** 1 a 2 semanas.

Extensão de sintaxe:

```roboflow
if next_destination == "linha_2" {
    turn_right()
} else {
    continue_straight()
}
```

Tarefas:

- adicionar tokens `IF`, `ELSE` e `EQ`;
- ampliar gramática e AST;
- declarar variáveis de contexto e seus tipos;
- validar variáveis não declaradas;
- analisar todos os caminhos de controle;
- gerar estados C++ para os ramos.

Critério de conclusão:

- todos os caminhos de um `if/else` são validados e geram comportamento determinístico.

### Fase 8 — CLI, configuração e experiência de uso

**Duração:** 1 semana.

Comandos desejados:

```bash
python -m roboflow check examples/rota_basica.rf
python -m roboflow ast examples/rota_basica.rf
python -m roboflow build examples/rota_basica.rf --target esp32
python -m roboflow build examples/rota_basica.rf --target esp32 --upload
```

Tarefas:

- configurar alvo e limites físicos por JSON;
- gerar saída em diretório definido;
- integrar build do PlatformIO;
- oferecer modo `check` sem geração;
- melhorar mensagens e códigos de erro;
- criar front-end simples, se exigido pela disciplina.

Critério de conclusão:

- um usuário novo consegue validar, compilar e gravar um exemplo seguindo somente o README.

### Fase 9 — Integração e testes físicos

**Duração:** 2 semanas.

Tarefas:

- testar cada comando isoladamente;
- testar sequência completa de estações;
- testar estação desconhecida;
- testar perda de linha;
- testar timeout e sinal recebido;
- testar obstáculo durante cada comportamento;
- testar reinicialização e perda de comunicação;
- registrar métricas e vídeos.

Critério de conclusão:

- todos os casos críticos possuem resultado esperado documentado e evidência reproduzível.

### Fase 10 — Entrega final/AP2

**Duração:** 1 a 2 semanas.

Entregáveis:

- código completo;
- linguagem e gramática versionadas;
- tabela completa de erros;
- front-end funcionando;
- compilação e upload para ESP32;
- implementação embarcada;
- vídeo tutorial de aproximadamente 8 minutos;
- artigo IEEE de aproximadamente 10 páginas;
- apresentação oral e roteiro de demonstração;
- tag Git da versão apresentada.

## 7. Cronograma sugerido de 16 semanas

| Semana | Resultado principal |
|---|---|
| 1 | Arquitetura e escopo congelados |
| 2 | Especificação léxica e gramática |
| 3 | Lexer completo |
| 4–5 | Parser e AST |
| 6 | Backend C++ mínimo |
| 7 | Preparação e entrega da AP1 |
| 8–9 | Análise semântica |
| 10–11 | Runtime não bloqueante no ESP32 |
| 12 | Condicionais e contexto externo |
| 13 | CLI, configuração e front-end |
| 14–15 | Integração e testes físicos |
| 16 | Artigo, vídeo e apresentação da AP2 |

## 8. Estratégia de testes

### Testes unitários

- um teste por padrão léxico;
- um teste por produção sintática;
- um teste por regra semântica;
- um teste por instrução da IR;
- um teste por comando gerado em C++.

### Testes golden file

Cada programa em `examples/` deve possuir uma saída C++ esperada. O teste compara o arquivo gerado com a versão aprovada.

### Testes de compilação

- compilar o C++ gerado no computador com runtime simulado;
- compilar o firmware real com PlatformIO;
- tratar warning do código gerado como erro no CI.

### Testes de integração

```text
.rf → tokens → AST → semântica → IR → C++ → build PlatformIO
```

### Testes de segurança no hardware

- obstáculo com AGV seguindo linha;
- obstáculo durante curva;
- obstáculo durante ação de estação;
- programa inválido tentando exceder velocidade;
- estação desconhecida;
- timeout expirado;
- desconexão da comunicação externa.

## 9. Catálogo inicial de erros

| Código | Fase | Situação |
|---|---|---|
| `RF1001` | Léxica | Caractere inesperado |
| `RF1002` | Léxica | String não terminada |
| `RF1003` | Léxica | Número ou duração inválida |
| `RF2001` | Sintática | Token esperado não encontrado |
| `RF2002` | Sintática | Bloco não fechado |
| `RF2003` | Sintática | Lista de argumentos inválida |
| `RF3001` | Semântica | Estação duplicada |
| `RF3002` | Semântica | Estação `default` ausente ou duplicada |
| `RF3003` | Semântica | Comando desconhecido |
| `RF3004` | Semântica | Valor fora do limite físico |
| `RF3005` | Semântica | Tipo ou quantidade de argumentos inválida |
| `RF3006` | Semântica | Caminho sem término seguro |
| `RF3007` | Semântica | Estação da pista sem comportamento |
| `RF3008` | Semântica | Variável de contexto não declarada |
| `RF4001` | Geração | Operação da IR sem suporte no alvo |
| `RF5001` | Build | Falha ao compilar firmware do ESP32 |

## 10. Critérios de pronto do projeto

O projeto será considerado completo quando:

- a linguagem possuir especificação léxica, gramática e regras semânticas versionadas;
- o compilador não ignorar entradas inválidas;
- todos os erros mostrarem posição e explicação útil;
- um arquivo `.rf` válido gerar C++ determinístico;
- o firmware gerado compilar automaticamente para ESP32;
- ações demoradas não bloquearem o laço principal;
- o veto de segurança permanecer independente do código gerado;
- exemplos válidos e inválidos estiverem cobertos por testes;
- o AGV executar ao menos três estações em uma pista real;
- toda a demonstração puder ser refeita a partir de um clone limpo do repositório.

## 11. Riscos e contenções

| Risco | Contenção |
|---|---|
| Tentar criar uma linguagem geral | Manter a DSL restrita a comportamentos de estação |
| Gerar firmware inteiro | Gerar apenas o módulo de comportamento |
| `delay()` bloquear sensores e segurança | Runtime baseado em estados e `millis()` |
| Divergência entre documentação e implementação | Tratar gramática e testes como fonte de verdade |
| Hardware atrasar o compilador | Usar runtime C++ simulado desde a Fase 4 |
| Condicionais ampliarem demais o escopo | Entregar comandos sequenciais antes de `if/else` |
| Código gerado acessar motores diretamente | Expor somente API segura do runtime |
| Dependência excessiva do Raspberry Pi | Manter lógica compilada e segurança no ESP32 |

## 12. Próxima ação imediata

Antes de implementar, a equipe deve concluir a **Fase 0** e registrar uma única arquitetura oficial. Os documentos atuais descrevem duas versões diferentes:

1. RoboFlow gerando Python executado no Raspberry Pi;
2. DSL gerando C++ executado no ESP32.

Este roadmap assume a segunda opção: **RoboFlow → C++ → ESP32**, com o Raspberry Pi opcional e fora do caminho crítico de decisão. Após essa decisão, o primeiro incremento de código deve ser o lexer acompanhado da especificação formal dos tokens.
