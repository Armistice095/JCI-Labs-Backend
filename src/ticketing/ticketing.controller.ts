import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { categoryCreate, CategoryCreate, categoryUpdate, CategoryUpdate, ticketingSettings, TicketingSettings } from './ticketing.schemas';
import { TicketingService } from './ticketing.service';

const uuid = new ParseUUIDPipe();

@Controller('events/:eventId')
export class TicketingController {
  constructor(private readonly svc: TicketingService) {}

  @Get('ticketing')
  get(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string) { return this.svc.get(u, id); }

  @Patch('ticketing')
  update(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Body(new ZodPipe(ticketingSettings)) b: TicketingSettings, @Req() r: FastifyRequest) {
    return this.svc.updateSettings(u, id, b, r.ip);
  }

  @Post('ticketing/close') @HttpCode(200)
  close(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() r: FastifyRequest) { return this.svc.setClosed(u, id, true, r.ip); }

  @Post('ticketing/reopen') @HttpCode(200)
  reopen(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Req() r: FastifyRequest) { return this.svc.setClosed(u, id, false, r.ip); }

  @Post('categories')
  create(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Body(new ZodPipe(categoryCreate)) b: CategoryCreate, @Req() r: FastifyRequest) {
    return this.svc.createCategory(u, id, b, r.ip);
  }

  @Patch('categories/:categoryId')
  patch(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Param('categoryId', uuid) cid: string,
        @Body(new ZodPipe(categoryUpdate)) b: CategoryUpdate, @Req() r: FastifyRequest) {
    return this.svc.updateCategory(u, id, cid, b, r.ip);
  }

  @Delete('categories/:categoryId') @HttpCode(204)
  remove(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Param('categoryId', uuid) cid: string, @Req() r: FastifyRequest) {
    return this.svc.deleteCategory(u, id, cid, r.ip);
  }
}
