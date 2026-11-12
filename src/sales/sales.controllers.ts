import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit';
import { ZodPipe } from '../common/zod.pipe';
import { AdminOrdersService } from './admin-orders.service';
import { OrdersService } from './orders.service';
import { PhysicalSalesService } from './physical-sales.service';
import { PublicEventsQuery, publicEventsQuery } from './public-events.schemas';
import { PublicEventsService } from './public-events.service';
import {
  cancelTicketBody, idempotencyKey, orderListQuery, OrderListQuery, physicalSaleCreate, PhysicalSaleCreate,
  publicOrderCreate, PublicOrderCreate, tokenQuery,
} from './sales.schemas';
import { TicketsService } from './tickets.service';

const uuid = new ParseUUIDPipe();
const idem = new ZodPipe(idempotencyKey);

// ───────────── Administration ─────────────

@Controller()
export class AdminSalesController {
  constructor(private readonly orders: AdminOrdersService, private readonly physical: PhysicalSalesService, private readonly tickets: TicketsService) {}

  @Get('events/:eventId/orders')
  eventOrders(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Query(new ZodPipe(orderListQuery)) q: OrderListQuery) {
    return this.orders.listForEvent(u, id, q);
  }

  @Get('orders/:orderId')
  order(@CurrentUser() u: AuthUser, @Param('orderId', uuid) id: string) { return this.orders.detail(id, u); }

  @Get('payments') @RequirePermission('finance.view')
  payments(@CurrentUser() u: AuthUser, @Query(new ZodPipe(orderListQuery)) q: OrderListQuery) { return this.orders.list(u, { ...q, channel: 'ONLINE' }); }

  @Get('physical-sales') @RequirePermission('sale.create')
  physicalList(@CurrentUser() u: AuthUser, @Query(new ZodPipe(orderListQuery)) q: OrderListQuery) { return this.physical.list(u, q); }

  @Post('physical-sales') @RequirePermission('sale.create')
  async physicalCreate(@CurrentUser() u: AuthUser, @Headers('idempotency-key') key: string | undefined,
                       @Body(new ZodPipe(physicalSaleCreate)) body: PhysicalSaleCreate, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const r = await this.physical.create(u, body, idem.transform(key), req.ip);
    res.status(r.replayed ? 200 : 201);
    return r.order;
  }

  @Post('tickets/:ticketId/cancel') @HttpCode(200)
  cancelTicket(@CurrentUser() u: AuthUser, @Param('ticketId', uuid) id: string, @Body(new ZodPipe(cancelTicketBody)) b: { reason: string }, @Req() req: FastifyRequest) {
    return this.tickets.cancel(u, id, b.reason, req.ip);
  }
}

// ───────────── Public (sans compte) ─────────────

@Controller('public')
export class PublicSalesController {
  constructor(private readonly events: PublicEventsService, private readonly orders: OrdersService) {}

  @Public() @RateLimit('pub-events', 120, 60) @Get('events')
  async list(@Query(new ZodPipe(publicEventsQuery)) q: PublicEventsQuery, @Res({ passthrough: true }) res: FastifyReply) {
    const page = await this.events.list(q);
    res.header('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=60'); // même politique que la page d'un événement
    return page;
  }

  @Public() @RateLimit('pub-event', 120, 60) @Get('events/:slug')
  async event(@Param('slug') slug: string, @Res({ passthrough: true }) res: FastifyReply) {
    const page = await this.events.getBySlug(slug); // lève 404 si brouillon ou inconnu : l'en-tête ci-dessous n'est alors jamais posé
    // Page très consultée et identique pour tout le monde : un CDN peut la garder 60 s (puis la resservir 60 s le temps de la rafraîchir).
    // `max-age=0` : le navigateur, lui, revalide toujours. Le stock affiché reste donc à ~1 minute près ; le serveur tranche à la commande.
    // Jamais sur une erreur : sinon un « introuvable » resterait en cache juste après la publication de l'événement.
    res.header('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    return page;
  }

  @Public() @RateLimit('pub-view', 30, 60) @Post('events/:slug/views') @HttpCode(204)
  async view(@Param('slug') slug: string) { await this.events.countView(slug); }

  @Public() @RateLimit('pub-order', 10, 600) @Post('events/:slug/orders')
  async create(@Param('slug') slug: string, @Headers('idempotency-key') key: string | undefined,
               @Body(new ZodPipe(publicOrderCreate)) body: PublicOrderCreate, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('Cache-Control', 'no-store');
    const r = await this.orders.createPublic(slug, body, idem.transform(key), req.ip);
    return r;
  }

  @Public() @RateLimit('pub-order-status', 60, 60) @Get('orders/:reference')
  status(@Param('reference') ref: string, @Query(new ZodPipe(tokenQuery)) q: { token: string }, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('Cache-Control', 'no-store');
    return this.orders.getForBuyer(ref, q.token);
  }

  @Public() @RateLimit('pub-order-retry', 10, 600) @Post('orders/:reference/retry-payment') @HttpCode(200)
  retry(@Param('reference') ref: string, @Query(new ZodPipe(tokenQuery)) q: { token: string }, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('Cache-Control', 'no-store');
    return this.orders.retryPayment(ref, q.token);
  }

  @Public() @RateLimit('pub-ticket', 60, 60) @Get('tickets/:qrToken')
  ticket(@Param('qrToken') token: string) { return this.events.getTicketByToken(token); }
}
