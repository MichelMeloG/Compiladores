# O que o robô faz — RoboFlow

Atualizado em 21/10/2026. Para componentes, pinagem, alimentação e montagem, consulte [Arquitetura dos componentes](ARQUITETURA_DOS_COMPONENTES.md).

## 1. Objetivo

O RoboFlow é um carrinho seguidor de linha de pequeno porte, desenvolvido para a disciplina de Compiladores. Sua função é percorrer uma trilha no chão, corrigir a direção com dois motores e parar quando detectar um obstáculo à frente. A linguagem RoboFlow permite descrever comportamentos de uma missão, como parar em uma estação e aguardar uma liberação.

Esta documentação define a configuração atual de referência: ESP32 clássico, ponte H HW-095 baseada em L298N, dois motores DC, três sensores de linha e um ultrassônico frontal HC-SR04, alimentados a partir de um power bank de 5 V. A montagem física e o modelo exato de cada módulo precisam ser conferidos antes de energizar.

## 2. Como o carrinho se movimenta

Os sensores infravermelhos esquerdo, central e direito ficam sob a frente do chassi. Eles detectam o contraste entre a linha e o piso. O ESP32 lê os três sinais e ajusta separadamente a velocidade das rodas:

| Situação | Comportamento esperado |
|---|---|
| Linha sob o sensor central | Avançar com velocidades próximas nas duas rodas |
| Linha deslocada para a esquerda | Corrigir para a esquerda, reduzindo a roda esquerda em relação à direita |
| Linha deslocada para a direita | Corrigir para a direita, reduzindo a roda direita em relação à esquerda |
| Nenhum sensor reconhece a linha | Parar e aguardar recuperação e liberação |
| Vários sensores reconhecem a linha | Tratar como faixa larga ou cruzamento; parar se não houver regra validada |

É necessário calibrar quais níveis elétricos representam linha e piso. A inversão de polaridade de um motor também altera o sentido físico e deve ser corrigida na montagem ou no driver.

O carrinho usa direção diferencial: faz curvas pela diferença de velocidade das rodas. A configuração de referência não requer servo de direção, câmera ou Raspberry Pi.

### 2.1 Pista em grade e execução da rota

A pista será uma grade de linhas e colunas no chão. Cada cruzamento representa uma coordenada lógica `(x,y)`; cada segmento conecta dois cruzamentos vizinhos. Não há leitura de velocidade ou de posição absoluta. O PWM define o acionamento dos motores.

O operador posiciona o carrinho em um cruzamento com orientação conhecida e seleciona uma rota na dashboard. O backend transforma os pontos da rota em uma fila de ações, enviada ao ESP32:

| Comando | Significado |
|---|---|
| F | Seguir em frente até o próximo cruzamento |
| D | Virar à direita no cruzamento atual e avançar até o próximo |
| E | Virar à esquerda no cruzamento atual e avançar até o próximo |
| T | Ir de ré até o próximo cruzamento atrás, mantendo a orientação do chassi |

Cada comando corresponde a um segmento. D/E já incluem o avanço; não precisam de F adicional. T tem significado definido, mas sua execução continua dependendo de validação física: o protótipo não possui sensor de distância traseiro e o MVP proposto mantém essa capacidade desabilitada.

O ESP32 deve distinguir saída do cruzamento atual e chegada ao seguinte para contar cada cruzamento uma única vez. A regra de reconhecimento pelos três sensores e o alinhamento para curvas ainda serão implementados e calibrados. Não é necessário parar em todo cruzamento intermediário, mas o fim da fila desabilita os motores.

Como cruzamentos iguais não informam seus nomes ou coordenadas, a posição é acompanhada pela referência inicial e pelas ações confirmadas. Se perder essa referência, o carrinho para e precisa de reposicionamento confirmado. Ver [plano do backend](PLANO_BACKEND_ROBOFLOW.md), seções 4 e 5.

## 3. Como evita obstáculos

O HC-SR04 fica centralizado na frente do carrinho e mede a distância por ultrassom. O ESP32 deve verificar essa informação mesmo enquanto executa uma curva, aguarda um evento ou segue a linha.

Política inicial de operação, ainda sujeita a testes na pista:

