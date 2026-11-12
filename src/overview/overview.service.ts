import { Injectable } from '@nestjs/common';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { EventAccess } from '../events/event-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { remaining } from '../ticketing/sales-status';

const ACTIVITY_LIMIT = 10;

export type ActivityType = 'TICKET_ISSUED' | 'TICKET_CHECKED_IN' | 'TICKET_CANCELLED';

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService, private readonly access: EventAccess) {}

  /** Activité récente : derniers billets émis, scannés à l'entrée ou annulés. */
  private async activity(eventId: string) {
    const select = { id: true, number: true, holderFirstName: true, holderLastName: true, category: { select: { name: true } } } as const;
    const [issued, checkedIn, cancelled] = await Promise.all([
      this.prisma.ticket.findMany({ where: { eventId }, orderBy: { issuedAt: 'desc' }, take: ACTIVITY_LIMIT, select: { ...select, issuedAt: true } }),
      this.prisma.ticket.findMany({ where: { eventId, checkedInAt: { not: null } }, orderBy: { checkedInAt: 'desc' }, take: ACTIVITY_LIMIT, select: { ...select, checkedInAt: true } }),
      this.prisma.ticket.findMany({ where: { eventId, cancelledAt: { not: null } }, orderBy: { cancelledAt: 'desc' }, take: ACTIVITY_LIMIT, select: { ...select, cancelledAt: true } }),
    ]);
    const item = (type: ActivityType, at: Date, t: { id: string; number: string; holderFirstName: string; holderLastName: string; category: { name: string } }) =>
      ({ type, at, ticketId: t.id, ticketNumber: t.number, holderName: `${t.holderFirstName} ${t.holderLastName}`, category: t.category.name });
    return [
      ...issued.map((t) => item('TICKET_ISSUED', t.issuedAt, t)),
      ...checkedIn.map((t) => item('TICKET_CHECKED_IN', t.checkedInAt!, t)),
      ...cancelled.map((t) => item('TICKET_CANCELLED', t.cancelledAt!, t)),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, ACTIVITY_LIMIT);
  }

  /**
   * Onglet « Vue d'ensemble » : tout utilisateur qui voit l'événement.
   * Les recettes exigent `finance.view` ou `order.read` (sinon `null`), l'activité (noms des participants) exige `participant.read` (sinon `null`).
   */
  async get(user: AuthUser, eventId: string) {
    const ev = await this.access.require(user, eventId, 'event.read');
    const canSeeRevenue = ev.status !== 'DRAFT' && (can(user, 'finance.view', ev) || can(user, 'order.read', ev));
    const canSeeActivity = can(user, 'participant.read', ev);

    const [categories, revenueRows, views, grouped, activity] = await Promise.all([
      this.prisma.ticketCategory.findMany({ where: { eventId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      canSeeRevenue
        ? this.prisma.$queryRaw<{ category_id: string; revenue: number | bigint }[]>`
            SELECT oi.category_id, COALESCE(SUM(oi.quantity * oi.unit_price_xof), 0)::int AS revenue
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.event_id = ${eventId}::uuid AND o.status = 'PAID'
            GROUP BY oi.category_id`
        : Promise.resolve([]),
      this.prisma.eventViewDaily.aggregate({ where: { eventId }, _sum: { views: true } }),
      this.prisma.ticket.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } }),
      canSeeActivity ? this.activity(eventId) : Promise.resolve(null),
    ]);

    const revenueOf = new Map(revenueRows.map((r) => [r.category_id, Number(r.revenue)]));
    const rows = categories.map((c) => ({
      id: c.id, name: c.name, priceXof: c.priceXof, isActive: c.isActive,
      quota: c.quota, sold: c.soldCount, reserved: c.reservedCount, remaining: remaining(c),
      revenueXof: canSeeRevenue ? revenueOf.get(c.id) ?? 0 : null,
    }));
    const active = rows.filter((c) => c.isActive);
    const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;

    return {
      eventId,
      kpis: {
        revenueXof: canSeeRevenue ? rows.reduce((a, c) => a + (c.revenueXof ?? 0), 0) : null,
        views: views._sum.views ?? 0,
        ticketsIssued: count('VALID') + count('USED'),
        capacity: active.reduce((a, c) => a + c.quota, 0),
        remaining: active.reduce((a, c) => a + c.remaining, 0),
      },
      categories: rows,
      activity,
    };
  }
}
