/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Modelos de FORMATO para arquivos de telemetria do carrinho.
 *
 * Estes arquivos não são dados operacionais e nunca alimentam o dashboard:
 * servem apenas como referência de estrutura para quem está implementando
 * a exportação de logs no sistema embarcado ou no backend.
 *
 * Os valores são marcadores sintéticos (prefixo `EXEMPLO-`) justamente para
 * que não sejam confundidos com registros reais caso alguém os importe.
 *
 * Campos obrigatórios: `timestamp`, `missionId`, `eventType`, `message`.
 * Variações de nome aceitas pelo parser: ver BACKEND_INTEGRATION.md §4.
 */

export const LOG_FORMAT_TEMPLATE_JSON = JSON.stringify(
  [
    {
      id: 'EXEMPLO-evt-1',
      missionId: 'EXEMPLO-001',
      timestamp: '2026-01-01T08:00:00.000Z',
      eventType: 'mission_start',
      command: 'INIT "Ponto A"',
      roverState: 'idle',
      severity: 'info',
      message: 'Descrição livre do evento registrado pelo carrinho',
    },
    {
      id: 'EXEMPLO-evt-2',
      missionId: 'EXEMPLO-001',
      timestamp: '2026-01-01T08:01:30.000Z',
      eventType: 'destination_reached',
      command: 'ARRIVE "Ponto B"',
      roverState: 'completed',
      severity: 'info',
      message: 'Descrição livre do evento registrado pelo carrinho',
    },
  ],
  null,
  2
);

export const LOG_FORMAT_TEMPLATE_CSV = [
  'id,missionId,timestamp,eventType,command,roverState,severity,message',
  'EXEMPLO-evt-1,EXEMPLO-001,2026-01-01T08:00:00.000Z,mission_start,"INIT ""Ponto A""",idle,info,Descrição livre do evento',
  'EXEMPLO-evt-2,EXEMPLO-001,2026-01-01T08:01:30.000Z,destination_reached,"ARRIVE ""Ponto B""",completed,info,Descrição livre do evento',
].join('\n');
