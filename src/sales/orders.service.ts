import { Inject, Injectable, Logger } from '@nestjs/common';
import { Order, OrderItem, Payment, Prisma } from '@prisma/client';
import { AppException, conflict, notFound, invalidState } from '../common/errors';
import { newAccessToken, safeEqual } from '../common/tokens';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { computeAvailability, computeSalesStatus } from '../ticketing/sales-status';
import { FedaPayClient, FedaPayError, toFedaPayLocalPhone } from './fedapay.client';
import { classifyStatus } from './fedapay-status';
import { lockOrder, pad } from './fulfillment.service';
import { PaymentsService } from './payments.service';
import { PublicOrderCreate } from './sales.schemas';
import { SettingsService } from './settings.service';
import { groupLines, nextCounter, releaseReservation, reserve } from './stock';
import { TurnstileService } from './turnstile.service';
import { TicketFilesService } from '../tickets/ticket-files.service';

const POLL_THROTTLE_MS = 3000;

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);
  private readonly lastPoll = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fedapay: FedaPayClient,
    private readonly payments: PaymentsService,
    private readonly turnstile: TurnstileService,
    private readonly settings: SettingsService,
    private readonly files: TicketFilesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────── Création (achat public) ─────────────

  async createPublic(slug: string, input: PublicOrderCreate, idemKey: string, ip: string | undefined) {
    // Rejeu d'une requête déjà traitée (double clic, réseau instable) : on renvoie la même réponse, sans nouveau captcha.
    const prior = await this.findByKey(idemKey);
    if (prior) return this.replay(prior, slug);

    await this.turnstile.verify(input.captchaToken, ip);

    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event || event.status === 'DRAFT') throw new AppException('NOT_FOUND', 'Événement introuvable.', 404);
    if (event.status !== 'PUBLISHED') throw new AppException('SALES_CLOSED', "Les ventes de cet événement sont terminées.", 409);
    if (computeSalesStatus(event) !== 'OPEN') throw new AppException('SALES_CLOSED', "La billetterie n'est pas ouverte.", 409);

    const total = input.tickets.length;
    if (total > event.maxPerOrder) throw new AppException('MAX_PER_ORDER_EXCEEDED', `Maximum ${event.maxPerOrder} billets par commande.`, 409);

    const cats = await this.prisma.ticketCategory.findMany({ where: { eventId: event.id, id: { in: [...new Set(input.tickets.map((t) => t.categoryId))] } } });
    const byId = new Map(cats.map((c) => [c.id, c]));
    const perCat = new Map<string, number>();
    for (const t of input.tickets) {
      const c = byId.get(t.categoryId);
      if (!c) throw new AppException('VALIDATION_ERROR', 'Catégorie de billet inconnue pour cet événement.', 422);
      const n = (perCat.get(c.id) ?? 0) + 1;
      perCat.set(c.id, n);
      if (n > (c.maxPerOrder ?? event.maxPerOrder)) throw new AppException('MAX_PER_ORDER_EXCEEDED', `Maximum ${c.maxPerOrder ?? event.maxPerOrder} billets « ${c.name} » par commande.`, 409);
      const a = computeAvailability(c, event);
      if (a === 'SOLD_OUT') throw new AppException('QUOTA_EXCEEDED', `Il n'y a plus de places « ${c.name} ».`, 409);
      if (a !== 'AVAILABLE') throw new AppException('SALES_CLOSED', `La vente « ${c.name} » n'est pas ouverte.`, 409);
    }
    const totalXof = [...perCat].reduce((s, [id, n]) => s + byId.get(id)!.priceXof * n, 0);
    const ttl = await this.settings.reservationTtlMinutes();
    const accessToken = newAccessToken();

    let created: { orderId: string; paymentId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await reserve(tx, groupLines([...perCat].map(([categoryId, qty]) => ({ categoryId, eventId: event.id, qty }))));
        const reference = `CMD-${pad(await nextCounter(tx, 'order'), 4)}`;
        const order = await tx.order.create({
          data: {
            reference, eventId: event.id, channel: 'ONLINE', status: 'PENDING_PAYMENT',
            buyerFirstName: input.buyer.firstName, buyerLastName: input.buyer.lastName, buyerEmail: input.buyer.email, buyerPhone: input.buyer.phone,
            totalXof, reservationHeld: true, expiresAt: new Date(Date.now() + ttl * 60_000), idempotencyKey: idemKey, accessToken,
          },
        });
        const itemIdByCat = new Map<string, string>();
        for (const [categoryId, quantity] of perCat) {
          const item = await tx.orderItem.create({ data: { orderId: order.id, categoryId, quantity, unitPriceXof: byId.get(categoryId)!.priceXof } });
          itemIdByCat.set(categoryId, item.id);
        }
        await tx.orderHolder.createMany({
          data: input.tickets.map((t) => ({ orderId: order.id, itemId: itemIdByCat.get(t.categoryId)!, firstName: t.firstName, lastName: t.lastName, email: t.email ?? null, phone: t.phone ?? null })),
        });
        const payment = await tx.payment.create({ data: { orderId: order.id, provider: 'FEDAPAY', status: 'PENDING', expectedAmountXof: totalXof } });
        return { orderId: order.id, paymentId: payment.id };
      });
    } catch (e) {
      // Deux requêtes simultanées avec la même clé : la seconde est annulée par la contrainte d'unicité, on renvoie la première.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.findByKey(idemKey);
        if (again) return this.replay(again, slug);
      }
      throw e;
    }
    return this.startPayment(created.orderId, created.paymentId, accessToken, event.title);
  }

  /** Appelle FedaPay (hors transaction SQL) : transaction + lien de paiement. En cas d'échec, les places sont libérées tout de suite. */
  private async startPayment(orderId: string, paymentId: string, accessToken: string, eventTitle: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    try {
      const txn = await this.fedapay.createTransaction({
        amountXof: order.totalXof,
        description: `Billets ${eventTitle} (${order.reference})`,
        callbackUrl: `${this.env.PUBLIC_WEB_URL}/commande/${order.reference}?token=${accessToken}`,
        customer: { firstname: order.buyerFirstName, lastname: order.buyerLastName, email: order.buyerEmail!, phoneLocal: toFedaPayLocalPhone(order.buyerPhone) },
        metadata: { order_reference: order.reference, order_id: order.id, payment_id: paymentId },
      });
      // On enregistre l'identifiant tout de suite : un webhook ou un balayage pourra retrouver ce paiement quoi qu'il arrive ensuite.
      await this.prisma.payment.update({ where: { id: paymentId }, data: { providerTransactionId: String(txn.id), providerReference: txn.reference } });
      const token = await this.fedapay.generateToken(txn.id);
      await this.prisma.$transaction([
        this.prisma.payment.update({ where: { id: paymentId }, data: { checkoutUrl: token.url } }),
        this.prisma.order.update({ where: { id: orderId }, data: { status: 'PAYMENT_IN_PROGRESS' } }),
      ]);
      return { reference: order.reference, accessToken, amountXof: order.totalXof, reservedUntil: order.expiresAt, checkoutUrl: token.url };
    } catch (e) {
      this.log.error(`Démarrage du paiement impossible (${order.reference}) : ${(e as Error).message}`);
      await this.abortBeforePayment(orderId, paymentId, e instanceof FedaPayError ? `FEDAPAY_${e.status ?? 'ERROR'}` : 'ERROR');
      throw new AppException('PAYMENT_PROVIDER_ERROR', "Le service de paiement est momentanément indisponible. Aucun montant n'a été débité, réessayez dans un instant.", 502);
    }
  }

  private async abortBeforePayment(orderId: string, paymentId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const o = await lockOrder(tx, orderId);
      if (!o || !o.reservation_held || o.status === 'PAID') return;
      const items = await tx.orderItem.findMany({ where: { orderId } });
      await releaseReservation(tx, groupLines(items.map((i) => ({ categoryId: i.categoryId, eventId: o.event_id, qty: i.quantity }))));
      await tx.order.update({ where: { id: orderId }, data: { status: 'FAILED', reservationHeld: false } });
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureReason: reason } });
    });
  }

  private findByKey(key: string) {
    return this.prisma.order.findUnique({ where: { idempotencyKey: key }, include: { event: { select: { slug: true } }, payments: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  }

  private replay(o: Order & { event: { slug: string }; payments: Payment[] }, slug: string) {
    if (o.event.slug !== slug) throw conflict('Cette clé de requête a déjà été utilisée pour un autre événement.', 'DUPLICATE_REQUEST');
    return { reference: o.reference, accessToken: o.accessToken!, amountXof: o.totalXof, reservedUntil: o.expiresAt, checkoutUrl: o.payments[0]?.checkoutUrl ?? null };
  }

  // ───────────── Suivi et nouvelle tentative (acheteur, sans compte) ─────────────

  private async loadForBuyer(reference: string, token: string) {
    const o = await this.prisma.order.findUnique({
      where: { reference },
      include: { event: { select: { title: true } }, payments: { orderBy: { createdAt: 'desc' } }, tickets: { include: { category: { select: { name: true } } }, orderBy: { number: 'asc' } } },
    });
    if (!o || !o.accessToken || !safeEqual(o.accessToken, token)) throw notFound('Commande introuvable.'); // même réponse pour « inconnue » et « mauvais jeton »
    return o;
  }

  /** Page de retour de paiement : on ne se fie jamais au navigateur, mais on interroge FedaPay côté serveur (limité à 1 appel / 3 s / commande). */
  async getForBuyer(reference: string, token: string) {
    let o = await this.loadForBuyer(reference, token);
    const pending = o.payments.find((p) => p.status === 'PENDING' && p.providerTransactionId);
    if (pending && (o.status === 'PAYMENT_IN_PROGRESS' || o.status === 'PENDING_PAYMENT')) {
      const last = this.lastPoll.get(o.id) ?? 0;
      if (Date.now() - last > POLL_THROTTLE_MS) {
        this.lastPoll.set(o.id, Date.now());
        if (this.lastPoll.size > 5000) this.lastPoll.clear();
        try { await this.payments.reconcilePayment(pending.id); o = await this.loadForBuyer(reference, token); }
        catch (e) { this.log.warn(`Sondage FedaPay ${reference} : ${(e as Error).message}`); }
      }
    }
    const urls = o.status === 'PAID' ? await this.files.urlsFor(o.tickets.map((t) => ({ id: t.id, number: t.number }))) : new Map();
    return {
      reference: o.reference, status: o.status, eventTitle: o.event.title, amountXof: o.totalXof,
      reservedUntil: o.reservationHeld ? o.expiresAt : null,
      message: MESSAGES[o.status] ?? null,
      tickets: o.status === 'PAID' ? o.tickets.map((t) => {
        const u = urls.get(t.id);
        return { number: t.number, holderName: `${t.holderFirstName} ${t.holderLastName}`, category: t.category.name, filesReady: !!u, pdfUrl: u?.pdfUrl ?? null, imageUrl: u?.imageUrl ?? null };
      }) : [],
    };
  }

  async retryPayment(reference: string, token: string) {
    const o = await this.loadForBuyer(reference, token);
    if (o.status === 'PAID') throw invalidState('Cette commande est déjà payée.');
    if (!o.reservationHeld || !o.expiresAt || o.expiresAt <= new Date() || !['PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS', 'FAILED'].includes(o.status)) {
      throw invalidState('Cette commande a expiré. Veuillez recommencer votre achat.');
    }
    const last = o.payments.find((p) => p.provider === 'FEDAPAY');
    if (last?.providerTransactionId && last.status === 'PENDING') {
      const txn = await this.fedapay.getTransaction(last.providerTransactionId).catch(() => null);
      const kind = classifyStatus(txn?.status);
      if (txn && (kind === 'PAID' || kind === 'PARTIAL_REFUND')) { await this.payments.apply(last.id, txn); throw invalidState('Votre paiement a bien été reçu.'); }
      if (txn && kind === 'PENDING') {
        // Le paiement précédent est toujours ouvert chez FedaPay : on le reprend au lieu d'en créer un second (pas de double débit).
        const tk = await this.fedapay.generateToken(last.providerTransactionId);
        await this.prisma.payment.update({ where: { id: last.id }, data: { checkoutUrl: tk.url } });
        return { reference: o.reference, accessToken: token, amountXof: o.totalXof, reservedUntil: o.expiresAt, checkoutUrl: tk.url };
      }
      if (txn) await this.payments.apply(last.id, txn); // refusé / annulé : on le clôture avant d'en ouvrir un nouveau
    }
    const payment = await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: o.id }, data: { status: 'PENDING_PAYMENT' } });
      return tx.payment.create({ data: { orderId: o.id, provider: 'FEDAPAY', status: 'PENDING', expectedAmountXof: o.totalXof } });
    });
    return this.startPayment(o.id, payment.id, token, o.event.title);
  }
}

const MESSAGES: Record<string, string> = {
  PENDING_PAYMENT: 'En attente de votre paiement.',
  PAYMENT_IN_PROGRESS: 'Paiement en cours de vérification.',
  FAILED: "Le paiement n'a pas abouti. Vous pouvez réessayer tant que votre réservation est valide.",
  EXPIRED: 'Votre réservation a expiré. Veuillez recommencer votre achat.',
  REFUND_REQUIRED: "Votre paiement a bien été reçu, mais vos places n'ont pas pu être garanties. L'organisation vous contactera pour un remboursement.",
  REFUNDED: 'Cette commande a été remboursée.',
  CANCELLED: 'Cette commande a été annulée.',
};

export type { OrderItem };
