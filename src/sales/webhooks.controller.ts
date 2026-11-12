import { Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit';
import { AppException } from '../common/errors';
import { sha256Hex } from '../common/tokens';
import { ENV, Env } from '../config/env';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { verifyWebhookSignature } from './fedapay-signature';

type RawRequest = FastifyRequest & { rawBody?: Buffer };

@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);
  private readonly allowedIps: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.allowedIps = new Set(env.FEDAPAY_WEBHOOK_IPS.split(',').map((s) => s.trim()).filter(Boolean));
  }

  /**
   * Notification FedaPay. On vérifie l'origine (IP si configurée) et la signature HMAC, on journalise l'événement
   * (clé unique = idempotence), on enfile le traitement et on répond 200 sans attendre (recommandation FedaPay).
   * Le corps du webhook n'est JAMAIS utilisé pour valider un paiement : le job relit la transaction via l'API.
   */
  @Public()
  @RateLimit('webhook', 600, 60)
  @Post('fedapay')
  @HttpCode(200)
  async fedapay(@Req() req: RawRequest) {
    if (this.allowedIps.size && !this.allowedIps.has(req.ip)) {
      this.log.warn(`Webhook refusé : IP non autorisée (${req.ip})`);
      throw new AppException('UNAUTHORIZED', 'Origine non autorisée.', 401);
    }
    const sig = verifyWebhookSignature({
      rawBody: req.rawBody,
      header: req.headers['x-fedapay-signature'] as string | undefined,
      secret: this.env.FEDAPAY_WEBHOOK_SECRET,
      toleranceSeconds: this.env.FEDAPAY_WEBHOOK_TOLERANCE_SECONDS,
    });
    if (!sig.ok) {
      this.log.warn(`Webhook refusé : signature ${sig.reason} (IP ${req.ip})`);
      throw new AppException('UNAUTHORIZED', 'Signature invalide.', 401);
    }

    const body = (req.body ?? {}) as Record<string, any>;
    const name = String(body.name ?? body.type ?? '');
    if (!name.startsWith('transaction.')) return { received: true, ignored: true };

    const entity = body.entity && typeof body.entity === 'object' ? body.entity : {};
    const transactionId = entity.id ?? body.object_id;
    if (transactionId === undefined || transactionId === null) {
      this.log.warn(`Webhook ${name} sans identifiant de transaction`);
      return { received: true, ignored: true };
    }
    const providerEventId = body.id !== undefined && body.id !== null ? `evt:${body.id}` : `sha:${sha256Hex(req.rawBody!)}`;

    let eventRow: { id: string; processedAt: Date | null };
    try {
      eventRow = await this.prisma.paymentEvent.create({
        data: { provider: 'FEDAPAY', providerEventId, type: name, payload: body as Prisma.InputJsonValue, signatureValid: true },
        select: { id: true, processedAt: true },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      eventRow = await this.prisma.paymentEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'FEDAPAY', providerEventId } }, select: { id: true, processedAt: true } });
      if (eventRow.processedAt) return { received: true, duplicate: true };
      // Reçu mais pas encore traité (échec précédent) : on réenfile, le traitement est idempotent.
    }
    await this.jobs.enqueue(QUEUES.RECONCILE, { paymentEventId: eventRow.id, transactionId: String(transactionId) });
    return { received: true };
  }
}
