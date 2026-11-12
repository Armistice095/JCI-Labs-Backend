import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { AppException } from '../common/errors';
import { newQrToken } from '../common/tokens';
import { utcToLocalParts } from '../common/time';
import { AuditService } from '../audit/audit.service';
import { groupLines, nextCounter, convertReservation, sellDirect, StockLine } from './stock';

type Tx = Prisma.TransactionClient;

export type FulfillOutcome =
  | { outcome: 'FULFILLED'; ticketIds: string[] }
  | { outcome: 'ALREADY_PAID' }
  | { outcome: 'REFUND_REQUIRED' };

export const pad = (n: number, w: number) => String(n).padStart(w, '0');

export async function lockOrder(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: OrderStatus; reservation_held: boolean; event_id: string }[]>`
    SELECT id, status, reservation_held, event_id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Crée un billet nominatif (numéro unique + jeton QR) par bénéficiaire. */
export async function issueTickets(
  tx: Tx,
  o: { orderId: string; eventId: string },
  holders: { itemId: string; categoryId: string; firstName: string; lastName: string; email: string | null; phone: string | null }[],
): Promise<string[]> {
  const year = utcToLocalParts(new Date()).date.slice(0, 4);
  const ids: string[] = [];
  for (const h of holders) {
    const seq = await nextCounter(tx, `ticket:${year}`);
    const t = await tx.ticket.create({
      data: {
        number: `JCI-${year}-${pad(seq, 6)}`,
        qrToken: newQrToken(),
        eventId: o.eventId, orderId: o.orderId, orderItemId: h.itemId, categoryId: h.categoryId,
        holderFirstName: h.firstName, holderLastName: h.lastName, holderEmail: h.email, holderPhone: h.phone,
      },
      select: { id: true },
    });
    ids.push(t.id);
  }
  return ids;
}

@Injectable()
export class FulfillmentService {
  private readonly log = new Logger(FulfillmentService.name);
  constructor(private readonly audit: AuditService) {}

  /**
   * Confirme une commande en ligne dont le paiement est vérifié. Idempotent : le verrou de ligne sur la commande
   * sérialise les traitements concurrents (webhook + sondage du navigateur + balayage) et le statut PAID bloque tout rejeu.
   * À appeler DANS une transaction.
   */
  async fulfillPaid(tx: Tx, orderId: string, pay: { paymentId: string; amountXof: number; method: PaymentMethod; confirmedAt: Date }): Promise<FulfillOutcome> {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error(`Commande ${orderId} introuvable`);
    if (order.status === 'PAID') return { outcome: 'ALREADY_PAID' };

    const [items, holders] = await Promise.all([
      tx.orderItem.findMany({ where: { orderId } }),
      tx.orderHolder.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    ]);
    const lines: StockLine[] = groupLines(items.map((i) => ({ categoryId: i.categoryId, eventId: order.event_id, qty: i.quantity })));
    const expected = items.reduce((s, i) => s + i.quantity, 0);
    if (holders.length !== expected) throw new Error(`Commande ${orderId} : ${holders.length} bénéficiaires pour ${expected} billets`);

    if (order.reservation_held) {
      await convertReservation(tx, lines);
    } else {
      // Paiement arrivé après l'expiration de la réservation : on tente de reprendre les places.
      // Savepoint : un échec de stock ne doit pas annuler le reste de la transaction.
      try {
        await tx.$executeRaw`SAVEPOINT late_stock`;
        await sellDirect(tx, lines, { requireActive: false });
        await tx.$executeRaw`RELEASE SAVEPOINT late_stock`;
      } catch (e) {
        if (!(e instanceof AppException) || e.code !== 'QUOTA_EXCEEDED') throw e;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT late_stock`;
        await tx.order.update({ where: { id: orderId }, data: { status: 'REFUND_REQUIRED', reservationHeld: false } });
        await tx.payment.update({
          where: { id: pay.paymentId },
          data: { status: 'REFUND_REQUIRED', confirmedAmountXof: pay.amountXof, confirmedAt: pay.confirmedAt, method: pay.method, failureReason: 'LATE_PAYMENT_NO_CAPACITY' },
        });
        await this.audit.log({ actorId: null, action: 'order.refund_required', entityType: 'order', entityId: orderId, metadata: { paymentId: pay.paymentId, reason: 'LATE_PAYMENT_NO_CAPACITY', amountXof: pay.amountXof } }, tx);
        this.log.error(`Commande ${orderId} payée mais plus de stock : remboursement manuel requis.`);
        return { outcome: 'REFUND_REQUIRED' };
      }
    }

    const catByItem = new Map(items.map((i) => [i.id, i.categoryId]));
    const ticketIds = await issueTickets(
      tx,
      { orderId, eventId: order.event_id },
      holders.map((h) => ({ itemId: h.itemId, categoryId: catByItem.get(h.itemId)!, firstName: h.firstName, lastName: h.lastName, email: h.email, phone: h.phone })),
    );
    await tx.order.update({ where: { id: orderId }, data: { status: 'PAID', paidAt: pay.confirmedAt, reservationHeld: false } });
    await tx.payment.update({
      where: { id: pay.paymentId },
      data: { status: 'PAID', confirmedAmountXof: pay.amountXof, confirmedAt: pay.confirmedAt, method: pay.method, failureReason: null },
    });
    await this.audit.log({ actorId: null, action: 'order.paid', entityType: 'order', entityId: orderId, metadata: { paymentId: pay.paymentId, tickets: ticketIds.length, amountXof: pay.amountXof } }, tx);
    return { outcome: 'FULFILLED', ticketIds };
  }
}
