# Visão Geral Integrada: AGV Seguidor de Linha + Compilador RoboFlow

**Versão:** 2.0 (Seguidor de Linha Industrial)  
**Data:** Agosto 2026

---

## 🎯 O Projeto em Uma Frase

Um AGV segue uma linha no chão com controle PID clássico; ao chegar em cada estação, um trecho de código **gerado por um compilador da disciplina** decide o que fazer — e um sensor de proximidade em hardware garante que essa decisão nunca resulte em colisão.

---

## 🧩 As Três Peças e Quem é Responsável por Cada Uma

```
┌─────────────────────────────────────────────────────────┐
│  PEÇA 1 — Seguir a linha                                │
│  Robótica clássica: array IR + PID no ESP32              │
│  Não usa nada da disciplina de compiladores              │
│  Sempre ativa, 100 Hz                                    │
└─────────────────────────────────────────────────────────┘
                          +
┌─────────────────────────────────────────────────────────┐
│  PEÇA 2 — Decidir o que fazer em cada estação            │
│  ★ Aqui mora o projeto de Compiladores ★                 │
│  RoboFlow (linguagem) → Lexer → Parser → Semântica →     │
│  Code Generator → módulo Python                          │
│  Roda sob evento, num script Python simples no Pi        │
└─────────────────────────────────────────────────────────┘
                          +
┌─────────────────────────────────────────────────────────┐
│  PEÇA 3 — Nunca colidir, aconteça o que acontecer         │
│  Sensor de proximidade + veto de hardware no ESP32        │
│  Fora do alcance do que RoboFlow pode gerar                │
│  Sempre ativa, prioridade máxima                           │
└─────────────────────────────────────────────────────────┘
```

Cada peça tem uma responsabilidade e nenhuma delas faz o trabalho da outra. Essa separação é o principal argumento de design do projeto.

---

## 🔄 Fluxo Completo, do Chão de Fábrica ao Código

```
1. AGV segue a linha (PID, ESP32)
        ↓
2. Array IR detecta padrão especial → marcador de estação
        ↓
3. Leitor RFID identifica qual estação (ex: "carga")
        ↓
4. ESP32 escreve "STATION carga" na porta serial
        ↓
5. station_runner.py (Raspberry Pi) lê a linha
        ↓
6. Função gerada pelo compilador RoboFlow (handle_carga) executa:
        send_cmd('CMD STOP')
        wait_for_signal('carga_completa', timeout=30)
        send_cmd('CMD RESUME_LINE_FOLLOWING')
        ↓
7. Cada send_cmd escreve uma linha "CMD ..." na serial
        ↓
8. ESP32 recebe comando — MAS primeiro verifica o veto
        ↓
   Veto ativo? ──SIM──→ comando é descartado, PWM = 0
        │
        NÃO
        ↓
9. Comando executado (motor para, aguarda sinal, retoma linha)
        ↓
10. AGV volta à Peça 1 (seguir linha) até o próximo marcador
```

---

## 🎓 Onde Cada Conceito da Disciplina Aparece

| Conceito | Onde aparece no projeto |
|---|---|
| **Análise Léxica** | Tokenizar `station`, `on_arrival`, comandos e strings do RoboFlow |
| **Análise Sintática** | Gramática BNF de `station { on_arrival { ... } }`, parser recursivo descendente |
| **Análise Semântica** | Completude (toda estação comissionada tem comportamento), determinismo (sem duplicatas), terminação garantida (sem travar o AGV) |
| **Autômatos Finitos** | O comportamento do AGV é, por natureza, uma máquina de estados finita — RoboFlow compila diretamente para essa estrutura |
| **Geração de Código** | AST → módulo Python (`compiled_behavior.py`), mapeamento direto de comandos para chamadas `send_cmd(...)` |
| **Linguagens Formais** | Definição formal da sintaxe e das propriedades garantidas sobre o autômato resultante |

---

## 📅 Cronograma Consolidado

| Fase | Duração | Foco |
|---|---|---|
| 1. Hardware base | 2 semanas | Chassi, array IR, sensor de proximidade |
| 2. Firmware — seguimento de linha | 2-3 semanas | PID, calibração |
| 3. Firmware — segurança e estação | 1-2 semanas | Veto, detecção de marcador |
| 4. Script Python + identificação de estação | 1 semana | RFID, `station_runner.py`, protocolo serial |
| 5. Compilador — infraestrutura | 2-3 semanas | Lexer, Parser |
| 6. Compilador — semântica | 2 semanas | Completude, determinismo, terminação |
| 7. Compilador — geração de código | 2 semanas | Módulo Python gerado |
| 8. Integração e testes de pista | 2 semanas | Pista real, fail-safe, demonstração |

**Total: 4 meses**

---

## ⚙️ Nota de Arquitetura: Sem ROS 2

Versões anteriores deste documento previam ROS 2 como middleware de comunicação. Isso foi removido: com apenas dois dispositivos (ESP32 e Raspberry Pi) trocando mensagens simples, um framework de robótica multi-nó era complexidade desnecessária (over-engineering). A comunicação agora é serial texto direto (`STATION ...`, `CMD ...`), lida por um script Python sem framework (`station_runner.py`). Isso também simplificou o alvo de geração do compilador: de nó C++/ROS 2 para função Python — mais rápido de implementar e testar, sem perda de nenhuma das garantias de segurança do projeto.

---

## 📚 Mapa dos Documentos do Projeto

- **PROJETO_ROBO.md** — Visão geral, objetivos, hardware, cronograma (documento principal)
- **PROJETO_ROBO_SLAM_TECNICO.md** — Especificações de hardware, firmware, requisitos de performance
- **LINGUAGEM_ROBO_COMPILADOR.md** — Sintaxe do RoboFlow, gramática, conexão com autômatos
- **ARQUITETURA_DUAS_CAMADAS.md** — Detalhe do veto de segurança e por que fica isolado em hardware
- **COMPILADOR_GERA_CONTROLE.md** — As quatro fases do compilador com código de exemplo
- **PROJETO_INTEGRADO_VISAO_GERAL.md** — Este documento, ponto de entrada para quem quer o resumo

---

## 💼 Valor Comercial

Este é o modelo real de integradores de automação industrial: uma linguagem de configuração de comportamento de estação permite reprogramar o roteiro de um AGV editando um arquivo texto — sem tocar em firmware ou recompilar o sistema de controle de baixo nível. Isso reduz custo de comissionamento e erro humano, e é exatamente o tipo de ferramenta vendida por empresas de automação para clientes industriais.

---

**Ponto de entrada da documentação. Comece por aqui, depois vá para PROJETO_ROBO.md.**
