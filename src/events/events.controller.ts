import '@fastify/multipart';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { validation } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { cancelBody, eventCreate, EventCreate, eventListQuery, eventUpdate, EventUpdate, posterPatch, posterQuery } from './events.schemas';
import { EventsService } from './events.service';
import { PostersService } from './posters.service';

const uuid = new ParseUUIDPipe();

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService, private readonly posters: PostersService) {}

  @Get() @RequirePermission('event.read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(eventListQuery)) q: ReturnType<typeof eventListQuery.parse>) { return this.events.list(u, q); }

  @Post() @RequirePermission('event.create')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(eventCreate)) body: EventCreate, @Req() req: FastifyRequest) { return this.events.create(u, body, req.ip); }

  @Get(':eventId')
  get(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string) { return this.events.get(u, id); }

  @Patch(':eventId')
  update(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Body(new ZodPipe(eventUpdate)) body: EventUpdate, @Req() req: FastifyRequest) {
    return this.events.update(u, id, body, req.ip);
  }

  @Delete(':eventId') @HttpCode(204)
  remove(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() req: FastifyRequest) { return this.events.remove(u, id, req.ip); }

  @Post(':eventId/publish') @HttpCode(200)
  publish(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() req: FastifyRequest) { return this.events.publish(u, id, req.ip); }

  @Post(':eventId/close') @HttpCode(200)
  close(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() req: FastifyRequest) { return this.events.close(u, id, req.ip); }

  @Post(':eventId/cancel') @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Body(new ZodPipe(cancelBody)) body: { reason: string }, @Req() req: FastifyRequest) {
    return this.events.cancel(u, id, body.reason, req.ip);
  }

  // ── Affiches (multipart ; ?isCover=true pour la définir comme couverture) ──
  @Post(':eventId/posters')
  async addPoster(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() req: FastifyRequest,
                  @Query(new ZodPipe(posterQuery)) q: ReturnType<typeof posterQuery.parse>) {
    const part = await req.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!part) throw validation('Aucun fichier envoyé.');
    const buffer = await part.toBuffer(); // lève FST_REQ_FILE_TOO_LARGE au-delà de 2 Mo (converti en 413)
    return this.posters.upload(u, id, buffer, q.isCover === 'true');
  }

  @Patch(':eventId/posters/:posterId')
  patchPoster(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Param('posterId', uuid) pid: string,
              @Body(new ZodPipe(posterPatch)) body: ReturnType<typeof posterPatch.parse>) {
    return this.posters.patch(u, id, pid, body);
  }

  @Delete(':eventId/posters/:posterId') @HttpCode(204)
  deletePoster(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Param('posterId', uuid) pid: string) {
    return this.posters.remove(u, id, pid);
  }
}
