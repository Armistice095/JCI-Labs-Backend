import { Injectable, Logger } from '@nestjs/common';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { TEMPLATE_VERSION } from '../tickets/ticket-files.service';
import { PaymentsService } from './payments.service';
import { lockOrder } from './fulfillment.service';
import { groupLines, releaseReservation } from './stock';

const GRACE_MS = 2 * 60_000;          // délai de grâce après l'expiration (laisse arriver un webhook en retard)
const STALE_PAYMENT_MS = 2 * 60_000;  // un paiement en attente depuis plus longtemps est revérifié auprès de FedaPay
const GIVE_UP_MS = 48 * 3600_000;     // au-delà, on arrête de sonder une transaction abandonnée

@Injectable()
export class MaintenanceService {
  private readonly log = new Logger(MaintenanceService.name);
  constructor(private readonly prisma: PrismaService, private readonly payments: PaymentsService, private readonly jobs: JobsService) {}

  /** Exécuté chaque minute (pg-boss). Idempotent et sûr en cas d'exécutions concurrentes. */
  async run(now = new Date()): Promise<{ reconciled: number; released: number; requeued: number }> {
    // 1. Filet de sécurité contre les webhooks perdus : on relit auprès de FedaPay les paiements en attente.
    const stale = await this.prisma.payment.findMany({
      where: {
        provider: 'FEDAPAY', status: 'PENDING', providerTransactionId: { not: null },
        createdAt: { lt: new Date(now.getTime() - STALE_PAYMENT_MS), gt: new Date(now.getTime() - GIVE_UP_MS) },
      },
      orderBy: { createdAt: 'asc' }, take: 50, select: { id: true },
    });
    let reconciled = 0;
    for (const p of stale) {
      try { await this.payments.reconcilePayment(p.id); reconciled++; }
      catch (e) { this.log.warn(`Réconciliation ${p.id} échouée : ${(e as Error).message}`); }
    }
    await this.prisma.payment.updateMany({
      where: { provider: 'FEDAPAY', status: 'PENDING', createdAt: { lt: new Date(now.getTime() - GIVE_UP_MS) } },
      data: { status: 'EXPIRED' },
    });

    // 2. Libération des réservations expirées (après la réconciliation : une commande payée n'est jamais libérée).
    const expired = await this.prisma.order.findMany({
      where: { reservationHeld: true, expiresAt: { lt: new Date(now.getTime() - GRACE_MS) }, status: { in: ['PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS', 'FAILED'] } },
      orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true },
    });
    let released = 0;
    for (const o of expired) if (await this.releaseOrder(o.id, now)) released++;
    const requeued = await this.catchUpFulfillment(now);
    if (reconciled || released || requeued) this.log.log(`Maintenance : ${reconciled} paiement(s) revérifié(s), ${released} réservation(s) libérée(s), ${requeued} commande(s) à terminer (billets/e-mail)`);
    return { reconciled, released, requeued };
  }

  /**
   * Rattrapage : commandes payées dont les fichiers de billets ne sont pas tous générés, ou dont l'e-mail n'est pas parti
   * (job perdu, panne de Chromium ou de Brevo, redémarrage). Les jobs sont idempotents ; on ne relance une même commande
   * qu'une fois toutes les 10 minutes (singletonSeconds) et on abandonne l'e-mail après 12 tentatives.
   */
  private async catchUpFulfillment(now: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM orders o
      WHERE o.status = 'PAID'
        AND o.paid_at < ${new Date(now.getTime() - 3 * 60_000)} AND o.paid_at > ${new Date(now.getTime() - 7 * 86_400_000)}
        AND (
          (SELECT count(*) FROM generated_files g JOIN tickets t ON t.id = g.ticket_id WHERE t.order_id = o.id AND g.template_version = ${TEMPLATE_VERSION})
            < 2 * (SELECT count(*) FROM tickets t WHERE t.order_id = o.id)
          OR (o.send_tickets_email AND o.buyer_email IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM email_logs e WHERE e.order_id = o.id AND e.template = 'TICKET_CONFIRMATION'
                  AND (e.status NOT IN ('QUEUED','FAILED') OR e.attempt >= 12)))
        )
      ORDER BY o.paid_at LIMIT 30`;
    for (const r of rows) {
      await this.jobs.enqueue(QUEUES.ORDER_FULFILLED, { orderId: r.id }, { singletonKey: `fulfill:${r.id}`, singletonSeconds: 600 }).catch((e) => this.log.warn(`Rattrapage ${r.id} : ${e.message}`));
    }
    return rows.length;
  }

  private async releaseOrder(orderId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockOrder(tx, orderId);
      if (!locked || !locked.reservation_held || !['PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS', 'FAILED'].includes(locked.status)) return false;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      if (!order.expiresAt || order.expiresAt.getTime() >= now.getTime() - GRACE_MS) return false;
      await releaseReservation(tx, groupLines(order.items.map((i) => ({ categoryId: i.categoryId, eventId: order.eventId, qty: i.quantity }))));
      await tx.order.update({ where: { id: orderId }, data: { reservationHeld: false, status: order.status === 'FAILED' ? 'FAILED' : 'EXPIRED' } });
      // Un paiement encore en attente passe à EXPIRED ; s'il est approuvé plus tard, il sera traité comme un paiement tardif.
      await tx.payment.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      return true;
    });
  }
}
