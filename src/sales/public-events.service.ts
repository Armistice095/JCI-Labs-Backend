import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { notFound } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { PublicEventsQuery } from './public-events.schemas';
import { utcToLocalParts } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';
import { posterUrl } from '../events/poster-url';
import { defaultPublicTexts } from '../events/default-public-texts';
import { SettingsService } from './settings.service';
import { computeAvailability, computeSalesStatus, remaining } from '../ticketing/sales-status';

const STOCK_CAP = 10; // on n'expose pas le stock exact

@Injectable()
export class PublicEventsService {
  constructor(private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env, private readonly settings: SettingsService) {}

  /**
   * Événements publiés, pour la page d'accueil de la billetterie et le sitemap.xml. Brouillons, clôturés et annulés n'y figurent jamais
   * (leur page reste consultable par son adresse). `updatedAt` = dernière modification de l'événement (balise `lastmod` du sitemap).
   */
  async list(q: PublicEventsQuery) {
    const now = new Date();
    const upcoming: Prisma.EventWhereInput = { OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }] };
    const where: Prisma.EventWhereInput = { status: 'PUBLISHED', ...(q.when === 'upcoming' ? upcoming : q.when === 'past' ? { NOT: upcoming } : {}) };
    const dir = q.when === 'upcoming' ? 'asc' : 'desc';
    const [total, rows] = await Promise.all([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where, orderBy: [{ startsAt: dir }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          posters: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }], take: 1 },
          categories: { where: { isActive: true } },
        },
      }),
    ]);
    const data = rows.map((e) => ({
      slug: e.slug, title: e.title, category: e.category, accentColor: e.accentColor,
      startsAt: e.startsAt, endsAt: e.endsAt, venueName: e.venueName, city: e.city,
      coverUrl: e.posters[0] ? posterUrl(this.env, e.posters[0].storagePath) : null,
      salesStatus: computeSalesStatus(e, now),
      priceFromXof: e.categories.length ? Math.min(...e.categories.map((c) => c.priceXof)) : null,
      soldOut: e.categories.length > 0 && e.categories.every((c) => computeAvailability(c, e, now) === 'SOLD_OUT'),
      updatedAt: e.updatedAt,
    }));
    return { data, meta: pageMeta(q.page, q.pageSize, total) };
  }

  async getBySlug(slug: string) {
    const e = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        posters: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }] },
        organizers: { orderBy: { position: 'asc' } },
        programme: { orderBy: { position: 'asc' } },
        categories: { where: { isActive: true }, orderBy: { position: 'asc' } },
      },
    });
    if (!e || e.status === 'DRAFT') throw notFound('Événement introuvable.'); // un brouillon n'existe pas publiquement
    const now = new Date();
    const cover = e.posters[0];
    // Pas de texte rédigé pour l'événement : texte général JCI (la page n'a jamais de section vide).
    const contactPhone = e.contactPhone ?? this.env.ORG_CONTACT_PHONE ?? null;
    const defaults = defaultPublicTexts({
      maxPerOrder: e.maxPerOrder, reservationMinutes: await this.settings.reservationTtlMinutes(),
      hasContact: !!contactPhone, hasCategoryConditions: e.categories.some((c) => !!c.conditions?.trim()),
    });
    const pick = (own: string | null, fallback: string) => ({ text: own ?? fallback, source: own ? ('event' as const) : ('default' as const) });
    const practical = pick(e.practicalInfo, defaults.practicalInfo);
    const terms = pick(e.ticketTerms, defaults.ticketTerms);
    const refund = pick(e.refundPolicy, defaults.refundPolicy);
    return {
      slug: e.slug, title: e.title, category: e.category, accentColor: e.accentColor, description: e.description, status: e.status,
      salesStatus: computeSalesStatus(e, now),
      startsAt: e.startsAt, endsAt: e.endsAt, venueName: e.venueName, city: e.city,
      posters: e.posters.map((p) => ({ url: posterUrl(this.env, p.storagePath), isCover: p.isCover })),
      programme: e.programme.map((p) => ({ time: p.time, label: p.label })),
      organizers: e.organizers.map((o) => ({ name: o.name, description: o.description })),
      categories: e.categories.map((c) => ({
        id: c.id, name: c.name, priceXof: c.priceXof, conditions: c.conditions,
        availability: computeAvailability(c, e, now),
        remaining: Math.min(remaining(c), STOCK_CAP),
        maxPerOrder: Math.min(c.maxPerOrder ?? e.maxPerOrder, e.maxPerOrder),
      })),
      maxPerOrder: e.maxPerOrder, contactEmail: e.contactEmail, contactPhone,
      practicalInfo: practical.text, ticketTerms: terms.text, refundPolicy: refund.text,
      infoSources: { practicalInfo: practical.source, ticketTerms: terms.source, refundPolicy: refund.source },
      // Une seule section « Questions fréquentes » : les trois rubriques d'information en tête, puis les questions générales.
      faq: [
        { question: 'Infos pratiques', answer: practical.text },
        { question: 'Conditions d’utilisation du billet', answer: terms.text },
        { question: 'Annulation et remboursement', answer: refund.text },
        ...defaults.faq,
      ],
      og: {
        title: e.title,
        description: e.description.length > 200 ? `${e.description.slice(0, 197)}…` : e.description,
        // Variante légère 1200×630 si elle existe (les aperçus WhatsApp/Facebook ignorent les images lourdes), sinon l'affiche d'origine.
        imageUrl: cover ? posterUrl(this.env, cover.sharePath ?? cover.storagePath) : null,
        imageWidth: cover ? (cover.sharePath ? 1200 : cover.width) : null,
        imageHeight: cover ? (cover.sharePath ? 630 : cover.height) : null,
        imageType: cover ? (cover.sharePath ? 'image/jpeg' : cover.mime) : null,
      },
    };
  }

  /** Compteur de vues agrégé par jour local (une ligne par événement et par jour). */
  async countView(slug: string): Promise<void> {
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!e || e.status === 'DRAFT') return;
    const day = utcToLocalParts(new Date()).date;
    await this.prisma.$executeRaw`
      INSERT INTO event_view_daily (event_id, day, views) VALUES (${e.id}::uuid, ${day}::date, 1)
      ON CONFLICT (event_id, day) DO UPDATE SET views = event_view_daily.views + 1`;
  }

  async getTicketByToken(qrToken: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { qrToken },
      include: { event: { select: { title: true, startsAt: true, venueName: true } }, category: { select: { name: true } } },
    });
    if (!t) throw notFound('Billet introuvable.');
    // Page ouverte par un scan « appareil photo » : jamais de marquage de présence ici, et un nom abrégé seulement.
    return {
      eventTitle: t.event.title, startsAt: t.event.startsAt, venueName: t.event.venueName,
      category: t.category.name,
      holderShortName: `${t.holderFirstName} ${t.holderLastName.charAt(0).toUpperCase()}.`,
      status: t.status === 'USED' ? 'USED' : t.status === 'VALID' ? 'VALID' : 'CANCELLED',
    };
  }
}
