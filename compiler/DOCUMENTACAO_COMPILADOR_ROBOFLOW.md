# Documentação do compilador RoboFlow

Análise do código disponível em 21/10/2026. Escopo: pacote `compiler/roboflow`, demonstração em `examples` e relação com o alvo C++/ESP32.

## 1. Visão geral e estado atual

A implementação atual de RoboFlow é uma linguagem de domínio específico (DSL) que associa estações a ações, esperas e condicionais. O objetivo atualizado é gerar o sistema embarcado do carrinho: leitura de sensores, telemetria para o backend, recepção da fila F/T/D/E e execução local com supervisor. A gramática existente ainda não expressa todas essas funções; sua extensão faz parte do trabalho pendente.

O objetivo informado para o projeto é **RoboFlow → C++ → ESP32**. Entretanto, o código existente implementa apenas o **front-end do compilador**: transforma texto em tokens e depois em uma árvore de sintaxe abstrata (AST). Não executa as ações descritas nem gera C++.

| Etapa | Situação encontrada |
|---|---|
| Leitura de arquivo UTF-8 | Implementada no script de demonstração |
| Análise léxica | Implementada |
| Análise sintática | Implementada por descida recursiva |
| AST e impressão da árvore | Implementadas |
| Reconhecimento de `if/else` | Implementado no lexer, parser e AST |
| Validação semântica | Não implementada |
| Tabela de símbolos e contexto tipado | Não implementados |
| Representação intermediária (IR) | Não implementada |
| Geração de C++ | Não implementada |
| Runtime e firmware-base do ESP32 | Ausentes na árvore de arquivos analisada |
| Compilação e upload | Feitos manualmente na Arduino IDE; fora do escopo do compilador |
| Interface para gerar `.ino` | Pendente; existe somente uma demonstração de tokens e AST |
| Suíte automatizada de testes | Não localizada |

Fluxo efetivamente implementado:

```text
arquivo .rf em UTF-8
        ↓ read_text()
texto Python (str)
        ↓ Lexer.tokenize()
lista de Token, terminada por EOF
        ↓ Parser.parse()
ProgramNode (AST)
        ↓ print_tree()
representação textual da árvore
```

Aceitação pelo parser significa apenas que a entrada tem uma estrutura reconhecida. Não significa que seja um programa seguro, semanticamente válido ou compilável para o ESP32.

## 2. Organização dos arquivos

Os caminhos abaixo são relativos à raiz do repositório.

```text
compiler/
└── roboflow/
    ├── __init__.py     API pública do front-end
    ├── tokens.py       Tipos de token, palavras reservadas e classe Token
    ├── lexer.py        Scanner manual e LexerError
    ├── parser.py       Parser de descida recursiva e ParserError
    └── ast_nodes.py    Nós da AST e impressão textual
examples/
├── demo_compilador.py  Execução demonstrativa
├── rota_basica.rf      Estações e comandos sequenciais
└── rota_completa.rf    Estações, comandos e decisão if/else
```

Há arquivos `__pycache__` no diretório analisado. São caches de bytecode Python, não módulos-fonte adicionais nem evidência de um backend implementado.

O código do compilador usa apenas a biblioteca padrão: `enum` e `typing`. A demonstração utiliza também `sys` e `pathlib`. Não foi localizado um `pyproject.toml` ou manifesto de dependências Python. O pacote não depende de bibliotecas de geração de parsers, Arduino ou PlatformIO para produzir a AST.

## 3. Linguagem reconhecida

### 3.1 Estações e evento de chegada

```roboflow
station "carga" {
    on_arrival {
        stop()
        wait_signal("carga_completa", timeout: 30s)
        resume_line_following()
    }
}

station default {
    on_arrival {
        stop()
        log("Estacao desconhecida")
        wait_signal("manual_override", timeout: none)
    }
}
```

Cada declaração contém exatamente um bloco `on_arrival`. O parser exige as duas camadas de chaves. Não aceita comandos diretamente no corpo externo de uma estação nem outros eventos ao lado de `on_arrival`.

O nome de uma estação comum deve ser uma string entre aspas duplas. `station default` cria a estação padrão; `station "default"` cria uma estação comum cujo nome é o texto `default`.

Blocos vazios são aceitos. Estações podem aparecer em qualquer ordem, inclusive com `default` no início ou entre estações comuns. A entrada vazia também é aceita.

A intenção da estação padrão é tratar estações desconhecidas. Esse despacho ainda não existe: o parser apenas armazena seu nó.

### 3.2 Comandos e efeitos pretendidos

| Comando | Assinatura pretendida | Efeito pretendido no robô |
|---|---|---|
| `stop` | `stop()` | Parar movimentação |
| `set_speed` | `set_speed(numero)` | Definir nível de acionamento PWM; escala ainda a definir |
| `turn_left` | `turn_left()` | Solicitar curva à esquerda |
| `turn_right` | `turn_right()` | Solicitar curva à direita |
| `continue_straight` | `continue_straight()` | Solicitar continuação em frente |
| `resume_line_following` | `resume_line_following()` | Retomar seguimento de linha |
| `signal_buzzer` | `signal_buzzer()` | Emitir evento para aviso visual na dashboard; comportamento futuro |
| `signal_light` | `signal_light()` | Emitir evento para aviso visual na dashboard; comportamento futuro |
| `log` | `log(string)` | Registrar mensagem |
| `wait_signal` | `wait_signal(string, timeout: duracao_ou_none)` | Esperar sinal externo |

