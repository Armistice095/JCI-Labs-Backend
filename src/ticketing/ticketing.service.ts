import { Injectable } from '@nestjs/common';
import { Event, Prisma, TicketCategory } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { conflict, invalidState, notFound, validation } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { EventAccess } from '../events/event-access.service';
import { computeAvailability, computeSalesStatus, remaining } from './sales-status';
import { CategoryCreate, CategoryUpdate, TicketingSettings } from './ticketing.schemas';

@Injectable()
export class TicketingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EventAccess,
    private readonly audit: AuditService,
  ) {}

  private categoryDto(c: TicketCategory, ev: Event, now: Date) {
    return {
      id: c.id, name: c.name, priceXof: c.priceXof, quota: c.quota, conditions: c.conditions,
      saleStartsAt: c.saleStartsAt, saleEndsAt: c.saleEndsAt, maxPerOrder: c.maxPerOrder, isActive: c.isActive,
      sold: c.soldCount, reserved: c.reservedCount, remaining: remaining(c),
      availability: computeAvailability(c, ev, now),
    };
  }

  private async state(eventId: string) {
    const ev = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const cats = await this.prisma.ticketCategory.findMany({ where: { eventId }, orderBy: { position: 'asc' } });
    const now = new Date();
    const active = cats.filter((c) => c.isActive);
    return {
      salesStatus: computeSalesStatus(ev, now),
      salesOpensAt: ev.salesOpensAt, salesClosesAt: ev.salesClosesAt,
      manuallyClosed: ev.salesManuallyClosed, maxPerOrder: ev.maxPerOrder,
      categories: cats.map((c) => this.categoryDto(c, ev, now)),
      totalCapacity: active.reduce((s, c) => s + c.quota, 0),
      potentialRevenueXof: active.reduce((s, c) => s + c.quota * c.priceXof, 0),
    };
  }

  async get(user: AuthUser, eventId: string) {
    await this.access.require(user, eventId, 'event.read');
    return this.state(eventId);
  }

  private assertEditable(ev: Event) {
    if (ev.status !== 'DRAFT' && ev.status !== 'PUBLISHED') throw invalidState("La billetterie d'un événement clôturé ou annulé n'est plus modifiable.");
  }

  async updateSettings(user: AuthUser, eventId: string, s: TicketingSettings, ip?: string) {
    const ev = await this.access.require(user, eventId, 'ticketing.manage');
    this.assertEditable(ev);
    const opens = s.salesOpensAt !== undefined ? s.salesOpensAt : ev.salesOpensAt;
    const closes = s.salesClosesAt !== undefined ? s.salesClosesAt : ev.salesClosesAt;
    if (opens && closes && closes <= opens) throw validation('La clôture doit être après l’ouverture.', { salesClosesAt: 'La clôture doit être après l’ouverture.' });
    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { salesOpensAt: opens, salesClosesAt: closes, ...(s.maxPerOrder !== undefined && { maxPerOrder: s.maxPerOrder }) } });
      await this.audit.log({ actorId: user.id, action: 'ticketing.update', entityType: 'event', entityId: eventId, metadata: { ...s } as Prisma.InputJsonValue, ip }, tx);
    });
    return this.state(eventId);
  }

  async setClosed(user: AuthUser, eventId: string, closed: boolean, ip?: string) {
    const ev = await this.access.require(user, eventId, 'ticketing.manage');
    if (ev.status !== 'PUBLISHED') throw invalidState("La billetterie ne peut être ouverte ou fermée que pour un événement publié.");
    if (!closed && ev.salesClosesAt && new Date() >= ev.salesClosesAt) {
      throw invalidState('La date de clôture est dépassée : modifiez-la avant de rouvrir la billetterie.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { salesManuallyClosed: closed } });
      await this.audit.log({ actorId: user.id, action: closed ? 'ticketing.close' : 'ticketing.reopen', entityType: 'event', entityId: eventId, ip }, tx);
    });
    return this.state(eventId);
  }

  async createCategory(user: AuthUser, eventId: string, c: CategoryCreate, ip?: string) {
    const ev = await this.access.require(user, eventId, 'ticketing.manage');
    this.assertEditable(ev);
    await this.assertNameFree(eventId, c.name);
    const last = await this.prisma.ticketCategory.aggregate({ where: { eventId }, _max: { position: true } });
    const created = await this.prisma.ticketCategory.create({
      data: {
        eventId, name: c.name, priceXof: c.priceXof, quota: c.quota, conditions: c.conditions ?? null,
        saleStartsAt: c.saleStartsAt ?? null, saleEndsAt: c.saleEndsAt ?? null, maxPerOrder: c.maxPerOrder ?? null,
        isActive: c.isActive ?? true, position: (last._max.position ?? -1) + 1,
      },
    });
    await this.audit.log({ actorId: user.id, action: 'category.create', entityType: 'ticket_category', entityId: created.id, metadata: { eventId, name: c.name, priceXof: c.priceXof, quota: c.quota }, ip });
    return this.categoryDto(created, ev, new Date());
  }

  async updateCategory(user: AuthUser, eventId: string, categoryId: string, u: CategoryUpdate, ip?: string) {
    const ev = await this.access.require(user, eventId, 'ticketing.manage');
    this.assertEditable(ev);
    const cat = await this.mustFindCategory(eventId, categoryId);
    if (u.quota !== undefined && u.quota < cat.soldCount + cat.reservedCount) {
      throw conflict(`Le quota ne peut pas être inférieur aux billets vendus ou réservés (${cat.soldCount + cat.reservedCount}).`, 'QUOTA_EXCEEDED');
    }
    if (u.name !== undefined && u.name.toLowerCase() !== cat.name.toLowerCase()) await this.assertNameFree(eventId, u.name);
    const start = u.saleStartsAt !== undefined ? u.saleStartsAt : cat.saleStartsAt;
    const end = u.saleEndsAt !== undefined ? u.saleEndsAt : cat.saleEndsAt;
    if (start && end && end <= start) throw validation('La fin de vente doit être après le début.', { saleEndsAt: 'La fin de vente doit être après le début.' });

    const updated = await this.prisma.ticketCategory.update({
      where: { id: categoryId },
      data: {
        ...(u.name !== undefined && { name: u.name }),
        ...(u.priceXof !== undefined && { priceXof: u.priceXof }), // ne s'applique qu'aux nouvelles commandes (prix figé dans order_items)
        ...(u.quota !== undefined && { quota: u.quota }),
        ...(u.conditions !== undefined && { conditions: u.conditions }),
        ...(u.saleStartsAt !== undefined && { saleStartsAt: u.saleStartsAt }),
        ...(u.saleEndsAt !== undefined && { saleEndsAt: u.saleEndsAt }),
        ...(u.maxPerOrder !== undefined && { maxPerOrder: u.maxPerOrder }),
        ...(u.isActive !== undefined && { isActive: u.isActive }),
      },
    });
    await this.audit.log({ actorId: user.id, action: 'category.update', entityType: 'ticket_category', entityId: categoryId, metadata: { eventId, fields: Object.keys(u) }, ip });
    return this.categoryDto(updated, ev, new Date());
  }

  async deleteCategory(user: AuthUser, eventId: string, categoryId: string, ip?: string) {
    const ev = await this.access.require(user, eventId, 'ticketing.manage');
    this.assertEditable(ev);
    const cat = await this.mustFindCategory(eventId, categoryId);
    const used = await this.prisma.orderItem.count({ where: { categoryId } });
    if (cat.soldCount > 0 || cat.reservedCount > 0 || used > 0) {
      throw conflict('Des billets ont été vendus ou réservés : désactivez la catégorie plutôt que de la supprimer.');
    }
    await this.prisma.ticketCategory.delete({ where: { id: categoryId } });
    await this.audit.log({ actorId: user.id, action: 'category.delete', entityType: 'ticket_category', entityId: categoryId, metadata: { eventId, name: cat.name }, ip });
  }

  private async mustFindCategory(eventId: string, categoryId: string) {
    const c = await this.prisma.ticketCategory.findFirst({ where: { id: categoryId, eventId } });
    if (!c) throw notFound('Catégorie introuvable.');
    return c;
  }

  private async assertNameFree(eventId: string, name: string) {
    const dup = await this.prisma.ticketCategory.findFirst({ where: { eventId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw conflict('Une catégorie porte déjà ce nom pour cet événement.');
  }
}
