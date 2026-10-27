import {
  DEFAULT_CAPABILITIES,
  isInsideGrid,
  blockedSet,
  nodeId,
  translateRoute,
  type Command,
  type ControlAccepted,
  type ControlRequest,
  type DeviceCommand,
  type Heading,
  type RoutePreview,
  type RouteSubmitRequest,
  type RouteSubmitResult,
  type RouteError,
  publicMissionStatus,
} from '@roboflow/contracts';
import { AppError, notFound, conflictState, deviceUnavailable } from '../errors.js';
import { isTerminal, tryTransition } from '../domain/mission.js';
import type { CommandDoc, MapDoc, MissionDoc, RobotDoc, RouteDoc } from '../domain/types.js';
import { addDays } from './common.js';
import { nextId } from './ids.js';
import { loadMap } from './maps.js';
import { C } from '../store/types.js';
import {
  addPending,
  emitEvent,
  isOnline,
  iso,
  removePending,
  withIdempotency,
  type Deps,
} from './common.js';
import { finishMission, markUncertain } from './lifecycle.js';

/** Operador autenticado (preenchido pelo middleware de auth). */
export interface Operator {
  uid: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
}

export type ControlKind = 'start' | 'stop' | 'resume' | 'abort';

const GEOMETRY_CODES = new Set([
  'ROUTE_TOO_SHORT',
  'NODE_INVALID',
  'NODE_OUT_OF_GRID',
  'NODE_BLOCKED',
  'NODE_REPEATED',
  'STEP_DIAGONAL',
  'STEP_JUMP',
  'EDGE_CLOSED',
  'HEADING_INVALID',
]);

async function loadRobotAndMap(deps: Deps, robotId: string) {
  const robot = await deps.store.get<RobotDoc>(C.robots, robotId);
  if (!robot) throw notFound(`Robô ${robotId} não encontrado.`);
  const map = await loadMap(deps, deps.store, robot.mapId, robot.mapVersion);
  return { robot, map };
}

function stationLabel(map: MapDoc, p: { x: number; y: number }): string {
  const hit = map.points?.find((q) => q.x === p.x && q.y === p.y && q.kind === 'station' && q.label);
  return hit?.label ?? nodeId(p);
}

// ---------------------------------------------------------------------------
// Prévia (não reserva o dispositivo)
// ---------------------------------------------------------------------------