1. Iniciar com os motores desabilitados.
2. Permitir movimento somente com leituras válidas, linha reconhecida e liberação de início.
3. Ao medir distância menor ou igual a **20 cm**, desabilitar os dois motores.
4. Manter a parada diante de medição inválida, vencida ou falha do sensor.
5. Considerar o caminho liberado após três medições válidas consecutivas a pelo menos **25 cm**.
6. Retomar somente após nova liberação explícita e confirmação de todas as condições.

Os limites de 20 e 25 cm são parâmetros propostos, não uma distância de frenagem comprovada. Devem aumentar se a velocidade, a inércia ou o tempo de reação exigirem. Desabilitar a ponte H permite que as rodas desacelerem por inércia; isso não significa parada instantânea.

O robô **para e espera**: o HC-SR04 não fornece um mapa e não implementa desvio autônomo. Objetos estreitos, inclinados ou que absorvem som podem não ser detectados. Trata-se de prevenção de colisão para um protótipo supervisionado, sem garantia de proteção de pessoas.

## 4. Relação com a disciplina de Compiladores

A linguagem RoboFlow usa arquivos `.rf` para declarar ações associadas a estações. Exemplo:

```text
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
    }
}
```

O comportamento pretendido é parar na estação de carga, aguardar a liberação e continuar. Se a espera vencer, a política definida para o runtime é permanecer parado e registrar a falha. O ultrassônico tem prioridade sobre qualquer comando de movimento.

**Situação do código:** o repositório contém analisador léxico, analisador sintático e construção de AST. Ainda é necessário implementar e integrar análise semântica, geração C++ e firmware. Reconhecer o programa sintaticamente não faz o robô executá-lo.

A origem dos sinais, como `carga_completa`, ainda depende de implementação. Os sensores reconhecem o avanço por cruzamentos da grade, mas não leem nomes de estações: o backend associa a posição lógica acompanhada às estações cadastradas. Não há leitor RFID na configuração definida aqui.

## 5. Sequência de uma utilização

1. Com a alimentação desligada, conferir os cabos e as tensões previstas na arquitetura.
2. Gravar um firmware compatível e testar com as rodas suspensas.
3. Ajustar sensores para a linha e o piso reais.
4. Colocar o carrinho sobre a linha e liberar o início.
5. Acompanhar o seguimento e a parada por obstáculo em baixa velocidade.
6. Retirar o obstáculo, confirmar distância e linha e liberar novamente.
7. Ao finalizar a missão, desabilitar os motores e desligar a alimentação.

## 6. Monitoramento

O projeto também possui uma interface web em `dashboard/`, feita em React e TypeScript. Ela apresenta missões, eventos, alertas e métricas. O código oferece integração HTTP e um modo de demonstração ativado por `VITE_DEMO=true`.

Para apresentar dados do carrinho real, ainda é necessário implementar o transporte da telemetria do ESP32 para um backend e integrar esse backend à interface. O modo de demonstração não comprova comunicação com o robô. O backend planeja a rota e envia a fila; o seguimento de linha, a execução e as paradas ficam no ESP32. A dashboard também permite selecionar a rota e solicitar liberação explícita, sempre sujeita à validação local. Avisos serão visuais na dashboard, sem exigir buzzer ou LEDs externos.

## 7. O que está definido e o que falta validar

| Item | Situação |
|---|---|
| Lexer, parser, AST e exemplos `.rf` | Presentes no repositório |
| Dashboard e serviços HTTP | Presentes; integração física não comprovada |
| Pinagem atualizada e HC-SR04 | Definidos na documentação de arquitetura |
| Firmware de motores, linha e ultrassom | Não localizado no repositório; implementação e teste pendentes |
| Geração C++ e execução de missões | Planejadas; não implementadas no compilador atual |
| Pista e significado das ações | Grade definida; cada ação termina no próximo cruzamento |
| Detecção de cruzamentos e localização lógica | Implementação e calibração pendentes; origem/orientação conhecidas |
| Liberação externa | Solicitação na dashboard via backend, validada no ESP32; integração pendente |
| Corrente disponível, autonomia e distância de parada | Dependem de medição no carrinho |

O primeiro resultado físico a validar é seguir a linha e parar diante de obstáculos. Depois vêm os comportamentos compilados e o monitoramento integrado.
