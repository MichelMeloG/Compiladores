# 🚗 AutoDrive DSL — Veículo Autônomo Guiado por Linguagem de Domínio Específico

> Projeto acadêmico desenvolvido para a disciplina de **Compiladores**. Simula a arquitetura modular de ECUs de veículos autônomos reais, integrando visão computacional, controle embarcado em tempo real e um compilador customizado baseado em DSL.

---

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Arquitetura do Sistema](#arquitetura-do-sistema)
- [Hardware](#hardware)
- [A Linguagem DSL — AutoDrive Script](#a-linguagem-dsl--autodrive-script)
- [O Compilador](#o-compilador)
- [Fluxo de Funcionamento](#fluxo-de-funcionamento)
- [Estrutura do Repositório](#estrutura-do-repositório)
- [Como Usar](#como-usar)
- [Dependências](#dependências)
- [Equipe](#equipe)

---

## Visão Geral

O **AutoDrive DSL** é um sistema embarcado de veículo autônomo em escala reduzida. O objetivo central do projeto, dentro do contexto da disciplina de Compiladores, é a criação de uma **Linguagem de Domínio Específico (DSL)** declarativa e de um **compilador** capaz de ler essa linguagem e gerar código C++ (`main.cpp`) com a máquina de estados e as constantes PID que serão gravadas no microcontrolador ESP32.

O sistema replica, de forma didática, a separação de responsabilidades encontrada em veículos autônomos reais:

| Camada | Analogia Real | Implementação no Projeto |
|---|---|---|
| Percepção | Unidade de Processamento de Imagem | Raspberry Pi + OpenCV |
| Controle | ECU de Baixo Nível | ESP32 + PID |
| Parametrização | Ferramenta de Calibração de Engenharia | Compilador DSL |

---

## Arquitetura do Sistema

O projeto é dividido em três grandes pilares:

```
┌─────────────────────────────────────────────────────┐
│                   SISTEMA AUTODRIVE                 │
│                                                     │
│  ┌─────────────────┐      ┌──────────────────────┐  │
│  │   O CÉREBRO     │      │    A MEDULA           │  │
│  │  (Raspberry Pi) │─USB──│    (ESP32)            │  │
│  │                 │Serial│                       │  │
│  │  - Câmera       │─────►│  - Controle PID       │  │
│  │  - Bird's Eye   │      │  - Servo Motor        │  │
│  │  - Cálculo do   │      │  - Motor DC (L298N)   │  │
│  │    Desvio       │      │  - Máquina de Estados │  │
│  └─────────────────┘      └──────────────────────┘  │
│                                       ▲              │
│  ┌─────────────────┐                  │              │
│  │  O COMPILADOR   │    Grava main.cpp│              │
│  │  (DSL → C++)    │──────────────────┘              │
│  │                 │                                 │
│  │  arquivo.ads    │                                 │
│  │       ↓         │                                 │
│  │   Compilador    │                                 │
│  │       ↓         │                                 │
│  │   main.cpp      │                                 │
│  └─────────────────┘                                 │
└─────────────────────────────────────────────────────┘
```

### 🧠 O Cérebro — Visão Computacional (Raspberry Pi)

- Captura de frames via câmera USB/CSI
- Aplicação de **Bird's Eye View** (transformação de perspectiva homográfica via OpenCV)
- Detecção de faixas e cálculo do **erro de trajetória** (desvio lateral em pixels)
- Envio contínuo do valor de desvio ao ESP32 via **porta Serial (USB)**

### 🦴 A Medula — Controle Físico (ESP32)

- Recebe o valor de desvio pela Serial
- Executa **controle PID** de esterçamento (servo motor) e tração (motor DC)
- Opera uma **máquina de estados** gerada automaticamente pelo compilador
- As constantes PID (`Kp`, `Ki`, `Kd`) e os estados são definidos pelo arquivo DSL

### ⚙️ O Compilador — DSL → C++

- Lê um arquivo `.ads` (*AutoDrive Script*)
- Realiza análise léxica e sintática via expressões regulares
- Gera o arquivo `main.cpp` pronto para ser compilado e gravado no ESP32 via Arduino IDE / PlatformIO

---

## Hardware

| Componente | Função |
|---|---|
| **Raspberry Pi** (3B+ ou 4) | Unidade central de visão computacional |
| **ESP32** | Microcontrolador de controle em tempo real |
| **Câmera USB / CSI** | Captura de imagem do ambiente |
| **Servo Motor** | Esterçamento do eixo dianteiro (geometria Ackermann) |
| **Motor DC** | Tração traseira |
| **Driver L298N (Ponte H)** | Controle de velocidade e direção do Motor DC |
| **Chassi Ackermann** | Estrutura mecânica com geometria de direção real (evita skid-steer) |
| **Cabo USB** | Comunicação Serial entre Raspberry Pi e ESP32 |

> **Por que geometria Ackermann?**
> A geometria Ackermann garante que as rodas dianteiras tracem arcos concêntricos em curvas, eliminando a derrapagem lateral presente em plataformas com skid-steer. Isso torna o modelo mais fiel ao comportamento de veículos reais.

---

## A Linguagem DSL — AutoDrive Script

A DSL criada para este projeto é **declarativa** e baseada em **mapeamento de regras**. Sua sintaxe simples permite extração via expressões regulares (Regex), facilitando a implementação do compilador.

### Exemplo de arquivo `.ads`

```ads
// AutoDrive Script - Configuração do Controlador

VEHICLE {
    name: "Prototipo_v1"
    mode: AUTONOMOUS
}

PID_CONTROLLER {
    Kp: 1.20
    Ki: 0.05
    Kd: 0.80
    setpoint: 0.0
    output_min: -90
    output_max: 90
}

STATES {
    IDLE        -> FOLLOWING   : on_start
    FOLLOWING   -> STOPPED     : on_obstacle
    FOLLOWING   -> LOST_TRACK  : on_no_line
    LOST_TRACK  -> FOLLOWING   : on_line_found
    STOPPED     -> IDLE        : on_reset
}

SPEED {
    base_speed: 150
    turn_speed: 100
    max_speed:  200
}
```

### Tokens da Linguagem

| Token | Descrição |
|---|---|
| `VEHICLE { }` | Bloco de identificação e modo de operação do veículo |
| `PID_CONTROLLER { }` | Define as constantes e limites do controlador PID |
| `STATES { }` | Declara as transições da máquina de estados |
| `SPEED { }` | Define parâmetros de velocidade |
| `->` | Operador de transição de estado |
| `:` | Separador de chave-valor |
| `//` | Comentário de linha |

---

## O Compilador

O compilador é implementado em **Python** e segue as seguintes fases:

```
Arquivo .ads
     │
     ▼
┌─────────────┐
│ Analisador  │  Tokenização via Regex
│   Léxico    │  Identificação de blocos, operadores e literais
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Analisador  │  Validação da estrutura dos blocos
│  Sintático  │  e das transições de estado
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Gerador    │  Preenchimento de template C++
│  de Código  │  com constantes PID e máquina de estados
└──────┬──────┘
       │
       ▼
  main.cpp (para ESP32)
```

---

## Fluxo de Funcionamento

```
1. Engenheiro escreve o arquivo config.ads
          │
          ▼
2. Executa o compilador:
   $ python compiler.py config.ads
          │
          ▼
3. Compilador gera src/main.cpp
          │
          ▼
4. main.cpp é gravado no ESP32 via Arduino IDE / PlatformIO
          │
          ▼
5. Raspberry Pi inicia o pipeline de visão (vision.py)
          │
          ▼
6. Raspberry envia desvio → ESP32 executa PID → veículo segue a pista
```

---

## Estrutura do Repositório

```
autodrive-dsl/
│
├── compiler/                  # Código-fonte do compilador DSL
│   ├── compiler.py            # Entry point do compilador
│   ├── lexer.py               # Analisador Léxico
│   ├── parser.py              # Analisador Sintático
│   └── codegen.py             # Gerador de Código C++
│
├── dsl/                       # Exemplos de arquivos DSL (.ads)
│   ├── config_basico.ads
│   └── config_avancado.ads
│
├── esp32/                     # Código gerado e templates para o ESP32
│   ├── template/
│   │   └── main_template.cpp  # Template base para geração de código
│   └── src/
│       └── main.cpp           # Arquivo gerado pelo compilador (não editar manualmente)
│
├── raspberry/                 # Scripts de visão computacional
│   ├── vision.py              # Pipeline principal: captura, BEV e cálculo de desvio
│   └── serial_comm.py         # Módulo de comunicação Serial com o ESP32
│
├── docs/                      # Documentação adicional
│   └── arquitetura.png
│
└── README.md
```

---

## Como Usar

### 1. Compilar um arquivo DSL

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/autodrive-dsl.git
cd autodrive-dsl

# Instale as dependências do compilador
pip install -r requirements.txt

# Execute o compilador
python compiler/compiler.py dsl/config_basico.ads

# O arquivo gerado estará em:
# esp32/src/main.cpp
```

### 2. Gravar no ESP32

Abra `esp32/src/main.cpp` no **Arduino IDE** ou **PlatformIO** e faça o upload para o ESP32.

### 3. Executar a visão na Raspberry Pi

```bash
# Na Raspberry Pi, execute:
python raspberry/vision.py --port /dev/ttyUSB0 --baud 115200
```

---

## Dependências

### Compilador (Python)
```
python >= 3.9
re (built-in)
```

### Visão Computacional (Raspberry Pi)
```
opencv-python >= 4.5
pyserial >= 3.5
numpy >= 1.21
```

### Firmware (ESP32)
```
Arduino IDE >= 2.0  ou  PlatformIO
```

---

## Equipe

Projeto desenvolvido por alunos do curso de **Ciência da Computação** para a disciplina de **Compiladores**.

| Nome | Função |
|---|---|
| — | Compilador DSL (Léxico / Sintático / Gerador) |
| — | Visão Computacional (Raspberry Pi / OpenCV) |
| — | Firmware ESP32 (PID / Máquina de Estados) |
| — | Hardware (Chassi / Eletrônica / Integração) |

---

> *"A engenharia de um compilador, mesmo que simples, revela a elegância por trás de toda linguagem de programação."*
