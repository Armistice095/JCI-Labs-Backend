import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { can, eventScope } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { notFound } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { EventAccess } from '../events/event-access.service';
import { OrderListQuery } from './sales.schemas';

const include = {
  items: { include: { category: { select: { name: true, position: true } } } },
  payments: { orderBy: { createdAt: 'desc' } },
  soldBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.OrderInclude;
type OrderFull = Prisma.OrderGetPayload<{ include: typeof include }>;

interface ListOpts extends Partial<OrderListQuery> {
  page: number; pageSize: number;
  channel?: 'ONLINE' | 'PHYSICAL';
  /** Permission qui ouvre la lecture de toutes les commandes du périmètre (défaut : finance.view). */
  permission?: string;
  /** Ajoute les commandes enregistrées par l'utilisateur lui-même (vendeur), sur les événements où il peut vendre. */
  includeOwnSales?: boolean;
}

/** Traduit un périmètre d'événements en filtre sur les commandes. Périmètre vide = aucun résultat. */
function scopeWhere(scope: ReturnType<typeof eventScope>, userId: string): Prisma.OrderWhereInput | 'ALL' {
  if (scope.all) return 'ALL';
  return { OR: [
    ...(scope.ownCreated ? [{ event: { createdById: userId } }] : []),
    ...(scope.eventIds.length ? [{ eventId: { in: scope.eventIds } }] : []),
  ] };
}

@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly access: EventAccess) {}

  private summary(o: OrderFull) {
    const shown = o.payments.find((p) => p.status === 'PAID') ?? o.payments[0];
    const items = [...o.items].sort((a, b) => a.category.position - b.category.position).map((i) => `${i.quantity} × ${i.category.name}`).join(', ');
    return {
      id: o.id, reference: o.reference, providerReference: shown?.providerReference ?? null, eventId: o.eventId,
      buyerName: `${o.buyerFirstName} ${o.buyerLastName}`, channel: o.channel, items, amountXof: o.totalXof,
      paymentMethod: shown?.method ?? 'UNKNOWN', status: o.status,
      soldBy: o.soldBy ? `${o.soldBy.firstName} ${o.soldBy.lastName}` : null, createdAt: o.createdAt,
    };
  }

  /** Commandes d'un événement (onglet « Paiements ») : droit `order.read` sur cet événement. */
  async listForEvent(user: AuthUser, eventId: string, q: OrderListQuery) {
    await this.access.require(user, eventId, 'order.read');
    return this.query({ AND: [{ eventId }, this.search(q.q)] }, { eventId }, q, q.status);
  }

  /** Liste transverse (tableau de bord, ventes physiques). */
  async list(user: AuthUser, q: ListOpts) {
    const readable = scopeWhere(eventScope(user, q.permission ?? 'finance.view'), user.id);
    const sellable = scopeWhere(eventScope(user, 'sale.create'), user.id);
    const own: Prisma.OrderWhereInput = { AND: [{ soldById: user.id }, sellable === 'ALL' ? {} : sellable] };
    // Un filtre vide ({}) dans un OR ne se comporte pas comme « tout » : on traite « tout le périmètre » explicitement.
    const visible: Prisma.OrderWhereInput = readable === 'ALL' ? {} : q.includeOwnSales ? { OR: [readable, own] } : readable;
    const where: Prisma.OrderWhereInput = { AND: [visible, q.channel ? { channel: q.channel } : {}, q.eventId ? { eventId: q.eventId } : {}, this.search(q.q)] };
    return this.query(where, undefined, q, q.status);
  }

  private search(q?: string): Prisma.OrderWhereInput {
    if (!q) return {};
    return { OR: [
      { reference: { contains: q, mode: 'insensitive' } },
      { buyerLastName: { contains: q, mode: 'insensitive' } },
      { buyerFirstName: { contains: q, mode: 'insensitive' } },
      { payments: { some: { providerReference: { contains: q, mode: 'insensitive' } } } },
    ] };
  }

  private async query(where: Prisma.OrderWhereInput, countScope: { eventId: string } | undefined, q: { page: number; pageSize: number }, status?: OrderListQuery['status']) {
    const statusWhere: Prisma.OrderWhereInput = !status ? {} : status === 'PENDING' ? { status: { in: ['PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS'] } } : { status };
    const full: Prisma.OrderWhereInput = { AND: [where, statusWhere] };
    const [total, rows, grouped] = await Promise.all([
      this.prisma.order.count({ where: full }),
      this.prisma.order.findMany({ where: full, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const statusCounts: Record<string, number> = { ALL: 0 };
    for (const g of grouped) { statusCounts[g.status] = g._count._all; statusCounts.ALL += g._count._all; }
    statusCounts.PENDING = (statusCounts.PENDING_PAYMENT ?? 0) + (statusCounts.PAYMENT_IN_PROGRESS ?? 0); // pastille « En attente »
    return { data: rows.map((o) => this.summary(o)), meta: { ...pageMeta(q.page, q.pageSize, total), statusCounts } };
  }

  async detail(orderId: string, user?: AuthUser) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { ...include, tickets: { include: { category: { select: { name: true } } }, orderBy: { number: 'asc' } } },
    });
    if (!o) throw notFound('Commande introuvable.');
    if (user) {
      const ev = await this.prisma.event.findUniqueOrThrow({ where: { id: o.eventId }, select: { id: true, createdById: true } });
      const own = o.soldById === user.id && can(user, 'sale.create', ev);
      if (!own && !can(user, 'order.read', ev)) throw notFound('Commande introuvable.');
    }
    return {
      ...this.summary(o),
      buyerEmail: o.buyerEmail, buyerPhone: o.buyerPhone,
      tickets: o.tickets.map((t) => ({
        ticketId: t.id, ticketNumber: t.number, fullName: `${t.holderFirstName} ${t.holderLastName}`, phone: t.holderPhone, email: t.holderEmail,
        category: t.category.name, ticketStatus: t.status, checkedInAt: t.checkedInAt,
      })),
      payments: o.payments.map((p) => ({
        status: p.status, method: p.method, expectedAmountXof: p.expectedAmountXof, confirmedAmountXof: p.confirmedAmountXof,
        confirmedAt: p.confirmedAt, failureReason: p.failureReason,
      })),
    };
  }
}
