import { Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { invalidState, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { EventAccess } from '../events/event-access.service';
import { releaseSold } from './stock';

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService, private readonly access: EventAccess, private readonly audit: AuditService) {}

  /**
   * Annule un billet (erreur de saisie, demande de l'acheteur…). Le billet est refusé au scan et la place est remise en vente.
   * Le remboursement d'argent n'est pas géré ici (processus « À préciser » dans le cahier des charges).
   */
  async cancel(user: AuthUser, ticketId: string, reason: string, ip?: string) {
    const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { eventId: true } });
    if (!t) throw notFound('Billet introuvable.');
    await this.access.require(user, t.eventId, 'ticket.cancel');

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string; category_id: string; event_id: string }[]>`
        SELECT id, status, category_id, event_id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
      const cur = rows[0];
      if (!cur) throw notFound('Billet introuvable.');
      if (cur.status === 'USED') throw invalidState('Ce billet a déjà été utilisé à l’entrée.');
      if (cur.status !== 'VALID') throw invalidState('Ce billet est déjà annulé ou remboursé.');
      await tx.ticket.update({ where: { id: ticketId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason } });
      await releaseSold(tx, [{ categoryId: cur.category_id, eventId: cur.event_id, qty: 1 }]);
      await this.audit.log({ actorId: user.id, action: 'ticket.cancel', entityType: 'ticket', entityId: ticketId, metadata: { reason, eventId: cur.event_id }, ip }, tx);
      return { ticketId, status: 'CANCELLED' as const };
    });
  }
}
