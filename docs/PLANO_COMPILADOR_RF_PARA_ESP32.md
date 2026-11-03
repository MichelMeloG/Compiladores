# Plano do compilador RoboFlow: `.rf` para `.ino`

## 1. Objetivo e referência

Adequar o compilador RoboFlow para receber um programa **`.rf`** e gerar um sketch **`.ino` completo**, gravável manualmente no ESP32, que reproduza o comportamento de `firmware/carrinho_autonomo/carrinho_autonomo.ino`. A primeira referência é o firmware existente, inclusive suas limitações; mudanças de comportamento devem ser tratadas e testadas separadamente.

O resultado deve preservar a divisão de responsabilidades: o backend planeja a rota e envia comandos; o ESP32 recebe e executa a fila, acompanha a linha, controla motores e comunica progresso. A rota não é fixada no sketch durante a compilação.

O firmware de referência ainda precisa de validação física. Gerar um sketch e compilá-lo não comprova que o carrinho funciona na pista.

## 2. Estado atual

- `compiler/roboflow/lexer.py`, `parser.py`, `ast_nodes.py` e `semantic.py` implementam uma linguagem centrada em `station` e `on_arrival`.
- `compiler/roboflow/compiler.py` oferece os alvos `cpp` e `python`. O alvo C++ gera `behavior_generated.hpp` e `behavior_generated.cpp`, que dependem de uma interface de runtime; ele não gera um firmware completo.
- Os exemplos existentes usam `.rf`. Os programas de estações e os dois alvos atuais devem continuar funcionando, com testes de regressão.
- O firmware de referência é um sketch único, com configuração, controle local, protocolo, rede e inicialização. Ele usa ESP32 3.x e ArduinoJson 7.

## 3. Decisão de arquitetura

O `.rf` descreve configurações e seleciona comportamentos do robô. O compilador valida essas informações e as combina com um **runtime ESP32 versionado**, derivado do firmware de referência, para gerar um único `.ino` autossuficiente em código do projeto. Bibliotecas externas como ArduinoJson continuam sendo dependências de compilação.

Isso cobre o comportamento do firmware pelo conjunto **programa RoboFlow + runtime**. Não significa que a linguagem permitirá reimplementar arbitrariamente, linha por linha, JSON, HMAC, FreeRTOS ou C++. Suportar isso exigiria outro escopo de linguagem. Não usar blocos C++ arbitrários como substituto silencioso da linguagem.

O runtime deve ser uma fonte de verdade mantida no projeto, com versão explícita. Seus módulos podem ser separados no repositório e compostos na geração; a saída final deve ser um único sketch. Evitar depender de caminhos relativos ao diretório corrente, downloads ou do arquivo `.ino` de referência em tempo de execução do programa gerado. Registrar no sketch a versão do compilador, perfil e runtime, sem incluir segredos em comentários ou logs.

## 4. Cobertura funcional do firmware

| Área | Comportamento mínimo a preservar |
|---|---|
| Configuração | Identidade, Wi-Fi, URL, token, CA e NTP; pinos, polaridade, sentidos, potências e tempos configuráveis. |
| Inicialização | Configurar pinos, parar motores, criar sessão e estruturas de comunicação, aguardar o tempo inicial e iniciar a tarefa de rede. Falha de inicialização mantém o carrinho parado. |
| Motores e sensores | Aplicar PWM limitado e sentido configurado; ler os três sensores, manter a filtragem de leituras e parar conforme o estado do executor. |
| Execução | Receber até 16 ações por padrão; aceitar F, D e E; alinhar e girar quando aplicável, sair do cruzamento inicial, seguir a linha e confirmar chegada ao próximo cruzamento. Não anunciar nem executar ré. |
| Estados e interrupções | Preservar estados, bloqueio por perda de linha, limites de manobra, fila de eventos cheia, parada, cancelamento e retomada explícita nas condições implementadas no firmware. |
| Comunicação | Tarefa de rede separada, Wi-Fi, NTP, HTTP/HTTPS com CA, HMAC, apresentação, envio de eventos/telemetria, recebimento de comandos, confirmação e reconciliação. |
| Protocolo | Preservar IDs, sessão, sequências, validação e deduplicação de comandos, prioridades de parada, limites de mensagem, confirmação e reenvio dos eventos críticos. |
| Temporização | Preservar os tempos configurados e a política existente: perda de comunicação impede o início do próximo trecho após o limite; não declarar que ela interrompe imediatamente o trecho em andamento. |

