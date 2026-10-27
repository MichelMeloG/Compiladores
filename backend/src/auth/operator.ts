import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { forbidden, unauthenticated } from '../errors.js';
import type { Operator } from '../services/operator.js';

export type Role = Operator['role'];
const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

export interface VerifiedToken {
  uid: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  claims: Record<string, unknown>;
}

/** Verificador de ID token (Firebase em produção; falso nos testes). */
export interface OperatorVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

/** ID token do Firebase Auth, verificado com o Admin SDK (chaves públicas do Google, sem segredo). */
export class FirebaseVerifier implements OperatorVerifier {
  private auth: import('firebase-admin/auth').Auth | undefined;

  constructor(private readonly projectId: string) {}

  private async getAuth(): Promise<import('firebase-admin/auth').Auth> {
    if (!this.auth) {
      const { getApps, initializeApp } = await import('firebase-admin/app');
      const { getAuth } = await import('firebase-admin/auth');
      const app = getApps()[0] ?? initializeApp({ projectId: this.projectId });
      this.auth = getAuth(app);
    }
    return this.auth;
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    const auth = await this.getAuth();
    const d = await auth.verifyIdToken(idToken);
    return { uid: d.uid, email: d.email, emailVerified: d.email_verified, claims: d as unknown as Record<string, unknown> };
  }
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1];
}

/**
 * Autentica o operador.
 *  - `firebase`: token válido + e-mail verificado + e-mail na allowlist
 *    (lista vazia = ninguém entra) + papel pelo custom claim `role`
 *    (ausente => `viewer`, o de menor privilégio).
 *  - `off`: somente desenvolvimento/teste (a configuração proíbe produção e
 *    Firestore). O papel pode ser escolhido pelo cabeçalho `x-dev-role`.
 */
export class OperatorAuth {
  constructor(
    private readonly cfg: Pick<Config, 'authMode' | 'allowedOperatorEmails'>,
    private readonly verifier?: OperatorVerifier,
  ) {}

  async authenticate(req: FastifyRequest): Promise<Operator> {
    if (this.cfg.authMode === 'off') {
      const hdr = req.headers['x-dev-role'];
      const asked = Array.isArray(hdr) ? hdr[0] : hdr;
      const role = (ROLES as readonly string[]).includes(asked ?? '') ? (asked as Role) : 'admin';
      const uid = (req.headers['x-dev-uid'] as string | undefined) ?? 'dev-user';
      return { uid, email: `${uid}@local`, role };
    }
    const token = bearer(req);
    if (!token) throw unauthenticated('Envie o ID token no cabeçalho Authorization: Bearer.');
    if (!this.verifier) throw unauthenticated('Verificador de token indisponível.');

    let t: VerifiedToken;
    try {
      t = await this.verifier.verify(token);
    } catch {
      throw unauthenticated('ID token inválido ou expirado.');
    }
    const email = t.email?.toLowerCase();
    if (!email || t.emailVerified !== true) throw forbidden('E-mail não verificado.');
    if (!this.cfg.allowedOperatorEmails.includes(email)) throw forbidden('Usuário fora da lista de operadores autorizados.');
    const claim = t.claims['role'];
    const role: Role = (ROLES as readonly string[]).includes(String(claim)) ? (claim as Role) : 'viewer';
    return { uid: t.uid, email, role };
  }
}

export function requireRole(op: Operator, allowed: readonly Role[] | undefined): void {
  if (!allowed) return;
  if (op.role === 'admin' || allowed.includes(op.role)) return;
  throw forbidden(`O papel "${op.role}" não pode executar esta operação.`);
}
