import { Inject, Injectable, Logger } from '@nestjs/common';
import { EmailTemplate } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { BrandAssetsService } from './brand-assets.service';
import { BrevoAttachment, BrevoClient, BrevoError } from './brevo.client';
import { normalizeMessageId } from './brevo-events';
import { buildTicketEmail } from './email-template';
import { FILE_KINDS, TicketFilesService } from './ticket-files.service';

export type EmailOutcome = 'SENT' | 'SKIPPED' | 'ALREADY_SENT' | 'BUSY' | 'NOT_CONFIGURED';
const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // marge sous la limite Brevo de 20 Mo (le base64 ajoute ~33 %)

@Injectable()
export class TicketEmailService {
  private readonly log = new Logger(TicketEmailService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: TicketFilesService,
    private readonly brevo: BrevoClient,
    private readonly brand: BrandAssetsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** E-mail de confirmation d'une commande (une seule fois : un job rejoué ou le balayage ne renvoie jamais un message déjà accepté). */
  async sendOrderConfirmation(orderId: string): Promise<EmailOutcome> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, tickets: { where: { status: 'VALID' }, include: { category: true }, orderBy: { number: 'asc' } } },
    });
    if (!order || order.status !== 'PAID' || !order.sendTicketsEmail || !order.buyerEmail || !order.tickets.length) return 'SKIPPED';
    if (!this.brevo.configured) { this.log.warn(`E-mail non envoyé pour ${order.reference} : Brevo non configuré`); return 'NOT_CONFIGURED'; }
    return this.sendLocked({
      lockKey: `email:order:${orderId}`, template: 'TICKET_CONFIRMATION', orderId, ticketId: null, toEmail: order.buyerEmail,
      uniquePerOrder: true,
      compose: async () => this.compose('CONFIRMATION', order.buyerFirstName, order.reference, order.event, order.tickets, order.accessToken, order.buyerEmail!),
    });
  }

  /** Renvoi manuel d'un billet (admin) : un nouvel envoi à chaque demande, tracé dans email_logs. */
  async sendTicketCopy(ticketId: string, toEmail: string): Promise<EmailOutcome> {
    const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { category: true, order: true, event: true } });
    if (!t || t.status !== 'VALID') return 'SKIPPED';
    if (!this.brevo.configured) return 'NOT_CONFIGURED';
    return this.sendLocked({
      lockKey: `email:ticket:${ticketId}:${toEmail}`, template: 'TICKET_RESEND', orderId: t.orderId, ticketId, toEmail, uniquePerOrder: false,
      compose: async () => this.compose('RESEND', t.holderFirstName, t.order.reference, t.event, [t], t.order.accessToken, toEmail),
    });
  }

  private async compose(
    kind: 'CONFIRMATION' | 'RESEND', firstName: string, reference: string | null,
    event: { title: string; startsAt: Date | null; venueName: string; city: string; contactEmail: string | null; contactPhone: string | null },
    tickets: { id: string; number: string; holderFirstName: string; holderLastName: string; category: { name: string } }[],
    accessToken: string | null, toEmail: string,
  ) {
    // Pièces jointes : PDF de chaque billet + visuel de partage du premier ; si le total dépasse le budget, on envoie des liens seulement.
    const attachment: BrevoAttachment[] = [];
    let total = 0; let pdfAttached = true; let shareAttached = false;
    for (const t of tickets) {
      const pdf = await this.files.getBuffer(t.id, 'pdf');
      if (!pdf) throw new Error(`PDF du billet ${t.number} introuvable (génération en cours ?)`);
      total += pdf.length;
      if (total > MAX_ATTACH_BYTES) { pdfAttached = false; break; }
      attachment.push({ name: `Billet-${t.number}.pdf`, content: pdf.toString('base64') });
    }
    if (!pdfAttached) attachment.length = 0;
    else {
      const share = await this.files.getBuffer(tickets[0].id, 'share');
      if (share && total + share.length <= MAX_ATTACH_BYTES) { attachment.push({ name: `Partage-${tickets[0].number}.jpg`, content: share.toString('base64') }); shareAttached = true; }
    }
    const mail = buildTicketEmail({
      kind, buyerFirstName: firstName, reference: kind === 'CONFIRMATION' ? reference : null, event,
      tickets: tickets.map((t) => ({ holderName: `${t.holderFirstName} ${t.holderLastName}`, categoryName: t.category.name, number: t.number })),
      orderUrl: accessToken && reference ? `${this.env.PUBLIC_WEB_URL}/commande/${reference}?token=${accessToken}` : null,
      logoUrl: this.brand.logoUrl, pdfAttached, shareAttached,
    });
    return {
      to: [{ email: toEmail, name: firstName }],
      ...(event.contactEmail ? { replyTo: { email: event.contactEmail } } : {}),
      subject: mail.subject, htmlContent: mail.html, ...(attachment.length ? { attachment } : {}), tags: ['billets'],
    };
  }

  /**
   * Envoi protégé par un verrou consultatif : deux jobs simultanés (rejeu, balayage) ne peuvent pas envoyer deux fois.
   * Garantie « au moins une fois » : si Brevo accepte puis que notre base échoue, un nouvel essai peut renvoyer le message.
   */
  private async sendLocked(p: {
    lockKey: string; template: EmailTemplate; orderId: string; ticketId: string | null; toEmail: string; uniquePerOrder: boolean;
    compose: () => Promise<Parameters<BrevoClient['send']>[0]>;
  }): Promise<EmailOutcome> {
    let failure: unknown = null;
    const outcome = await this.prisma.$transaction(async (tx): Promise<EmailOutcome> => {
      const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${p.lockKey}, 0)) AS ok`;
      if (!lock[0].ok) return 'BUSY';
      const prev = p.uniquePerOrder ? await tx.emailLog.findFirst({ where: { orderId: p.orderId, template: p.template }, orderBy: { createdAt: 'desc' } }) : null;
      if (prev && prev.status !== 'QUEUED' && prev.status !== 'FAILED') return 'ALREADY_SENT';
      const row = prev
        ? await tx.emailLog.update({ where: { id: prev.id }, data: { attempt: { increment: 1 }, status: 'QUEUED', error: null } })
        : await tx.emailLog.create({ data: { orderId: p.orderId, ticketId: p.ticketId, template: p.template, toEmail: p.toEmail, status: 'QUEUED' } });
      try {
        const r = await this.brevo.send(await p.compose());
        await tx.emailLog.update({ where: { id: row.id }, data: { status: 'SENT', brevoMessageId: normalizeMessageId(r.messageId), sentAt: new Date(), lastEventAt: new Date() } });
        return 'SENT';
      } catch (e) {
        failure = e;
        const code = e instanceof BrevoError ? (e.code ?? `HTTP_${e.status ?? 'NET'}`) : 'ERROR';
        await tx.emailLog.update({ where: { id: row.id }, data: { status: 'FAILED', error: String(code).slice(0, 80) } });
        return 'SENT';
      }
    }, { timeout: 90_000, maxWait: 10_000 });
    if (failure) throw failure; // la ligne FAILED est validée ; pg-boss rejouera avec attente croissante
    return outcome;
  }
}
