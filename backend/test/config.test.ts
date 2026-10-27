import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseDeviceSecrets } from '../src/config.js';

const prodBase = {
  NODE_ENV: 'production',
  STORE: 'firestore',
  GCP_PROJECT: 'compiladores-512823',
  AUTH_MODE: 'firebase',
  ALLOWED_OPERATOR_EMAILS: 'a@b.com',
  INTERNAL_AUDIENCE: 'https://x.run.app',
  PUBSUB_PUSH_SA: 'p@x.iam',
  SCHEDULER_SA: 's@x.iam',
  DEVICE_SECRETS_JSON: JSON.stringify({ 'RB-01': 'x'.repeat(32) }),
};

describe('configuração: combinações inseguras nunca iniciam', () => {
  it('produção válida carrega', () => {
    const c = loadConfig(prodBase as never);
    expect(c.store).toBe('firestore');
    expect(c.seedOnBoot).toBe(false); // nunca semeia o Firestore sem pedido explícito
    expect(c.allowedOperatorEmails).toEqual(['a@b.com']);
  });

  it('AUTH_MODE=off é recusado em produção', () => {
    expect(() => loadConfig({ ...prodBase, AUTH_MODE: 'off' } as never)).toThrow(ConfigError);
  });

  it('AUTH_MODE=off é recusado com STORE=firestore, mesmo fora de produção', () => {
    expect(() =>
      loadConfig({ STORE: 'firestore', GCP_PROJECT: 'p', AUTH_MODE: 'off' } as never),
    ).toThrow(/AUTH_MODE=off/);
  });

  it('STORE=memory é recusado em produção', () => {
    expect(() => loadConfig({ ...prodBase, STORE: 'memory' } as never)).toThrow(/memory/);
  });

  it('allowlist vazia em produção falha fechada', () => {
    expect(() => loadConfig({ ...prodBase, ALLOWED_OPERATOR_EMAILS: '' } as never)).toThrow(/ALLOWED_OPERATOR_EMAILS/);
  });

  it('firestore exige GCP_PROJECT; produção exige audiência e service accounts internas', () => {
    expect(() => loadConfig({ STORE: 'firestore', AUTH_MODE: 'firebase' } as never)).toThrow(/GCP_PROJECT/);
    expect(() => loadConfig({ ...prodBase, INTERNAL_AUDIENCE: '' } as never)).toThrow(/INTERNAL_AUDIENCE/);
  });

  it('dev local: memory + off funciona sem credencial e semeia por padrão', () => {
    const c = loadConfig({ STORE: 'memory', AUTH_MODE: 'off' } as never);
    expect(c.seedOnBoot).toBe(true);
    expect(c.port).toBe(8080);
  });

  it('segredos de dispositivo: curtos ou malformados são recusados; rotação aceita lista', () => {
    expect(() => parseDeviceSecrets('{"RB-01":"curto"}')).toThrow(ConfigError);
    expect(() => parseDeviceSecrets('não é json')).toThrow(ConfigError);
    expect(parseDeviceSecrets(JSON.stringify({ 'RB-01': ['a'.repeat(20), 'b'.repeat(20)] }))['RB-01']).toHaveLength(2);
    expect(parseDeviceSecrets(undefined)).toEqual({});
  });
});