Essas assinaturas refletem a sintaxe atual e sua intenção de integração. `signal_buzzer` e `signal_light` são nomes herdados: na arquitetura definida, seus avisos serão visuais na dashboard, sem exigir periféricos externos. Um futuro nome genérico de sinalização exigirá mudança explícita da linguagem. O código atual **não valida quantidade, ordem ou tipos dos argumentos por comando**. Não há unidade física ou faixa de velocidade efetivamente imposta a `set_speed`.

Chamadas não precisam de ponto e vírgula. Quebras de linha são ignoradas pelo lexer: `stop() signal_light()` pode estar na mesma linha. Ponto e vírgula é um caractere inválido.

### 3.3 Valores e argumentos

| Forma | Representação na AST | Observação |
|---|---|---|
| `"carga"` | `LiteralNode("carga", "STRING")` | Aspas removidas |
| `30` | `LiteralNode(30, "NUMBER")` | Valor Python `int` |
| `0.15` | `LiteralNode(0.15, "NUMBER")` | Valor Python `float` |
| `30s` | `LiteralNode(30.0, "DURATION")` | Segundos, sempre `float` |
| `next_destination` | `IdentifierNode("next_destination")` | Referência ainda não resolvida |
| `timeout: 30s` | `NamedArgNode("timeout", LiteralNode(30.0, "DURATION"))` | Único argumento nomeado reconhecido |
| `timeout: none` | `NamedArgNode("timeout", LiteralNode(None, "NONE"))` | Intenção de espera sem prazo |

`none` não é um argumento posicional válido. `timeout: 30` também não é aceito: o valor precisa de sufixo `s` ou ser `none`. O parser aceita durações como argumentos posicionais, mesmo quando a assinatura pretendida não permite isso.

Não há atribuições, declarações de variáveis, funções do usuário, listas, operações aritméticas, laços ou retorno. A única comparação reconhecida é `==`.

### 3.4 Condicionais

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

O lado esquerdo da comparação precisa ser `ID`. O lado direito pode ser `STRING` ou `ID`. Comparações numéricas e comparações com `none` não são aceitas.

Não se usam parênteses em torno da condição. `else` é opcional. Condicionais aninhadas são aceitas porque seus blocos voltam a chamar o mesmo analisador de instruções. `else if` direto não faz parte da gramática; seria necessário colocar outro `if` dentro de `else { ... }`.

O código não consulta sensores nem fornece o valor de `next_destination`. Essa identificação é apenas um nó da árvore. A origem e os tipos das variáveis de contexto precisam ser definidos na futura integração com o firmware.

## 4. Tokens e análise léxica

### 4.1 Estrutura `Token`

Definida em `compiler/roboflow/tokens.py`:

```python
Token(type_: TokenType, value: Any, line: int, column: int)
```

| Campo | Conteúdo |
|---|---|
| `type` | Membro de `TokenType` |
| `value` | Valor convertido ou texto do token |
| `line` | Linha inicial, começando em 1 |
| `column` | Coluna inicial, começando em 1 |

Não existem campos separados para lexema e literal. Assim, a grafia original de um número não é preservada: `0.150` é armazenado como `0.15`. Também não há nome do arquivo, posição final ou deslocamento absoluto no token.

### 4.2 Tipos reconhecidos

| `TokenType` | Exemplo | Valor |
|---|---|---|
| `KEYWORD` | `station`, `stop`, `if` | Texto da palavra |
| `ID` | `next_destination` | Texto do identificador |
| `STRING` | `"ok"` | `"ok"`, sem as aspas delimitadoras |
| `NUMBER` | `30`, `0.15` | `int` ou `float` |
| `DURATION` | `30s` | `30.0` |
| `OP` | `==` | `"=="` |
| `LBRACE`, `RBRACE` | `{`, `}` | Caractere correspondente |
| `LPAREN`, `RPAREN` | `(`, `)` | Caractere correspondente |
| `COLON`, `COMMA` | `:`, `,` | Caractere correspondente |
| `EOF` | Fim da entrada | String `"EOF"` |

Espaços e comentários não produzem tokens.

As 17 palavras reservadas são:

```text
station default on_arrival
stop set_speed turn_left turn_right continue_straight
resume_line_following signal_buzzer signal_light log
wait_signal timeout none if else
```

Todas usam o mesmo tipo `KEYWORD`. Não existem tipos individuais como `STATION`, `IF` ou `STOP`. O parser diferencia essas palavras pelo campo `value`.

### 4.3 Varredura de `Lexer.tokenize()`

`Lexer(source)` inicia `pos = 0`, `line = 1`, `column = 1` e uma lista vazia de tokens. A cada posição, aplica esta ordem:

1. `\n`: incrementa a linha e reinicia a coluna em 1.
2. Outros caracteres reconhecidos por `isspace()`: avança sem emitir token.
3. `//`: ignora o restante da linha.
4. `==`: emite `OP` e avança duas posições.
5. Chaves, parênteses, dois-pontos e vírgula: emite o token correspondente.
6. Aspas duplas: chama `_read_string()`.
7. Dígito: chama `_read_number()`.
8. Letra ou `_`: chama `_read_identifier()`.
9. Qualquer outro caractere: lança `LexerError`.

