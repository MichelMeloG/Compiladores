# Plano de integração: carrinho na bateria, dashboard e rotas

Data: 03/11/2026. Status: integração implementada em software; calibração e
validação física pendentes. O guia operacional é
[`firmware/carrinho_autonomo/README.md`](../firmware/carrinho_autonomo/README.md).

## Objetivo confirmado

Iniciar, parar, retomar e cancelar pela dashboard, além de carregar e executar
rotas com decisões nos cruzamentos. O carrinho usa bateria, Wi-Fi e nenhum botão
físico para operar. O controle dos motores e as correções de linha ficam no ESP32.

Isso exige mudanças no firmware, no backend e na dashboard. Alterar somente o
backend não conecta o sketch autônomo atual, que não contém comunicação de rede.

## Diagnóstico anterior à implementação

- `firmware/carrinho_autonomo/carrinho_autonomo.ino`: partida automática após 3 s,
  filtro de três leituras, correções suaves/fortes, parada nos cruzamentos, sem rede.
- `backend/src/services/sensor-control.ts`: calcula PWM e progresso no servidor;
  atende o firmware original por `POST /device/sensors`.
- `backend/src/services/device.ts` e `operator.ts`: já implementam sessões,
  entrega de rotas, comandos, confirmações, eventos e reconciliação.
- `contracts/src/device.ts`: já descreve `hello`, `poll`, `events`, comandos e
  eventos de execução. Esses endpoints usam HMAC; o Bearer de `/device/sensors`
  não serve como autenticação para eles.
- `dashboard/src/pages/RoutePlanner.tsx`: já permite enviar rotas. Falta completar
  o fluxo operacional com os comandos e o acompanhamento real da execução.
- Existem testes e simulador em `backend/test` e `backend/tools/esp-sim`.
- A documentação mistura arquiteturas antigas; deve ser alinhada com a entrega.

## Arquitetura e comportamento pretendidos

Dashboard → backend → rota/comandos por Wi-Fi → ESP32.
ESP32 → confirmações, sensores e progresso → backend → dashboard.

O backend traduz pontos da grade em uma fila de ações. O ESP32 recebe a fila
inteira, corrige a linha localmente e confirma cada trecho pelos sensores.
Uma resposta de rede não é necessária para cada correção dos motores.

Ao ligar, o firmware integrado mantém os motores parados, respeita a espera
inicial de 3 s, conecta e se apresenta. Só começa com rota carregada e `start`
válido. Sem rede no início, permanece parado e tenta conectar sem bloquear os
sensores. Isso substitui a partida automática do exemplo autônomo nesta versão.

Conforme a decisão final, toda a implementação fica no próprio
`firmware/carrinho_autonomo/carrinho_autonomo.ino`, em funções de movimento,
eventos e comunicação. O sketch original `carrinho_simples` permanece separado.
Não introduzir PID, MQTT ou um protocolo novo nesta primeira integração.

## Etapa 1 — Fixar o modo de operação e os contratos

1. Usar o protocolo existente: `POST /device/hello`, `GET /device/poll` e
   `POST /device/events`. Manter `/device/sensors` para o firmware original.
2. Registrar explicitamente qual controlador cada robô utiliza e impedir dois
   protocolos de controlar o mesmo robô durante uma missão. Migração ocorre parado.
3. Declarar versão do firmware, limites de fila/mensagem e `supportsReverse:false`.
   Primeira entrega: ações F, D e E; rejeitar rotas que exijam marcha à ré.
4. Manter identidade, sessão por boot, revisão de rota, sequência e confirmação.
   Eventos repetidos não avançam duas vezes; comandos antigos não reiniciam movimento.
5. Revisar validade dos comandos com relógio/idade da mensagem, além da sessão:
   uma resposta atrasada não pode renovar a validade de `start` ou `resume`.

Entrega: contrato e exemplos compatíveis com simulador, firmware e API.

## Etapa 2 — Adaptar e validar o backend

1. Reaproveitar os serviços de dispositivo e operador; o novo modo não chama
   `handleSensors` para decidir o PWM.
2. Confirmar origem e orientação antes da rota: três sensores não fornecem
   localização absoluta. A posição depois disso é estimada pelos trechos confirmados.
3. Manter os comandos `load_route`, `start`, `stop`, `resume` e `abort`.
   Solicitação aceita pela API fica pendente até a confirmação do ESP32.
4. Atualizar missão, posição e conclusão somente com eventos válidos do dispositivo.
   Não concluir trecho por tempo decorrido ou apenas por enviar um comando.
5. Revisar projeções, alertas de desconexão e mensagens conforme o modo do robô.
   Distinguir último estado conhecido de estado atual confirmado.
6. Ajustar consultas e atualização da telemetria: hoje o poll ativo padrão é
   1500 ms, o ocioso 30000 ms e a gravação de telemetria tem limite de 5000 ms.
   Para bancada local, propor poll ativo de 1500 ms e ocioso de 3000 ms, com
   limites de requisições compatíveis. Medir a atualização visível na dashboard;
   não prometer resposta em 10 ms para comandos remotos.

Entrega: fluxo completo passando pelo simulador antes de usar motores reais.

## Etapa 3 — Implementar o executor local de rotas

1. Reutilizar pinagem, `motor`, `mover`, níveis de potência e filtro existentes.
2. Usar estados explícitos: aguardando rota, pronto, executando, pausado,
   bloqueado e concluído. Apenas o controlador local escreve nos motores.