export async function previewRoute(
  deps: Deps,
  robotId: string,
  body: { waypoints: { x: number; y: number }[]; initialHeading?: Heading; mapVersion?: number },
): Promise<RoutePreview> {
  const { robot, map } = await loadRobotAndMap(deps, robotId);
  if (body.mapVersion !== undefined && body.mapVersion !== robot.mapVersion) {
    throw conflictState(`Versão do mapa desatualizada: o robô usa a v${robot.mapVersion}.`);
  }
  const heading = body.initialHeading ?? robot.heading ?? undefined;
  if (!heading) {
    throw new AppError('HEADING_REQUIRED', 'Informe o rumo inicial do chassi (N, E, S ou W).');
  }
  const t = translateRoute(map, body.waypoints, heading, robot.capabilities ?? DEFAULT_CAPABILITIES);
  const first = body.waypoints[0];
  return {
    robotId,
    mapId: robot.mapId,
    mapVersion: robot.mapVersion,
    waypoints: body.waypoints,
    actions: t.actions,
    expectedNodes: t.expectedNodes,
    initialHeading: t.initialHeading,
    finalHeading: t.finalHeading,
    executable: t.executable,
    errors: t.errors,
    startMismatch: first ? robot.currentPoint !== nodeId(first) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Envio da rota: cria a missão e registra o carregamento (NÃO inicia o motor)
// ---------------------------------------------------------------------------

export async function submitRoute(
  deps: Deps,
  robotId: string,
  body: RouteSubmitRequest,
  op: Operator,
  idemKey: string,
): Promise<{ status: number; body: RouteSubmitResult }> {
  const now = deps.clock();
  const nowIso = iso(now);

  const refuse = (message: string, extra: Partial<RouteSubmitResult> = {}) => ({
    status: 200,
    body: { routeId: '', accepted: false, waypointCount: body.waypoints.length, message, ...extra } as RouteSubmitResult,
  });

  const res = await deps.store.runTransaction(async (tx) => {
    return withIdempotency(
      tx,
      `route:${op.uid}:${robotId}`,
      idemKey,
      body,
      now,
      async () => {
        const robot = await tx.get<RobotDoc>(C.robots, robotId);
        if (!robot) throw notFound(`Robô ${robotId} não encontrado.`);
        const map = await loadMap(deps, tx, robot.mapId, robot.mapVersion);

        const heading = body.initialHeading ?? robot.heading ?? undefined;
        if (!heading) {
          throw new AppError('HEADING_REQUIRED', 'Informe o rumo inicial do chassi (N, E, S ou W).');
        }

        // Geometria/forma inválida => 422. Capacidade/estado => recusa de negócio (200).
        const caps = robot.capabilities ?? DEFAULT_CAPABILITIES;
        const t = translateRoute(map, body.waypoints, heading, caps);
        const geometry = t.errors.filter((e: RouteError) => GEOMETRY_CODES.has(e.code));
        if (geometry.length > 0) {
          throw new AppError('ROUTE_INVALID', geometry[0]?.message ?? 'Rota inválida.', { errors: geometry });
        }

        // Capacidade (ré sem suporte, fila longa demais) é propriedade da rota + dispositivo,
        // não do estado do momento: 422, e nunca se substitui `T` por outra manobra.
        const capability = t.errors.filter((e: RouteError) => !GEOMETRY_CODES.has(e.code));
        if (capability.length > 0) {
          throw new AppError('CAPABILITY_UNSUPPORTED', capability[0]?.message ?? 'Rota fora da capacidade do dispositivo.', {
            errors: capability,
            actions: t.actions,
          });
        }

        if (body.mapVersion !== undefined && body.mapVersion !== robot.mapVersion) {
          return refuse(`Versão do mapa desatualizada: o robô usa a v${robot.mapVersion}.`);
        }
        if (!isOnline(robot, now, deps.cfg)) {
          return refuse('O robô está offline; a rota não foi enviada.');
        }
        if (robot.maintenance) return refuse('O robô está em manutenção.');
        if (robot.activeMissionId) {
          return refuse(`O robô já executa ou aguarda a missão ${robot.activeMissionId}.`);
        }
        if (!t.executable) {
          return refuse(t.errors[0]?.message ?? 'A rota não é executável por este dispositivo.', { errors: t.errors, actions: t.actions });
        }
        const start = body.waypoints[0] as { x: number; y: number };
        // O primeiro waypoint é a posição DECLARADA pelo operador (README §4: o backend não
        // presume que o robô está onde a missão anterior terminou). Divergência da última
        // posição conhecida é registrada; no modo estrito (REQUIRE_CONFIRMED_POSITION) é recusada.
        const declared = nodeId(start);
        const mismatch = robot.currentPoint !== declared;
        if (deps.cfg.requireConfirmedPosition) {
          if (robot.currentPoint === null || robot.positionConfidence === 'unknown') {
            return refuse('A posição do robô é desconhecida. Confirme o cruzamento e o rumo antes de enviar a rota.');
          }
          if (mismatch) {
            return refuse(
              `A rota começa em (${start.x}, ${start.y}), mas o robô está em (${robot.currentPoint.replace(',', ', ')}). Reposicione ou confirme a posição.`,
            );
          }
        }
        const previousPoint = robot.currentPoint;
        const startConfidence = mismatch ? 'confirmed' : robot.positionConfidence; // declarar um nó é confirmá-lo

        const missionId = await nextId(tx, 'mission');
        const routeId = await nextId(tx, 'route');
        const cmdId = await nextId(tx, 'command');
        const last = body.waypoints[body.waypoints.length - 1] as { x: number; y: number };
        const mission: MissionDoc = {
          id: missionId,
          robotId,
          routeId,
          routeRevision: 1,
          origin: stationLabel(map, start),
          destination: stationLabel(map, last),
          state: 'queued',
          status: 'in_progress',
          active: true,
          rolledUp: false,
          mapId: robot.mapId,
          mapVersion: robot.mapVersion,
          waypoints: body.waypoints,
          actions: t.actions,
          expectedNodes: t.expectedNodes,
          initialHeading: heading,
          headingsAfter: t.steps.map((s) => s.headingAfter),
          startNode: nodeId(start),
          totalActions: t.actions.length,
          completedActions: 0,
          lastConfirmedNode: nodeId(start),
          headingAtLastConfirmedNode: heading,
          positionConfidence: startConfidence,
          startedAt: nowIso,
          durationSeconds: null,
          stopCount: 0,
          presenceStopCount: 0,
          otherStopCount: 0,
          unknownStopCount: 0,
          errorCount: 0,
          eventCount: 0,
          eventSeq: 0,
          stopReasons: [],
          currentBlock: null,
          faults: [],
          sessionId: robot.sessionId,
          operatorUid: op.uid,
          updatedAt: nowIso,
        };
        const route: RouteDoc = {
          id: routeId,
          robotId,
          missionId,
          waypoints: body.waypoints,
          actions: t.actions,
          initialHeading: heading,
          mapId: robot.mapId,
          mapVersion: robot.mapVersion,
          createdAt: nowIso,
        };
        const cmd: CommandDoc = {
          id: cmdId,
          type: 'load_route',
          missionId,
          robotId,
          sessionId: null,
          status: 'pending',
          attempts: 0,
          createdAt: nowIso,
          expiresAt: iso(new Date(now.getTime() + deps.cfg.loadCommandTtlMs)),
          operatorUid: op.uid,
          routeRevision: 1,
          expireAt: addDays(now, 8),
        };

        robot.activeMissionId = missionId;
        robot.currentRouteId = routeId;
        robot.currentPoint = declared;
        robot.heading = heading;
        robot.positionConfidence = startConfidence;
        addPending(robot, cmdId);

        emitEvent(
          tx,
          robotId,
          mission,
          {
            eventType: 'mission_start',
            severity: 'info',
            roverState: 'idle',
            command: `INIT "${mission.origin}"`,
            message:
              `Missão criada de ${mission.origin} para ${mission.destination} (${t.actions.length} ações: ${t.actions.join(' ')}).` +
              (mismatch && previousPoint
                ? ` Atenção: posição inicial declarada (${start.x}, ${start.y}) difere da última conhecida (${previousPoint.replace(',', ', ')}).`
                : ''),
            payload: { routeId, commandId: cmdId, actions: t.actions, declaredStart: declared, previousPoint },
          },
          now,
          { source: 'system' },
        );

        tx.create(C.missions, missionId, mission);
        tx.create(C.routes, routeId, route);
        tx.create(C.commands, cmdId, cmd);
        tx.set(C.robots, robotId, robot);

        return {
          status: 201,
          body: {
            routeId,
            accepted: true,
            waypointCount: body.waypoints.length,
            message: 'Rota aceita; a fila será carregada no robô. O movimento só começa após o início.',
            missionId,
            commandId: cmdId,
            actions: t.actions as Command[],
          } as RouteSubmitResult,
        };
      },
    );
  });

  return { status: res.status, body: res.body };
}

// ---------------------------------------------------------------------------
// Controle: start / stop / resume / abort (assíncronos, 202)
// ---------------------------------------------------------------------------

export async function controlMission(
  deps: Deps,
  missionId: string,
  kind: ControlKind,
  body: ControlRequest,
  op: Operator,
  idemKey: string,
): Promise<{ status: number; body: ControlAccepted }> {
  const now = deps.clock();
  const nowIso = iso(now);

  const res = await deps.store.runTransaction(async (tx) =>
    withIdempotency(tx, `ctl:${op.uid}:${missionId}:${kind}`, idemKey, body, now, async () => {
      const m = await tx.get<MissionDoc>(C.missions, missionId);
      if (!m) throw notFound(`Missão ${missionId} não encontrada.`);
      const robot = await tx.get<RobotDoc>(C.robots, m.robotId);
      if (!robot) throw notFound(`Robô ${m.robotId} não encontrado.`);

      if (isTerminal(m.state)) throw conflictState(`A missão já terminou (${m.state}).`);
      if (body.sessionId && robot.sessionId && body.sessionId !== robot.sessionId) {
        throw new AppError('CONFLICT_SESSION', 'A sessão do dispositivo mudou; atualize a tela antes de comandar.');
      }

      const online = isOnline(robot, now, deps.cfg);
      const pendingOfKind = await findPendingOfKind(tx, robot, kind, missionId);
      if (pendingOfKind) {
        throw conflictState(`Já existe um pedido de ${kind} pendente para esta missão (${pendingOfKind.id}).`);
      }

      let blockId: string | undefined;
      let localResolution = false;

      switch (kind) {
        case 'start':
          if (m.state !== 'ready') throw conflictState(`Não é possível iniciar uma missão em ${m.state}.`);
          if (!online) throw deviceUnavailable('Dispositivo sem conexão: o início foi recusado.');
          break;
        case 'resume':
          if (m.state !== 'blocked' && m.state !== 'paused') {
            throw conflictState(`Não é possível retomar uma missão em ${m.state}.`);
          }
          if (m.currentBlock && body.blockId !== m.currentBlock.blockId) {
            throw new AppError('STALE_BLOCK', 'O bloqueio informado não é o atual; a tela está desatualizada.');
          }
          if (!online) throw deviceUnavailable('Dispositivo sem conexão: a retomada foi recusada.');
          blockId = body.blockId;
          break;
        case 'stop':
          if (m.state !== 'running') throw conflictState(`Não é possível parar uma missão em ${m.state}.`);
          break;
        case 'abort':
          if (m.state === 'queued') localResolution = true;
          break;
      }

      const cmdId = await nextId(tx, 'command');
      const cmd: CommandDoc = {
        id: cmdId,
        type: kind,
        missionId,
        robotId: robot.id,
        sessionId: null,
        status: 'pending',
        attempts: 0,
        createdAt: nowIso,
        expiresAt: iso(new Date(now.getTime() + deps.cfg.commandTtlMs)),
        operatorUid: op.uid,
        routeRevision: m.routeRevision,
        expireAt: addDays(now, 8),
        ...(blockId ? { blockId } : {}),
      };

      if (localResolution) {
        // Nada foi entregue ao dispositivo: cancela localmente, sem esperar confirmação.
        for (const pid of [...robot.pendingCommandIds]) {
          const p = await tx.get<CommandDoc>(C.commands, pid);
          if (p && p.status === 'pending' && p.missionId === m.id) {
            p.status = 'expired';
            p.reason = 'CANCELLED_BEFORE_DELIVERY';
            p.resolvedAt = nowIso;
            removePending(robot, pid);
            tx.set(C.commands, pid, p);
          }
        }
        cmd.status = 'accepted';
        cmd.reason = 'LOCAL_CANCEL';
        cmd.resolvedAt = nowIso;
        finishMission(m, robot, 'aborted', now);
        emitEvent(
          tx,
          robot.id,
          m,
          {
            eventType: 'mission_end',
            severity: 'warning',
            roverState: 'idle',
            message: 'Missão cancelada antes de ser enviada ao dispositivo.',
            payload: { commandId: cmdId },
          },
          now,
          { source: 'system' },
        );
      } else {
        addPending(robot, cmdId);
        if ((kind === 'stop' || kind === 'abort') && !online) {
          // Sem conexão: nunca alegar parada confirmada. Registra a intenção e
          // marca o estado físico como incerto até reconciliar.
          m.cancelIntent = kind;
          markUncertain(m, robot, now);
        }
        emitEvent(
          tx,
          robot.id,
          m,
          {
            eventType: 'command',
            severity: online ? 'info' : 'warning',
            command: kind.toUpperCase(),
            message: online
              ? `Pedido de ${LABEL[kind]} registrado; aguardando confirmação do dispositivo.`
              : `Pedido de ${LABEL[kind]} registrado SEM conexão com o dispositivo; estado físico incerto até reconciliar.`,
            payload: { commandId: cmdId, operatorUid: op.uid },
          },
          now,
          { source: 'system' },
        );
      }

      tx.create(C.commands, cmdId, cmd);
      tx.set(C.missions, m.id, m);
      tx.set(C.robots, robot.id, robot);
      return { status: 202, body: { commandId: cmdId, missionId, status: 'pending' as const } };
    }),
  );
  return { status: res.status, body: res.body };
}

const LABEL: Record<ControlKind, string> = {
  start: 'início',
  stop: 'parada',
  resume: 'retomada',
  abort: 'cancelamento',
};

async function findPendingOfKind(
  tx: { get<T extends import('../store/types.js').Doc>(c: import('../store/types.js').Collection, id: string): Promise<T | undefined> },
  robot: RobotDoc,
  kind: ControlKind,
  missionId: string,
): Promise<CommandDoc | undefined> {
  for (const id of robot.pendingCommandIds) {
    const c = await tx.get<CommandDoc>(C.commands, id);
    if (c && c.status === 'pending' && c.type === kind && c.missionId === missionId) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extensões (fora do registro de contratos; ver CONTRACT_GAPS.md)
// ---------------------------------------------------------------------------

/** Operador confirma o cruzamento e o rumo do robô parado (sem missão ativa). */
export async function confirmPosition(
  deps: Deps,
  robotId: string,
  body: { x: number; y: number; heading: Heading },
): Promise<{ currentPoint: string; heading: Heading; positionConfidence: 'confirmed' }> {
  return deps.store.runTransaction(async (tx) => {
    const robot = await tx.get<RobotDoc>(C.robots, robotId);
    if (!robot) throw notFound(`Robô ${robotId} não encontrado.`);
    if (robot.activeMissionId) throw new AppError('DEVICE_BUSY', 'O robô tem missão ativa; não é possível reposicioná-lo.');
    const map = await loadMap(deps, tx, robot.mapId, robot.mapVersion);
    const p = { x: body.x, y: body.y };
    if (!isInsideGrid(p, map) || blockedSet(map).has(nodeId(p))) {
      throw new AppError('ROUTE_INVALID', `(${p.x}, ${p.y}) está fora da malha ou bloqueado.`);
    }
    robot.currentPoint = nodeId(p);
    robot.heading = body.heading;
    robot.positionConfidence = 'confirmed';
    tx.set(C.robots, robot.id, robot);
    return { currentPoint: robot.currentPoint, heading: body.heading, positionConfidence: 'confirmed' as const };
  });
}

/**
 * Encerramento explícito de uma missão `uncertain` (só administrador): libera a
 * reserva SEM confirmação do dispositivo e registra isso. Não inventa
 * `endedAt` nem sucesso.
 */
export async function forceCloseMission(deps: Deps, missionId: string, op: Operator): Promise<{ missionId: string; state: string }> {
  const now = deps.clock();
  return deps.store.runTransaction(async (tx) => {
    const m = await tx.get<MissionDoc>(C.missions, missionId);
    if (!m) throw notFound(`Missão ${missionId} não encontrada.`);
    if (m.state !== 'uncertain') throw conflictState('Só missões com estado incerto podem ser encerradas à força.');
    const robot = await tx.get<RobotDoc>(C.robots, m.robotId);
    if (!robot) throw notFound(`Robô ${m.robotId} não encontrado.`);
    m.closedWithoutConfirmation = true;
    tryTransition(m, 'aborted', iso(now));
    m.endedAt = undefined;
    m.durationSeconds = null;
    // Os comandos pendentes perdem o sentido.
    for (const pid of [...robot.pendingCommandIds]) {
      const c = await tx.get<CommandDoc>(C.commands, pid);
      if (c && c.missionId === m.id && c.status === 'pending') {
        c.status = 'expired';
        c.reason = 'FORCE_CLOSED';
        c.resolvedAt = iso(now);
        tx.set(C.commands, pid, c);
      }
      removePending(robot, pid);
    }
    robot.activeMissionId = null;
    robot.positionConfidence = 'unknown';
    emitEvent(
      tx,
      robot.id,
      m,
      {
        eventType: 'mission_end',
        severity: 'warning',
        roverState: 'unknown',
        message: 'Missão encerrada manualmente SEM confirmação do dispositivo. Reposicione o robô antes da próxima rota.',
        payload: { operatorUid: op.uid, forced: true },
      },
      now,
      { source: 'system' },
    );
    tx.set(C.missions, m.id, m);
    tx.set(C.robots, robot.id, robot);
    return { missionId: m.id, state: m.state };
  });
}

export function toPublicCommand(c: CommandDoc): DeviceCommand {
  return {
    id: c.id,
    type: c.type,
    missionId: c.missionId,
    deviceId: c.robotId,
    ...(c.sessionId ? { sessionId: c.sessionId } : {}),
    status: c.status,
    ...(c.reason ? { reason: c.reason } : {}),
    attempts: c.attempts,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    ...(c.deliveredAt ? { deliveredAt: c.deliveredAt } : {}),
    ...(c.resolvedAt ? { resolvedAt: c.resolvedAt } : {}),
    ...(c.operatorUid ? { operatorUid: c.operatorUid } : {}),
    ...(c.blockId ? { blockId: c.blockId } : {}),
  };
}

export { publicMissionStatus };