Ao terminar, acrescenta `EOF` e retorna a própria lista `self.tokens`.

Não há expressões regulares executadas pelo scanner. A especificação formal usa regex, mas a implementação realiza a varredura manualmente.

### 4.4 Strings

`_read_string()` salva a posição inicial, consome a aspa de abertura e acumula caracteres até a próxima aspa dupla. O valor emitido não inclui as aspas.

Uma quebra `\n` antes do fechamento é erro. Chegar ao fim da entrada sem fechar a string também é erro. Não há processamento de escapes: `\n` escrito como barra e letra permanece barra e letra, e uma barra invertida não protege uma aspa seguinte. Strings vazias são aceitas. `//` dentro de uma string é texto comum.

### 4.5 Números e durações

`_read_number()` consome dígitos e, no máximo, um ponto. Um segundo ponto causa erro. Se o próximo caractere for `s`, ele também é consumido e o token será `DURATION`; caso contrário, será `NUMBER`.

```text
30      → NUMBER, int 30
0.15    → NUMBER, float 0.15
30s     → DURATION, float 30.0
0.5s    → DURATION, float 0.5
30 s    → NUMBER 30 seguido de ID s
```

O sufixo é somente `s` minúsculo. Não há unidades `ms` ou `min`, sinal negativo ou notação científica como um único literal. `-1` falha no caractere `-`; `.5` falha no ponto inicial. `1e3` é dividido em número e identificador, não convertido para mil.

Há uma divergência da regex formal: o código aceita ponto final sem dígitos depois dele, como `1.` e `1.s`, pois `float("1.")` é válido em Python.

### 4.6 Identificadores e palavras reservadas

`_read_identifier()` consome letras, dígitos e `_`, depois consulta `KEYWORDS`. A comparação é sensível a maiúsculas: `stop` é reservado e `Stop` é `ID`.

O código usa `isalpha()` e `isalnum()`, que reconhecem caracteres Unicode. Portanto, identificadores como `ação` podem ser reconhecidos, embora a regex dos documentos descreva somente caracteres ASCII.

`isdigit()` também é mais amplo que `[0-9]`: certos caracteres Unicode passam na classificação e podem falhar na conversão com `int()` ou `float()`, lançando `ValueError`, que não é convertido em `LexerError`.

### 4.7 Posição e funções auxiliares

| Método | Responsabilidade |
|---|---|
| `_peek(offset=1)` | Consultar um caractere adiante; retornar `""` fora da entrada |
| `_advance(step=1)` | Incrementar posição e coluna |
| `_emit(type_, value)` | Acrescentar token na posição atual |
| `_error(message)` | Lançar `LexerError` com linha e coluna |

Tabs contam como uma coluna; não há expansão visual. A contagem de linhas usa especificamente `\n`. O leitor de arquivos Python normalmente normaliza terminações de linha na demonstração.

No descarte de comentários, `pos` avança sem atualizar `column`. Se o comentário termina em `\n`, a coluna é reiniciada normalmente. Se termina no fim do arquivo, a coluna de `EOF` fica na posição do início do comentário.

## 5. Gramática efetivamente implementada

Nesta EBNF, `{ X }` indica repetição, `[ X ]` indica opcionalidade e caracteres entre aspas são terminais:

```ebnf
program       = { station_decl }, EOF ;
station_decl  = "station", (STRING | "default"),
                "{", "on_arrival", "{", stmt_list, "}", "}" ;
stmt_list     = { stmt } ;
stmt          = if_stmt | command_call ;
command_call  = COMMAND_KEYWORD, "(", [ arg_list ], ")" ;
arg_list      = arg, { ",", arg } ;
arg           = STRING | NUMBER | DURATION | ID | timeout_arg ;
timeout_arg   = "timeout", ":", (DURATION | "none") ;
if_stmt       = "if", condition, "{", stmt_list, "}",
                [ "else", "{", stmt_list, "}" ] ;
condition     = ID, "==", (STRING | ID) ;
```

`COMMAND_KEYWORD` representa qualquer token `KEYWORD` exceto `if` na posição inicial da instrução: `stmt()` intercepta `if` para analisar uma condicional. `command_call()` isoladamente aceita qualquer `KEYWORD`, sem consultar um catálogo de comandos.

Consequências importantes:

- `else()` e `station()` dentro de `on_arrival` são aceitos como chamadas, embora não sejam comandos válidos do domínio.
- `voar()` não é aceito: `voar` vira `ID`, mas chamadas exigem `KEYWORD`.
- Não há vírgula final permitida em argumentos.
- Não existem expressões como argumentos: apenas os valores listados.
- O parser verifica que chegou ao fim por `is_at_end()`; não chama `consume(EOF)` explicitamente.

## 6. Funcionamento do parser

`Parser(tokens)` recebe a lista completa, incluindo `EOF`, e inicia `current = 0`. É uma descida recursiva preditiva: cada produção principal corresponde a um método, com decisão pelo próximo token, sem backtracking.

### 6.1 Navegação

