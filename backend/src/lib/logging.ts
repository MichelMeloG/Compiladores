import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';

const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Opções do pino compatíveis com o Cloud Logging: `severity` no lugar de
 * `level`, `message` no lugar de `msg` e `timestamp` em ISO 8601.
 * O Cloud Run envia o stdout JSON direto ao Logging, sem agente.
 */
export function loggerOptions(cfg: Pick<Config, 'logLevel'>): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: cfg.logLevel,
    messageKey: 'message',
    base: null,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level(label: string) {
        return { severity: SEVERITY[label] ?? 'DEFAULT' };
      },
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-signature"]'],
      censor: '[REDACTED]',
    },
  };
}

/** Converte X-Cloud-Trace-Context ("TRACE/SPAN;o=1") para o campo de trace do Logging. */
export function traceField(header: string | undefined, project: string): Record<string, string> {
  if (!header || !project) return {};
  const traceId = header.split('/')[0];
  if (!traceId || !/^[0-9a-f]{32}$/i.test(traceId)) return {};
  return { 'logging.googleapis.com/trace': `projects/${project}/traces/${traceId}` };
}

export interface LogLabels {
  deviceId?: string;
  missionId?: string;
  sessionId?: string;
  robotId?: string;
}

/** Labels indexáveis no Logs Explorer (filtro por missão reconstrói o caso). */
export function labels(l: LogLabels): Record<string, unknown> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(l)) if (v) clean[k] = String(v);
  return { 'logging.googleapis.com/labels': clean, ...clean };
}