O firmware não mede distância, bateria ou velocidade real; não implementa PID, ultrassom ou ré. Não incluir esses recursos como se já existissem. Também não prometer identificação física de estações: o backend acompanha os nós usando a rota e os eventos.

## 5. Linguagem `.rf` proposta

A sintaxe abaixo é uma **proposta para implementação**, não é aceita pelo compilador atual. A especificação final deve definir gramática, precedência, unidades, nomes reservados, comentários, escapes, valores padrão, regras de obrigatoriedade e mensagens de erro antes da implementação. O perfil `autonomous_line_v1` identifica expressamente a lógica fixa do runtime e evita que a configuração aparente representar comportamentos arbitrários.

```text
robot "RB-01" {
    profile autonomous_line_v1
    board esp32

    network {
        ssid: "SUA_REDE"
        password: "SUA_SENHA"
        backend: "http://192.168.1.10:8080"
        token: "SEGREDO_CADASTRADO_NO_BACKEND"
        ca_certificate: ""
        ntp: "pool.ntp.org"
    }

    motors {
        left_pins: [25, 26, 27]
        right_pins: [13, 14, 23]
        left_direction: 1
        right_direction: 1
    }

    line_sensors {
        pins: [32, 34, 33]
        active_level: high
        stable_samples: 3
        interval: 10ms
    }

    movement {
        straight_power: 150
        outer_power: 150
        gentle_inner_power: 110
        strong_inner_power: 60
        alignment: 120ms
        minimum_turn: 180ms
        turn_timeout: 2500ms
        segment_timeout: 15000ms
    }

    execution {
        startup_delay: 3000ms
        communication_timeout: 30000ms
        max_actions: 16
        max_events: 12
        route_source: backend
        actions: [forward, right, left]
        require_start_command: true
    }
}
```

Cada trio de pinos de motor é `EN, IN1, IN2`; a lista de sensores é esquerda, centro, direita. O compilador deve gerar os demais detalhes do perfil com valores explícitos e estáveis, inclusive os limites de protocolo e intervalos que não aparecem no exemplo. Se um campo for omitido, o padrão deve estar documentado e corresponder à versão do perfil; opções fixas pelo perfil podem ser omitidas na sintaxe final, desde que documentadas.

Criar `examples/carrinho_autonomo.rf` como programa de referência executável pelo compilador depois da implementação. Usar apenas marcadores para credenciais; nunca commitar credenciais reais. Definir uma forma documentada de fornecer valores privados no momento da geração, sem exibi-los em diagnósticos ou logs. O `.ino` gerado terá os valores necessários para conexão e deve ser tratado como arquivo sensível quando contiver credenciais reais.

## 6. Etapas do compilador

### 6.1. Entrada e análise léxica

- Reconhecer a extensão `.rf` na CLI e ler UTF-8 com erros de leitura claros.
- Acrescentar tokens para blocos, listas, separadores, booleanos, inteiros negativos e durações em milissegundos, sem quebrar a sintaxe existente de segundos.
- Definir escapes de strings, inclusive caracteres acentuados e certificados multilinha; rejeitar sequências inválidas com linha e coluna.
- Garantir que entrada incompleta ou inválida produza diagnóstico, não exceção inesperada na integração com a IDE.

### 6.2. Parser e AST

- Implementar declarações `robot`, perfil, blocos, propriedades e listas; preservar localização de origem em cada nó relevante.
- Detectar erros de sintaxe e estruturas incompletas. Não descartar propriedades duplicadas antes da análise semântica.
- Manter o parser dos programas `station` e definir explicitamente se a mistura de `robot` e `station` no mesmo arquivo será suportada. Até haver integração real das estações ao runtime autônomo, rejeitar a mistura com diagnóstico claro; não gerar comportamento de estação que nunca será executado.
- Documentar a gramática formal e exemplos válidos e inválidos.

### 6.3. Análise semântica