| Método | Comportamento |
|---|---|
| `peek()` | Token atual |
| `previous()` | Token imediatamente anterior |
| `is_at_end()` | Testa se o atual é `EOF` |
| `advance()` | Avança se não estiver em `EOF` e retorna o anterior |
| `check(type_, value=None)` | Testa tipo e, opcionalmente, valor; retorna falso em `EOF` |
| `match(type_, value=None)` | Testa e consome se houver correspondência |
| `consume(type_, value=None, message="")` | Consome o esperado ou lança erro |
| `_error(message)` | Lança `ParserError` na posição do token atual |

O contrato pressupõe tokens válidos e terminados em `EOF`, normalmente produzidos pelo lexer. Não há validação defensiva de listas vazias ou incompletas fornecidas manualmente.

### 6.2 Produções e construção da árvore

| Método | Resultado / função |
|---|---|
| `parse()` | Analisa todas as estações e cria `ProgramNode` |
| `station_decl()` | Consome cabeçalho, `on_arrival`, corpo e fechamentos; cria `StationNode` |
| `stmt_list()` | Acumula instruções até `}` ou `EOF` |
| `stmt()` | Seleciona condicional ou chamada |
| `command_call()` | Consome palavra reservada e argumentos; cria `CommandCallNode` |
| `arg()` | Converte token em literal, identificador ou argumento `timeout` |
| `timeout_arg()` | Cria `NamedArgNode` e seu literal |
| `if_stmt()` | Cria condição, ramo principal e ramo alternativo opcional |
| `condition()` | Cria comparação de identificador com string ou identificador |

`stmt_list()` parar ao encontrar `EOF` não faz um bloco incompleto ser aceito: o método chamador ainda exige as chaves de fechamento.

### 6.3 Tratamento das estações

Estações comuns entram em `ProgramNode.stations` na ordem relativa de leitura. A estação padrão fica em `ProgramNode.default`.

Se existirem várias declarações `station default`, a última substitui a anterior silenciosamente. Não fica uma lista com todos os padrões para uma validação posterior. Nomes repetidos de estações comuns são preservados na lista e não causam erro.

A posição original de `default` entre as estações também se perde: o impressor sempre o apresenta depois das estações comuns.

## 7. Estrutura da AST

Todos os nós herdam de `ASTNode`. Os construtores apenas armazenam atributos; não fazem validação semântica.

| Classe | Atributos | Significado |
|---|---|---|
| `ASTNode` | — | Base; `print_tree()` lança `NotImplementedError` |
| `LiteralNode` | `value`, `type_name` | String, número, duração ou `NONE` |
| `IdentifierNode` | `name` | Referência a variável de contexto |
| `NamedArgNode` | `name`, `value` | Argumento nomeado |
| `CommandCallNode` | `name`, `args` | Chamada e lista de argumentos |
| `ConditionNode` | `left`, `op`, `right` | Comparação; atualmente `op` é `"=="` |
| `IfStmtNode` | `condition`, `then_branch`, `else_branch` | Decisão condicional |
| `StationNode` | `name`, `is_default`, `body` | Declaração de estação |
| `ProgramNode` | `stations`, `default` | Programa inteiro |

Para `StationNode` padrão, `name` é `None` e `is_default` é verdadeiro. Em um `IfStmtNode`, `else_branch = None` indica ausência de `else`; uma lista vazia indica `else {}` presente.

Os argumentos posicionais e nomeados ficam misturados na mesma lista `args`, mantendo sua ordem. Não existem coleções separadas nem um dicionário de argumentos nomeados.

Exemplo estrutural, sem reproduzir os emojis do impressor:

```text
ProgramNode
├── stations
│   └── StationNode(name="carga", is_default=False)
│       └── body
│           ├── CommandCallNode(name="stop", args=[])
│           ├── CommandCallNode(name="wait_signal")
│           │   ├── LiteralNode("carga_completa", "STRING")
│           │   └── NamedArgNode("timeout")
│           │       └── LiteralNode(30.0, "DURATION")
│           └── CommandCallNode(name="resume_line_following", args=[])
└── default: StationNode ou None
```

### 7.1 Impressão

`print_tree(indent="", is_last=True)` retorna uma string; não escreve diretamente no terminal. Os helpers `_branch()` e `_child_indent()` desenham os conectores e o recuo da árvore. Os valores literais usam `repr` por meio de `!r`.

Há marcadores para programa, estação, comando, argumento, condição e ramos. Uma estação com corpo vazio recebe a indicação `(bloco vazio)`.

O impressor de `IfStmtNode` usa `bool(self.else_branch)` para decidir se mostra o ramo alternativo. Por isso, `else {}` existe na AST, mas não aparece na representação textual.

### 7.2 Informações não preservadas

A AST não armazena linha, coluna, arquivo, comentários, espaços ou lexemas originais. O bloco `on_arrival` também não tem nó próprio: seu conteúdo é diretamente `StationNode.body`.

Isso é suficiente para a demonstração sintática, mas limita diagnósticos semânticos precisos e reconstrução do código-fonte. Também não há serialização JSON, visitor ou executor implementado.

## 8. API pública e uso programático

`compiler/roboflow/__init__.py` exporta:

```python
Lexer, LexerError, Parser, ParserError, Token, TokenType, KEYWORDS
```

Os nós da AST podem ser importados diretamente de `compiler.roboflow.ast_nodes`; não estão em `__all__` do pacote.

Exemplo executado a partir da raiz do repositório, com Python instalado:

