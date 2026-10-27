# Pendências de hardware

Tudo que o firmware **não consegue decidir sozinho** porque depende de medição ou de uma decisão física. Cada item diz como medir e qual resultado fecha a pendência. Fonte do hardware: [`../ARQUITETURA_DOS_COMPONENTES.md`](../ARQUITETURA_DOS_COMPONENTES.md) (inclui o infravermelho adicional no GPIO 35, acrescentado depois dos demais documentos) e [`../O_QUE_O_ROBO_FAZ.md`](../O_QUE_O_ROBO_FAZ.md).

Nenhum número desta página foi medido ainda. Os "critérios" são metas propostas; ajuste-os ao protótipo e registre o valor real.

## 1. Identificação dos componentes

| Pendência | Como resolver | Fecha quando |
|---|---|---|
| Variante exata da placa ESP32 | Ler a inscrição do módulo e o chip no `esptool chip_id`; conferir GPIOs expostos | Pinagem de [FIRMWARE_ESP32.md](FIRMWARE_ESP32.md) confirmada na placa real |
| Esquema da ponte HW-095 (confirmar CI L298N, jumpers, bornes) | Inspeção e foto do verso | Jumper 5V-EN e ENA/ENB conferidos |
| Motores (tensão nominal, corrente, redução) | Ler etiqueta; medir corrente de partida e travada | Valores anotados |
| Tipo de saída dos sensores de linha (digital/analógica, nível) | Medir o nível alto no pino com multímetro antes de ligar | Nunca mais que 3,3 V no GPIO |
| Capacidade real do power bank | Teste de carga (ver §9) | Autonomia e corte automático medidos |

## 2. Sensores de linha (esquerdo 32, central 34, direito 33)

| Pendência | Como medir | Critério |
|---|---|---|
| Polaridade (qual nível é "linha") | Leitura sobre a fita e sobre o piso, 50 amostras de cada | Separação clara; polaridade normalizada no firmware (`1 = linha`) |
| Limiar (se analógico) | Histograma de valores sobre linha e piso, por sensor, com a luz do ambiente real | Margem ≥ 30 % da faixa entre as duas populações |
| Altura e espaçamento dos sensores | Variar a altura (3 a 10 mm); registrar leitura | Detecção estável da fita na largura usada |
| GPIO 34 sem pull-up/pull-down interno | Verificar que o módulo dirige os dois níveis, ou colocar polarização externa | Sinal definido com o sensor desligado |
| Influência da luz ambiente e do brilho do piso | Repetir em ambiente claro e escuro | Mesma decisão nas duas condições |

## 3. Papel do infravermelho adicional (GPIO 35)

Foi acrescentado ao documento de hardware como "sensor infravermelho adicional", GPIO 35 (somente entrada, ADC1, sem resistores internos, máximo 3,3 V). **O papel dele não está definido em nenhum documento.** Decisão necessária da equipe:

| Opção | Efeito no firmware | Efeito no contrato com a nuvem |
|---|---|---|
| Sensor transversal à frente dos três, para antecipar o cruzamento | Melhora a regra de cruzamento (§4) | A telemetria `line` aceita **exatamente 3 bits** (`LineReadingSchema` é uma tupla de 3). Se o quarto valor precisar chegar à nuvem, o contrato muda (responsável: `contracts`) |
| Sensor redundante/central | Validação cruzada da leitura da linha | Nenhum |
| Sensor traseiro (para habilitar a ré no futuro) | Só útil depois de validar a ré (§8) | Nenhum agora |
| Só diagnóstico | Registrar no log local | Nenhum |

Fecha quando: papel escolhido, posição física anotada (distância à frente do sensor central, em cm) e regra de leitura definida.

## 4. Regra de cruzamento com os sensores

Hoje `101` e `111` são só "candidatos"; nenhuma leitura isolada prova um cruzamento (documento de hardware). A confirmação precisa de filtro e rearme.

| Pendência | Como medir | Critério |
|---|---|---|
| Largura da fita, espaçamento entre sensores e padrão real no cruzamento | Passar o carro devagar por um cruzamento gravando as leituras a 100 Hz | Padrão do cruzamento identificado para os dois sentidos |
| Número de amostras estáveis para confirmar (proposto: 4 a 100 Hz) | Variar de 2 a 8 | Zero falsos positivos em linha reta e zero falsos negativos nos cruzamentos |
| Tempo mínimo e distância de rearme (saída do cruzamento) | Medir até o padrão voltar a "linha simples" | Mesmo cruzamento nunca contado duas vezes |
| Taxa de acerto | 30 passagens por cruzamento em cada sentido | 30 de 30 corretas |

## 5. Geometria: sensores em relação ao eixo das rodas

Sem encoder, quando o sensor detecta a faixa transversal o centro do chassi ainda **não** está no centro do cruzamento. Antes de girar em D/E é preciso avançar a distância certa.

| Pendência | Como medir | Critério |
|---|---|---|
| Distância do sensor central ao eixo das rodas (cm) | Régua | Valor registrado |
| Avanço necessário após a detecção para centralizar | Ensaio com PWM fixo e cronômetro, bateria cheia e média | Giro de 90° termina alinhado à linha de saída |
| Diâmetro de giro | Marcar no chão o arco de uma volta | Cabe dentro do cruzamento sem sair da faixa |

## 6. Curvas D/E