3. Executar cada ação por fases: alinhar/virar se necessário, sair do cruzamento
   inicial, seguir o trecho e confirmar o próximo cruzamento.
4. Não contar o cruzamento de partida como chegada. Exigir saída confirmada e
   leituras estáveis antes de reconhecer outro cruzamento.
5. D/E escolhem a saída e avançam ao próximo nó conforme o contrato; correção
   suave/forte acompanha a linha entre nós, mas não substitui a curva no cruzamento.
6. Nas curvas, confirmar saída da linha anterior e reencontro da nova. Uma ausência
   breve de linha pode fazer parte da manobra; fora dessa fase provoca bloqueio.
   Limites de tempo detectam falha, nunca confirmam chegada por si só.
7. `stop` interrompe localmente e só então confirma. `abort` interrompe e cancela.
   `resume` exige bloqueio resolvido e fase recuperável; caso contrário, exige
   reposicionamento. Encontrar a linha novamente não retoma sozinho neste modo.
8. Emitir início/fim de ação e parar ao terminar a fila. Distância de obstáculos
   e bateria permanecem indisponíveis: não há leitura desses valores no sketch.

Entrega: rota curta com reta, direita e esquerda executada sem depender da rede
para corrigir a linha. Calibração física continua necessária.

## Etapa 4 — Adicionar comunicação sem bloquear os motores

1. Criar uma tarefa de comunicação separada no ESP32. Ela faz Wi-Fi/HTTP;
   o controle local mantém a espera de 10 ms entre leituras.
2. Trocar comandos e retratos da telemetria por filas limitadas/cópias consistentes.
   A tarefa de rede nunca aciona motores diretamente. Parada/cancelamento têm prioridade.
3. Implementar a autenticação HMAC já exigida, sincronização de relógio para
   as assinaturas e validação TLS quando o servidor usar HTTPS.
4. Guardar eventos críticos até confirmação, retransmitindo com o mesmo ID.
   Telemetria pode ser substituída pela mais recente. Se faltar espaço para eventos
   críticos, interromper de forma controlada e sinalizar falha, sem perder progresso.
5. Reutilizar a política do ADR 0002: após o prazo de comunicação, inicialmente
   30 s, terminar o trecho em andamento e aguardar no próximo cruzamento; perda
   de linha/falha local continua provocando parada antes disso. Um limite local
   para trecho sem cruzamento impede movimento indefinido.
6. Reconectar não retoma sozinho. Reiniciar o ESP32 invalida a fila/sessão anterior
   e exige reconciliação. Uma missão pode ter terminado durante a queda de rede;
   reconciliar com eventos/snapshot, sem repetir o percurso.

Entrega: indisponibilidade HTTP não congela a leitura dos sensores, e reinícios
ou retransmissões não repetem movimentos.

## Etapa 5 — Completar a dashboard

1. Reutilizar o planejador e acrescentar confirmação de origem/orientação e prévia.
2. Adicionar Carregar rota, Iniciar, Parar, Retomar e Cancelar, conforme o estado.
3. Exibir comando pendente, confirmado, rejeitado, expirado ou incerto. Não mostrar
   “parado” apenas porque a API aceitou a solicitação de parada.
4. Exibir nó confirmado, próximo nó, progresso, sensores, motivo de bloqueio,
   conexão e idade dos dados. Posição é estimada; bateria fica sem leitura.
5. Atualizar periodicamente usando as consultas existentes, com tratamento de falhas.
   Usar o backend real, com demonstração desativada no teste de integração.

Entrega: operar pelo navegador sem cabo USB no carrinho. Parada remota está sujeita
à latência e à disponibilidade da rede; o veto imediato dos sensores é local.

## Etapa 6 — Validação e ambiente

Começar com o backend local e armazenamento em memória, cadastro limpo e segredo
do dispositivo configurado. O computador hospeda o servidor, mas não se conecta
por cabo ao carrinho. Para dispensar também esse computador durante a operação,
usar o servidor hospedado já previsto no projeto, com persistência e autenticação;
o ESP32 precisa alcançar esse endereço pela rede Wi-Fi.

Validações exigidas:

- Contratos e backend: compilação, tipos, testes de missão, segurança e regressão
  do modo `/device/sensors`, mais cenários novos do controlador integrado.
- Simulador: rota F/D/E, duplicatas, comandos fora de ordem, stop antes de start
  atrasado, bloqueio/retomada, perda de resposta, reboot e reconciliação.
- Firmware: compilação e verificação das oito combinações dos sensores, filtro,
  saída/chegada ao cruzamento, curvas, interrupção e fim da fila.
- Hardware: rodas suspensas primeiro; depois pista com reta, curvas e cruzamentos,
  alimentado somente por bateria. Medir ciclo local e tempo de parada remota.
- Rede: desconectar Wi-Fi e reiniciar backend/ESP32 em cada fase relevante.
- Dashboard: não antecipar confirmação nem apresentar dados antigos como atuais.

Critério de conclusão: selecionar uma rota, carregá-la, iniciar, acompanhar os
trechos confirmados, parar/retomar/cancelar e concluir no destino, tudo via Wi-Fi,
sem USB e com recuperação previsível de falhas. Atualizar os READMEs e documentos
de arquitetura para distinguir os três firmwares e registrar as limitações medidas.

Ordem de execução: contratos e simulador → ajustes do backend → executor e rede
no firmware → controles da dashboard → integração física e calibração.
