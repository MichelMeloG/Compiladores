# Material de Aula — Compiladores

## Ementa do curso

> Em rosa: AP1.

1. O que são linguagens?
2. O que são compiladores?
3. Criação de tokens
4. Análise léxica
5. Árvore sintática
6. Análise semântica
7. Erros e código parcial
8. Código fonte
9. Otimização e compilação

## Avaliações

- **AP1:** 50% prova, 50% trabalho.
- **AP2:** 50% trabalho, 50% seminário/apresentação.
- **AC:** 3 ou 4 listas sobre análise léxica, análise sintática ou análise semântica.

## Trabalho

### Primeira entrega

- Pitch de aproximadamente 10 minutos: plano de negócios, pesquisa, logo, ideia, cores, cronograma, orçamento etc.
- Documentação do código no Git com:
  - Análise léxica e tabela de tokens.
  - Análise sintática e AST.
  - Back-end funcionando.
  - Código-fonte.

### Segunda entrega

- Vídeo tutorial do app (aproximadamente 8 minutos).
- Artigo no padrão IEEE, com aproximadamente 10 páginas, descrevendo o desenvolvimento.
- Documentação completa no Git com:
  - Análise semântica e tabela de erros.
  - Código compilando para a linguagem desejada.
  - Front-end funcionando.
- Implementação prática com eletrônica embarcada.
- Apresentação oral com banca.

# Introdução a Compiladores

## O que é um compilador?

É um sistema completo de tradução de linguagens, normalmente de alto para baixo nível. É composto por diversos elementos de análise e otimização para que a tradução seja feita corretamente.

## O que é um transpilador?

É um compilador que executa a tradução entre linguagens de mesmo nível hierárquico.

## O que é um parser?

É um dos elementos básicos de um compilador. Ele divide e categoriza os tokens, montando uma tabela e auxiliando na criação da AST.

> Em tecnologia, AST significa *Abstract Syntax Tree* (Árvore de Sintaxe Abstrata). É uma forma de representar o código-fonte em formato de árvore hierárquica, focando na lógica e ignorando detalhes visuais como parênteses, pontos e vírgulas ou espaços.

## O que é um interpretador?

É um executor que lê o código e o executa diretamente, sem gerar arquivo objeto.

## Partes de um compilador

Um compilador básico segue uma *pipeline*, dividida em duas grandes fases, ligadas a uma representação/interpretação intermediária.

- **Analisador léxico (lexer/scanner)**
  - Entrada: caracteres do código-fonte.
  - Função: agrupar os caracteres em unidades com significado (lexemas) e emitir tokens.
- **Analisador sintático (parser)**
  - Entrada: fluxo de tokens.
  - Função: verificar se a ordem dos tokens respeita a gramática livre de contexto e construir a Árvore de Sintaxe Abstrata (AST).
- **Analisador semântico (type checker)**
  - Entrada: AST.
  - Função: conferir o significado do programa; verificar tipos e garantir, por exemplo, que variáveis foram declaradas antes do uso.
- **Representação intermediária**
  - É uma linguagem interna do compilador.
  - Função: desacoplar a análise da geração de código.

# Hierarquia de Chomsky e Regex

## Hierarquia de Chomsky

É uma classificação de gramáticas formais proposta em 1956. Ela organiza as linguagens formais em quatro níveis contidos, da mais complexa à mais simples.

| Nível | Tipo | Linguagem | Autômato/máquina necessária |
| --- | --- | --- | --- |
| 0 | Irrestrita | Recursivamente enumerável | Máquina de Turing |
| 1 | Sensível | Sensível ao contexto | Autômato com limite linear (LBA) |
| 2 | Livre | Livre de contexto | Autômato com pilha (PDA) |
| 3 | Regular | Regular | Autômato finito (DFA/NFA) |

Aplicabilidade em compiladores:

- **0:** computabilidade geral.
- **1:** análise semântica e verificação de tipos.
- **2:** análise sintática (*parsing*/AST).
- **3:** análise léxica (lexer/regex).

## Linguagens regulares

São as mais simples. As regras só podem derivar de um símbolo terminal ou de um terminal seguido por um único não terminal:

> A → w ou A → wB (*single input, single output*).

**Restrição:** não conseguem contar ou balancear estruturas de profundidade arbitrária, como parênteses consecutivos/balanceados.

## Expressões regulares

É uma expressão algébrica usada para especificar uma linguagem regular sobre um alfabeto `Σ`.

Operadores indutivos principais:

- União: `r1|r2` → `L(r1|r2) = L(r1) ∪ L(r2)`.
- Concatenação: `r1r2` → `L(r1r2) = L(r1)L(r2)`.
- Fecho de Kleene: `r*`.

O fecho de Kleene descreve todas as combinações possíveis, incluindo a cadeia vazia `ε`.

Exemplo: para o alfabeto binário `Σ = {0, 1}`, `Σ*` inclui `ε`, `0`, `1`, `00`, `01`, `10`, `11` etc.

Comportamentos comparativos:

- `a*`: fecho de Kleene; inclui `ε`.
- `a+`: fecho positivo; exclui `ε`.
- `a?`: opcional.

Exemplos de padrões:

- Variável/identificador: `[a-zA-Z][a-zA-Z0-9]*`
- Números inteiros: `[0-9]+`
- Números float: `[0-9]+\.[0-9]+`
- String: `"[a-zA-Z0-9]+"`
- Comentário com quebra de linha: `#[a-zA-Z0-9]+\n*`