```python
from pathlib import Path
from compiler.roboflow import Lexer, LexerError, Parser, ParserError

source = Path("examples/rota_basica.rf").read_text(encoding="utf-8")

try:
    tokens = Lexer(source).tokenize()
    ast = Parser(tokens).parse()
except (LexerError, ParserError) as exc:
    print(exc)
else:
    for token in tokens:
        print(token.type.name, repr(token.value), token.line, token.column)
    print(ast.print_tree())
```

Crie uma nova instância de `Lexer` e de `Parser` para cada análise. `tokenize()` não reinicia seu estado: uma segunda chamada na mesma instância acrescenta outro `EOF` à lista existente. O parser também mantém seu cursor; chamar `parse()` novamente depois de chegar ao fim produz um programa vazio.

## 9. Como executar a demonstração

No PowerShell, a partir da raiz do projeto:

```powershell
Set-Location 'C:\Users\202401569852\Desktop\projetos\Compiladores'
python examples/demo_compilador.py
python examples/demo_compilador.py examples/rota_basica.rf
python examples/demo_compilador.py examples/rota_completa.rf
```

Se o ambiente disponibilizar Python por outro executável, substitua `python` pelo caminho ou comando correspondente. Não existe uma versão mínima de Python formalmente declarada no repositório.

Sem argumentos, o script seleciona `rota_completa.rf` ao lado dele. Um caminho fornecido como argumento é resolvido em relação ao diretório de trabalho. O script inclui a raiz do repositório em `sys.path`, permitindo importar `compiler.roboflow`.

Etapas da demonstração:

1. Configura a saída padrão como UTF-8, se `reconfigure` estiver disponível.
2. Lê o arquivo em UTF-8 e mostra o fonte.
3. Tokeniza e tenta imprimir os tokens.
4. Faz o parsing e mostra a árvore retornada por `print_tree()`.
5. Encerra com código 1 em `LexerError` ou `ParserError`; no sucesso, termina normalmente.

**Limitação da tabela de tokens:** o script faz `print(tok)`, mas `Token` não implementa `__str__` nem `__repr__`. Portanto, a saída apresenta a representação padrão do objeto, em vez de uma tabela legível de tipo, valor e posição. O laço do exemplo programático da seção anterior permite inspecionar os campos sem alterar o compilador.

A leitura ocorre antes dos blocos `try`. Arquivo inexistente, falta de permissão ou erro de decodificação não recebem tratamento amigável do script. Não há ajuda `--help`, seleção de alvo, diretório de saída ou upload.

### 9.1 Exemplos fornecidos

| Arquivo | Conteúdo |
|---|---|
| `examples/rota_basica.rf` | Estações `carga` e `descarga`, sinalização, esperas finitas e estação padrão com espera sem prazo |
| `examples/rota_completa.rf` | Estações `carga`, `cruzamento_pedestres`, `bifurcacao_A`, comparação com `next_destination` e estação padrão |

Ambos demonstram construções compatíveis com a implementação por inspeção do código. Não geram movimento físico nem arquivos C++.

## 10. Diagnósticos e falhas

`LexerError` e `ParserError` herdam de `SyntaxError`. A implementação interrompe a análise no primeiro erro, sem recuperação nem acumulação de diagnósticos.

### 10.1 Erros léxicos

Formato implementado:

```text
[Erro léxico] linha L, coluna C: mensagem
```

Situações tratadas explicitamente:

| Situação | Mensagem |
|---|---|
| Caractere não reconhecido | `caractere inesperado ...` |
| `\n` dentro de string | `string não pode conter quebra de linha (Cometa sem cauda!)` |
| String aberta até o fim | `string não terminada` |
| Mais de um ponto numérico | `número malformado com múltiplos pontos decimais` |

Em strings, a posição do erro é a posição corrente de varredura, não necessariamente a aspa inicial.

### 10.2 Erros sintáticos

Formato implementado:

```text
[Erro sintático] linha L, coluna C, perto de 'valor': mensagem
```

Há mensagens específicas para cabeçalho de estação, abertura e fechamento de blocos, parênteses, argumentos, dois-pontos de `timeout` e comparação condicional.

Exemplos de entradas rejeitadas por inspeção do fluxo:

```roboflow
// Erro léxico: ponto e vírgula não pertence à linguagem.
station "x" { on_arrival { stop(); } }

// Erro sintático: um ID não pode iniciar uma chamada.
station "x" { on_arrival { voar() } }

// Erro sintático: timeout requer duração ou none.
station "x" { on_arrival { wait_signal("ok", timeout: 30) } }

// Erro sintático: comparação não aceita NUMBER à direita.
station "x" { on_arrival { if speed == 1 {} } }
```

Um catálogo RF apareceu no planejamento histórico removido; esses códigos não são emitidos pelo compilador atual e não constituem um contrato implementado. Os diagnósticos também não incluem o nome do arquivo.

## 11. Limitações e diferenças entre sintaxe e semântica

