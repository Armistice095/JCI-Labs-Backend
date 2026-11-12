import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export class BrevoError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string, public readonly retryAfterSec?: number) { super(message); }
}

export interface BrevoAttachment { name: string; content: string /* base64 */ }
export interface BrevoMail {
  to: { email: string; name?: string }[];
  replyTo?: { email: string; name?: string };
  subject: string;
  htmlContent: string;
  attachment?: BrevoAttachment[];
  tags?: string[];
}

/**
 * Client minimal de l'API transactionnelle Brevo (doc : developers.brevo.com, « Send a transactional email »).
 *  POST /v3/smtp/email   en-tête `api-key`   → 201 { messageId: "<…@smtp-relay.mailin.fr>" }
 * L'expéditeur doit être un expéditeur/domaine VÉRIFIÉ dans Brevo (SPF/DKIM/DMARC), sinon les envois sont refusés ou finissent en spam.
 * Taille maximale d'un e-mail (contenu + pièces jointes) : 20 Mo selon l'aide Brevo.
 */
@Injectable()
export class BrevoClient {
  private readonly log = new Logger(BrevoClient.name);
  private readonly base: string;
  constructor(@Inject(ENV) private readonly env: Env) { this.base = (env.BREVO_API_BASE ?? 'https://api.brevo.com').replace(/\/+$/, ''); }

  get configured(): boolean { return !!this.env.BREVO_API_KEY && !!this.env.BREVO_SENDER_EMAIL; }

  async send(mail: BrevoMail): Promise<{ messageId: string }> {
    if (!this.configured) throw new BrevoError('Brevo non configuré (BREVO_API_KEY / BREVO_SENDER_EMAIL).');
    const body = JSON.stringify({ sender: { name: this.env.BREVO_SENDER_NAME, email: this.env.BREVO_SENDER_EMAIL }, ...mail });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/v3/smtp/email`, {
          method: 'POST',
          headers: { 'api-key': this.env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
          body, signal: AbortSignal.timeout(45_000),
        });
      } catch (e) { throw new BrevoError(`Brevo injoignable (${(e as Error).name})`); }

      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(5, Math.max(1, Number(res.headers.get('x-sib-ratelimit-reset')) || 2));
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      let json: { messageId?: string; code?: string; message?: string } = {};
      try { json = text ? JSON.parse(text) : {}; } catch { /* corps non JSON */ }
      if (res.status === 201 || res.status === 200) {
        if (!json.messageId) throw new BrevoError('Réponse Brevo inattendue (messageId manquant).', res.status);
        return { messageId: json.messageId };
      }
      // Ne jamais journaliser le corps de la requête (adresses, pièces jointes) ; le code d'erreur Brevo suffit.
      this.log.warn(`Brevo ${res.status} ${json.code ?? ''} : ${(json.message ?? '').slice(0, 160)}`);
      throw new BrevoError(`Brevo HTTP ${res.status}${json.code ? ` (${json.code})` : ''}`, res.status, json.code);
    }
  }
}
