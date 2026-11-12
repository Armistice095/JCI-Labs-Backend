import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { AppException, conflict, invalidState } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { EventAccess } from '../events/event-access.service';
import { computeAvailability, computeSalesStatus } from '../ticketing/sales-status';
import { AdminOrdersService } from './admin-orders.service';
import { issueTickets, pad } from './fulfillment.service';
import { PaymentsService } from './payments.service';
import { PhysicalSaleCreate } from './sales.schemas';
import { groupLines, nextCounter, sellDirect } from './stock';

@Injectable()
export class PhysicalSalesService {
  private readonly log = new Logger(PhysicalSalesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EventAccess,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly admin: AdminOrdersService,
  ) {}

  /**
   * Enregistre une vente faite en main propre et émet les billets dans la MÊME transaction :
   * quota contrôlé de façon atomique, vendeur et date tracés, rejeu impossible grâce à la clé d'idempotence.
   */
  async create(user: AuthUser, input: PhysicalSaleCreate, idemKey: string, ip?: string) {
    const prior = await this.prisma.order.findUnique({ where: { idempotencyKey: idemKey }, select: { id: true, soldById: true, eventId: true } });
    if (prior) return this.replay(user, prior, input.eventId);

    const event = await this.access.require(user, input.eventId, 'sale.create');
    if (event.status !== 'PUBLISHED' || computeSalesStatus(event) !== 'OPEN') throw new AppException('SALES_CLOSED', "La billetterie de cet événement n'est pas ouverte.", 409);

    const cats = await this.prisma.ticketCategory.findMany({ where: { eventId: event.id, id: { in: [...new Set(input.tickets.map((t) => t.categoryId))] } } });
    const byId = new Map(cats.map((c) => [c.id, c]));
    const perCat = new Map<string, number>();
    for (const t of input.tickets) {
      const c = byId.get(t.categoryId);
      if (!c) throw new AppException('VALIDATION_ERROR', 'Catégorie de billet inconnue pour cet événement.', 422);
      perCat.set(c.id, (perCat.get(c.id) ?? 0) + 1);
      const a = computeAvailability(c, event);
      if (a === 'SOLD_OUT') throw new AppException('QUOTA_EXCEEDED', `Il n'y a plus de places « ${c.name} ».`, 409);
      if (a !== 'AVAILABLE') throw new AppException('SALES_CLOSED', `La vente « ${c.name} » n'est pas ouverte.`, 409);
    }
    const totalXof = [...perCat].reduce((s, [id, n]) => s + byId.get(id)!.priceXof * n, 0);

    let orderId: string;
    let ticketIds: string[];
    try {
      ({ orderId, ticketIds } = await this.prisma.$transaction(async (tx) => {
        await sellDirect(tx, groupLines([...perCat].map(([categoryId, qty]) => ({ categoryId, eventId: event.id, qty }))), { requireActive: true });
        const reference = `CMD-${pad(await nextCounter(tx, 'order'), 4)}`;
        const now = new Date();
        const order = await tx.order.create({
          data: {
            reference, eventId: event.id, channel: 'PHYSICAL', status: 'PAID', totalXof, paidAt: now, soldById: user.id, idempotencyKey: idemKey,
            sendTicketsEmail: input.sendEmail && !!input.buyer.email,
            buyerFirstName: input.buyer.firstName, buyerLastName: input.buyer.lastName, buyerEmail: input.buyer.email ?? null, buyerPhone: input.buyer.phone ?? null,
          },
        });
        const itemIdByCat = new Map<string, string>();
        for (const [categoryId, quantity] of perCat) {
          const item = await tx.orderItem.create({ data: { orderId: order.id, categoryId, quantity, unitPriceXof: byId.get(categoryId)!.priceXof } });
          itemIdByCat.set(categoryId, item.id);
        }
        await tx.payment.create({
          data: {
            orderId: order.id, provider: 'PHYSICAL', method: input.paymentMethod, status: 'PAID',
            expectedAmountXof: totalXof, confirmedAmountXof: totalXof, confirmedAt: now, receivedById: user.id, providerReference: input.paymentReference ?? null,
          },
        });
        const ids = await issueTickets(tx, { orderId: order.id, eventId: event.id }, input.tickets.map((t) => ({
          itemId: itemIdByCat.get(t.categoryId)!, categoryId: t.categoryId, firstName: t.firstName, lastName: t.lastName, email: t.email ?? null, phone: t.phone ?? null,
        })));
        await this.audit.log({ actorId: user.id, action: 'sale.create', entityType: 'order', entityId: order.id, metadata: { reference, eventId: event.id, tickets: ids.length, totalXof, method: input.paymentMethod }, ip }, tx);
        return { orderId: order.id, ticketIds: ids };
      }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.order.findUnique({ where: { idempotencyKey: idemKey }, select: { id: true, soldById: true, eventId: true } });
        if (again) return this.replay(user, again, input.eventId);
      }
      throw e;
    }
    await this.payments.notifyFulfilled(orderId); // génère toujours les fichiers (remise en main propre) ; l'e-mail dépend de `sendTicketsEmail`
    return { replayed: false, order: await this.admin.detail(orderId), ticketCount: ticketIds.length };
  }

  private async replay(user: AuthUser, prior: { id: string; soldById: string | null; eventId: string }, eventId: string) {
    if (prior.soldById !== user.id || prior.eventId !== eventId) throw conflict('Cette clé de requête a déjà été utilisée.', 'DUPLICATE_REQUEST');
    return { replayed: true, order: await this.admin.detail(prior.id) };
  }

  /** Un vendeur ne voit que ses propres ventes, sauf droit `sale.read_all`. */
  async list(user: AuthUser, q: { page: number; pageSize: number; eventId?: string }) {
    return this.admin.list(user, { ...q, channel: 'PHYSICAL', permission: 'sale.read_all', includeOwnSales: true });
  }
}
