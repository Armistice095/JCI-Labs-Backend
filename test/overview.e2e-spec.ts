/**
 * Écran « Vue d'ensemble » : KPI, ventes par catégorie, activité récente, et ce que chaque rôle a le droit de voir.
 * Les commandes et billets sont insérés directement en base. Prérequis : voir api.e2e-spec.ts. ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Vue d’ensemble (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), organizer: randomUUID(), owner: randomUUID(), seller: randomUUID() };
  let eventId: string; let bigId: string; let draftId: string;
  const cat: Record<string, string> = {};

  const call = async (url: string, as?: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {} });
    checkContract('GET', `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);
  const overview = async (id = eventId, as = ids.admin) => json(await call(`/events/${id}/overview`, as));
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30),
      PUBLIC_WEB_URL: 'http://localhost:5173', ADMIN_WEB_URL: 'http://localhost:5174', RATE_LIMIT_DISABLED: 'true', JOBS_POLL_SECONDS: '0.5',
      FEDAPAY_SECRET_KEY: 'sk_sandbox_test_key', FEDAPAY_WEBHOOK_SECRET: 'wh_sandbox_test_secret', FEDAPAY_API_BASE: 'http://127.0.0.1:1',
    });
    const { Test } = await import('@nestjs/testing');
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    const { AppModule } = await import('../src/app.module');
    const { TokenVerifier } = await import('../src/auth/token-verifier.service');
    const { SupabaseAdminService } = await import('../src/supabase/supabase-admin.service');
    const { AllExceptionsFilter } = await import('../src/common/http-exception.filter');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const { fakeStorage } = await import('./fakes');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue({ verify: async (t: string) => t })
      .overrideProvider(SupabaseAdminService).useValue({ client: fakeStorage().client })
      .compile();
    app = mod.createNestApplication(new FastifyAdapter({ trustProxy: true }), { rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    await prisma.$executeRawUnsafe('TRUNCATE audit_logs, payment_events, order_holders, ticket_categories, events, user_roles, profiles, counters, auth.users CASCADE');
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    const mk = async (id: string, email: string, role: string, scoped?: string) => {
      await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','${email}')`);
      await prisma.profile.create({ data: { id, email, firstName: email.split('@')[0], lastName: 'Test' } });
      await prisma.userRole.create({ data: { userId: id, roleId: roles[role], eventId: scoped ?? null } });
    };
    await mk(ids.admin, 'admin@t.bj', 'ADMIN');
    await mk(ids.organizer, 'orga@t.bj', 'ORGANIZER'); // n'a créé aucun événement
    await mk(ids.owner, 'owner@t.bj', 'ORGANIZER');    // a créé l'événement principal

    const base = { description: 'x', startsAt: new Date(Date.now() + 20 * 86400e3), endsAt: new Date(Date.now() + 20 * 86400e3 + 9 * 3600e3), venueName: 'Centre', city: 'Comé',
                   salesOpensAt: new Date(Date.now() - 86400e3), salesClosesAt: new Date(Date.now() + 19 * 86400e3), maxPerOrder: 5 };
    eventId = (await prisma.event.create({ data: { ...base, slug: 'vue-ensemble', title: 'Soirée', status: 'PUBLISHED', publishedAt: new Date(), createdById: ids.owner } })).id;
    bigId = (await prisma.event.create({ data: { ...base, slug: 'gros-evenement', title: 'Gros', status: 'PUBLISHED', publishedAt: new Date(), createdById: ids.admin } })).id;
    draftId = (await prisma.event.create({ data: { slug: 'brouillon', title: 'Brouillon', createdById: ids.admin } })).id;
    await mk(ids.seller, 'vendeur@t.bj', 'SELLER', eventId);

    const mkCat = async (event: string, name: string, priceXof: number, quota: number, position: number, extra: object = {}) =>
      (await prisma.ticketCategory.create({ data: { eventId: event, name, priceXof, quota, position, ...extra } })).id;
    cat.Standard = await mkCat(eventId, 'Standard', 3000, 100, 0, { soldCount: 2 });
    cat.VIP = await mkCat(eventId, 'VIP', 10000, 5, 1, { soldCount: 1, reservedCount: 1 });
    cat.Ancien = await mkCat(eventId, 'Ancien tarif', 2000, 20, 2, { isActive: false });
    cat.Gros = await mkCat(bigId, 'Standard', 1000, 500, 0);

    type T = { n: number; first: string; last: string; status?: 'VALID' | 'USED' | 'REFUNDED' | 'CANCELLED'; issuedAt: Date; checkedInAt?: Date; cancelledAt?: Date };
    const mkOrder = async (event: string, c: string, unit: number, ref: string, status: 'PAID' | 'REFUNDED', tickets: T[]) => {
      const order = await prisma.order.create({
        data: {
          reference: ref, eventId: event, channel: 'ONLINE', status, buyerFirstName: 'Koffi', buyerLastName: 'Ahoussou', buyerEmail: 'k@exemple.bj', totalXof: unit * tickets.length,
          paidAt: new Date(), items: { create: [{ categoryId: c, quantity: tickets.length, unitPriceXof: unit }] },
        }, include: { items: true },
      });
      for (const t of tickets) {
        await prisma.ticket.create({
          data: {
            number: `JCI-2026-${String(t.n).padStart(6, '0')}`, qrToken: randomUUID().replaceAll('-', '') + t.n, eventId: event, orderId: order.id, orderItemId: order.items[0].id, categoryId: c,
            holderFirstName: t.first, holderLastName: t.last, status: t.status ?? 'VALID', issuedAt: t.issuedAt, checkedInAt: t.checkedInAt ?? null,
            checkedInById: t.status === 'USED' ? ids.seller : null, cancelledAt: t.cancelledAt ?? null, // contraintes chk_ticket_used / chk_ticket_cancelled
          },
        });
      }
    };
    await mkOrder(eventId, cat.Standard, 3000, 'CMD-O1', 'PAID', [{ n: 1, first: 'Aïcha', last: 'Hounkpatin', issuedAt: ago(50) }, { n: 2, first: 'Edwige', last: 'Zossou', issuedAt: ago(40) }]);
    await mkOrder(eventId, cat.VIP, 10000, 'CMD-O2', 'PAID', [{ n: 3, first: 'Luc', last: 'Dossou', status: 'USED', issuedAt: ago(30), checkedInAt: ago(5) }]);
    await mkOrder(eventId, cat.Standard, 3000, 'CMD-O3', 'REFUNDED', [{ n: 4, first: 'Sènami', last: 'Adjovi', status: 'REFUNDED', issuedAt: ago(20), cancelledAt: ago(2) }]);
    await mkOrder(eventId, cat.Standard, 3000, 'CMD-O4', 'PAID', [{ n: 5, first: 'Habib', last: 'Tidjani', status: 'CANCELLED', issuedAt: ago(10), cancelledAt: ago(1) }]);
    await prisma.eventViewDaily.createMany({ data: [{ eventId, day: new Date('2026-11-01'), views: 5 }, { eventId, day: new Date('2026-11-02'), views: 7 }] });

    // 12 billets : l'activité est limitée à 10
    await mkOrder(bigId, cat.Gros, 1000, 'CMD-G1', 'PAID', Array.from({ length: 12 }, (_, i) => ({ n: 100 + i, first: `P${i}`, last: 'Nom', issuedAt: ago(100 - i) })));
  }, 60000);

  afterAll(async () => { await app?.close(); });

  it('KPI de la maquette : recettes, visiteurs, billets émis / capacité, places restantes', async () => {
    const o = await overview();
    expect(o.eventId).toBe(eventId);
    // Recettes = commandes payées (la commande remboursée n'est pas comptée ; le billet annulé non remboursé l'est encore)
    expect(o.kpis).toEqual({ revenueXof: 9000 + 10000, views: 12, ticketsIssued: 3, capacity: 105, remaining: 98 + 3 });
  });

  it('ventes par catégorie : ordre de la billetterie, vendus / quota, recettes, catégories inactives exclues des totaux', async () => {
    const o = await overview();
    expect(o.categories.map((c: any) => c.name)).toEqual(['Standard', 'VIP', 'Ancien tarif']);
    expect(o.categories[0]).toMatchObject({ priceXof: 3000, isActive: true, quota: 100, sold: 2, reserved: 0, remaining: 98, revenueXof: 9000 });
    expect(o.categories[1]).toMatchObject({ priceXof: 10000, quota: 5, sold: 1, reserved: 1, remaining: 3, revenueXof: 10000 });
    expect(o.categories[2]).toMatchObject({ isActive: false, sold: 0, revenueXof: 0 });
    expect(o.categories.reduce((a: number, c: any) => a + c.revenueXof, 0)).toBe(o.kpis.revenueXof);
  });

  it('activité récente : billets émis, scannés et annulés, du plus récent au plus ancien', async () => {
    const { activity } = await overview();
    expect(activity.map((a: any) => `${a.type}:${a.ticketNumber}`)).toEqual([
      'TICKET_CANCELLED:JCI-2026-000005', 'TICKET_CANCELLED:JCI-2026-000004', 'TICKET_CHECKED_IN:JCI-2026-000003',
      'TICKET_ISSUED:JCI-2026-000005', 'TICKET_ISSUED:JCI-2026-000004', 'TICKET_ISSUED:JCI-2026-000003', 'TICKET_ISSUED:JCI-2026-000002', 'TICKET_ISSUED:JCI-2026-000001',
    ]);
    expect(activity[7]).toMatchObject({ holderName: 'Aïcha Hounkpatin', category: 'Standard' });
    const times = activity.map((a: any) => new Date(a.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('activité : limitée aux 10 derniers événements', async () => {
    const o = await overview(bigId);
    expect(o.activity).toHaveLength(10);
    expect(o.activity[0].ticketNumber).toBe('JCI-2026-000111'); // le plus récent
    expect(o.kpis).toMatchObject({ ticketsIssued: 12, revenueXof: 12000, views: 0 });
  });

  it('droits : l’organisateur de l’événement voit tout ; un vendeur voit les chiffres sans recettes ni noms', async () => {
    const owner = await overview(eventId, ids.owner);
    expect(owner.kpis.revenueXof).toBe(19000);
    expect(owner.activity).toHaveLength(8);

    const seller = await overview(eventId, ids.seller);
    expect(seller.kpis).toEqual({ revenueXof: null, views: 12, ticketsIssued: 3, capacity: 105, remaining: 101 });
    expect(seller.categories.every((c: any) => c.revenueXof === null)).toBe(true);
    expect(seller.categories[0].sold).toBe(2);
    expect(seller.activity).toBeNull();
  });

  it('brouillon : zéros, recettes masquées', async () => {
    const o = await overview(draftId);
    expect(o.kpis).toEqual({ revenueXof: null, views: 0, ticketsIssued: 0, capacity: 0, remaining: 0 });
    expect(o.categories).toEqual([]);
    expect(o.activity).toEqual([]);
  });

  it('accès : 401 sans jeton, 404 hors périmètre ou inexistant', async () => {
    expect((await call(`/events/${eventId}/overview`)).statusCode).toBe(401);
    expect((await call(`/events/${eventId}/overview`, ids.organizer)).statusCode).toBe(404);
    expect((await call(`/events/${randomUUID()}/overview`, ids.admin)).statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/events/pas-un-uuid/overview', headers: { authorization: `Bearer ${ids.admin}` } });
    expect(bad.statusCode).toBe(400);
  });
});
