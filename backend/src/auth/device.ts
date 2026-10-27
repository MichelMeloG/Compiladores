import type { FastifyRequest } from 'fastify';
import { verifyRequest } from '@roboflow/contracts/signing';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { DeviceAuth } from '../services/device.js';
import type { RobotDoc } from '../domain/types.js';

type Failure = Extract<ReturnType<typeof verifyRequest>, { ok: false }>;

/**
 * Autenticação HMAC do dispositivo (ADR 0005, `@roboflow/contracts/signing`).
 *
 * Anti-replay: janela de relógio + `X-Sequence` estritamente crescente por
 * sessão. A última sequência vive em memória da instância e, ao cair numa
 * instância fria, é recuperada de `robot.lastRequestSeq` (persistida em hello
 * e eventos). Um polling repetido dentro da janela é inofensivo (leitura).
 */
export class DeviceAuthenticator {
  private readonly lastSeq = new Map<string, number>();

  constructor(
    private readonly secrets: Config['deviceSecrets'],
    private readonly skewMs: number,
    private readonly now: () => Date,
  ) {}

  hasDevice(deviceId: string): boolean {
    return Object.hasOwn(this.secrets, deviceId);
  }

  /** Lê o deviceId cru do cabeçalho (ainda NÃO autenticado) para carregar o robô. */
  static claimedDeviceId(req: FastifyRequest): string | undefined {
    const v = req.headers['x-device-id'];
    return Array.isArray(v) ? v[0] : v;
  }

  verify(req: FastifyRequest, robot: RobotDoc | undefined, rawBody: string): DeviceAuth {
    const deviceId = DeviceAuthenticator.claimedDeviceId(req);
    // Mesma resposta para dispositivo desconhecido e assinatura inválida (sem enumeração).
    const invalid = new AppError('SIGNATURE_INVALID', 'Assinatura inválida.');
    if (!deviceId || !robot || !this.hasDevice(deviceId)) throw invalid;

    const sessionId = String(req.headers['x-session-id'] ?? '');
    // O sessionId compõe IDs de documentos (deviceEvents): só caracteres seguros.
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw invalid;
    const key = `${deviceId}|${sessionId}`;
    const lastAccepted =
      this.lastSeq.get(key) ?? (robot.sessionId === sessionId ? robot.lastRequestSeq : undefined);

    let failure: Failure | undefined;
    for (const secret of this.secrets[deviceId] ?? []) {
      const r = verifyRequest({
        method: req.method,
        path: req.raw.url ?? req.url,
        headers: req.headers,
        body: rawBody,
        secret,
        nowSeconds: Math.floor(this.now().getTime() / 1000),
        toleranceSeconds: Math.floor(this.skewMs / 1000),
        ...(lastAccepted !== undefined ? { lastAcceptedSequence: lastAccepted } : {}),
      });
      if (r.ok) {
        this.lastSeq.set(key, Math.max(r.sequence, this.lastSeq.get(key) ?? -1));
        if (this.lastSeq.size > 2000) this.lastSeq.delete(this.lastSeq.keys().next().value as string);
        return {
          deviceId: r.deviceId,
          sessionId: r.sessionId,
          sequence: r.sequence,
          timestamp: Number(req.headers['x-timestamp']),
        };
      }
      // Prefere o erro mais informativo (relógio/replay indicam segredo correto).
      if (!failure || failure.error === 'SIGNATURE_INVALID') failure = r;
    }
    if (failure && failure.error !== 'SIGNATURE_INVALID') {
      throw new AppError(failure.error, failure.message);
    }
    throw invalid;
  }
}
