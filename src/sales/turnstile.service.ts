import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { AppException } from '../common/errors';

/** Vérification serveur Cloudflare Turnstile (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
@Injectable()
export class TurnstileService {
  private readonly log = new Logger(TurnstileService.name);
  constructor(@Inject(ENV) private readonly env: Env) {}

  async verify(token: string | undefined, ip: string | undefined): Promise<void> {
    if (!this.env.TURNSTILE_SECRET_KEY) {
      if (this.env.NODE_ENV === 'production') throw new AppException('CAPTCHA_FAILED', 'Vérification anti-robot indisponible.', 503);
      return; // développement / tests : pas de captcha configuré
    }
    if (!token) throw new AppException('CAPTCHA_FAILED', 'Vérification anti-robot requise.', 400);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { success?: boolean };
      if (!data.success) throw new AppException('CAPTCHA_FAILED', 'Vérification anti-robot échouée. Rechargez la page.', 400);
    } catch (e) {
      if (e instanceof AppException) throw e;
      this.log.warn(`Turnstile injoignable : ${(e as Error).name}`);
      throw new AppException('CAPTCHA_FAILED', 'Vérification anti-robot indisponible, réessayez.', 503); // on échoue « fermé »
    }
  }
}
