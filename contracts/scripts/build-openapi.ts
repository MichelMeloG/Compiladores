/**
 * Gera `contracts/openapi.json` (OpenAPI 3.0) a partir de `ENDPOINTS`.
 * Uso: npm run openapi
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CONTRACT_VERSION,
  ENDPOINTS,
  ErrorEnvelopeSchema,
  IDEMPOTENCY_HEADER,
  successEnvelope,
  type Endpoint,
} from '../src/index.js';

const js = (schema: z.ZodType, io: 'input' | 'output') => {
  const out = z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
};

const paths: Record<string, Record<string, unknown>> = {};

for (const e of ENDPOINTS as readonly Endpoint[]) {
  const oaPath = e.path.replace(/:([A-Za-z]+)/g, '{$1}');
  const params: unknown[] = [...(e.path.match(/:([A-Za-z]+)/g) ?? [])].map((p) => ({
    name: p.slice(1),
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  if (e.query) {
    const q = js(e.query, 'input') as { properties?: Record<string, unknown> };
    for (const [name, schema] of Object.entries(q.properties ?? {})) {
      params.push({ name, in: 'query', required: false, schema });
    }
  }
  if (e.idempotency) {
    params.push({ name: IDEMPOTENCY_HEADER, in: 'header', required: e.idempotency === 'required', schema: { type: 'string', minLength: 8, maxLength: 128 } });
  }
  if (e.auth === 'device') {
    for (const h of ['X-Device-Id', 'X-Session-Id', 'X-Sequence', 'X-Timestamp', 'X-Signature']) {
      params.push({ name: h, in: 'header', required: true, schema: { type: 'string' } });
    }
  }

  const responses: Record<string, unknown> = {};
  for (const s of e.okStatus) {
    responses[String(s)] = {
      description: 'Sucesso',
      content: { 'application/json': { schema: js(successEnvelope(e.response), 'output') } },
    };
  }
  responses.default = {
    description: `Erro (${e.errors.join(', ') || 'códigos transversais'})`,
    content: { 'application/json': { schema: js(ErrorEnvelopeSchema, 'output') } },
  };

  const security =
    e.auth === 'operator' ? [{ firebaseIdToken: [] }] : e.auth === 'device' ? [{ deviceHmac: [] }] : e.auth === 'internal' ? [{ oidc: [] }] : [];

  (paths[oaPath] ??= {})[e.method.toLowerCase()] = {
    operationId: e.id,
    summary: e.summary,
    tags: [e.path.split('/')[1] === 'api' ? (e.path.split('/')[2] ?? 'api') : (e.path.split('/')[1] ?? 'misc')],
    ...(e.roles ? { 'x-roles': e.roles } : {}),
    parameters: params,
    ...(e.body ? { requestBody: { required: true, content: { 'application/json': { schema: js(e.body, 'input') } } } } : {}),
    responses,
    security,
  };
}

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'RoboFlow API',
    version: CONTRACT_VERSION,
    description:
      'Gerado a partir de @roboflow/contracts (ENDPOINTS). Fonte da verdade: contracts/src. Convenção de coordenadas: ADR 0004.',
  },
  components: {
    securitySchemes: {
      firebaseIdToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      deviceHmac: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 'HMAC-SHA256 — ver contracts/src/signing.ts' },
      oidc: { type: 'http', scheme: 'bearer', bearerFormat: 'OIDC' },
    },
  },
  paths,
};

writeFileSync(join(import.meta.dirname, '..', 'openapi.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`openapi.json gerado (${Object.keys(paths).length} caminhos)`);