| Caso | Comportamento atual | Necessidade futura |
|---|---|---|
| Programa vazio | Aceito | Definir política de validade |
| Ausência de `default` | Aceita | Validar presença, conforme contrato da linguagem |
| Vários `default` | Último sobrescreve os anteriores | Detectar duplicação antes de perder o nó |
| Estações comuns duplicadas | Mantidas na lista | Tabela de símbolos e erro |
| `stop(123)` | Aceito | Validar assinatura |
| `else()` dentro do corpo | Aceito como chamada | Catálogo fechado de comandos |
| `stop(timeout: none)` | Aceito | Validar argumentos por comando |
| `timeout` repetido | Aceito na lista | Detectar repetição |
| Argumento posicional após nomeado | Aceito | Definir e validar política |
| Velocidade fora da faixa física | Número aceito | Configuração do alvo e checagem |
| Variável de contexto desconhecida | `IdentifierNode` criado | Resolução de nomes e tipos |
| Caminho sem retomada segura | Aceito | Análise de fluxo de controle |
| `else {}` | Preservado na AST, oculto na impressão | Distinguir lista vazia de ausência no impressor |
| Identificador Unicode | Aceito pela varredura | Alinhar implementação e especificação |
| Número `1.` | Aceito | Alinhar formato numérico e especificação |

Exemplo que passa pela estrutura sintática, mas não atende ao contrato pretendido:

```roboflow
station "carga" {
    on_arrival {
        stop(123, timeout: none)
        else()
    }
}
```

O parser não avalia a segurança das instruções, não simula o robô, não verifica estações reais da pista e não confirma o recebimento de sinais.

## 12. Relação com linguagens formais e compiladores

O lexer reconhece classes de lexemas compatíveis com uma especificação regular, embora tenha sido escrito manualmente. Não há construção explícita de AFN, AFD ou minimização de autômatos no código.

O parser reconhece estrutura aninhada de blocos e chamadas por uma gramática livre de contexto. A pilha de chamadas Python representa o aninhamento durante a descida recursiva. A AST remove detalhes de pontuação e mantém as estruturas necessárias às próximas fases.

A máquina de estados do comportamento do robô é outro nível de representação. Ela ainda não é construída pela implementação. Ter uma AST com estações não significa que exista um autômato de execução gerado.

O custo de percorrer os tokens no parser tende a ser linear no número de tokens, com memória para AST e pilha proporcional à estrutura. O lexer percorre a entrada sem backtracking, mas usa concatenação sucessiva de strings ao ler lexemas; portanto, não se deve afirmar um limite linear estrito para todos os custos de alocação. Aninhamento muito profundo pode atingir o limite de recursão Python, inclusive na impressão da árvore.

## 13. Objetivo atualizado: sketch completo para Arduino IDE

O compilador roda no computador e recebe um arquivo RoboFlow. Sua entrega deverá ser **um único sketch `.ino` completo**, com `setup()`, `loop()`, funções, configuração dos pinos e suporte embarcado. O usuário copia o conteúdo para a Arduino IDE, seleciona a placa/porta, compila e grava manualmente.

Não se exige instalar PlatformIO, gerar binário, fazer upload automático ou juntar arquivos C++ manualmente. Internamente, o gerador pode combinar templates de drivers e runtime com código derivado da AST, mas toda essa composição precisa aparecer no sketch entregue.

```text
RoboFlow .rf → tokens → AST → semântica → representação validada
            → gerador + templates embarcados → sketch .ino completo
            → usuário copia para Arduino IDE → compila/grava ESP32
```

A rota operacional não fica fixa no sketch. Alterar a rota na dashboard não deverá exigir recompilar o RoboFlow nem regravar a placa.

### 13.1 Divisão com backend e dashboard

```text
Dashboard: selecionar rota
    ↓
Backend: mapa → pontos (x,y) → fila F/T/D/E
    ↓
ESP32: receber fila → executar com motores e sensores
    ↓
Backend: telemetria, progresso e falhas
    ↓
Dashboard: avisos e estado
```

F = frente, T = trás, D = direita, E = esquerda. O [plano do backend](../docs/PLANO_BACKEND_ROBOFLOW.md) propõe o protocolo, a geometria e o significado de conclusão das ações. Esses itens ainda precisam ser implementados nos dois lados.

O backend é responsável por planejamento, processamento pesado, histórico, indicadores e decisões de missão. O ESP32 mantém correções rápidas de linha, temporização, execução e veto de movimento. Não depende do backend para detectar um obstáculo e parar.

Não há leitura de velocidade. `set_speed`, se mantido, deverá definir PWM com escala e limites explícitos. Não gerar telemetria de velocidade medida nem converter arbitrariamente o valor para m/s.

### 13.2 Hardware de referência

A montagem e pinagem são definidas em [Arquitetura dos componentes](../docs/ARQUITETURA_DOS_COMPONENTES.md). O sketch gerado deverá usar esse perfil, sem introduzir câmera, servo ou Raspberry Pi.

| Função | GPIO |
|---|---|
| Motor esquerdo: ENA / IN1 / IN2 | 25 / 26 / 27 |
| Motor direito: ENB / IN3 / IN4 | 13 / 14 / 23 |
| Linha: esquerda / centro / direita | 32 / 34 / 33 |
| HC-SR04: TRIG / ECHO | 18 / 19 |

Os requisitos elétricos, divisor do ECHO, jumpers e alimentação continuam no documento físico. O compilador não substitui essas verificações de montagem. Começar com regras discretas ou controle proporcional de linha; PID não é requisito inicial fechado.

## 14. O que falta implementar no compilador

### 14.1 Definir a extensão da linguagem

