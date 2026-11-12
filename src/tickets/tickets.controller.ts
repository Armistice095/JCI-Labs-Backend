import { Body, Controller, Get, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { AppException, invalidState, notFound, validation } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventAccess } from '../events/event-access.service';
import { TicketFilesService, FileKindParam } from './ticket-files.service';
import { fileKind, resendBody, ResendBody } from './tickets.schemas';

const uuid = new ParseUUIDPipe();
const MAX_RESENDS_PER_HOUR = 5;

@Controller('tickets')
export class TicketsController {
  private readonly log = new Logger(TicketsController.name);
  private readonly kicked = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: TicketFilesService,
    private readonly access: EventAccess,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lien de téléchargement (URL signée, 15 min) du PDF, de l'image ou du visuel de partage.
   * Autorisé : participant.read sur l'événement, ou le vendeur qui a enregistré la vente (remise du billet en main propre).
   * 202 tant que les fichiers ne sont pas prêts : relancer dans quelques secondes.
   */
  @Get(':ticketId/files/:kind')
  async file(@CurrentUser() u: AuthUser, @Param('ticketId', uuid) id: string, @Param('kind', new ZodPipe(fileKind)) kind: FileKindParam, @Res({ passthrough: true }) res: FastifyReply) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { event: { select: { id: true, createdById: true } }, order: { select: { soldById: true, id: true } } } });
    const allowed = t && can(u, 'event.read', t.event) && (can(u, 'participant.read', t.event) || (t.order.soldById === u.id && can(u, 'sale.create', t.event)));
    if (!t || !allowed) throw notFound('Billet introuvable.');

    const f = await this.files.signedUrl(id, kind, t.number);
    res.header('Cache-Control', 'no-store');
    if (f) return { url: f.url, expiresAt: f.expiresAt, fileName: f.fileName, contentType: f.contentType };

    // Auto-réparation : si la génération n'a pas eu lieu (échec, file vidée), on la relance (au plus une fois par minute et par commande).
    const last = this.kicked.get(t.order.id) ?? 0;
    if (Date.now() - last > 60_000) {
      this.kicked.set(t.order.id, Date.now());
      if (this.kicked.size > 2000) this.kicked.clear();
      await this.jobs.enqueue(QUEUES.ORDER_FULFILLED, { orderId: t.order.id }).catch((e) => this.log.warn(`Enfilage impossible : ${e.message}`));
    }
    res.status(202);
    return { status: 'PENDING' as const };
  }

  /** Renvoie le billet par e-mail (à l'adresse du bénéficiaire, de l'acheteur, ou à `toEmail`). Limité à 5 renvois par heure et par billet. */
  @Post(':ticketId/resend')
  @HttpCode(202)
  async resend(@CurrentUser() u: AuthUser, @Param('ticketId', uuid) id: string, @Body(new ZodPipe(resendBody)) body: ResendBody, @Req() req: FastifyRequest) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { order: { select: { buyerEmail: true } } } });
    if (!t) throw notFound('Billet introuvable.');
    await this.access.require(u, t.eventId, 'ticket.resend');
    if (t.status !== 'VALID') throw invalidState("Seul un billet valide peut être renvoyé.");
    const toEmail = body.toEmail ?? t.holderEmail ?? t.order.buyerEmail;
    if (!toEmail) throw validation("Aucune adresse e-mail connue pour ce billet : précisez `toEmail`.", { toEmail: 'Adresse e-mail requise.' });

    const recent = await this.prisma.emailLog.count({ where: { ticketId: id, template: 'TICKET_RESEND', createdAt: { gt: new Date(Date.now() - 3600_000) } } });
    if (recent >= MAX_RESENDS_PER_HOUR) throw new AppException('RATE_LIMITED', 'Trop de renvois pour ce billet. Réessayez dans une heure.', 429);

    await this.jobs.enqueue(QUEUES.TICKET_RESEND, { ticketId: id, toEmail });
    await this.audit.log({ actorId: u.id, action: 'ticket.resend', entityType: 'ticket', entityId: id, ip: req.ip });
    return { queued: true as const };
  }
}
