import { Injectable } from '@nestjs/common';
import { Prisma, ScanResult } from '@prisma/client';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { conflict, forbidden, notFound } from '../common/errors';
import { EventAccess } from '../events/event-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScanBody } from './checkin.schemas';

/** Résultats exposés à l'application (les « VALID » et « REFUNDED » de la base deviennent ADMITTED et CANCELLED). */
export type ApiScanResult = 'ADMITTED' | 'ALREADY_USED' | 'WRONG_EVENT' | 'CANCELLED' | 'EVENT_NOT_ACTIVE' | 'INVALID';

const ticketInclude = {
  category: { select: { name: true } },
  event: { select: { title: true } },
  checkedInBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.TicketInclude;
type LoadedTicket = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

const toApi = (r: ScanResult): ApiScanResult =>
  r === 'VALID' ? 'ADMITTED' : r === 'REFUNDED' || r === 'CANCELLED' ? 'CANCELLED' : r === 'ALREADY_USED' ? 'ALREADY_USED'
  : r === 'WRONG_EVENT' ? 'WRONG_EVENT' : r === 'EVENT_NOT_ACTIVE' ? 'EVENT_NOT_ACTIVE' : 'INVALID';

@Injectable()
export class CheckinService {
  constructor(private readonly prisma: PrismaService, private readonly access: EventAccess) {}

  /**
   * Contrôle un billet à l'entrée. Toujours HTTP 200 pour les six résultats : un billet refusé n'est pas une erreur.
   *
   * Un billet ne peut être admis qu'une seule fois, même si deux téléphones le scannent au même instant :
   * l'admission est un `UPDATE … WHERE status = 'VALID'` unique, et la base n'en laisse passer qu'un.
   * L'`Idempotency-Key` rend le scan rejouable (réseau coupé après l'envoi) : on renvoie le résultat déjà enregistré.
   */
  async scan(user: AuthUser, input: ScanBody, key: string) {
    const prior = await this.prisma.checkinAttempt.findUnique({ where: { idempotencyKey: key } });
    if (prior) return this.replay(user, prior, input.eventId);

    const event = await this.access.require(user, input.eventId, 'checkin.scan');
    const where = input.qrToken !== undefined ? { qrToken: input.qrToken } : { number: input.ticketNumber! };
    const hint = input.qrToken !== undefined ? input.qrToken.slice(0, 6) : input.ticketNumber!; // jamais le jeton entier

    try {
      const { result, ticket } = await this.prisma.$transaction(async (tx) => {
        const found = await tx.ticket.findUnique({ where, include: ticketInclude });
        let result = this.decide(found, event);
        let ticket = found;
        if (result === 'VALID' && found) {
          const n = await tx.$executeRaw`UPDATE tickets SET status = 'USED', checked_in_at = now(), checked_in_by_id = ${user.id}::uuid WHERE id = ${found.id}::uuid AND status = 'VALID'`;
          if (n === 0) { // un autre téléphone a gagné la course (ou le billet vient d'être annulé) : on relit et on tranche
            ticket = await tx.ticket.findUnique({ where: { id: found.id }, include: ticketInclude });
            result = this.decide(ticket, event);
          } else {
            ticket = await tx.ticket.findUnique({ where: { id: found.id }, include: ticketInclude });
          }
        }
        await tx.checkinAttempt.create({
          data: {
            eventId: event.id, ticketId: ticket?.id ?? null, agentId: user.id, result, tokenHint: hint,
            deviceId: input.deviceId ?? null, appVersion: input.appVersion ?? null, idempotencyKey: key,
          },
        });
        return { result, ticket };
      });
      return this.respond(result, ticket, event.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') { // même clé envoyée deux fois en même temps
        const again = await this.prisma.checkinAttempt.findUnique({ where: { idempotencyKey: key } });
        if (again) return this.replay(user, again, input.eventId);
      }
      throw e;
    }
  }

  /** Compteurs de l'écran de scan : permission `checkin.view` ou `checkin.scan` sur l'événement. */
  async stats(user: AuthUser, eventId: string) {
    const ev = await this.access.require(user, eventId, 'event.read');
    if (!can(user, 'checkin.view', ev) && !can(user, 'checkin.scan', ev)) throw forbidden();
    return { eventId, ...(await this.counters(eventId)) };
  }

  private decide(t: LoadedTicket | null, event: { id: string; status: string }): ScanResult {
    if (!t) return 'INVALID';
    if (t.eventId !== event.id) return 'WRONG_EVENT';
    if (event.status !== 'PUBLISHED') return 'EVENT_NOT_ACTIVE';
    if (t.status === 'REFUNDED') return 'REFUNDED';
    if (t.status === 'CANCELLED') return 'CANCELLED';
    if (t.status === 'USED') return 'ALREADY_USED';
    return 'VALID';
  }

  /** `capacity` = billets à contrôler (valides ou utilisés), pas la jauge de l'événement : « 342 / 500 » doit pouvoir atteindre 100 %. */
  private async counters(eventId: string) {
    const [admitted, expected] = await Promise.all([
      this.prisma.ticket.count({ where: { eventId, status: 'USED' } }),
      this.prisma.ticket.count({ where: { eventId, status: { in: ['VALID', 'USED'] } } }),
    ]);
    return { admitted, capacity: expected };
  }

  private async respond(result: ScanResult, t: LoadedTicket | null, eventId: string) {
    const api = toApi(result);
    const foreign = result === 'WRONG_EVENT'; // billet d'un autre événement : ni nom ni catégorie
    const ticket = !t ? null : {
      number: t.number, eventTitle: t.event.title,
      holderName: foreign ? null : `${t.holderFirstName} ${t.holderLastName}`,
      category: foreign ? null : t.category.name,
    };
    const reason = result === 'REFUNDED' ? 'Billet remboursé' : result === 'CANCELLED' ? (t?.cancelReason || 'Billet annulé')
      : result === 'EVENT_NOT_ACTIVE' ? "L'événement n'est pas ouvert au contrôle" : null;
    const used = result === 'ALREADY_USED' && t;
    return {
      result: api,
      ticket,
      firstCheckedInAt: used ? t.checkedInAt : null,
      firstCheckedInBy: used && t.checkedInBy ? `${t.checkedInBy.firstName} ${t.checkedInBy.lastName}` : null,
      reason,
      counters: await this.counters(eventId),
    };
  }

  /** Scan rejoué : même résultat que la première fois, sans rien enregistrer de plus. */
  private async replay(user: AuthUser, prior: { agentId: string; eventId: string; ticketId: string | null; result: ScanResult }, eventId: string) {
    if (prior.agentId !== user.id || prior.eventId !== eventId) throw conflict('Cette clé de requête a déjà été utilisée.', 'DUPLICATE_REQUEST');
    const ticket = prior.ticketId ? await this.prisma.ticket.findUnique({ where: { id: prior.ticketId }, include: ticketInclude }) : null;
    if (prior.ticketId && !ticket) throw notFound('Billet introuvable.');
    return this.respond(prior.result, ticket, eventId);
  }
}