# DFA e NFA (Tipo 3)

## O que é um autômato finito?

É um modelo matemático de computação com memória finita. Ele lê uma cadeia de símbolos de um alfabeto `Σ`, transita entre estados e aceita ou rejeita a entrada ao final da cadeia.

Tanto o DFA quanto o NFA são definidos por:

> M = (Q, Σ, δ, q₀, F)

- `Q`: conjunto finito e não vazio de estados.
- `Σ`: alfabeto finito.
- `δ`: função de transição.
- `q₀ ∈ Q`: estado inicial.
- `F ⊆ Q`: conjunto de estados de aceitação (ou finais).

## DFA — Deterministic Finite Automata

É um modelo cujo comportamento é totalmente previsível: para cada estado `q` e cada símbolo `a` da entrada, existe exatamente uma transição definida.

> δ: Q × Σ → Q

Características:

- Sem ambiguidades ou escolhas de caminhos.
- Não possui transições vazias (`ε`).

## NFA — Non-deterministic Finite Automata

Em um NFA, a máquina pode ter zero, uma ou múltiplas transições para o mesmo símbolo `a` a partir de um único estado, além de poder mudar de estado sem consumir caractere por meio de transições `ε`.

> δ: Q × (Σ ∪ {ε}) → P(Q)

Características:

- Execução conceitualmente paralela.
- A cadeia é aceita se existir ao menos um caminho que termine em estado de aceitação.

# Análise Léxica (Scanning)

É a primeira fase do *front-end* do compilador. Sua função é ler uma sequência bruta de caracteres e transformá-la em uma sequência significativa chamada token.

Exemplo de entrada: `a = b + 2`

O analisador léxico agrupa esses caracteres em palavras ou símbolos da linguagem, descartando o que não importa e catalogando o que importa, além de informar erros de caracteres inválidos.

- **Lexema:** sequência real de caracteres do código-fonte compatível com o padrão de um token.
- **Token:** par abstrato no formato `<nome, valor>`. É o símbolo usado pelo analisador sintático; seu valor pode apontar para informações na tabela de símbolos.
- **Padrão:** regra descritiva de como os lexemas de um token devem ser formados.

## Como construir uma tabela de padrões?

Usando regex. Exemplos:

- Dígito: `[0-9]`
- Letra: `[a-zA-Z]`
- Variáveis: `letra(letra/dígito)*`
- Inteiros: `dígito+`
- Float: `dígito+(\.dígito)+`

## Como fazer uma análise léxica?

### Passo 1 — Avaliar a entrada (texto bruto)

- Ler o fluxo de caracteres (alfabeto).
- Descartar caracteres não semânticos: espaços, tabulações e comentários.
- Conceituar a tríade: **lexema → token → padrão**.

### Passo 2 — Especificar os tokens por regex

- Definir o alfabeto e a linguagem regular.
- Aplicar as operações primárias: fechos, união e concatenação.
- Construir regras de regex para literais, números e identificadores.

### Passo 3 — Construir o NFA (algoritmo de Thompson)

Transformar regex em grafos com estados e transições:

- Símbolos.
- Estados.
- Uniões e fluxos.
- Fechos de Kleene.

### Passo 4 — Converter NFA para DFA

- Mapear todos os estados alcançáveis apenas por transições vazias.
- Agrupar estados do NFA em superestados de um DFA.

### Passo 5 — Minimizar estados (algoritmo de Hopcroft)

- Particionar estados em dois grupos: finais e não finais.
- Refinar e eliminar ambiguidades com base na equivalência das saídas.
- Fundir estados indistinguíveis para otimizar a memória.

### Passo 6 — Executar o lexer

- Gerenciar buffer: usar ponteiros duplos para tratar arquivos grandes.
- Aplicar a regra do casamento mais longo: garante que o padrão mais longo seja reconhecido.
- Resolver conflitos: palavras-chave e reservadas têm prioridade sobre identificadores comuns.

# Análise Sintática

Avalia a gramática do código, analisando o conjunto de regras que o compõe. Recebe o fluxo de tokens como entrada e produz a AST como saída.

Gramáticas livres de contexto são definidas pela quádrupla:

> G = (V, Σ, R, S)

- `V`: conjunto de símbolos não terminais.
- `Σ`: conjunto de símbolos terminais.
- `R`: conjunto de regras de produção.
- `S`: símbolo inicial.

A AST (*Abstract Syntax Tree*) ordena os tokens para criar uma árvore de operações ou sentenças a ser avaliada.

## Tipos de parsing

### Top-down

- Pode entrar em loop com recursão à esquerda.
- Leitura `LL`: *left-to-right*.
- Exemplo de produção: `A → aα`.
- Resolve decisões ambíguas antecipadamente.
- Cria um token de *lookahead*, por exemplo: `a == z`.

### Bottom-up (LR)

- Leitura *left-to-right*, com derivação mais à direita (*right-most derivation*).
- Em vez de expandir da raiz às folhas, o parser lê os tokens (folhas) e tenta reduzi-los até alcançar o símbolo inicial.
- Aceita uma classe maior de gramáticas sem necessitar eliminar recursão à esquerda.
- Funciona como uma pilha de execução:
  - **Shift (empilha):** consome o token e empilha um novo estado.
  - **Reduce (reduz):** identifica uma sequência de símbolos no topo da pilha e a compara com uma regra.
  - **Accept:** parsing bem-sucedido.
  - **Error:** erro sintático.
