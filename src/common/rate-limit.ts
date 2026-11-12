import { CanActivate, ExecutionContext, Global, Inject, Injectable, Module, OnModuleDestroy, SetMetadata } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV, Env } from '../config/env';
import { AppException } from './errors';

interface Rule { bucket: string; limit: number; windowSec: number }
const KEY = 'rateLimitRule';

/** Limite par IP et par « bucket » (fenêtre glissante, en mémoire). Suffisant pour une instance unique derrière Caddy. */
export const RateLimit = (bucket: string, limit: number, windowSec: number) => SetMetadata(KEY, { bucket, limit, windowSec } satisfies Rule);

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly hits = new Map<string, number[]>();
  private readonly timer = setInterval(() => this.sweep(), 60_000);
  constructor(private readonly reflector: Reflector, @Inject(ENV) private readonly env: Pick<Env, 'RATE_LIMIT_DISABLED'>) { this.timer.unref(); }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.env.RATE_LIMIT_DISABLED === 'true') return true;
    const rule = this.reflector.getAllAndOverride<Rule | undefined>(KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!rule) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const key = `${rule.bucket}:${req.ip}`;
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      ctx.switchToHttp().getResponse<FastifyReply>().header('Retry-After', String(retryAfter));
      throw new AppException('RATE_LIMITED', 'Trop de requêtes. Réessayez dans un instant.', 429);
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < 3_600_000)) this.hits.delete(k);
  }
  onModuleDestroy() { clearInterval(this.timer); }
}

/** À importer en premier dans AppModule : le contrôle de débit s'exécute avant l'authentification. */
@Global()
@Module({ providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }] })
export class RateLimitModule {}