A sintaxe implementada reconhece `station`, `on_arrival`, comandos e `if/else`. Ela não declara aquisição periódica, transporte, callbacks de mensagens ou executor da fila recebida. Não documentar funções novas como se já fossem aceitas.

Antes de ampliar lexer/parser/AST, especificar como o `.rf` configura o sistema embarcado e como usa o runtime padrão. Uma abordagem é manter drivers, comunicação e executor nos templates e deixar a DSL configurar parâmetros e reações. A escolha da sintaxe é pendente: não basta copiar o antigo gerador de estações.

Separar comportamento embarcado de rota remota: estações atuais podem servir a eventos locais ou compatibilidade, mas o backend é quem planeja o percurso. Atualizar exemplos para demonstrar essa divisão após fechar a sintaxe. O tradutor `(x,y) → F/T/D/E` pertence ao backend, não ao compilador.

### 14.2 Semântica e diagnósticos

Implementar catálogo de comandos, validação de quantidade/nome/tipo dos argumentos, duplicações, contexto declarado, parâmetros PWM, limites de duração e perfil de hardware. Preservar posições de origem na AST para indicar erros úteis.

Não sobrescrever `default` antes de validar duplicações. Definir em que situações ele é obrigatório na linguagem estendida; a política histórica de exigir `default` não deve ser aplicada sem avaliar a nova forma do programa.

Proibir configuração que remova o supervisor ou permita escrever nos motores ignorando o veto. Esperas e condicionais precisam manter aquisição e comunicação funcionando. `wait_signal` expirado deve parar e registrar falha; `timeout: none` mantém espera com supervisor ativo.

### 14.3 Gerador e composição do sketch

Implementar um gerador determinístico, preferencialmente a partir de uma IR pequena, que:

1. Converta comandos e reações validados em C++.
2. Inclua os templates de motores, sensores, comunicação e executor.
3. Emita `setup()` com motores inicialmente desabilitados.
4. Emita `loop()` não bloqueante, incluindo atualização dos sensores, transporte, fila e supervisor.
5. Escape strings, gere nomes válidos, evite colisões e trate comparação textual corretamente.
6. Normalize segundos para a unidade interna de temporização, com limites definidos.
7. Gere um único `.ino` e informe dependências/versão do core ESP32 usadas na validação.
8. Não inclua segredos reais em arquivos versionados; configuração de transporte deve ter campos claramente identificados quando necessária.

Drivers e runtime ainda precisam ser escritos. O fato de poderem ser templates fixos não significa que já existam no repositório.

### 14.4 Sensores e acionamento

O runtime incluído no sketch deverá ler os três sensores de linha com polaridade normalizada e medir ultrassom preservando validade e idade da leitura. Os documentos físicos propõem linha a cada 10 ms, ultrassom a cada 70 ms e leitura de distância vencida após 200 ms; são parâmetros iniciais sujeitos a teste.

Toda saída de motor passa por uma única função que aplica o supervisor. Não usar leitura de sensores em backend como substituto desse controle. PWM comanda os canais da ponte H e não representa velocidade medida.

### 14.5 Comunicação e fila recebida

Implementar o contrato do plano do backend: handshake com sessão de boot/capacidades, recepção limitada da fila, validação, confirmação, início separado do carregamento e mensagens de progresso. Proposta inicial de transporte: serial USB; adaptação de rede futura não altera o significado da fila.

O sketch deve rejeitar caracteres diferentes de F/T/D/E, filas grandes demais, comandos vencidos ou de sessão/missão errada. Duplicatas não repetem movimento. Mudança de rota exige parar e cancelar a anterior.

Não incluir a rota escolhida pelo usuário como array fixo em cada geração do sketch. O array é recebido durante a operação, preservado em memória limitada e executado por índice/fase. Após reboot, motores permanecem parados; não retomar missão antiga automaticamente.

### 14.6 Fim das ações e restrições físicas

O término das ações está definido: **cada comando leva do cruzamento atual até o próximo cruzamento de uma grade de linhas e colunas no chão**. Cada cruzamento é um ponto lógico `(x,y)`. O ESP32 não mede coordenadas ou velocidade; reconhece cruzamentos pelos sensores de linha e informa o progresso. A detecção física e a geometria da grade ainda precisam de calibração.

Semântica definida: F segue em frente até o próximo cruzamento; D vira à direita no atual e avança até o seguinte; E faz o equivalente à esquerda; T desloca em ré até o próximo cruzamento atrás, mantendo orientação. D/E não precisam de F adicional para o mesmo segmento. O carrinho começa em cruzamento e orientação conhecidos. O backend só envia trechos entre vizinhos consecutivos, sem saltar cruzamentos.

Implementar fases de manobra/alinhamento, saída do cruzamento atual, seguimento do segmento e confirmação de entrada no próximo. A detecção deve ser rearmada somente após sair da região anterior, com filtragem para contar cada cruzamento uma única vez. Calibrar a referência de chegada conforme a posição dos sensores e o eixo das rodas. Emitir `action_completed` e avançar o índice uma única vez por confirmação. Cruzamento intermediário não obriga parada se houver continuação autorizada; no último, parar e confirmar conclusão.

Os cruzamentos não identificam suas próprias coordenadas. O backend estima posição a partir da referência inicial e do progresso. Se essa referência ficar incerta, o executor deve parar e exigir reposicionamento confirmado; não continuar contando. Timeout de ação deve causar parada/falha, nunca conclusão presumida por tempo.

