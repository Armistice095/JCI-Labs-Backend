import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { notFound, validation } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { utcToLocalParts } from '../common/time';
import { EventAccess } from '../events/event-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { TEMPLATE_VERSION } from '../tickets/ticket-files.service';
import { buildCsv, buildXlsx, ExportRow } from './participants.export';
import { EMAIL_FR, EmailDelivery, METHOD_FR, PAYMENT_STATUS_FR, PRESENCE_FR, presenceOf } from './participants.labels';
import { ParticipantExportQuery, ParticipantListQuery, Presence } from './participants.schemas';

const MAX_EXPORT_ROWS = 10_000;
const MAX_SEARCH_TOKENS = 6;

const include = {
  category: { select: { id: true, name: true } },
  orderItem: { select: { unitPriceXof: true } },
  order: {
    select: {
      id: true, reference: true, channel: true, status: true, createdAt: true, sendTicketsEmail: true,
      payments: { select: { status: true, method: true }, orderBy: { createdAt: 'desc' } },
    },
  },
} satisfies Prisma.TicketInclude;
type TicketRow = Prisma.TicketGetPayload<{ include: typeof include }>;

type Filters = Pick<ParticipantListQuery, 'q' | 'categoryId' | 'presence' | 'sort' | 'dir'>;

const PRESENCE_STATUSES: Record<Presence, Prisma.TicketWhereInput> = {
  UPCOMING: { status: 'VALID' },
  PRESENT: { status: 'USED' },
  CANCELLED: { status: { in: ['CANCELLED', 'REFUNDED'] } },
};

@Injectable()
export class ParticipantsService {
  constructor(private readonly prisma: PrismaService, private readonly access: EventAccess, private readonly audit: AuditService) {}

  /** Événement + catégorie + recherche (sans le filtre de présence : il sert aussi aux compteurs). */
  private baseWhere(eventId: string, f: Pick<Filters, 'q' | 'categoryId'>): Prisma.TicketWhereInput {
    // Chaque mot doit se retrouver quelque part (nom, prénom, e-mail, téléphone, référence du billet ou de la commande) : « paul soule » fonctionne.
    const tokens = (f.q ?? '').split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
    return {
      eventId,
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      AND: tokens.map((t) => ({
        OR: [
          { holderFirstName: { contains: t, mode: 'insensitive' as const } },
          { holderLastName: { contains: t, mode: 'insensitive' as const } },
          { holderEmail: { contains: t, mode: 'insensitive' as const } },
          { holderPhone: { contains: t } },
          { number: { contains: t, mode: 'insensitive' as const } },
          { order: { reference: { contains: t, mode: 'insensitive' as const } } },
        ],
      })),
    };
  }

  private orderBy(f: Pick<Filters, 'sort' | 'dir'>): Prisma.TicketOrderByWithRelationInput[] {
    const tie: Prisma.TicketOrderByWithRelationInput = { number: 'asc' }; // ordre stable entre deux pages
    switch (f.sort) {
      case 'name': return [{ holderLastName: f.dir }, { holderFirstName: f.dir }, tie];
      case 'purchasedAt': return [{ order: { createdAt: f.dir } }, tie];
      case 'category': return [{ category: { name: f.dir } }, tie];
      default: return [{ number: f.dir }];
    }
  }

  /** Dernier état connu de l'e-mail : envoi de confirmation (rattaché à la commande) ou dernier renvoi manuel (rattaché au billet). */
  private async emailStatuses(rows: TicketRow[]): Promise<Map<string, EmailDelivery>> {
    const out = new Map<string, EmailDelivery>();
    if (!rows.length) return out;
    const logs = await this.prisma.emailLog.findMany({
      where: { OR: [{ ticketId: { in: rows.map((r) => r.id) } }, { ticketId: null, orderId: { in: [...new Set(rows.map((r) => r.orderId))] } }] },
      select: { ticketId: true, orderId: true, status: true },
      orderBy: { createdAt: 'desc' },
    });
    for (const r of rows) {
      const last = logs.find((l) => l.ticketId === r.id || (l.ticketId === null && l.orderId === r.orderId));
      out.set(r.id, last?.status ?? (r.order.sendTicketsEmail ? 'NOT_SENT' : 'NOT_REQUESTED'));
    }
    return out;
  }

