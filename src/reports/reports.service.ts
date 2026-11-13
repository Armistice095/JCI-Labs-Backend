import { Inject, Injectable } from '@nestjs/common';
import { Event, Prisma } from '@prisma/client';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { forbidden, invalidState, validation } from '../common/errors';
import { EventAccess } from '../events/event-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeSalesStatus } from '../ticketing/sales-status';
import { RendererService } from '../tickets/renderer.service';
import { bucketize, dateLong, dateShort, eventDates, eventHours, fileSafe, hourlyBars, int, pct, phoneFr, timeFr, weekCaption } from './report-format';
import {
  AnomalyRow, AttendanceBlock, AttendanceReport, attendanceHtml, PaymentsReport, paymentsHtml, ParticipantsReport, participantsHtml, PaymentTone,
  ReportMeta, TicketingReport, ticketingHtml,
} from './report-html';
import { MAX_REPORT_ROWS, REPORT_KINDS, ReportKind } from './reports.schemas';
import { utcToLocalParts } from '../common/time';

const ORG = 'JCI Comé Excellence';

const CATALOG: Record<ReportKind, { title: string; description: string; file: string }> = {
  participants: { title: 'Liste des participants', description: 'Noms, téléphones et e-mails des participants inscrits.', file: 'liste-participants' },
  ticketing: { title: 'Rapport de billetterie', description: 'Synthèse des ventes, des recettes et des présences.', file: 'rapport-billetterie' },
  attendance: { title: 'Liste des présences', description: 'Scans valides et anomalies à l’entrée.', file: 'liste-presences' },
  payments: { title: 'Journal des paiements', description: 'Commandes et transactions FedaPay.', file: 'journal-paiements' },
};

/** Chaque rapport exige `report.view` plus le droit sur les données qu'il contient (personnes, recettes, entrées). */
function allowed(user: AuthUser, ev: Event, kind: ReportKind): boolean {
  if (!can(user, 'report.view', ev)) return false;
  switch (kind) {
    case 'participants': return can(user, 'participant.export', ev);
    case 'attendance': return can(user, 'checkin.view', ev);
    default: return can(user, 'finance.view', ev) || can(user, 'order.read', ev); // billetterie et paiements : montants
  }
}

const ANOMALIES: Record<string, { label: string; detail: string }> = {
  ALREADY_USED: { label: 'Billet déjà scanné', detail: 'Tentative d’entrée avec un billet déjà validé' },
  INVALID: { label: 'Billet non reconnu', detail: 'Code introuvable dans la base' },
  REFUNDED: { label: 'Billet remboursé', detail: 'Billet présenté après remboursement' },
  CANCELLED: { label: 'Billet annulé', detail: 'Billet présenté après annulation' },
  PAYMENT_NOT_CONFIRMED: { label: 'Paiement non confirmé', detail: 'Billet dont le paiement n’est pas confirmé' },
  WRONG_EVENT: { label: 'Billet d’un autre événement', detail: 'Billet présenté à l’entrée d’un autre événement' },
  EVENT_NOT_ACTIVE: { label: 'Événement non ouvert', detail: 'Scan effectué alors que le contrôle n’était pas ouvert' },
};
const ANOMALY_ORDER = Object.keys(ANOMALIES);
const NOT_ANOMALIES = ['VALID', 'MANUAL_ADMIT'];

const PAY_STATUS: Record<string, { label: string; tone: PaymentTone }> = {
  PAID: { label: 'Approuvée', tone: 'ok' }, REFUNDED: { label: 'Remboursée', tone: 'refund' }, FAILED: { label: 'Échouée', tone: 'ko' },
  EXPIRED: { label: 'Expirée', tone: 'ko' }, PENDING: { label: 'En attente', tone: 'wait' }, REFUND_REQUIRED: { label: 'À rembourser', tone: 'wait' },
};
const REFUND_REASON: Record<string, string> = { LATE_PAYMENT_NO_CAPACITY: 'Paiement tardif, plus de place', AMOUNT_MISMATCH: 'Montant différent', DUPLICATE_PAYMENT: 'Paiement en double' };