| Pendência | Como medir | Critério |
|---|---|---|
| Estratégia: temporizada, por linha, ou mista | Comparar nos dois métodos | 10 de 10 curvas encontram a linha de saída |
| PWM e duração do giro | Variar | Giro estável de 90° ± 10° |
| Fases em que a falta de linha é esperada | Registrar quanto tempo o sensor central fica sem linha durante o giro | Limite por fase definido; fora dele é falha |
| Parada no meio da curva | Interromper a curva (`stop`) e retomar | Recupera a fase com a referência de linha ou exige reposicionamento |

## 7. PWM, velocidade e distância de parada

Não há medição de velocidade. O PWM é nível de acionamento, não m/s.

| Pendência | Como medir | Critério |
|---|---|---|
| PWM mínimo de partida (zona morta) e PWM de cruzeiro seguro | Aumentar o PWM até o carro andar; repetir com bateria cheia e baixa | Faixa de operação registrada |
| Tempo por segmento em PWM de cruzeiro | Cronômetro, 10 repetições | Variação aceitável (ex.: ±15 %); define o *timeout* de ação |
| **Distância de parada** | Aproximar o carro de um alvo plano em PWM de cruzeiro, medir com régua a distância percorrida após o veto | **Distância de parada + margem < distância de detecção** (limite de 20 cm mais o recuo do sensor). Se não for, reduzir PWM ou aumentar o limite |
| Latência total do veto | Medir: período de aquisição (70 ms), idade máxima aceita (200 ms), período do controle (10 ms) | O pior caso entra na conta da distância de parada. Não prometer veto em 20 ms |

Fórmula do documento de hardware: `distância_limite ≥ velocidade_máx × latência_total + distância_de_desaceleração_medida + margem`.

## 8. Marcha à ré (`T`)

Desabilitada no POC (`supportsReverse:false`; o firmware rejeita `T`). Habilitar exige: cobertura de obstáculos atrás (sensor traseiro), seguidor de linha validado em ré, e a decisão sobre o papel do infravermelho do GPIO 35. Critério para habilitar: 10 de 10 trechos de ré terminando no cruzamento correto, com veto traseiro verificado.

## 9. Alimentação

| Pendência | Como medir | Critério |
|---|---|---|
| Queda de tensão do L298N | Multímetro nos bornes do motor sob carga | Tensão no motor suficiente para partir com bateria média |
| Corrente de partida simultânea dos dois motores + ESP32 com Wi-Fi | Alicate amperímetro ou módulo INA219 | Dentro do limite do power bank e dos cabos |
| Corte automático do power bank por baixa corrente | Deixar o carro parado (só ESP32 e Wi-Fi em poll de 30 s) por 30 min | O power bank **não** desliga; senão, usar modo de corrente baixa ou uma carga auxiliar |
| Reinício por queda de tensão (brownout) | Dez partidas seguidas dos dois motores; registrar `esp_reset_reason()` a cada boot | Zero reinícios. Se houver, adicionar capacitores e revisar a distribuição |
| Autonomia | Cronometrar em operação com poll | ≥ 30 min de missão contínua |

Registre o motivo do último reset no `hello`/`fault` (`BOOT_REASON`) para diferenciar falta de energia de falha de software.

## 10. Wi-Fi

| Pendência | Como medir | Critério |
|---|---|---|
| Cobertura em toda a pista | Registrar RSSI em cada cruzamento e curva | RSSI ≥ −75 dBm em toda a pista |
| Interferência dos motores | Comparar perdas de pacote com motores desligados e ligados | Sem aumento perceptível de falhas de requisição |
| Consumo com o rádio ligado | Medir com e sem *modem sleep* | Autonomia (§9) mantida |
| Rede da bancada | Verificar UDP 123 (NTP) e HTTPS 443 liberados, sem portal cativo e sem isolamento de clientes | Use o ponto de acesso do celular se a rede do local não permitir |
| Banda | Apenas 2,4 GHz | — |

## 11. Grade física e mapa cadastrado

O mapa semeado no backend (`pista-1`) tem **5 colunas × 4 linhas** (outros: `pista-2`, `pista-3` com a mesma dimensão; `pista-4` com 4 × 4). Os mapas do seed são de demonstração.

| Pendência | Como resolver | Fecha quando |
|---|---|---|
| Dimensões reais da grade (espaçamento, largura da fita) | Medir e desenhar | Mapa cadastrado corresponde à pista física (nós, arestas, bloqueios, estações) |
| Origem e orientação inicial | Marcar no chão o cruzamento e o rumo de partida | O operador consegue posicionar o carro sem dúvida |
| Convenção de coordenadas | ADR 0004: origem no canto superior esquerdo, `y` cresce para baixo, N = (0, −1) | A marcação física segue a mesma convenção |
| `deviceId` do carrinho físico | Decidir entre `RB-01` a `RB-04` | Registrado no README |

## 12. Segurança física

| Pendência | Como resolver |
|---|---|
| Chave de alimentação acessível | Instalar e testar |
| Pull-downs de 10 kΩ em ENA e ENB | Instalar e verificar com o osciloscópio ou o multímetro que o carro não se move no reset |
| Divisor de tensão do ECHO (10 kΩ e 15 kΩ) | Conferir 3,0 V no GPIO 19 |
| Rodas suspensas em todo teste novo de firmware | Calço padronizado |
| Barreiras e obstáculos de espuma para a pista | Providenciar |

## 13. Medições do firmware (não são hardware, mas dependem da placa)

Registrar na primeira bancada: tamanho do binário, pico de heap no TLS, heap mínimo em operação, número de conexões TLS novas por hora, latência de `stop` remoto. Ver [PLANO_DE_BANCADA.md](PLANO_DE_BANCADA.md) §6.