  private shape(t: TicketRow, email: EmailDelivery) {
    const payment = t.order.payments.find((p) => p.status === 'PAID') ?? t.order.payments[0];
    return {
      ticketId: t.id, ticketNumber: t.number,
      firstName: t.holderFirstName, lastName: t.holderLastName, phone: t.holderPhone, email: t.holderEmail,
      categoryId: t.category.id, category: t.category.name, amountXof: t.orderItem.unitPriceXof,
      paymentStatus: t.order.status, paymentMethod: payment?.method ?? 'UNKNOWN',
      ticketStatus: t.status, presence: presenceOf(t.status), checkedInAt: t.checkedInAt,
      purchasedAt: t.order.createdAt, orderId: t.order.id, orderReference: t.order.reference, channel: t.order.channel,
      emailStatus: email,
    };
  }

  private async load(where: Prisma.TicketWhereInput, orderBy: Prisma.TicketOrderByWithRelationInput[], page?: { skip: number; take: number }) {
    const rows = await this.prisma.ticket.findMany({ where, include, orderBy, ...(page ?? {}) });
    const emails = await this.emailStatuses(rows);
    return rows.map((r) => this.shape(r, emails.get(r.id)!));
  }

  /** Onglet « Participants » : droit `participant.read` sur l'événement. */
  async list(user: AuthUser, eventId: string, q: ParticipantListQuery) {
    await this.access.require(user, eventId, 'participant.read');
    const base = this.baseWhere(eventId, q);
    const where: Prisma.TicketWhereInput = q.presence ? { AND: [base, PRESENCE_STATUSES[q.presence]] } : base;
    const [total, data, grouped] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.load(where, this.orderBy(q), { skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.ticket.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const n = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const counts = { ALL: grouped.reduce((a, g) => a + g._count._all, 0), UPCOMING: n('VALID'), PRESENT: n('USED'), CANCELLED: n('CANCELLED') + n('REFUNDED') };
    return { data, meta: { ...pageMeta(q.page, q.pageSize, total), counts } };
  }

  /** « Voir le billet » : droit `participant.read`, ou le vendeur qui a enregistré la vente (comme pour les fichiers). */
  async detail(user: AuthUser, ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        category: { select: { id: true, name: true } },
        orderItem: { select: { unitPriceXof: true } },
        event: { select: { id: true, title: true, createdById: true } },
        order: {
          select: {
            id: true, reference: true, channel: true, status: true, createdAt: true, paidAt: true, soldById: true,
            buyerFirstName: true, buyerLastName: true, buyerEmail: true, buyerPhone: true, sendTicketsEmail: true,
            payments: { select: { status: true, method: true, providerReference: true }, orderBy: { createdAt: 'desc' } },
            soldBy: { select: { firstName: true, lastName: true } },
          },
        },
        checkedInBy: { select: { firstName: true, lastName: true } },
        cancelledBy: { select: { firstName: true, lastName: true } },
      },
    });
    const allowed = t && can(user, 'event.read', t.event) && (can(user, 'participant.read', t.event) || (t.order.soldById === user.id && can(user, 'sale.create', t.event)));
    if (!t || !allowed) throw notFound('Billet introuvable.');

