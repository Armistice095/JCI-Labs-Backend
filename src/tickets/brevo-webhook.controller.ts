import { Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators';
import { AppException } from '../common/errors';
import { RateLimit } from '../common/rate-limit';
import { safeEqual } from '../common/tokens';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { mapBrevoEvent, normalizeMessageId, shouldApply } from './brevo-events';

@Controller('webhooks')
export class BrevoWebhookController {
  private readonly log = new Logger(BrevoWebhookController.name);
  private readonly ips: Set<string>;
  constructor(private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env) {
    this.ips = new Set(env.BREVO_WEBHOOK_IPS.split(',').map((s) => s.trim()).filter(Boolean));
  }

  /**
   * Statuts de livraison des e-mails. Les webhooks Brevo ne sont PAS signés : l'authentification repose sur un jeton secret
   * (en-tête Authorization: Bearer, à configurer dans Brevo) et, en option, sur la liste d'IP publiée par Brevo.
   * Ces événements ne servent qu'à l'information (suivi d'envoi) : ils ne déclenchent aucune action sensible.
   */
  @Public()
  @RateLimit('webhook-brevo', 600, 60)
  @Post('brevo')
  @HttpCode(200)
  async brevo(@Req() req: FastifyRequest) {
    const token = this.env.BREVO_WEBHOOK_TOKEN;
    if (!token) throw new AppException('INTERNAL_ERROR', 'Webhook Brevo non configuré.', 503);
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
      this.log.warn(`Webhook Brevo refusé : jeton invalide (IP ${req.ip})`);
      throw new AppException('UNAUTHORIZED', 'Authentification invalide.', 401);
    }
    if (this.ips.size && !this.ips.has(req.ip)) throw new AppException('UNAUTHORIZED', 'Origine non autorisée.', 401);

    const events = Array.isArray(req.body) ? req.body : [req.body];
    let updated = 0;
    for (const ev of events.slice(0, 100) as Record<string, any>[]) {
      const next = mapBrevoEvent(ev?.event);
      const id = ev?.['message-id'] ?? ev?.messageId;
      if (!next || typeof id !== 'string') continue;
      const row = await this.prisma.emailLog.findFirst({ where: { brevoMessageId: normalizeMessageId(id) } });
      if (!row || !shouldApply(row.status, next)) continue;
      const ms = Number(ev.ts_epoch) > 1e12 ? Number(ev.ts_epoch) : Number(ev.ts_event) > 0 ? Number(ev.ts_event) * 1000 : Date.now();
      await this.prisma.emailLog.update({
        where: { id: row.id },
        // Code d'événement seulement (le texte « reason » de Brevo peut contenir l'adresse du destinataire).
        data: { status: next, lastEventAt: new Date(ms), error: ['SENT', 'DELIVERED'].includes(next) ? null : String(ev.event).slice(0, 40) },
      });
      updated++;
    }
    return { received: true, updated };
  }
}
