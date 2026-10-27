# Teste de bancada por Wi-Fi: sensores e motores

O sketch [`teste_wifi.ino`](../../firmware/teste_wifi/teste_wifi.ino) é independente do firmware de missão e do backend. Ele cria um ponto de acesso Wi-Fi no ESP32, mostra os quatro sensores de linha e oferece comandos manuais momentâneos para testar as duas rodas dianteiras. **Não faz seguimento de linha nem executa rotas.**

## Ligações esperadas

Use somente se os módulos e a placa corresponderem ao hardware da bancada. Os números são GPIOs:

| Sinal | GPIO ESP32 |
|---|---:|
| L298N ENA / IN1 / IN2 | 25 / 26 / 27 |
| L298N IN3 / IN4 / ENB | 14 / 23 / 13 |
| Sensores de linha 1–4 | 32 / 34 / 33 / 35 |
| HC-SR04 TRIG / ECHO | 18 / 19 |

O sketch pressupõe **dois motores**, um motor para cada roda dianteira, ligados separadamente aos dois canais do L298N; as rodas traseiras ficam livres. Não ligue quatro motores em paralelo sem verificar a corrente de partida admissível da ponte H. Se o motor girar ao contrário, ajuste `LEFT_MOTOR_INVERTED` ou `RIGHT_MOTOR_INVERTED` no sketch.

Antes de alimentar:

- Confirme que é um ESP32 clássico compatível com esta pinagem.
- Não aplique mais que **3,3 V** a nenhum GPIO. A saída ECHO do HC-SR04 deve passar por divisor/conversor de nível antes do GPIO 19.
- Garanta GND comum entre ESP32, sensores e L298N; confira a alimentação e o jumper 5V-EN da ponte conforme o módulo real.
- Para o primeiro teste, suspenda as rodas ou mantenha o chassi apoiado de modo que ele não possa sair andando. Tenha a alimentação dos motores/chave de emergência ao alcance.
- Instale pull-downs de 10 kΩ em ENA/ENB, conforme o projeto, para manter os motores desabilitados durante reset.

## Gravar e usar

1. Abra `firmware/teste_wifi/teste_wifi.ino` na Arduino IDE, selecione a placa ESP32 correta e grave.
2. Conecte o celular/computador à rede `RoboFlow-Teste`, senha `RoboFlow32`, e abra `http://192.168.4.1`.
3. Na página, confira as leituras ADC e HIGH/LOW dos quatro GPIOs. A saída ADC ajuda a avaliar módulos analógicos; a indicação HIGH/LOW ajuda nos módulos digitais. O sketch não supõe qual nível representa a faixa.
4. Mantenha um botão de direção pressionado para mover para frente ou girar; solte para parar. Use `PARAR` para interromper. A marcha à ré está desabilitada porque não há sensor traseiro.

## Limites e segurança do teste

- O HC-SR04 é um veto local: movimento só é aceito com eco válido e recente; para a primeira liberação, são necessárias três leituras acima de 25 cm. A leitura a 20 cm ou menos, falta de eco, leitura vencida ou perda do comando Wi-Fi param os motores.
- O HC-SR04 é frontal: ele não protege a traseira nem toda a área varrida ao girar. Por isso a ré está desabilitada e os giros devem ser testados em espaço livre, preferencialmente com as rodas suspensas.
- O limite de 20 cm e a lógica são apenas uma barreira de bancada, **não uma garantia contra colisão**. O HC-SR04 pode falhar com superfícies inclinadas, pequenas, macias ou fora do cone; a distância de parada real não foi medida. Use baixa velocidade, rodas suspensas e parada física acessível.
- O PWM inicial é 120/255 (`MOTOR_PWM`). Ajuste somente com as rodas suspensas e depois de verificar que o conjunto motor/ponte/fonte é compatível.
- GPIO 34 e 35 não têm pull-up/pull-down interno. Cada módulo deve dirigir níveis definidos, e as saídas devem ser compatíveis com 3,3 V. Para entrada analógica, ligue AO; para digital, ligue DO.
- A rede é um AP local com senha de teste fixa no sketch. Troque `AP_PASSWORD` se outras pessoas puderem alcançar o carrinho.
- Este sketch não implementa TLS, nuvem, watchdog de hardware nem a lógica de missão do firmware planejado; não o use como firmware de operação.
