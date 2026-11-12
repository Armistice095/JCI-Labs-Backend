import { Controller, Get, Param, ParseUUIDPipe, Query, Req, StreamableFile } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { ParticipantsService } from './participants.service';
import { participantExportQuery, ParticipantExportQuery, participantListQuery, ParticipantListQuery } from './participants.schemas';

const uuid = new ParseUUIDPipe();

@Controller()
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get('events/:eventId/participants')
  list(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Query(new ZodPipe(participantListQuery)) q: ParticipantListQuery) {
    return this.participants.list(u, id, q);
  }

  @Get('events/:eventId/participants/export')
  async export(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Query(new ZodPipe(participantExportQuery)) q: ParticipantExportQuery, @Req() req: FastifyRequest) {
    const f = await this.participants.export(u, id, q, req.ip);
    return new StreamableFile(f.buffer, { type: f.contentType, disposition: `attachment; filename="${f.fileName}"` });
  }

  @Get('tickets/:ticketId')
  ticket(@CurrentUser() u: AuthUser, @Param('ticketId', uuid) id: string) { return this.participants.detail(u, id); }
}
