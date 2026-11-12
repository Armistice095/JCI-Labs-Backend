import { Injectable } from '@nestjs/common';
import { Event } from '@prisma/client';
import { can } from '../auth/access';
import { AuthUser } from '../auth/auth.types';
import { forbidden, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EventAccess {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Charge l'événement et contrôle les droits.
   * 404 si l'utilisateur n'a pas le droit de le voir (on ne révèle pas son existence), 403 s'il le voit mais n'a pas `permission`.
   */
  async require(user: AuthUser, eventId: string, permission: string): Promise<Event> {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!ev || !can(user, 'event.read', ev)) throw notFound('Événement introuvable.');
    if (permission !== 'event.read' && !can(user, permission, ev)) throw forbidden();
    return ev;
  }
}
