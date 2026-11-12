import { Injectable, Logger } from '@nestjs/common';
import { Payment } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { FedaPayClient, FedaTransaction } from './fedapay.client';
import { classifyStatus, mapMethod } from './fedapay-status';
import { FulfillmentService, lockOrder } from './fulfillment.service';
import { groupLines, releaseSold } from './stock';

export type ApplyOutcome =
  | 'FULFILLED' | 'ALREADY_PAID' | 'REFUND_REQUIRED' | 'AMOUNT_MISMATCH' | 'DUPLICATE'
  | 'FAILED' | 'REFUNDED' | 'PENDING' | 'ALREADY_HANDLED' | 'UNKNOWN_TRANSACTION';
export interface ReconcileResult { outcome: ApplyOutcome; orderId?: string }

/**
 * Applique l'état RÉEL d'une transaction FedaPay (relu via l'API avec la clé secrète) à notre base.
 * Appelé par : le job déclenché par le webhook, le sondage de la page de retour, et le balayage périodique.
 * Les trois chemins aboutissent au même code, idempotent grâce au verrou de ligne sur la commande.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fedapay: FedaPayClient,
    private readonly fulfillment: FulfillmentService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  async reconcileByTransactionId(transactionId: string | number): Promise<ReconcileResult> {
    const txn = await this.fedapay.getTransaction(transactionId);
    let payment = await this.prisma.payment.findUnique({ where: { providerTransactionId: String(transactionId) } });
    payment ??= await this.adoptByMetadata(txn, transactionId);
    if (!payment) return { outcome: 'UNKNOWN_TRANSACTION' };
    return this.apply(payment.id, txn);
  }

  async reconcilePayment(paymentId: string): Promise<ReconcileResult> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (!p.providerTransactionId) return { outcome: 'PENDING', orderId: p.orderId };
    const txn = await this.fedapay.getTransaction(p.providerTransactionId);
    return this.apply(p.id, txn);
  }

  /** Cas rare : le webhook arrive avant que l'identifiant de transaction soit enregistré. On retrouve la commande par ses métadonnées. */
  private async adoptByMetadata(txn: FedaTransaction, transactionId: string | number): Promise<Payment | null> {
    const ref = txn.metadata?.order_reference;
    if (typeof ref !== 'string') return null;
    const candidate = await this.prisma.payment.findFirst({
      where: { provider: 'FEDAPAY', status: 'PENDING', providerTransactionId: null, order: { reference: ref } },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) return null;
    const { count } = await this.prisma.payment.updateMany({ where: { id: candidate.id, providerTransactionId: null }, data: { providerTransactionId: String(transactionId) } });
    return count ? { ...candidate, providerTransactionId: String(transactionId) } : this.prisma.payment.findUnique({ where: { providerTransactionId: String(transactionId) } });
  }

  async apply(paymentId: string, txn: FedaTransaction): Promise<ReconcileResult> {
    const kind = classifyStatus(txn.status);
    const method = mapMethod(txn.mode);
    const confirmedAt = txn.paidAt && !Number.isNaN(Date.parse(txn.paidAt)) ? new Date(txn.paidAt) : new Date();

    const result = await this.prisma.$transaction(async (tx): Promise<ReconcileResult & { ticketIds?: string[] }> => {
      const pay = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const order = await lockOrder(tx, pay.orderId);
      if (!order) throw new Error(`Commande introuvable pour le paiement ${paymentId}`);
      const orderId = pay.orderId;

      if (kind === 'PAID' || kind === 'PARTIAL_REFUND') {
        if (pay.status === 'PAID') return { outcome: 'ALREADY_PAID', orderId };
        if (pay.status === 'REFUND_REQUIRED' || pay.status === 'REFUNDED') return { outcome: 'ALREADY_HANDLED', orderId };

        // Le montant confirmé par FedaPay doit être EXACTEMENT celui attendu : sinon aucun billet.
        if (txn.amount !== pay.expectedAmountXof) {
          await tx.payment.update({ where: { id: pay.id }, data: { status: 'REFUND_REQUIRED', confirmedAmountXof: txn.amount, confirmedAt, method, failureReason: 'AMOUNT_MISMATCH' } });
          await this.audit.log({ actorId: null, action: 'payment.amount_mismatch', entityType: 'payment', entityId: pay.id, metadata: { expected: pay.expectedAmountXof, received: txn.amount, orderId } }, tx);
          this.log.error(`Montant inattendu pour ${pay.id} : attendu ${pay.expectedAmountXof}, reçu ${txn.amount}`);
          return { outcome: 'AMOUNT_MISMATCH', orderId };
        }
        // Une autre tentative de paiement de la même commande a déjà été validée : celle-ci est un doublon à rembourser.
        if (order.status === 'PAID') {
          await tx.payment.update({ where: { id: pay.id }, data: { status: 'REFUND_REQUIRED', confirmedAmountXof: txn.amount, confirmedAt, method, failureReason: 'DUPLICATE_PAYMENT' } });
          await this.audit.log({ actorId: null, action: 'payment.duplicate', entityType: 'payment', entityId: pay.id, metadata: { orderId, amountXof: txn.amount } }, tx);
          return { outcome: 'DUPLICATE', orderId };
        }
        if (kind === 'PARTIAL_REFUND') {
          await this.audit.log({ actorId: null, action: 'payment.partial_refund_seen', entityType: 'payment', entityId: pay.id, metadata: { status: txn.status } }, tx);
        }
        const r = await this.fulfillment.fulfillPaid(tx, orderId, { paymentId: pay.id, amountXof: txn.amount, method, confirmedAt });
        return { outcome: r.outcome, orderId, ticketIds: r.outcome === 'FULFILLED' ? r.ticketIds : undefined };
      }

      if (kind === 'FAILED') {
        if (pay.status === 'PENDING') {
          await tx.payment.update({ where: { id: pay.id }, data: { status: 'FAILED', failureReason: txn.status, method } });
          if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_IN_PROGRESS') {
            const otherPending = await tx.payment.count({ where: { orderId, status: 'PENDING', id: { not: pay.id } } });
            // La réservation est conservée jusqu'à son expiration : l'acheteur peut relancer un paiement.
            if (!otherPending) await tx.order.update({ where: { id: orderId }, data: { status: 'FAILED' } });
          }
        }
        return { outcome: 'FAILED', orderId };
      }

      if (kind === 'REFUNDED') {
        if (pay.status === 'REFUNDED') return { outcome: 'ALREADY_HANDLED', orderId };
        await tx.payment.update({ where: { id: pay.id }, data: { status: 'REFUNDED', confirmedAmountXof: txn.amount, method } });
        if (pay.status === 'PAID') {
          const valid = await tx.ticket.findMany({ where: { orderId, status: 'VALID' }, select: { id: true, categoryId: true, eventId: true } });
          if (valid.length) {
            await tx.ticket.updateMany({ where: { id: { in: valid.map((t) => t.id) } }, data: { status: 'REFUNDED', cancelledAt: new Date(), cancelReason: 'Remboursement FedaPay' } });
            await releaseSold(tx, groupLines(valid.map((t) => ({ categoryId: t.categoryId, eventId: t.eventId, qty: 1 }))));
          }
          await tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
        }
        await this.audit.log({ actorId: null, action: 'payment.refunded', entityType: 'payment', entityId: pay.id, metadata: { orderId } }, tx);
        return { outcome: 'REFUNDED', orderId };
      }

      if (txn.mode && pay.method === 'UNKNOWN') await tx.payment.update({ where: { id: pay.id }, data: { method } });
      return { outcome: 'PENDING', orderId };
    });

    if (result.outcome === 'FULFILLED') await this.notifyFulfilled(result.orderId!);
    return { outcome: result.outcome, orderId: result.orderId };
  }

  /** L'étape 5 (billets + e-mails) consomme ce job. Un balayage de rattrapage couvrira un éventuel échec d'enfilage. */
  async notifyFulfilled(orderId: string): Promise<void> {
    try {
      await this.jobs.enqueue(QUEUES.ORDER_FULFILLED, { orderId });
    } catch (e) {
      this.log.error(`Enfilage order.fulfilled impossible pour ${orderId} : ${(e as Error).message}`);
    }
  }
}
