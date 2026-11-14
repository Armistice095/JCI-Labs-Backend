import { Inject, Injectable } from '@nestjs/common';
import { Event, Prisma } from '@prisma/client';
import { can, eventScope } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { forbidden, invalidState, notFound, validation } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { randomSuffix, slugify } from '../common/slug';
import { defaultSalesClose, localToUtc, utcToLocalParts } from '../common/time';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { computeSalesStatus } from '../ticketing/sales-status';
import { EventAccess } from './event-access.service';
import { EventCreate, EventUpdate } from './events.schemas';
import { posterUrl } from './poster-url';
import { missingForPublish } from './publish-validation';
import { PostersService } from './posters.service';

const detailInclude = {
  posters: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }] },
  organizers: { orderBy: { position: 'asc' } },
  programme: { orderBy: { position: 'asc' } },
  createdBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.EventInclude;
type EventDetail = Prisma.EventGetPayload<{ include: typeof detailInclude }>;

interface Aggregate { issued: number; present: number; capacity: number; views: number; revenue: number }
type ListQuery = {
  page: number; pageSize: number; status?: Event['status']; sales?: 'open' | 'not_open' | 'closed'; q?: string;
  sort: 'startsAt' | '-startsAt' | 'createdAt' | '-createdAt'; upcoming?: 'true' | 'false';
};
const ORDER_BY: Record<ListQuery['sort'], Prisma.EventOrderByWithRelationInput[]> = {
  startsAt: [{ startsAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
  '-startsAt': [{ startsAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  createdAt: [{ createdAt: 'asc' }],
  '-createdAt': [{ createdAt: 'desc' }],
};

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EventAccess,
    private readonly audit: AuditService,
    private readonly posters: PostersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────── Lecture ─────────────

  async list(user: AuthUser, q: ListQuery) {
    const scope = eventScope(user, 'event.read');
    const scopeWhere: Prisma.EventWhereInput = scope.all
      ? {}
      : { OR: [...(scope.ownCreated ? [{ createdById: user.id }] : []), ...(scope.eventIds.length ? [{ id: { in: scope.eventIds } }] : [])] };
    const where: Prisma.EventWhereInput = {
      AND: [
        scopeWhere,
        q.status ? { status: q.status } : {},
        q.sales ? this.salesWhere(q.sales) : {},
        q.upcoming === 'true' ? { startsAt: { gte: new Date() } } : {},
        q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { venueName: { contains: q.q, mode: 'insensitive' } }] } : {},
      ],
    };
    const [total, rows, grouped] = await Promise.all([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        include: { posters: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }], take: 1 } },
        orderBy: ORDER_BY[q.sort],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.event.groupBy({ by: ['status'], where: scopeWhere, _count: { _all: true } }),
    ]);
    const agg = await this.aggregates(rows.map((r) => r.id));
    const statusCounts: Record<string, number> = { ALL: 0, DRAFT: 0, PUBLISHED: 0, CLOSED: 0, CANCELLED: 0 };
    for (const g of grouped) { statusCounts[g.status] = g._count._all; statusCounts.ALL += g._count._all; }
    const now = new Date();
    return {
      data: rows.map((e) => this.toSummary(e, e.posters[0]?.storagePath ?? null, agg.get(e.id), user, now)),
      meta: { ...pageMeta(q.page, q.pageSize, total), statusCounts },
    };
  }

  async get(user: AuthUser, id: string) {
    await this.access.require(user, id, 'event.read');
    return this.detail(user, id);
  }

  private async detail(user: AuthUser, id: string) {
    const e = await this.prisma.event.findUniqueOrThrow({ where: { id }, include: detailInclude });
    const agg = await this.aggregates([id]);
    return this.toDetail(e, agg.get(id), user);
  }

  // ───────────── Écriture ─────────────

  async create(user: AuthUser, input: EventCreate, ip?: string) {
    if (!can(user, 'event.create')) throw forbidden();
    if (input.publish && !can(user, 'event.publish', { id: 'new', createdById: user.id })) {
      throw forbidden("Vous n'avez pas le droit de publier : enregistrez l'événement en brouillon.");
    }
    const { startsAt, endsAt } = this.resolveTimes(input, null);
    const venueName = input.venueName ?? '';
    const city = input.city ?? '';
    const description = input.description ?? '';
    if (input.publish) this.assertPublishable({ title: input.title, description, startsAt, endsAt, venueName, city });

    const slug = await this.uniqueSlug(input.title, input.date);
    const salesClosesAt = input.ticketing?.salesClosesAt !== undefined ? input.ticketing.salesClosesAt : input.date ? defaultSalesClose(input.date) : null;
    const salesOpensAt = input.ticketing?.salesOpensAt ?? null;
    this.assertSalesWindow(salesOpensAt, salesClosesAt);

    const id = await this.prisma.$transaction(async (tx) => {
      const ev = await tx.event.create({
        data: {
          slug, title: input.title, category: input.category ?? 'CONFERENCE', description, venueName, city, startsAt, endsAt,
          salesOpensAt, salesClosesAt, maxPerOrder: input.ticketing?.maxPerOrder ?? 5,
          accentColor: input.accentColor ?? null, contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null,
          practicalInfo: input.practicalInfo ?? null, ticketTerms: input.ticketTerms ?? null, refundPolicy: input.refundPolicy ?? null,
          createdById: user.id,
          ...(input.publish ? { status: 'PUBLISHED' as const, publishedAt: new Date() } : {}),
          organizers: { create: (input.organizers ?? []).map((o, i) => ({ name: o.name, description: o.description ?? null, position: i })) },
          programme: { create: (input.programme ?? []).map((p, i) => ({ time: p.time, label: p.label, position: i })) },
          categories: {
            create: (input.categories ?? []).map((c, i) => ({
              name: c.name, priceXof: c.priceXof, quota: c.quota, conditions: c.conditions ?? null,
              saleStartsAt: c.saleStartsAt ?? null, saleEndsAt: c.saleEndsAt ?? null, maxPerOrder: c.maxPerOrder ?? null,
              isActive: c.isActive ?? true, position: i,
            })),
          },
        },
      });
      await this.audit.log({ actorId: user.id, action: 'event.create', entityType: 'event', entityId: ev.id, metadata: { title: ev.title, published: !!input.publish }, ip }, tx);
      return ev.id;
    });
    return this.detail(user, id);
  }

  async update(user: AuthUser, id: string, input: EventUpdate, ip?: string) {
    const ev = await this.access.require(user, id, 'event.update');
    if (ev.status === 'CLOSED' || ev.status === 'CANCELLED') throw invalidState("Un événement clôturé ou annulé n'est plus modifiable.");
    if (input.ticketing && !can(user, 'ticketing.manage', ev)) throw forbidden();

    const { startsAt, endsAt } = this.resolveTimes(input, ev);
    const data: Prisma.EventUpdateInput = {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.venueName !== undefined && { venueName: input.venueName }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.accentColor !== undefined && { accentColor: input.accentColor }),
      ...(input.contactEmail !== undefined && { contactEmail: input.contactEmail }),
      ...(input.contactPhone !== undefined && { contactPhone: input.contactPhone }),
      ...(input.practicalInfo !== undefined && { practicalInfo: input.practicalInfo }),
      ...(input.ticketTerms !== undefined && { ticketTerms: input.ticketTerms }),
      ...(input.refundPolicy !== undefined && { refundPolicy: input.refundPolicy }),
      startsAt, endsAt,
    };
    if (input.ticketing) {
      const opens = input.ticketing.salesOpensAt !== undefined ? input.ticketing.salesOpensAt : ev.salesOpensAt;
      const closes = input.ticketing.salesClosesAt !== undefined ? input.ticketing.salesClosesAt : ev.salesClosesAt;
      this.assertSalesWindow(opens, closes);
      data.salesOpensAt = opens;
      data.salesClosesAt = closes;
      if (input.ticketing.maxPerOrder !== undefined) data.maxPerOrder = input.ticketing.maxPerOrder;
    }
    if (ev.status === 'PUBLISHED') {
      this.assertPublishable({
        title: input.title ?? ev.title, description: input.description ?? ev.description,
        startsAt, endsAt, venueName: input.venueName ?? ev.venueName, city: input.city ?? ev.city,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id }, data });
      if (input.programme) {
        await tx.eventProgramItem.deleteMany({ where: { eventId: id } });
        await tx.eventProgramItem.createMany({ data: input.programme.map((p, i) => ({ eventId: id, time: p.time, label: p.label, position: i })) });
      }
      if (input.organizers) {
        await tx.eventOrganizer.deleteMany({ where: { eventId: id } });
        await tx.eventOrganizer.createMany({ data: input.organizers.map((o, i) => ({ eventId: id, name: o.name, description: o.description ?? null, position: i })) });
      }
      await this.audit.log({ actorId: user.id, action: 'event.update', entityType: 'event', entityId: id, metadata: { fields: Object.keys(input) }, ip }, tx);
    });
    return this.detail(user, id);
  }

  async publish(user: AuthUser, id: string, ip?: string) {
    const ev = await this.access.require(user, id, 'event.publish');
    if (ev.status !== 'DRAFT') throw invalidState('Seul un brouillon peut être publié.');
    this.assertPublishable(ev);
    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      await this.audit.log({ actorId: user.id, action: 'event.publish', entityType: 'event', entityId: id, ip }, tx);
    });
    return this.detail(user, id);
  }

  async close(user: AuthUser, id: string, ip?: string) {
    const ev = await this.access.require(user, id, 'event.close');
    if (ev.status !== 'PUBLISHED') throw invalidState('Seul un événement publié peut être clôturé.');
    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
      await this.audit.log({ actorId: user.id, action: 'event.close', entityType: 'event', entityId: id, ip }, tx);
    });
    return this.detail(user, id);
  }

  async cancel(user: AuthUser, id: string, reason: string, ip?: string) {
    const ev = await this.access.require(user, id, 'event.cancel');
    if (ev.status !== 'PUBLISHED') throw invalidState('Seul un événement publié peut être annulé (supprimez un brouillon).');
    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.audit.log({ actorId: user.id, action: 'event.cancel', entityType: 'event', entityId: id, metadata: { reason }, ip }, tx);
    });
    return this.detail(user, id);
  }

  async remove(user: AuthUser, id: string, ip?: string) {
    const ev = await this.access.require(user, id, 'event.delete_draft');
    if (ev.status !== 'DRAFT') throw invalidState("Seul un brouillon peut être supprimé. Annulez ou clôturez l'événement.");
    if ((await this.prisma.order.count({ where: { eventId: id } })) > 0) throw invalidState('Cet événement a des commandes et ne peut pas être supprimé.');
    await this.posters.removeAllFiles(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.event.delete({ where: { id } });
      await this.audit.log({ actorId: user.id, action: 'event.delete', entityType: 'event', entityId: id, metadata: { title: ev.title }, ip }, tx);
    });
  }

  // ───────────── Helpers ─────────────

  private assertPublishable(e: Parameters<typeof missingForPublish>[0]) {
    const missing = missingForPublish(e);
    if (Object.keys(missing).length) throw validation('Complétez les informations avant de publier.', missing);
  }

  private assertSalesWindow(opens: Date | null, closes: Date | null) {
    if (opens && closes && closes <= opens) throw validation('La clôture doit être après l’ouverture de la billetterie.', { 'ticketing.salesClosesAt': 'La clôture doit être après l’ouverture.' });
  }

  /** Fusionne date/heures reçues avec l'existant (heure locale Africa/Porto-Novo) et retourne des instants UTC. */
  private resolveTimes(input: { date?: string; startTime?: string; endTime?: string }, current: Pick<Event, 'startsAt' | 'endsAt'> | null) {
    const cs = current?.startsAt ? utcToLocalParts(current.startsAt) : null;
    const ce = current?.endsAt ? utcToLocalParts(current.endsAt) : null;
    const date = input.date ?? cs?.date;
    if (!date) {
      if (input.startTime || input.endTime) throw validation('Indiquez la date avant les horaires.', { date: 'La date est obligatoire.' });
      return { startsAt: null as Date | null, endsAt: null as Date | null };
    }
    const startsAt = localToUtc(date, input.startTime ?? cs?.time ?? '08:00');
    const endsAt = localToUtc(date, input.endTime ?? ce?.time ?? '17:00');
    if (endsAt <= startsAt) throw validation("L'heure de fin doit être après le début.", { endTime: "L'heure de fin doit être après le début." });
    return { startsAt, endsAt };
  }

  private async uniqueSlug(title: string, date?: string): Promise<string> {
    const year = date?.slice(0, 4);
    const slug = slugify(title, 50);
    // pas d'année en double quand le titre la contient déjà (« Passation de charge 2026 » → …-2026, pas …-2026-2026)
    const base = [slug, year && !new RegExp(`(^|-)${year}$`).test(slug) ? year : ''].filter(Boolean).join('-');
    let candidate = base;
    for (let i = 0; i < 5; i++) {
      if (!(await this.prisma.event.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
      candidate = `${base}-${randomSuffix()}`;
    }
    return `${base}-${randomSuffix(8)}`;
  }

  private salesWhere(s: 'open' | 'not_open' | 'closed'): Prisma.EventWhereInput {
    const now = new Date();
    if (s === 'open') return { status: 'PUBLISHED', salesManuallyClosed: false, salesOpensAt: { lte: now }, OR: [{ salesClosesAt: null }, { salesClosesAt: { gt: now } }] };
    if (s === 'not_open') return { status: 'PUBLISHED', salesManuallyClosed: false, OR: [{ salesOpensAt: null }, { salesOpensAt: { gt: now } }] };
    return { OR: [{ status: { in: ['CLOSED', 'CANCELLED'] } }, { status: 'PUBLISHED', OR: [{ salesManuallyClosed: true }, { salesClosesAt: { lte: now } }] }] };
  }

  /** Compteurs pour une page d'événements en 4 requêtes groupées (pas de N+1). */
  private async aggregates(ids: string[]): Promise<Map<string, Aggregate>> {
    const out = new Map<string, Aggregate>(ids.map((i) => [i, { issued: 0, present: 0, capacity: 0, views: 0, revenue: 0 }]));
    if (!ids.length) return out;
    const [tickets, caps, views, revenue] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['eventId', 'status'], where: { eventId: { in: ids } }, _count: { _all: true } }),
      this.prisma.ticketCategory.groupBy({ by: ['eventId'], where: { eventId: { in: ids }, isActive: true }, _sum: { quota: true } }),
      this.prisma.eventViewDaily.groupBy({ by: ['eventId'], where: { eventId: { in: ids } }, _sum: { views: true } }),
      this.prisma.order.groupBy({ by: ['eventId'], where: { eventId: { in: ids }, status: 'PAID' }, _sum: { totalXof: true } }),
    ]);
    for (const t of tickets) {
      const a = out.get(t.eventId)!;
      if (t.status === 'VALID' || t.status === 'USED') a.issued += t._count._all;
      if (t.status === 'USED') a.present += t._count._all;
    }
    for (const c of caps) out.get(c.eventId)!.capacity = c._sum.quota ?? 0;
    for (const v of views) out.get(v.eventId)!.views = v._sum.views ?? 0;
    for (const r of revenue) out.get(r.eventId)!.revenue = r._sum.totalXof ?? 0;
    return out;
  }

  private toSummary(e: Event, coverPath: string | null, agg: Aggregate | undefined, user: AuthUser, now: Date) {
    const a = agg ?? { issued: 0, present: 0, capacity: 0, views: 0, revenue: 0 };
    const canSeeRevenue = can(user, 'finance.view', e) || can(user, 'order.read', e);
    return {
      id: e.id, slug: e.slug, title: e.title, category: e.category, status: e.status,
      salesStatus: computeSalesStatus(e, now),
      startsAt: e.startsAt, venueName: e.venueName, city: e.city,
      coverUrl: coverPath ? posterUrl(this.env, coverPath) : null,
      views: a.views, ticketsIssued: a.issued, capacity: a.capacity,
      revenueXof: canSeeRevenue && e.status !== 'DRAFT' ? a.revenue : null,
      presentCount: e.startsAt && now >= e.startsAt ? a.present : null,
    };
  }

  private toDetail(e: EventDetail, agg: Aggregate | undefined, user: AuthUser) {
    const local = e.startsAt ? utcToLocalParts(e.startsAt) : null;
    const localEnd = e.endsAt ? utcToLocalParts(e.endsAt) : null;
    return {
      ...this.toSummary(e, e.posters[0]?.storagePath ?? null, agg, user, new Date()),
      description: e.description,
      endsAt: e.endsAt,
      date: local?.date ?? null, startTime: local?.time ?? null, endTime: localEnd?.time ?? null,
      posters: e.posters.map((p) => ({ id: p.id, url: posterUrl(this.env, p.storagePath), isCover: p.isCover, position: p.position, width: p.width, height: p.height })),
      organizers: e.organizers.map((o) => ({ name: o.name, description: o.description })),
      programme: e.programme.map((p) => ({ time: p.time, label: p.label })),
      accentColor: e.accentColor, contactEmail: e.contactEmail, contactPhone: e.contactPhone,
      practicalInfo: e.practicalInfo, ticketTerms: e.ticketTerms, refundPolicy: e.refundPolicy,
      publicUrl: e.status === 'DRAFT' ? null : `${this.env.PUBLIC_WEB_URL}/evenements/${e.slug}`,
      createdBy: `${e.createdBy.firstName} ${e.createdBy.lastName}`,
      createdAt: e.createdAt,
    };
  }
}
