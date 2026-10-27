import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { forbidden, unauthenticated } from '../errors.js';
import { bearer } from './operator.js';

export interface OidcClaims {
  email?: string | undefined;
  emailVerified?: boolean | undefined;
}

/** Verifica ID tokens OIDC do Google (assinatura + audiência). */
export interface OidcVerifier {
  verify(idToken: string, audience: string): Promise<OidcClaims>;
}

export class GoogleOidcVerifier implements OidcVerifier {
  private client: import('google-auth-library').OAuth2Client | undefined;

  async verify(idToken: string, audience: string): Promise<OidcClaims> {
    if (!this.client) {
      const { OAuth2Client } = await import('google-auth-library');
      this.client = new OAuth2Client();
    }
    const ticket = await this.client.verifyIdToken({ idToken, audience });
    const p = ticket.getPayload();
    return { email: p?.email, emailVerified: p?.email_verified };
  }
}

/**
 * `/internal/*` só aceita o ID token da service account esperada
 * (Pub/Sub push ou Cloud Scheduler). O Cloud Run é público; esta é a barreira.
 */
export async function requireInternal(
  req: FastifyRequest,
  verifier: OidcVerifier | undefined,
  cfg: Pick<Config, 'internalAudience'>,
  expectedEmail: string,
): Promise<void> {
  const token = bearer(req);
  if (!token) throw unauthenticated('Token OIDC ausente.');
  if (!verifier || !cfg.internalAudience || !expectedEmail) throw unauthenticated('Autenticação interna não configurada.');
  let claims: OidcClaims;
  try {
    claims = await verifier.verify(token, cfg.internalAudience);
  } catch {
    throw unauthenticated('Token OIDC inválido.');
  }
  if (claims.emailVerified !== true || claims.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw forbidden('Service account não autorizada para este endpoint.');
  }
}