- Validar perfil e placa suportados, blocos obrigatórios, propriedades desconhecidas ou duplicadas e tipos de valores.
- Validar número de pinos, faixa e capacidade dos GPIOs para o perfil de placa selecionado, conflitos de uso e possíveis restrições de hardware. Não presumir que todo GPIO é apropriado para entrada e saída.
- Validar polaridade, sentido `1` ou `-1`, PWM de 0 a 255, contagem positiva de amostras, durações e intervalos dentro de limites seguros para a temporização; documentar os limites e o comportamento no estouro de `millis()`.
- Validar URL e exigir CA não vazia para HTTPS; verificar campos de identidade, configuração de rede e tamanhos máximos definidos pelo perfil, sem imprimir segredos.
- Validar capacidades anunciadas, tamanho das filas e limites de memória/protocolo coerentes com o runtime e backend. Os limiares internos que reservam espaço para eventos precisam ser coerentes com `max_events`; rejeitar combinações que violem essa reserva.
- Aceitar apenas ações suportadas e configurações cujo comportamento esteja implementado. Rejeitar ré, valores contraditórios ou opções que removam verificações essenciais. Nenhum arquivo deve ser gerado após erro.
- Emitir diagnóstico com código, mensagem e posição; avisos não podem mascarar configurações inválidas.

### 6.4. Representação intermediária e geração

- Converter a AST validada em uma configuração tipada e normalizada: durações em milissegundos, pinos, strings e opções do perfil. Não deixar o gerador reinterpretar entradas inválidas.
- Introduzir um alvo explícito `arduino`, preservando o significado dos alvos `cpp` e `python` existentes.
- Compor o runtime com as constantes validadas, `setup()` e `loop()` em um único `.ino`; gerar de modo determinístico para a mesma entrada e versões de compilador/runtime.
- Escapar corretamente strings UTF-8 para C++, inclusive quebras de linha e certificado PEM; evitar colisões de nomes e dependência da ordem acidental de mapas.
- Não gerar o `.ino` parcialmente quando ocorrer erro; produzir diagnósticos úteis para falhas de geração e escrita. Definir política clara para sobrescrever saída existente.
- Evitar alterar a semântica do firmware ao extrair o runtime. Em particular, preservar a separação entre tarefa de rede e controle, a fila e a sincronização entre tarefas, o fluxo de eventos e as regras de retomada.

### 6.5. CLI e API

Proposta de uso, sujeita à implementação:

```powershell
roboflow compile examples/carrinho_autonomo.rf --target arduino --output build/carrinho_autonomo/carrinho_autonomo.ino
```

- Disponibilizar ponto de entrada instalável e documentar instalação, uso e códigos de saída: sucesso, erro de entrada/compilação e erro de escrita.
- Garantir nome e pasta compatíveis com o sketch Arduino; criar diretório de saída conforme política documentada. Não fazer upload ao dispositivo.
- Ampliar `compile_roboflow` e seu resultado para o alvo Arduino, mantendo API e testes existentes. Documentar como a aplicação consumidora obtém o conteúdo e os diagnósticos.
- A integração com a interface visual deve usar a mesma API e só oferecer download do `.ino` quando a compilação tiver sucesso; entrega na interface depende de integração própria, não apenas da CLI.

## 7. Correspondência com o firmware

Antes de alterar a geração, produzir uma tabela técnica rastreável que mapeie cada constante, estado e função do firmware para campo `.rf`, padrão do perfil ou trecho do runtime. Cobrir ao menos:

1. Credenciais, endereço, CA, NTP, pinos, sentido, PWM, amostras, intervalos e capacidades.
2. `motor`, `mover`, leitura dos sensores, `seguirLinha` e `executarRota`.
3. Estados e fases, `iniciarAcao`, `bloquear`, `falhar` e condições de conclusão.
4. Identificação, eventos, snapshot, confirmação de comandos e controle da fila.
5. Validação e aplicação de `load_route`, `start`, `stop`, `resume` e `abort`.
6. Publicação de pacote, HMAC, HTTPS, handshake, polling, respostas e sincronização entre tarefas.
7. `setup`, `loop`, falhas de inicialização e limites de comunicação.

A comparação deve cobrir comportamento e valores, não exigir que o texto C++ gerado seja idêntico ao arquivo de referência. Qualquer divergência intencional deve ser registrada e validada com teste próprio.

## 8. Testes e validação