const plural = (n: number, one: string, many = `${one}s`) => (n > 1 ? many : one);
const person = (last: string, first: string) => `${last} ${first}`.trim();
const nameOf = (t: { holderLastName: string; holderFirstName: string }) => person(t.holderLastName, t.holderFirstName);

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService, private readonly access: EventAccess, private readonly audit: AuditService,
    private readonly renderer: RendererService,
  ) {}

  /** Les documents proposés dans l'onglet « Documents » de l'événement, avec ce que l'utilisateur peut télécharger. */
  async catalog(user: AuthUser, eventId: string) {
    const ev = await this.access.require(user, eventId, 'event.read');
    return {
      data: REPORT_KINDS.map((kind) => ({
        kind, title: CATALOG[kind].title, description: CATALOG[kind].description, formats: ['pdf'] as const,
        available: ev.status !== 'DRAFT' && allowed(user, ev, kind),
      })),
    };
  }

  async generate(user: AuthUser, eventId: string, kind: ReportKind, ip?: string) {
    const ev = await this.access.require(user, eventId, 'report.view');
    if (!allowed(user, ev, kind)) throw forbidden();
    if (ev.status === 'DRAFT') throw invalidState('Aucun rapport pour un brouillon : publiez d’abord l’événement.');

    const now = new Date();
    const meta: ReportMeta = {
      org: ORG, editionDate: dateLong(now), eventTitle: ev.title, eventDates: eventDates(ev.startsAt, ev.endsAt),
      eventPlace: [ev.venueName, ev.city].filter(Boolean).join(', '),
    };
    let html: string; let rows = 0;
    switch (kind) {
      case 'participants': { const d = await this.participants(ev); html = participantsHtml(meta, d); rows = d.rows.length; break; }
      case 'ticketing': html = ticketingHtml(meta, await this.ticketing(ev, now)); break;
      case 'attendance': { const d = await this.attendance(ev, now); html = attendanceHtml(meta, d); rows = d.scans.length + d.anomalies.length; break; }
      case 'payments': { const d = await this.payments(ev); html = paymentsHtml(meta, d); rows = d.transactions.length; break; }
    }
    const pdf = await this.renderer.renderPdf(html);
    await this.audit.log({ actorId: user.id, action: 'report.export', entityType: 'event', entityId: eventId, metadata: { kind, format: 'pdf', rows }, ip });
    return { buffer: pdf, fileName: `${CATALOG[kind].file}-${fileSafe(ev.slug)}-${utcToLocalParts(now).date.replaceAll('-', '')}.pdf` };
  }

  private tooMany(n: number) {
    if (n > MAX_REPORT_ROWS) throw validation(`Trop de lignes pour un PDF (${int(n)}, maximum ${int(MAX_REPORT_ROWS)}).`);
  }

  /* ───────────── éléments communs ───────────── */

  private statusLabel(ev: Event, now: Date): string {
    if (ev.status === 'CLOSED') return 'Clôturé';
    if (ev.status === 'CANCELLED') return 'Annulé';
    const s = computeSalesStatus(ev, now);
    return s === 'OPEN' ? 'Publié, billetterie ouverte' : s === 'NOT_OPEN' ? 'Publié, billetterie pas encore ouverte' : 'Publié, billetterie fermée';
  }

  /** L'événement est passé (ou clôturé) : les billets non scannés sont des « absents », sinon ils n'ont simplement « pas encore » été scannés. */
  private finished(ev: Event, now: Date): boolean {
    const end = ev.endsAt ?? ev.startsAt;
    return ev.status === 'CLOSED' || (!!end && now > end);
  }

  private async attendanceBlock(ev: Event, now: Date): Promise<AttendanceBlock> {
    const grouped = await this.prisma.ticket.groupBy({ by: ['status'], where: { eventId: ev.id }, _count: { _all: true } });
    const n = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const expected = n('VALID') + n('USED'); const entered = n('USED'); const refunded = n('REFUNDED'); const cancelled = n('CANCELLED');
    const issued = expected + refunded + cancelled;
    const excl = [refunded && `${int(refunded)} ${plural(refunded, 'remboursé')}`, cancelled && `${int(cancelled)} ${plural(cancelled, 'annulé')}`].filter(Boolean).join(' et ');
    const finished = this.finished(ev, now);
    return {
      expected, entered, absents: expected - entered,
      expectedNote: excl ? `${int(expected)} (${int(issued)} ${plural(issued, 'billet')}, hors ${excl})` : int(expected),
      absentsLabel: finished ? 'Absents' : 'Pas encore entrés',
      rate: pct(entered, expected),
    };
  }

  private async anomalyCounts(eventId: string): Promise<AnomalyRow[]> {
    const g = await this.prisma.checkinAttempt.groupBy({ by: ['result'], where: { eventId, result: { notIn: NOT_ANOMALIES as never[] } }, _count: { _all: true } });
    return ANOMALY_ORDER.map((r) => ({ r, count: g.find((x) => x.result === r)?._count._all ?? 0 })).filter((x) => x.count > 0)
      .map((x) => ({ label: ANOMALIES[x.r].label, count: x.count, detail: ANOMALIES[x.r].detail }));
  }

  /* ───────────── 1. Liste des participants ───────────── */

  private async participants(ev: Event): Promise<ParticipantsReport> {
    const where: Prisma.TicketWhereInput = { eventId: ev.id, status: { in: ['VALID', 'USED'] } };
    const [count, excluded, organizers, programme] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.count({ where: { eventId: ev.id, status: { in: ['CANCELLED', 'REFUNDED'] } } }),
      this.prisma.eventOrganizer.findMany({ where: { eventId: ev.id }, orderBy: { position: 'asc' }, select: { name: true } }),
      this.prisma.eventProgramItem.findMany({ where: { eventId: ev.id }, orderBy: { position: 'asc' }, select: { time: true, label: true } }),
    ]);
    this.tooMany(count);
    const tickets = await this.prisma.ticket.findMany({
      where, orderBy: { number: 'asc' }, select: { holderFirstName: true, holderLastName: true, holderPhone: true, holderEmail: true },
    });
    const orgs = organizers.map((o) => o.name);
    const info: ParticipantsReport['info'] = [
      ['Événement', ev.title], ['Statut', this.statusLabel(ev, new Date())], ['Date', eventDates(ev.startsAt, ev.endsAt)], ['Horaires', eventHours(ev.startsAt, ev.endsAt)],
      ['Lieu', [ev.venueName, ev.city].filter(Boolean).join(', ') || '—'], [plural(orgs.length, 'Organisateur'), orgs.length ? orgs.join(', ') : ORG], ['Participants inscrits', int(count)],
      ...(programme.length ? [['Programme', programme.map((p) => `${p.time.replace(':', 'h')} ${p.label}`).join(' · ')] as [string, string]] : []),
    ];
    return { info, excluded, rows: tickets.map((t) => ({ name: nameOf(t), phone: phoneFr(t.holderPhone), email: t.holderEmail ?? '—' })) };
  }

  /* ───────────── 2. Rapport de billetterie ───────────── */

  private async ticketing(ev: Event, now: Date): Promise<TicketingReport> {
    const [categories, byCat, revenueRows, issuedDates, paid, attendance, anomalies] = await Promise.all([
      this.prisma.ticketCategory.findMany({ where: { eventId: ev.id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.ticket.groupBy({ by: ['categoryId', 'status'], where: { eventId: ev.id }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ category_id: string; status: string; amount: number | bigint }[]>`
        SELECT oi.category_id, o.status::text AS status, COALESCE(SUM(oi.quantity * oi.unit_price_xof), 0)::int AS amount
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.event_id = ${ev.id}::uuid AND o.status IN ('PAID', 'REFUNDED')
        GROUP BY oi.category_id, o.status`,
      this.prisma.ticket.findMany({ where: { eventId: ev.id }, select: { issuedAt: true } }),
      this.prisma.payment.findMany({ where: { status: 'PAID', order: { eventId: ev.id } }, select: { provider: true, method: true, confirmedAmountXof: true, expectedAmountXof: true } }),
      this.attendanceBlock(ev, now),
      this.anomalyCounts(ev.id),
    ]);

    const count = (catId: string, statuses: string[]) => byCat.filter((g) => g.categoryId === catId && statuses.includes(g.status)).reduce((a, g) => a + g._count._all, 0);
    const money = (catId: string | null, status: string) => revenueRows.filter((r) => r.status === status && (catId === null || r.category_id === catId)).reduce((a, r) => a + Number(r.amount), 0);

    const rows = categories
      .map((c) => ({ c, sold: count(c.id, ['VALID', 'USED', 'CANCELLED', 'REFUNDED']), refunded: count(c.id, ['REFUNDED']), active: count(c.id, ['VALID', 'USED']) }))
      .filter((x) => x.c.isActive || x.sold > 0); // une catégorie désactivée mais déjà vendue reste dans le rapport
    const capacity = rows.reduce((a, x) => a + x.c.quota, 0);
    const active = rows.reduce((a, x) => a + x.active, 0);
    const sold = rows.reduce((a, x) => a + x.sold, 0);
    const refundedTickets = rows.reduce((a, x) => a + x.refunded, 0);
    const cancelled = count_all(byCat, 'CANCELLED');
    const net = money(null, 'PAID'); const refunded = money(null, 'REFUNDED');

    const { bars, days } = bucketize(issuedDates.map((t) => t.issuedAt), ev.salesOpensAt, now);

    const modeLabel = (p: { provider: string; method: string }) =>
      p.provider === 'PHYSICAL'
        ? (p.method === 'CASH' ? 'Espèces' : p.method === 'MOBILE_MONEY_DIRECT' ? 'Mobile Money direct' : 'Vente à l’accueil')
        : (p.method === 'CARD' ? 'FedaPay, carte' : p.method.startsWith('MOBILE_MONEY') ? 'FedaPay, Mobile Money' : 'FedaPay, autre moyen');
    const modes = new Map<string, number>();
    for (const p of paid) modes.set(modeLabel(p), (modes.get(modeLabel(p)) ?? 0) + (p.confirmedAmountXof ?? p.expectedAmountXof));
    const modesTotal = [...modes.values()].reduce((a, b) => a + b, 0);

    const soldNote = refundedTickets > 0 ? `${int(sold)} (dont ${int(refundedTickets)} ${plural(refundedTickets, 'remboursé')})` : int(sold);
    return {
      capacity, sold, soldNote, remaining: Math.max(0, capacity - active), fillRate: pct(active, capacity),
      gross: net + refunded, refunded, refundedTickets, net,
      categories: rows.map((x) => ({ name: x.c.name, price: x.c.priceXof, sold: x.sold, refunded: x.refunded, net: money(x.c.id, 'PAID') })),
      cancelledNote: cancelled > 0 ? `${int(cancelled)} ${plural(cancelled, 'billet annulé', 'billets annulés')} par l’équipe, sans remboursement automatique : ${plural(cancelled, 'il reste compté', 'ils restent comptés')} dans les recettes.` : null,
      sales: bars, salesCaption: weekCaption('Billets vendus', days),
      modes: [...modes.entries()].sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, net: v, share: modesTotal ? v / modesTotal : 0 })),
      attendance, anomalies,
    };
  }

  /* ───────────── 3. Liste des présences ───────────── */

  private async attendance(ev: Event, now: Date): Promise<AttendanceReport> {
    const [used, refused] = await Promise.all([
      this.prisma.ticket.count({ where: { eventId: ev.id, status: 'USED' } }),
      this.prisma.checkinAttempt.count({ where: { eventId: ev.id, result: { notIn: NOT_ANOMALIES as never[] } } }),
    ]);
    this.tooMany(used); this.tooMany(refused);

    const [block, anomalyRows, grouped, scans, attempts, categories] = await Promise.all([
      this.attendanceBlock(ev, now),
      this.anomalyCounts(ev.id),
      this.prisma.ticket.groupBy({ by: ['categoryId', 'status'], where: { eventId: ev.id, status: { in: ['VALID', 'USED'] } }, _count: { _all: true } }),
      this.prisma.ticket.findMany({
        where: { eventId: ev.id, status: 'USED', checkedInAt: { not: null } }, orderBy: [{ checkedInAt: 'asc' }, { number: 'asc' }],
        select: { number: true, holderFirstName: true, holderLastName: true, checkedInAt: true, category: { select: { name: true } } },
      }),
      this.prisma.checkinAttempt.findMany({
        where: { eventId: ev.id, result: { notIn: NOT_ANOMALIES as never[] } }, orderBy: { scannedAt: 'asc' },
        select: { result: true, scannedAt: true, tokenHint: true, ticket: { select: { number: true } } },
      }),
      this.prisma.ticketCategory.findMany({ where: { eventId: ev.id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, name: true } }),
    ]);

    const times = scans.map((t) => t.checkedInAt!);
    const byCategory = categories.map((c) => {
      const expected = grouped.filter((g) => g.categoryId === c.id).reduce((a, g) => a + g._count._all, 0);
      const entered = grouped.find((g) => g.categoryId === c.id && g.status === 'USED')?._count._all ?? 0;
      return { name: c.name, expected, entered, absents: expected - entered, rate: pct(entered, expected) };
    }).filter((c) => c.expected > 0);

    return {
      ...block,
      anomaliesCount: anomalyRows.reduce((a, r) => a + r.count, 0),
      firstScan: times.length ? timeFr(times[0]) : '—', lastScan: times.length ? timeFr(times[times.length - 1]) : '—',
      byCategory, hourly: hourlyBars(times),
      scans: scans.map((t) => ({ time: timeFr(t.checkedInAt!), name: nameOf(t), category: t.category.name, number: t.number })),
      // Un code scanné qui ne correspond à aucun billet n'a pas de numéro : on garde les premiers caractères du code (jamais le code entier).
      anomalies: attempts.map((a) => ({
        time: timeFr(a.scannedAt), reference: a.ticket?.number ?? (a.tokenHint ? `Code ${a.tokenHint}…` : '—'), label: ANOMALIES[a.result]?.label ?? 'Anomalie',
      })),
    };
  }

  /* ───────────── 4. Journal des paiements ───────────── */

  private async payments(ev: Event): Promise<PaymentsReport> {
    const all = await this.prisma.payment.findMany({
      where: { order: { eventId: ev.id } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        provider: true, method: true, status: true, expectedAmountXof: true, confirmedAmountXof: true, failureReason: true, createdAt: true, updatedAt: true, confirmedAt: true,
        order: { select: { reference: true, buyerFirstName: true, buyerLastName: true } },
      },
    });
    type P = (typeof all)[number];
    const fedapay = all.filter((p) => p.provider === 'FEDAPAY');
    this.tooMany(fedapay.length);

    const amount = (p: P) => p.confirmedAmountXof ?? p.expectedAmountXof;
    const sum = (rows: P[]) => rows.reduce((a, p) => a + amount(p), 0);
    const of = (rows: P[], ...st: string[]) => rows.filter((p) => st.includes(p.status));
    const buyer = (p: P) => person(p.order.buyerLastName, p.order.buyerFirstName);

    const approved = of(fedapay, 'PAID', 'REFUNDED'); const refundedF = of(fedapay, 'REFUNDED'); const toRefund = of(fedapay, 'REFUND_REQUIRED');

    const methodLabel = (p: P) =>
      p.provider === 'PHYSICAL'
        ? (p.method === 'CASH' ? 'Espèces' : p.method === 'MOBILE_MONEY_DIRECT' ? 'Mobile Money direct' : 'Vente à l’accueil')
        : (p.method === 'CARD' ? 'Carte bancaire' : p.method.startsWith('MOBILE_MONEY') ? 'Mobile Money' : 'Non précisé');
    const labels = [...new Set(all.map(methodLabel))];
    const order = ['Carte bancaire', 'Mobile Money', 'Non précisé', 'Mobile Money direct', 'Espèces', 'Vente à l’accueil'];
    labels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const methods = labels.map((label) => {
      const rows = all.filter((p) => methodLabel(p) === label);
      return { label, orders: rows.length, approved: of(rows, 'PAID', 'REFUNDED').length, refunded: of(rows, 'REFUNDED').length, failed: of(rows, 'FAILED', 'EXPIRED').length, net: sum(of(rows, 'PAID')) };
    });

    const { bars, days } = bucketize(approved.map((p) => p.confirmedAt ?? p.createdAt), ev.salesOpensAt);
    const fedaMethod = (p: P) => (p.method === 'CARD' ? 'Carte' : p.method.startsWith('MOBILE_MONEY') ? 'Mobile Money' : '—');

    return {
      orders: fedapay.length, approved: approved.length, approvedRefunded: refundedF.length, failed: of(fedapay, 'FAILED', 'EXPIRED').length, pending: of(fedapay, 'PENDING').length,
      toRefund: toRefund.length, toRefundAmount: sum(toRefund),
      successRate: pct(approved.length, fedapay.length),
      collected: sum(approved), refunded: sum(refundedF), net: sum(of(fedapay, 'PAID')),
      methods, weekly: bars, weeklyCaption: weekCaption('Transactions approuvées', days),
      transactions: fedapay.map((p) => ({
        date: dateShort(p.createdAt), order: p.order.reference, buyer: buyer(p), method: fedaMethod(p), amount: amount(p),
        status: PAY_STATUS[p.status]?.label ?? p.status, tone: PAY_STATUS[p.status]?.tone ?? 'wait',
      })),
      refunds: of(all, 'REFUNDED').map((p) => ({ date: dateShort(p.updatedAt), order: p.order.reference, buyer: buyer(p), amount: amount(p) })),
      toRefundRows: of(all, 'REFUND_REQUIRED').map((p) => ({ date: dateShort(p.updatedAt), order: p.order.reference, buyer: buyer(p), amount: amount(p), reason: REFUND_REASON[p.failureReason ?? ''] ?? 'À vérifier' })),
    };
  }
}

function count_all(g: { status: string; _count: { _all: number } }[], status: string): number {
  return g.filter((x) => x.status === status).reduce((a, x) => a + x._count._all, 0);
}