    const [emails, files] = await Promise.all([
      this.prisma.emailLog.findMany({
        where: { OR: [{ ticketId }, { ticketId: null, orderId: t.order.id }] },
        select: { template: true, toEmail: true, status: true, attempt: true, sentAt: true, lastEventAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' }, take: 20,
      }),
      this.prisma.generatedFile.count({ where: { ticketId, templateVersion: TEMPLATE_VERSION, kind: { in: ['TICKET_PDF', 'TICKET_IMAGE'] } } }),
    ]);
    const payment = t.order.payments.find((p) => p.status === 'PAID') ?? t.order.payments[0];
    const name = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : null);
    return {
      ticketId: t.id, ticketNumber: t.number, eventId: t.event.id, eventTitle: t.event.title,
      holder: { firstName: t.holderFirstName, lastName: t.holderLastName, email: t.holderEmail, phone: t.holderPhone },
      category: { id: t.category.id, name: t.category.name }, amountXof: t.orderItem.unitPriceXof,
      ticketStatus: t.status, presence: presenceOf(t.status), issuedAt: t.issuedAt,
      checkedInAt: t.checkedInAt, checkedInBy: name(t.checkedInBy),
      cancelledAt: t.cancelledAt, cancelledBy: name(t.cancelledBy), cancelReason: t.cancelReason,
      order: {
        id: t.order.id, reference: t.order.reference, channel: t.order.channel, status: t.order.status,
        buyerName: `${t.order.buyerFirstName} ${t.order.buyerLastName}`, buyerEmail: t.order.buyerEmail, buyerPhone: t.order.buyerPhone,
        paymentMethod: payment?.method ?? 'UNKNOWN', paymentReference: payment?.providerReference ?? null,
        createdAt: t.order.createdAt, paidAt: t.order.paidAt, soldBy: name(t.order.soldBy),
      },
      emails: emails.map((e) => ({ template: e.template, toEmail: e.toEmail, status: e.status, attempt: e.attempt, sentAt: e.sentAt, lastEventAt: e.lastEventAt, createdAt: e.createdAt })),
      filesReady: files >= 2,
    };
  }

  /** Export CSV ou Excel de la liste filtrée : droit `participant.export`. */
  async export(user: AuthUser, eventId: string, q: ParticipantExportQuery, ip?: string) {
    const ev = await this.access.require(user, eventId, 'participant.export');
    const base = this.baseWhere(eventId, q);
    const where: Prisma.TicketWhereInput = q.presence ? { AND: [base, PRESENCE_STATUSES[q.presence]] } : base;
    const total = await this.prisma.ticket.count({ where });
    if (total > MAX_EXPORT_ROWS) throw validation(`Trop de lignes à exporter (${total}, maximum ${MAX_EXPORT_ROWS}). Affinez les filtres.`);

    const rows = await this.load(where, this.orderBy(q));
    const fmt = (d: Date | null) => { if (!d) return ''; const p = utcToLocalParts(d); return `${p.date.split('-').reverse().join('/')} ${p.time}`; };
    const data: ExportRow[] = rows.map((r, i) => ({
      n: i + 1, lastName: r.lastName, firstName: r.firstName, phone: r.phone ?? '', email: r.email ?? '', category: r.category,
      ticketNumber: r.ticketNumber, amountXof: r.amountXof, payment: PAYMENT_STATUS_FR[r.paymentStatus] ?? r.paymentStatus,
      method: METHOD_FR[r.paymentMethod], presence: PRESENCE_FR[r.presence], purchasedAt: fmt(r.purchasedAt), checkedInAt: fmt(r.checkedInAt),
      emailStatus: EMAIL_FR[r.emailStatus], orderReference: r.orderReference,
    }));

    await this.audit.log({ actorId: user.id, action: 'participants.export', entityType: 'event', entityId: eventId, metadata: { format: q.format, rows: data.length, q: q.q ?? null, categoryId: q.categoryId ?? null, presence: q.presence ?? null }, ip });

    const day = utcToLocalParts(new Date()).date.replaceAll('-', '');
    const fileName = `participants-${ev.slug}-${day}.${q.format}`;
    return q.format === 'xlsx'
      ? { buffer: await buildXlsx(data), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName }
      : { buffer: buildCsv(data), contentType: 'text/csv; charset=utf-8', fileName };
  }
}
