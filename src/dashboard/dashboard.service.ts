import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { can, eventScope, hasPermissionAnywhere } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { forbidden } from '../common/errors';
import { ENV, Env } from '../config/env';
import { posterUrl } from '../events/poster-url';
import { PrismaService } from '../prisma/prisma.service';
import { computeSalesStatus } from '../ticketing/sales-status';
import { DashboardQuery } from './dashboard.schemas';

const TZ = 'Africa/Porto-Novo'; // UTC+1 toute l'année : les « jours » du graphique sont des jours du Bénin
const UPCOMING_LIMIT = 5;
const CATEGORY_LIMIT = 5; // au-delà, regroupé dans « Autres »

/** Date du jour au Bénin (AAAA-MM-JJ), décalée de `minusDays` jours. */
function localDay(now: Date, minusDays = 0): string {
  return new Date(now.getTime() + 3600e3 - minusDays * 86400e3).toISOString().slice(0, 10);
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env) {}

  /**
   * Tableau de bord global : permission `dashboard.view`. Porte sur tous les événements que l'utilisateur peut voir (`event.read`), brouillons exclus.
   * Les montants n'incluent que les événements où il a `finance.view` ou `order.read` ; sans ce droit nulle part, ils valent `null`.
   */
  async get(user: AuthUser, q: DashboardQuery, now = new Date()) {
    if (!hasPermissionAnywhere(user, 'dashboard.view')) throw forbidden();
    const scope = eventScope(user, 'event.read');
    const scopeWhere: Prisma.EventWhereInput = scope.all ? {} : { OR: [
      ...(scope.ownCreated ? [{ createdById: user.id }] : []),
      ...(scope.eventIds.length ? [{ id: { in: scope.eventIds } }] : []),
    ] };
    const events = await this.prisma.event.findMany({
      where: { AND: [scopeWhere, { status: { not: 'DRAFT' } }] },
      select: { id: true, createdById: true, status: true, title: true, startsAt: true, endsAt: true, salesOpensAt: true, salesClosesAt: true, salesManuallyClosed: true },
    });
    const ids = events.map((e) => e.id);
    const revenueIds = events.filter((e) => can(user, 'finance.view', e) || can(user, 'order.read', e)).map((e) => e.id);
    const live = events.filter((e) => e.status === 'PUBLISHED' || e.status === 'CLOSED');
    // Le droit se lit dans les rôles, pas dans les événements : un administrateur sans événement voit « 0 », pas un tiret.
    const hasScope = (permission: string) => { const sc = eventScope(user, permission); return sc.all || sc.ownCreated || sc.eventIds.length > 0; };
    const canSeeRevenue = hasScope('finance.view') || hasScope('order.read');

    const from = localDay(now, q.range - 1);
    const [revenueAgg, issuedAgg, fillAgg, revenueByDay, ticketsByDay, byCategory, upcoming] = await Promise.all([
      canSeeRevenue
        ? this.prisma.order.aggregate({ where: { eventId: { in: revenueIds }, status: 'PAID' }, _sum: { totalXof: true } })
        : Promise.resolve(null),
      this.prisma.ticket.count({ where: { eventId: { in: ids }, status: { in: ['VALID', 'USED'] } } }),
      this.prisma.ticketCategory.aggregate({ where: { eventId: { in: live.map((e) => e.id) }, isActive: true }, _sum: { quota: true, soldCount: true } }),
      canSeeRevenue
        ? this.prisma.$queryRaw<{ day: string; revenue: number }[]>`
            SELECT to_char((paid_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(total_xof), 0)::int AS revenue
            FROM orders
            WHERE event_id = ANY(${revenueIds}::uuid[]) AND status = 'PAID' AND paid_at IS NOT NULL AND (paid_at AT TIME ZONE ${TZ})::date >= ${from}::date
            GROUP BY 1`
        : Promise.resolve([]),
      this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char((issued_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
        FROM tickets
        WHERE event_id = ANY(${ids}::uuid[]) AND status::text IN ('VALID', 'USED') AND (issued_at AT TIME ZONE ${TZ})::date >= ${from}::date
        GROUP BY 1`,
      this.prisma.$queryRaw<{ name: string; n: number }[]>`
        SELECT MIN(c.name) AS name, COUNT(*)::int AS n
        FROM tickets t JOIN ticket_categories c ON c.id = t.category_id
        WHERE t.event_id = ANY(${ids}::uuid[]) AND t.status::text IN ('VALID', 'USED')
        GROUP BY lower(btrim(c.name))
        ORDER BY n DESC, 1`,
      this.upcoming(live.filter((e) => e.status === 'PUBLISHED' && (e.endsAt ?? e.startsAt) !== null && (e.endsAt ?? e.startsAt)! >= now), now),
    ]);

    const capacity = fillAgg._sum.quota ?? 0;
    const sold = fillAgg._sum.soldCount ?? 0;

    const revenueOf = new Map(revenueByDay.map((r) => [r.day, Number(r.revenue)]));
    const ticketsOf = new Map(ticketsByDay.map((r) => [r.day, Number(r.n)]));
    const points = Array.from({ length: q.range }, (_, i) => {
      const date = localDay(now, q.range - 1 - i);
      return { date, revenueXof: canSeeRevenue ? revenueOf.get(date) ?? 0 : null, tickets: ticketsOf.get(date) ?? 0 };
    });

    const total = byCategory.reduce((a, c) => a + Number(c.n), 0);
    const head = byCategory.slice(0, CATEGORY_LIMIT);
    const rest = byCategory.slice(CATEGORY_LIMIT).reduce((a, c) => a + Number(c.n), 0);
    const share = (n: number) => (total ? Math.round((n * 100) / total) : 0);
    const categories = [
      ...head.map((c) => ({ name: c.name, count: Number(c.n), percent: share(Number(c.n)) })),
      ...(rest > 0 ? [{ name: 'Autres', count: rest, percent: share(rest) }] : []),
    ];

    return {
      kpis: {
        revenueXof: canSeeRevenue ? revenueAgg?._sum.totalXof ?? 0 : null,
        fillRatePercent: capacity > 0 ? Math.min(100, Math.round((sold * 100) / capacity)) : null,
        ticketsIssued: issuedAgg,
        eventsCount: live.length,
      },
      sales: {
        range: q.range,
        points,
        totalRevenueXof: canSeeRevenue ? points.reduce((a, p) => a + (p.revenueXof ?? 0), 0) : null,
        totalTickets: points.reduce((a, p) => a + p.tickets, 0),
      },
      ticketsByCategory: { total, categories },
      upcomingEvents: upcoming,
    };
  }

  /** « Événements proches » : publiés et pas encore terminés, du plus proche au plus lointain. */
  private async upcoming(
    candidates: { id: string; title: string; startsAt: Date | null; status: 'PUBLISHED' | 'CLOSED' | 'DRAFT' | 'CANCELLED'; salesOpensAt: Date | null; salesClosesAt: Date | null; salesManuallyClosed: boolean }[],
    now: Date,
  ) {
    const next = [...candidates].sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0)).slice(0, UPCOMING_LIMIT);
    if (!next.length) return [];
    const evIds = next.map((e) => e.id);
    const [posters, caps, issued] = await Promise.all([
      this.prisma.eventPoster.findMany({ where: { eventId: { in: evIds } }, orderBy: [{ isCover: 'desc' }, { position: 'asc' }] }),
      this.prisma.ticketCategory.groupBy({ by: ['eventId'], where: { eventId: { in: evIds }, isActive: true }, _sum: { quota: true } }),
      this.prisma.ticket.groupBy({ by: ['eventId'], where: { eventId: { in: evIds }, status: { in: ['VALID', 'USED'] } }, _count: { _all: true } }),
    ]);
    return next.map((e) => {
      const cover = posters.find((p) => p.eventId === e.id);
      return {
        id: e.id, title: e.title, startsAt: e.startsAt,
        coverUrl: cover ? posterUrl(this.env, cover.storagePath) : null,
        salesStatus: computeSalesStatus(e, now),
        ticketsIssued: issued.find((g) => g.eventId === e.id)?._count._all ?? 0,
        capacity: caps.find((g) => g.eventId === e.id)?._sum.quota ?? 0,
      };
    });
  }
}