Padrões de linha ambíguos continuam gerando parada se não houver uma regra de pista validada. Durante curvas, definir fases esperadas de aquisição da linha e limites; não desabilitar genericamente a detecção de perda da linha.

A ré fica desabilitada no MVP proposto, pois não há sensor traseiro nem seguimento em ré validado. O protocolo reconhece T, mas o firmware anuncia `supportsReverse=false` e rejeita sua execução. O backend deverá barrar essas rotas antes de enviar. Essa é uma restrição explícita de implementação proposta, não uma mudança no significado de T.

### 14.7 Parada e retomada

Parar localmente em todos os casos definidos: obstáculo, medição inválida ou vencida e perda da linha. Manter também falha e parada solicitada como bloqueios. A proposta de watchdog de comunicação do plano do backend acrescenta parada quando a autorização de comunicação expira; seu prazo exige validação.

Usar inicialmente os limites documentados de ≤20 cm para parar e três medições consecutivas ≥25 cm para considerar recuperação do ultrassom. Retomada requer:

- Todos os bloqueios resolvidos e sensores com dados válidos/recentes.
- Linha válida ou reposicionamento confirmado quando necessário.
- Solicitação explícita da dashboard, encaminhada pelo backend.
- Nova validação local pelo ESP32 no recebimento.

Não retomar só porque o obstáculo saiu, o backend reconectou ou um alerta foi reconhecido. Uma liberação rejeitada não fica pendente. Se a posição/fase de uma ação estiver incerta após parada, exigir recuperação explícita; não avançar nem repetir cegamente o índice.

### 14.8 Telemetria e avisos visuais

Emitir leituras de linha, distância/validade/idade, estado, motivo de parada, índice/fase da ação, confirmações e falhas. O backend persiste e projeta os dados no contrato HTTP da dashboard.

`log`, `signal_light` e `signal_buzzer` devem produzir eventos para apresentação visual. Os nomes dos dois últimos são herdados; não pressupor buzzer ou LED instalado. Uma eventual renomeação precisa atualizar reservadas, parser, semântica, exemplos e documentação.

A dashboard não identifica fisicamente a estação. O backend acompanha os nós por eventos e pela rota selecionada; sem referência confiável, informar posição incerta. O ultrassom não identifica carga nem nome de estação.

### 14.9 Interface de geração e testes

Oferecer um comando simples que receba `.rf` e produza `.ino`; sintaxe exata ainda a implementar. Em erro semântico, não gerar um sketch aparentemente válido. A CLI de upload não faz parte do requisito.

Verificação necessária para declarar o compilador pronto:

| Nível | Evidência |
|---|---|
| Léxico/sintático | Exemplos positivos/negativos, posições e AST |
| Semântico | Assinaturas, limites, duplicações e supervisor preservado |
| Geração | Saída determinística, C++ escapado e sketch único |
| Arduino IDE | Sketch abre e compila para o ESP32 clássico com dependências declaradas |
| Simulação | Fila, duplicação, timeout, reboot e comunicação com backend simulado |
| Bancada | Sensores reais, motores suspensos e interrupção em todas as fases |
| Pista | Eventos de fim de ação, perda da linha e retomada explícita |

## 15. Fontes atuais e limites da análise

Referências atuais: [arquitetura física](../docs/ARQUITETURA_DOS_COMPONENTES.md), [comportamento do robô](../docs/O_QUE_O_ROBO_FAZ.md), [plano do backend](../docs/PLANO_BACKEND_ROBOFLOW.md) e [contrato da dashboard](../dashboard/BACKEND_INTEGRATION.md). Os documentos antigos em `docs/linguagem` e `docs/planejamento` não estão mais presentes e não são requisitos vigentes.

O README da raiz contém seções identificadas como históricas. Pitch e plano comercial também descrevem propostas anteriores; suas afirmações sobre deploy, Raspberry Pi e estágios de implementação não comprovam funcionalidades no código.

As seções 1–12 descrevem o front-end existente por inspeção estática. As seções 13–14 descrevem o destino acordado e trabalho pendente; exemplos de protocolo e escolhas ainda propostas estão identificados no plano do backend.

Na análise original foi tentada execução com `python`, mas o comando disponível redirecionava à Microsoft Store. Não houve execução de exemplos, compilação Arduino ou teste físico nesta revisão documental. Nenhum backend, gerador, firmware ou tela de seleção de rota foi implementado nesta entrega.

## 16. Ordem de implementação

1. Fechar protocolo e extensão da DSL; calibrar a detecção dos cruzamentos que já definem o fim de cada ação.
2. Preservar posições na AST e implementar semântica.
3. Construir runtime com drivers, aquisição, supervisor e executor limitado.
4. Implementar telemetria e comunicação com simulador do backend.
5. Compor runtime e comportamento em um único sketch `.ino`.
6. Validar compilação na Arduino IDE e ensaios de bancada.
7. Integrar fila real da dashboard/backend e validar a pista.

O resultado esperado é um compilador que entregue o sistema embarcado pronto para gravação manual. O backend continua responsável por converter a rota escolhida em ações; o ESP32 continua responsável por executá-las e impedir movimento quando as condições locais não permitirem.
