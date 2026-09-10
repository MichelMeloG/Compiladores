# Documentação do Projeto

Este diretório reúne a documentação do RoboFlow e do AGV por assunto.

## Comece por aqui

1. [Visão geral do projeto](projeto/PROJETO_ROBO.md)
2. [Roadmap da linguagem e do compilador para ESP32](planejamento/ROADMAP_ROBOFLOW_ESP32.md)
3. [Especificação da linguagem RoboFlow](linguagem/LINGUAGEM_ROBO_COMPILADOR.md)
4. [Implementação do compilador](linguagem/COMPILADOR_GERA_CONTROLE.md)

## Estrutura

### Aulas

- [Material de aula — Compiladores](aulas/MATERIAL_AULA_COMPILADORES.md)

### Projeto

- [Projeto do robô](projeto/PROJETO_ROBO.md) — objetivos, escopo, etapas e critérios de sucesso.

### Arquitetura

- [Visão computacional e visão geral integrada](arquitetura/VISÃO_COMPUTACIONAL.md)
- [Arquitetura em duas camadas](arquitetura/ARQUITETURA_DUAS_CAMADAS.md)
- [Hardware](arquitetura/HARDWARE.md)

### Linguagem e compilador

- [Linguagem RoboFlow](linguagem/LINGUAGEM_ROBO_COMPILADOR.md) — sintaxe, tokens, gramática e semântica.
- [Como o compilador gera o controle](linguagem/COMPILADOR_GERA_CONTROLE.md) — lexer, parser, análise semântica e geração de código.

### Planejamento

- [Roadmap RoboFlow → ESP32](planejamento/ROADMAP_ROBOFLOW_ESP32.md) — fases, cronograma, testes e entregas da AP1/AP2.

## Observação arquitetural

Parte da documentação histórica descreve geração de Python para execução no Raspberry Pi, enquanto o roadmap novo assume geração de C++ para execução no ESP32. Essa decisão deve ser consolidada antes da implementação para que todos os documentos descrevam a mesma arquitetura.