| Nível | Verificações necessárias |
|---|---|
| Léxico e parser | Exemplos válidos/inválidos, listas, durações, strings/PEM, fim inesperado, posição dos erros e regressão dos programas `station`. |
| Semântica | Campos ausentes/duplicados/desconhecidos, tipos, GPIOs, conflitos, limites de PWM/tempo/filas, HTTPS sem CA, configurações incompatíveis e ações não suportadas. |
| Gerador | Saída determinística, constantes corretas, escape seguro de strings, ausência de saída em erro, composição do runtime, metadados de versão e isolamento de segredos nos logs. |
| CLI e API | Entrada UTF-8, caminhos, diretórios, erros, códigos de saída, política de sobrescrita e compatibilidade com `cpp` e `python`. |
| Compilação ESP32 | Compilar o sketch gerado com core ESP32 3.x, ArduinoJson 7 e partição No OTA; registrar versões exatas e comando usado. |
| Protocolo e execução simulada | Carregamento/início, F/D/E, término de ação, duplicatas, sessão inválida, expiração, stop/abort prioritários, perda de linha, timeouts, reconciliação, falha de comunicação e limite/reenvio de eventos. Comparar os efeitos com o firmware de referência e os contratos do backend. |
| Bancada e pista | Com rodas suspensas, conferir sentidos e PWM; depois validar sensores, cruzamentos, curvas, parada/retomada, perda de linha, rede e reinicialização no hardware real. Registrar resultados e calibração. |

Automatizar os níveis viáveis no CI, incluindo instalação reproduzível das dependências Arduino quando disponível. Testes automatizados e compilação cruzada não substituem validação física.

## 9. Ordem de implementação e entregas

1. Fechar especificação da linguagem, perfil e limites, incluindo tabela de cobertura do firmware.
2. Separar e versionar o runtime a partir do sketch, mantendo o comportamento e adicionando testes de regressão.
3. Implementar lexer, parser, AST e diagnósticos para a configuração do robô; preservar os programas existentes.
4. Implementar validação semântica e representação normalizada.
5. Gerar sketch único no alvo Arduino e implementar CLI/API.
6. Criar `examples/carrinho_autonomo.rf`, documentação de uso e testes ponta a ponta.
7. Compilar para ESP32, executar testes de protocolo e registrar pendências físicas.
8. Integrar a interface visual e executar bancada/pista conforme disponibilidade do hardware.

Cada etapa deve manter a suíte existente passando e entregar testes proporcionais ao comportamento introduzido. A extensão aceita e documentada para o código-fonte será `.rf`.

## 10. Critérios de aceite

- Um `.rf` de referência, sem credenciais reais versionadas, descreve as configurações do carrinho e seleciona o perfil autônomo.
- O compilador gera um único `.ino` completo, determinístico e sem erros para esse programa; entradas inválidas falham com diagnósticos localizados e sem saída utilizável.
- O sketch gerado compila com as versões de ESP32 e ArduinoJson registradas e mantém os comportamentos e limitações documentados do firmware de referência, verificados por testes automatizados apropriados.
- A API e os exemplos anteriores continuam funcionando; misturas e recursos ainda não suportados são recusados claramente.
- CLI, dependências, configuração de segredos, gravação e limitações estão documentadas.
- O estado dos testes físicos é informado separadamente. A conclusão em software não implica aprovação de bancada ou de pista.

## 11. Implementação inicial disponível

A primeira fatia está implementada no repositório: existe um exemplo em `examples/carrinho_autonomo.rf`, um alvo `arduino` na API `compile_roboflow` e uma CLI instalável via `pip install -e .`. O uso padrão é `roboflow compile examples/carrinho_autonomo.rf`; o sketch é escrito em `build/carrinho_autonomo/carrinho_autonomo.ino`. Também é possível executar `python -m compiler.roboflow compile ...`.

A interface web em `http://localhost:3000/compilador/` conversa com a API local do compilador. Inicie `python -m compiler.roboflow serve` em um terminal e `npm --prefix dashboard run dev -- --host 127.0.0.1` em outro; a página oferece edição/abertura/salvamento de `.rf`, compilação, diagnósticos, visualização e download do `.ino`. A API escuta somente em loopback e aceita chamadas do Vite local.

O gerador atual parte do template versionado em `compiler/roboflow/runtime/carrinho_autonomo.ino.template`, que foi copiado do firmware de referência. Ele injeta identidade, rede, pinos, polaridade, potências, tempos, limites e ações permitidas. Credenciais preenchidas no `.rf` ficam no `.ino` gerado; mantenha os arquivos reais fora do controle de versão. O exemplo contém somente marcadores.

Esta entrega é uma primeira implementação funcional do caminho de geração, não o fechamento de todos os itens deste plano. O parser da configuração e o gerador ainda precisam de cobertura automatizada ampla, validação rigorosa de propriedades/formatos e compilação do sketch contra o core ESP32/ArduinoJson declarado. A lista `actions` agora limita os comandos de rota aceitos pelo firmware. A gramática de estações existente continua separada e compatível por inferência do tipo de programa.
