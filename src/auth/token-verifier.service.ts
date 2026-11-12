import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { ENV, Env } from '../config/env';
import { unauthorized } from '../common/errors';

/** Vérifie un jeton d'accès Supabase Auth (clés asymétriques via JWKS, ou secret HS256 hérité). */
@Injectable()
export class TokenVerifier {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly secret?: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.issuer = `${env.SUPABASE_URL}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
    if (env.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  }

  /** Retourne l'identifiant Supabase (claim `sub`). */
  async verify(token: string): Promise<string> {
    try {
      const { alg } = decodeProtectedHeader(token);
      const opts = { issuer: this.issuer, audience: 'authenticated' };
      const { payload } =
        alg === 'HS256'
          ? await jwtVerify(token, this.requireSecret(), { ...opts, algorithms: ['HS256'] })
          : await jwtVerify(token, this.jwks, opts);
      if (!payload.sub) throw new Error('sub manquant');
      return payload.sub;
    } catch {
      throw unauthorized('Session expirée ou invalide.');
    }
  }

  private requireSecret(): Uint8Array {
    if (!this.secret) throw new Error('SUPABASE_JWT_SECRET non configuré');
    return this.secret;
  }
}
