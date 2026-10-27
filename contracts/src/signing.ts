/**
 * Assinatura HMAC-SHA256 das requisições do dispositivo (ADR 0005).
 *
 * Importe de `@roboflow/contracts/signing` (usa `node:crypto`; não serve para
 * o navegador).
 *
 * String a assinar (campos separados por "\n"):
 *   METHOD
 *   PATH_COM_QUERY
 *   X-Timestamp        (epoch em SEGUNDOS, inteiro)
 *   X-Sequence         (contador de REQUISIÇÕES da sessão, crescente)
 *   hex(sha256(corpo)) (corpo vazio => sha256 de "")
 *
 * Cabeçalhos: X-Device-Id, X-Session-Id, X-Sequence, X-Timestamp, X-Signature
 * (hex minúsculo do HMAC com o segredo do dispositivo).
 *
 * Anti-replay: (a) timestamp dentro de `toleranceSeconds`; (b) `X-Sequence`
 * estritamente maior que a última aceita da sessão. O servidor mantém a
 * última sequência em memória por instância e a persiste junto com eventos
 * e `hello` (não a cada poll, por causa da cota de escrita).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ErrorCode } from './common.js';

export const SIGNATURE_HEADERS = {
  deviceId: 'x-device-id',
  sessionId: 'x-session-id',
  sequence: 'x-sequence',
  timestamp: 'x-timestamp',
  signature: 'x-signature',
} as const;

export const DEFAULT_TOLERANCE_SECONDS = 60;

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface SignInput {
  method: string;
  /** Caminho com query, exatamente como enviado (ex.: `/device/poll`). */
  path: string;
  timestamp: number;
  sequence: number;
  body?: string | Uint8Array;
}

export function stringToSign(input: SignInput): string {
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    String(input.sequence),
    sha256Hex(input.body ?? ''),
  ].join('\n');
}

export function sign(secret: string, input: SignInput): string {
  return createHmac('sha256', secret).update(stringToSign(input)).digest('hex');
}

export type SignedHeaders = Record<'X-Device-Id' | 'X-Session-Id' | 'X-Sequence' | 'X-Timestamp' | 'X-Signature', string>;

/** Monta os cabeçalhos de uma requisição assinada (usado pelo simulador/runner). */
export function buildSignedHeaders(
  secret: string,
  ids: { deviceId: string; sessionId: string },
  input: SignInput
): SignedHeaders {
  return {
    'X-Device-Id': ids.deviceId,
    'X-Session-Id': ids.sessionId,
    'X-Sequence': String(input.sequence),
    'X-Timestamp': String(input.timestamp),
    'X-Signature': sign(secret, input),
  };
}

export type VerifyResult =
  | { ok: true; deviceId: string; sessionId: string; sequence: number }
  | { ok: false; error: Extract<ErrorCode, 'SIGNATURE_INVALID' | 'CLOCK_SKEW' | 'REPLAY_DETECTED'>; message: string };

export interface VerifyInput {
  method: string;
  path: string;
  /** Cabeçalhos em minúsculas (como o Node entrega). */
  headers: Record<string, string | string[] | undefined>;
  body?: string | Uint8Array;
  /** Segredo do dispositivo identificado por `x-device-id`. */
  secret: string;
  /** Epoch em segundos "agora" (injetável para teste). */
  nowSeconds: number;
  toleranceSeconds?: number;
  /** Última `X-Sequence` aceita desta sessão (-1/undefined = nenhuma). */
  lastAcceptedSequence?: number;
}

function header(h: VerifyInput['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Verifica assinatura, relógio e sequência. Comparação em tempo constante. */
export function verifyRequest(input: VerifyInput): VerifyResult {
  const deviceId = header(input.headers, SIGNATURE_HEADERS.deviceId);
  const sessionId = header(input.headers, SIGNATURE_HEADERS.sessionId);
  const seqRaw = header(input.headers, SIGNATURE_HEADERS.sequence);
  const tsRaw = header(input.headers, SIGNATURE_HEADERS.timestamp);
  const sig = header(input.headers, SIGNATURE_HEADERS.signature);

  if (!deviceId || !sessionId || !seqRaw || !tsRaw || !sig) {
    return { ok: false, error: 'SIGNATURE_INVALID', message: 'Cabeçalhos de assinatura ausentes.' };
  }
  if (!/^\d+$/.test(seqRaw) || !/^\d+$/.test(tsRaw)) {
    return { ok: false, error: 'SIGNATURE_INVALID', message: 'Sequência ou timestamp inválidos.' };
  }
  const sequence = Number(seqRaw);
  const timestamp = Number(tsRaw);

  const expected = sign(input.secret, {
    method: input.method,
    path: input.path,
    timestamp,
    sequence,
    body: input.body,
  });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'SIGNATURE_INVALID', message: 'Assinatura inválida.' };
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    return { ok: false, error: 'CLOCK_SKEW', message: 'Timestamp fora da tolerância de relógio.' };
  }

  if (input.lastAcceptedSequence !== undefined && sequence <= input.lastAcceptedSequence) {
    return { ok: false, error: 'REPLAY_DETECTED', message: 'Sequência já utilizada.' };
  }

  return { ok: true, deviceId, sessionId, sequence };
}
