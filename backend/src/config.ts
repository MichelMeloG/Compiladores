import { z } from 'zod';

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite().positive());

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: num(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  GCP_PROJECT: z.string().default(''),
  STORE: z.enum(['memory', 'firestore']).default('memory'),
  PUBSUB_TOPIC_EVENTS: z.string().default('agv-events'),
  PUBSUB_TOPIC_DLQ: z.string().default('agv-events-dlq'),
  CORS_ORIGINS: z.string().optional(),
  AUTH_MODE: z.enum(['firebase', 'off']).default('firebase'),
  ALLOWED_OPERATOR_EMAILS: z.string().optional(),
  DEVICE_SECRETS_JSON: z.string().optional(),
  INTERNAL_AUDIENCE: z.string().default(''),
  PUBSUB_PUSH_SA: z.string().default(''),
  SCHEDULER_SA: z.string().default(''),
  // Ajustes opcionais (todos com padrão seguro para a cota gratuita).
  POLL_ACTIVE_MS: num(1500),
  POLL_IDLE_MS: num(30000),
  OFFLINE_AFTER_MS: num(45000),
  OFFLINE_AFTER_IDLE_MS: num(180000),
  LAST_SEEN_WRITE_MS: num(10000),
  LAST_SEEN_WRITE_IDLE_MS: num(120000),
  COMMAND_TTL_MS: num(30000),
  LOAD_COMMAND_TTL_MS: num(120000),
  DEVICE_CLOCK_SKEW_MS: num(120000),
  RATE_LIMIT_USER_PER_MIN: num(300),
  RATE_LIMIT_DEVICE_PER_MIN: num(240),
  SEED_ON_BOOT: z.enum(['true', 'false']).optional(),
  SEED_PROFILE: z.enum(['demo', 'clean']).default('demo'),
  // Recusa rotas enquanto a posição do robô for desconhecida (exige POST /api/robots/:id/position).
  REQUIRE_CONFIRMED_POSITION: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  nodeEnv: string;
  port: number;
  logLevel: string;
  gcpProject: string;
  store: 'memory' | 'firestore';
  topicEvents: string;
  topicDlq: string;
  corsOrigins: string[];
  authMode: 'firebase' | 'off';
  allowedOperatorEmails: string[];
  deviceSecrets: Record<string, string[]>;
  internalAudience: string;
  pubsubPushSa: string;
  schedulerSa: string;
  pollActiveMs: number;
  pollIdleMs: number;
  offlineAfterMs: number;
  offlineAfterIdleMs: number;
  lastSeenWriteMs: number;
  lastSeenWriteIdleMs: number;
  commandTtlMs: number;
  loadCommandTtlMs: number;
  deviceClockSkewMs: number;
  rateLimitUserPerMin: number;
  rateLimitDevicePerMin: number;
  seedOnBoot: boolean;
  seedProfile: 'demo' | 'clean';
  requireConfirmedPosition: boolean;
}

export class ConfigError extends Error {}

export function parseDeviceSecrets(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('DEVICE_SECRETS_JSON não é JSON válido.');
  }
  const out: Record<string, string[]> = {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('DEVICE_SECRETS_JSON deve ser um objeto {deviceId: segredo | [segredos]}.');
  }
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0 || !list.every((s) => typeof s === 'string' && s.length >= 16)) {
      throw new ConfigError(`Segredo do dispositivo ${id} ausente ou curto demais (mínimo 16 caracteres).`);
    }
    out[id] = list as string[];
  }
  return out;
}

/** Lê e valida o ambiente. Falha no boot em combinações inseguras. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const cfg: Config = {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    gcpProject: e.GCP_PROJECT,
    store: e.STORE,
    topicEvents: e.PUBSUB_TOPIC_EVENTS,
    topicDlq: e.PUBSUB_TOPIC_DLQ,
    corsOrigins: csv(e.CORS_ORIGINS),
    authMode: e.AUTH_MODE,
    allowedOperatorEmails: csv(e.ALLOWED_OPERATOR_EMAILS).map((s) => s.toLowerCase()),
    deviceSecrets: parseDeviceSecrets(e.DEVICE_SECRETS_JSON),
    internalAudience: e.INTERNAL_AUDIENCE,
    pubsubPushSa: e.PUBSUB_PUSH_SA,
    schedulerSa: e.SCHEDULER_SA,
    pollActiveMs: e.POLL_ACTIVE_MS,
    pollIdleMs: e.POLL_IDLE_MS,
    offlineAfterMs: e.OFFLINE_AFTER_MS,
    offlineAfterIdleMs: e.OFFLINE_AFTER_IDLE_MS,
    lastSeenWriteMs: e.LAST_SEEN_WRITE_MS,
    lastSeenWriteIdleMs: e.LAST_SEEN_WRITE_IDLE_MS,
    commandTtlMs: e.COMMAND_TTL_MS,
    loadCommandTtlMs: e.LOAD_COMMAND_TTL_MS,
    deviceClockSkewMs: e.DEVICE_CLOCK_SKEW_MS,
    rateLimitUserPerMin: e.RATE_LIMIT_USER_PER_MIN,
    rateLimitDevicePerMin: e.RATE_LIMIT_DEVICE_PER_MIN,
    // Em memória o padrão é popular com o seed; em Firestore nunca sem pedido explícito.
    seedOnBoot: e.SEED_ON_BOOT ? e.SEED_ON_BOOT === 'true' : e.STORE === 'memory',
    seedProfile: e.SEED_PROFILE,
    requireConfirmedPosition: e.REQUIRE_CONFIRMED_POSITION === 'true',
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const prod = cfg.nodeEnv === 'production';
  if (prod && cfg.authMode === 'off') {
    throw new ConfigError('AUTH_MODE=off é proibido com NODE_ENV=production.');
  }
  if (cfg.authMode === 'off' && cfg.store === 'firestore') {
    throw new ConfigError('AUTH_MODE=off é proibido com STORE=firestore.');
  }
  if (cfg.store === 'firestore' && !cfg.gcpProject) {
    throw new ConfigError('STORE=firestore exige GCP_PROJECT.');
  }
  if (prod && cfg.store === 'memory') {
    throw new ConfigError('STORE=memory é proibido com NODE_ENV=production (estado não pode ficar na memória).');
  }
  if (prod && cfg.authMode === 'firebase' && cfg.allowedOperatorEmails.length === 0) {
    throw new ConfigError('ALLOWED_OPERATOR_EMAILS vazio: nenhum operador poderia entrar (fail-closed).');
  }
  if (prod && (!cfg.internalAudience || !cfg.pubsubPushSa || !cfg.schedulerSa)) {
    throw new ConfigError('INTERNAL_AUDIENCE, PUBSUB_PUSH_SA e SCHEDULER_SA são obrigatórios em produção.');
  }
}
