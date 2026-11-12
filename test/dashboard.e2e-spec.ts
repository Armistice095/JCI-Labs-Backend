/**
 * Écran « Tableau de bord » : KPI, graphique des ventes, billets par catégorie, événements proches, et ce que chaque rôle a le droit de voir.
 * Les commandes et billets sont insérés directement en base. Prérequis : voir api.e2e-spec.ts. ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;
const DAY = 86400e3;

d('Tableau de bord (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), organizer: randomUUID(), owner: randomUUID(), seller: randomUUID(), analyst: randomUUID() };
  let e1: string; let e2: string;

  const call = async (url: string, as?: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {} });
    checkContract('GET', `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);
  const dash = async (as = ids.admin, query = '') => json(await call(`/dashboard${query}`, as));

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
    await mk(ids.owner, 'owner@t.bj', 'ORGANIZER');    // a créé e1 seulement

    const now = Date.now();
    const base = { description: 'x', venueName: 'Centre', city: 'Comé', maxPerOrder: 5, status: 'PUBLISHED' as const, publishedAt: new Date() };
    const open = { salesOpensAt: new Date(now - 60 * DAY), salesClosesAt: new Date(now + 40 * DAY) };
    e1 = (await prisma.event.create({ data: { ...base, ...open, slug: 'soiree', title: 'Soirée', startsAt: new Date(now + 20 * DAY), endsAt: new Date(now + 20 * DAY + 9 * 3600e3), createdById: ids.owner } })).id;
    e2 = (await prisma.event.create({ data: { ...base, ...open, salesManuallyClosed: true, slug: 'gros', title: 'Gros', startsAt: new Date(now + 10 * DAY), endsAt: new Date(now + 10 * DAY + 9 * 3600e3), createdById: ids.admin } })).id;
    const past = (await prisma.event.create({ data: { ...base, ...open, slug: 'passe', title: 'Passé', startsAt: new Date(now - 30 * DAY), endsAt: new Date(now - 30 * DAY + 9 * 3600e3), createdById: ids.admin } })).id;
    const draft = (await prisma.event.create({ data: { slug: 'brouillon', title: 'Brouillon', createdById: ids.admin } })).id;
    await mk(ids.seller, 'vendeur@t.bj', 'SELLER', e1);
    // Rôle de test : voit le tableau de bord et les événements, mais ni commandes ni finances (aucun rôle réel n'est dans ce cas)
    await prisma.role.deleteMany({ where: { code: 'ANALYST_TEST' } });
    const analyst = await prisma.role.create({ data: { code: 'ANALYST_TEST', name: 'Analyste (test)', eventScope: 'ALL_EVENTS', permissions: { create: [{ permission: 'event.read' }, { permission: 'dashboard.view' }] } } });
    roles.ANALYST_TEST = analyst.id;
    await mk(ids.analyst, 'analyste@t.bj', 'ANALYST_TEST');
    await prisma.eventPoster.create({ data: { eventId: e2, storagePath: `${e2}/a.jpg`, mime: 'image/jpeg', sizeBytes: 10, isCover: true } });

    const mkCat = async (event: string, name: string, priceXof: number, quota: number, position: number, soldCount = 0) =>
      (await prisma.ticketCategory.create({ data: { eventId: event, name, priceXof, quota, position, soldCount } })).id;
    const standard = await mkCat(e1, 'Standard', 3000, 100, 0, 2);
    const vip = await mkCat(e1, 'VIP', 10000, 5, 1, 1);
    const gros = await mkCat(e2, 'standard ', 1000, 50, 0, 3); // même nom que « Standard » à la casse et à l'espace près : additionnées
    await mkCat(past, 'Standard', 1000, 10, 0, 10);
    await mkCat(draft, 'Standard', 1000, 1000, 0); // brouillon : ignoré partout

    let n = 0;
    const mkOrder = async (event: string, c: string, unit: number, ref: string, status: 'PAID' | 'REFUNDED', qty: number, daysAgo: number) => {
      const at = new Date(now - daysAgo * DAY);
      const order = await prisma.order.create({
        data: {
          reference: ref, eventId: event, channel: 'ONLINE', status, buyerFirstName: 'Koffi', buyerLastName: 'Ahoussou', buyerEmail: 'k@exemple.bj', totalXof: unit * qty,
          paidAt: at, items: { create: [{ categoryId: c, quantity: qty, unitPriceXof: unit }] },
        }, include: { items: true },
      });
      for (let i = 0; i < qty; i++) {
        n += 1;
        await prisma.ticket.create({
          data: {
            number: `JCI-2026-${String(n).padStart(6, '0')}`, qrToken: randomUUID().replaceAll('-', '') + n, eventId: event, orderId: order.id, orderItemId: order.items[0].id, categoryId: c,
            holderFirstName: `P${n}`, holderLastName: 'Nom', status: status === 'REFUNDED' ? 'REFUNDED' : 'VALID', issuedAt: at, cancelledAt: status === 'REFUNDED' ? at : null,
          },
        });
      }
    };
    await mkOrder(e1, standard, 3000, 'CMD-D1', 'PAID', 2, 0.1);  // aujourd'hui : 6 000
    await mkOrder(e1, vip, 10000, 'CMD-D2', 'PAID', 1, 3);        // il y a 3 jours : 10 000
    await mkOrder(e2, gros, 1000, 'CMD-D3', 'PAID', 2, 20);       // il y a 20 jours : 2 000
    await mkOrder(e2, gros, 1000, 'CMD-D4', 'PAID', 1, 45);       // hors des 30 jours, mais dans les recettes : 1 000
    await mkOrder(e1, standard, 3000, 'CMD-D5', 'REFUNDED', 1, 1); // remboursée : ni recettes ni billets
  }, 60000);

  afterAll(async () => { await prisma?.userRole.deleteMany({ where: { role: { code: 'ANALYST_TEST' } } }); await prisma?.role.deleteMany({ where: { code: 'ANALYST_TEST' } }); await app?.close(); });

  it('KPI de la maquette : recettes, taux de remplissage, billets émis, événements (brouillon exclu, remboursé exclu)', async () => {
    const o = await dash();
    // Remplissage : (2 + 1 + 3 + 10) vendus / (100 + 5 + 50 + 10) places = 16 / 165 → 10 %
    expect(o.kpis).toEqual({ revenueXof: 19000, fillRatePercent: 10, ticketsIssued: 6, eventsCount: 3 });
  });

  it('graphique des ventes : un point par jour du Bénin, jours à zéro compris, 30 jours par défaut', async () => {
    const { sales } = await dash();
    expect(sales.range).toBe(30);
    expect(sales.points).toHaveLength(30);
    const days = sales.points.map((p: any) => p.date);
    expect(days).toEqual([...days].sort());
    expect(new Set(days).size).toBe(30);
    expect(sales.points[29].date).toBe(new Date(Date.now() + 3600e3).toISOString().slice(0, 10)); // aujourd'hui, heure du Bénin
    expect(sales.points[29]).toEqual({ date: days[29], revenueXof: 6000, tickets: 2 });
    expect(sales.points[26]).toMatchObject({ revenueXof: 10000, tickets: 1 });
    expect(sales.points.filter((p: any) => p.revenueXof === 0)).toHaveLength(27);
    expect(sales.totalRevenueXof).toBe(18000); // la vente d'il y a 45 jours est hors période
    expect(sales.totalTickets).toBe(5);
  });

  it('graphique : 7 jours', async () => {
    const { sales } = await dash(ids.admin, '?range=7');
    expect(sales.range).toBe(7);
    expect(sales.points).toHaveLength(7);
    expect(sales.totalRevenueXof).toBe(16000);
    expect(sales.totalTickets).toBe(3);
  });

  it('billets par catégorie : tous événements confondus, noms regroupés sans tenir compte de la casse', async () => {
    const { ticketsByCategory: c } = await dash();
    expect(c.total).toBe(6);
    expect(c.categories).toEqual([{ name: 'Standard', count: 5, percent: 83 }, { name: 'VIP', count: 1, percent: 17 }]);
  });

  it('événements proches : publiés et pas terminés, le plus proche d’abord, avec statut de vente, couverture et remplissage', async () => {
    const { upcomingEvents: u } = await dash();
    expect(u.map((e: any) => e.title)).toEqual(['Gros', 'Soirée']); // « Passé » et le brouillon sont absents
    expect(u[0]).toMatchObject({ id: e2, salesStatus: 'CLOSED', ticketsIssued: 3, capacity: 50 });
    expect(u[0].coverUrl).toContain(`${e2}/a.jpg`);
    expect(u[1]).toMatchObject({ id: e1, salesStatus: 'OPEN', ticketsIssued: 3, capacity: 105, coverUrl: null });
  });

  it('droits : l’organisateur ne voit que ses événements, avec les recettes', async () => {
    const o = await dash(ids.owner);
    expect(o.kpis).toEqual({ revenueXof: 16000, fillRatePercent: 3, ticketsIssued: 3, eventsCount: 1 });
    expect(o.ticketsByCategory.categories).toEqual([{ name: 'Standard', count: 2, percent: 67 }, { name: 'VIP', count: 1, percent: 33 }]);
    expect(o.upcomingEvents.map((e: any) => e.id)).toEqual([e1]);
  });

  it('droits : sans droit sur les commandes, les chiffres restent visibles mais les montants valent null (pas 0)', async () => {
    const o = await dash(ids.analyst);
    expect(o.kpis).toEqual({ revenueXof: null, fillRatePercent: 10, ticketsIssued: 6, eventsCount: 3 });
    expect(o.sales.totalRevenueXof).toBeNull();
    expect(o.sales.points.every((p: any) => p.revenueXof === null)).toBe(true);
    expect(o.sales.totalTickets).toBe(5);
  });

  it('aucun événement visible : zéros, taux null, listes vides ; les recettes valent 0 pour qui a le droit', async () => {
    const o = await dash(ids.organizer);
    expect(o.kpis).toEqual({ revenueXof: 0, fillRatePercent: null, ticketsIssued: 0, eventsCount: 0 });
    expect(o.sales.points).toHaveLength(30);
    expect(o.ticketsByCategory).toEqual({ total: 0, categories: [] });
    expect(o.upcomingEvents).toEqual([]);
  });

  it('accès : 401 sans jeton, 403 pour un vendeur (pas de dashboard.view), 422 si la période est inconnue', async () => {
    expect((await call('/dashboard')).statusCode).toBe(401);
    expect((await call('/dashboard', ids.seller)).statusCode).toBe(403);
    expect((await call('/dashboard?range=15', ids.admin)).statusCode).toBe(422);
  });
});
