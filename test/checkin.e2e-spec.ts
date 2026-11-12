/**
 * Contrôle d'accès (application JCI Stafs) : résultats d'un scan, admission unique même en cas de scans simultanés,
 * rejeu idempotent, droits par événement, compteurs. Prérequis : voir api.e2e-spec.ts. ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Contrôle d’accès (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), agent1: randomUUID(), agent2: randomUUID(), otherAgent: randomUUID(), seller: randomUUID(), unassigned: randomUUID() };
  let ev: string; let evOther: string; let evClosed: string; let catId: string; let catOther: string; let catClosed: string;
  let seq = 0;

  const post = async (body: unknown, as?: string, key: string | null = randomUUID()) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) headers.authorization = `Bearer ${as}`;
    if (key) headers['idempotency-key'] = key;
    const res = await app.inject({ method: 'POST', url: '/api/v1/checkin/scan', headers, payload: JSON.stringify(body) });
    checkContract('POST', '/api/v1/checkin/scan', res.statusCode, res.body);
    return res;
  };
  const scan = async (as: string, token: string, event = ev, key?: string) => JSON.parse((await post({ eventId: event, qrToken: token }, as, key)).body);
  const stats = async (event: string, as?: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${event}/checkin/stats`, headers: as ? { authorization: `Bearer ${as}` } : {} });
    checkContract('GET', `/api/v1/events/${event}/checkin/stats`, res.statusCode, res.body);
    return res;
  };

  const mkTicket = async (event: string, category: string, o: { first?: string; last?: string; status?: 'VALID' | 'USED' | 'CANCELLED' | 'REFUNDED'; reason?: string } = {}) => {
    seq += 1;
    const status = o.status ?? 'VALID';
    const order = await prisma.order.create({
      data: {
        reference: `CMD-CK${seq}`, eventId: event, channel: 'ONLINE', status: 'PAID', buyerFirstName: 'Acheteur', buyerLastName: 'Test', buyerEmail: 'a@exemple.bj', totalXof: 3000, paidAt: new Date(),
        items: { create: [{ categoryId: category, quantity: 1, unitPriceXof: 3000 }] },
      }, include: { items: true },
    });
    const token = `tok${String(seq).padStart(4, '0')}${randomUUID().replaceAll('-', '')}`;
    const t = await prisma.ticket.create({
      data: {
        number: `JCI-2026-${String(900000 + seq)}`, qrToken: token, eventId: event, orderId: order.id, orderItemId: order.items[0].id, categoryId: category,
        holderFirstName: o.first ?? 'Koffi', holderLastName: o.last ?? `Nom${seq}`, status,
        cancelledAt: status === 'CANCELLED' || status === 'REFUNDED' ? new Date() : null, cancelReason: o.reason ?? null,
        checkedInAt: status === 'USED' ? new Date() : null, checkedInById: status === 'USED' ? ids.agent1 : null,
      },
    });
    return { id: t.id, number: t.number, token };
  };

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
    const mk = async (id: string, email: string, first: string, role: string, scoped?: string) => {
      await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','${email}')`);
      await prisma.profile.create({ data: { id, email, firstName: first, lastName: 'Agent' } });
      await prisma.userRole.create({ data: { userId: id, roleId: roles[role], eventId: scoped ?? null } });
    };
    await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${ids.unassigned}','libre@t.bj')`);
    await prisma.profile.create({ data: { id: ids.unassigned, email: 'libre@t.bj', firstName: 'Libre', lastName: 'Agent' } });
    await prisma.userRole.create({ data: { userId: ids.unassigned, roleId: roles.GATE_AGENT, eventId: null } }); // rôle global « OWN_OR_ASSIGNED » : ne couvre aucun événement

    await mk(ids.admin, 'admin@t.bj', 'Admin', 'ADMIN');
    const base = { description: 'x', venueName: 'Centre', city: 'Comé', maxPerOrder: 5, publishedAt: new Date(), startsAt: new Date(Date.now() + 86400e3), createdById: ids.admin };
    ev = (await prisma.event.create({ data: { ...base, slug: 'e-ck', title: 'Soirée JCI', status: 'PUBLISHED' } })).id;
    evOther = (await prisma.event.create({ data: { ...base, slug: 'e-autre', title: 'Autre soirée', status: 'PUBLISHED' } })).id;
    evClosed = (await prisma.event.create({ data: { ...base, slug: 'e-clos', title: 'Soirée clôturée', status: 'CLOSED' } })).id;
    await mk(ids.agent1, 'a1@t.bj', 'Yao', 'GATE_AGENT', ev);
    await mk(ids.agent2, 'a2@t.bj', 'Sènami', 'GATE_AGENT', ev);
    await mk(ids.otherAgent, 'a3@t.bj', 'Paul', 'GATE_AGENT', evOther);
    await mk(ids.seller, 'v@t.bj', 'Vendeur', 'SELLER', ev);
    const mkCat = async (event: string, name: string) => (await prisma.ticketCategory.create({ data: { eventId: event, name, priceXof: 3000, quota: 100, position: 0 } })).id;
    catId = await mkCat(ev, 'VIP'); catOther = await mkCat(evOther, 'Standard'); catClosed = await mkCat(evClosed, 'Standard');
  }, 60000);

  afterAll(async () => { await app?.close(); });

  it('billet valide : ENTRÉE AUTORISÉE, puis DÉJÀ SCANNÉ avec l’heure et le nom du premier agent', async () => {
    const t = await mkTicket(ev, catId, { first: 'Armistice', last: 'Anagonou' });
    const first = await scan(ids.agent1, t.token);
    expect(first).toMatchObject({
      result: 'ADMITTED', firstCheckedInAt: null, firstCheckedInBy: null, reason: null,
      ticket: { number: t.number, eventTitle: 'Soirée JCI', holderName: 'Armistice Anagonou', category: 'VIP' },
    });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'USED', checkedInById: ids.agent1 });
    expect(row.checkedInAt).not.toBeNull();

    const second = await scan(ids.agent2, t.token); // un autre agent, autre téléphone
    expect(second.result).toBe('ALREADY_USED');
    expect(second.firstCheckedInBy).toBe('Yao Agent');
    expect(new Date(second.firstCheckedInAt).getTime()).toBe(row.checkedInAt!.getTime());
    expect(second.ticket.holderName).toBe('Armistice Anagonou');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).checkedInById).toBe(ids.agent1); // le premier passage n'est jamais écrasé
  });

  it('20 scans simultanés du même billet par deux agents : une seule admission, tous les scans journalisés', async () => {
    const t = await mkTicket(ev, catId);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => scan(i % 2 ? ids.agent1 : ids.agent2, t.token)));
    expect(results.filter((r) => r.result === 'ADMITTED')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'ALREADY_USED')).toHaveLength(19);
    expect(await prisma.checkinAttempt.count({ where: { ticketId: t.id } })).toBe(20);
    expect(await prisma.checkinAttempt.count({ where: { ticketId: t.id, result: 'VALID' } })).toBe(1);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    const winner = results.findIndex((r) => r.result === 'ADMITTED') % 2 ? ids.agent1 : ids.agent2;
    expect(row.checkedInById).toBe(winner);
  });

  it('rejeu avec la même Idempotency-Key : même résultat, rien de plus enregistré (même en parallèle)', async () => {
    const t = await mkTicket(ev, catId);
    const key = randomUUID();
    const a = await scan(ids.agent1, t.token, ev, key);
    const b = await scan(ids.agent1, t.token, ev, key); // le réseau a coupé, le téléphone renvoie
    expect(a.result).toBe('ADMITTED');
    expect(b).toEqual(a);
    expect(await prisma.checkinAttempt.count({ where: { ticketId: t.id } })).toBe(1);

    const t2 = await mkTicket(ev, catId);
    const key2 = randomUUID();
    const many = await Promise.all(Array.from({ length: 5 }, () => scan(ids.agent1, t2.token, ev, key2)));
    expect(many.every((r) => r.result === 'ADMITTED')).toBe(true);
    expect(await prisma.checkinAttempt.count({ where: { ticketId: t2.id } })).toBe(1);
  });

  it('la clé d’un autre agent ou d’un autre événement est refusée (409)', async () => {
    const t = await mkTicket(ev, catId);
    const key = randomUUID();
    await scan(ids.agent1, t.token, ev, key);
    const other = await post({ eventId: ev, qrToken: t.token }, ids.agent2, key);
    expect(other.statusCode).toBe(409);
    expect(JSON.parse(other.body).code).toBe('DUPLICATE_REQUEST');
    const wrongEvent = await post({ eventId: evOther, qrToken: t.token }, ids.otherAgent, key);
    expect(wrongEvent.statusCode).toBe(409);
  });

  it('code inconnu : BILLET INCONNU (200, pas une erreur), journalisé sans le jeton entier', async () => {
    const r = await scan(ids.agent1, 'https-nimporte-quoi-1234567890');
    expect(r).toMatchObject({ result: 'INVALID', ticket: null, firstCheckedInAt: null });
    const att = await prisma.checkinAttempt.findFirstOrThrow({ where: { result: 'INVALID' }, orderBy: { scannedAt: 'desc' } });
    expect(att).toMatchObject({ ticketId: null, tokenHint: 'https-' });
    expect(att.agentId).toBe(ids.agent1);
  });

  it('billet d’un autre événement : AUTRE ÉVÉNEMENT, sans nom ni catégorie, et le billet reste valide', async () => {
    const t = await mkTicket(evOther, catOther, { first: 'Secret', last: 'Personne' });
    const r = await scan(ids.agent1, t.token);
    expect(r.result).toBe('WRONG_EVENT');
    expect(r.ticket).toEqual({ number: t.number, eventTitle: 'Autre soirée', holderName: null, category: null });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('VALID');
  });

  it('billet annulé ou remboursé : refusé avec le motif ; événement clôturé : refusé', async () => {
    const cancelled = await mkTicket(ev, catId, { status: 'CANCELLED', reason: 'Doublon de commande' });
    const refunded = await mkTicket(ev, catId, { status: 'REFUNDED' });
    expect(await scan(ids.agent1, cancelled.token)).toMatchObject({ result: 'CANCELLED', reason: 'Doublon de commande' });
    expect(await scan(ids.agent1, refunded.token)).toMatchObject({ result: 'CANCELLED', reason: 'Billet remboursé' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe('CANCELLED');

    const closed = await mkTicket(evClosed, catClosed);
    const r = await scan(ids.admin, closed.token, evClosed);
    expect(r.result).toBe('EVENT_NOT_ACTIVE');
    expect(r.reason).toContain('pas ouvert');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: closed.id } })).status).toBe('VALID');
  });

  it('saisie manuelle du numéro (minuscules acceptées)', async () => {
    const t = await mkTicket(ev, catId);
    const res = await post({ eventId: ev, ticketNumber: t.number.toLowerCase() }, ids.agent1);
    expect(JSON.parse(res.body)).toMatchObject({ result: 'ADMITTED', ticket: { number: t.number } });
    expect(JSON.parse((await post({ eventId: ev, ticketNumber: 'JCI-2026-000000' }, ids.agent1)).body).result).toBe('INVALID');
  });

  it('compteurs : admis / billets à contrôler, mis à jour dans chaque réponse de scan', async () => {
    await prisma.ticket.deleteMany({ where: { eventId: evOther } }); // isole l'événement de test
    const before = JSON.parse((await stats(ev, ids.agent1)).body);
    const t = await mkTicket(ev, catId);
    const r = await scan(ids.agent2, t.token);
    expect(r.counters).toEqual({ admitted: before.admitted + 1, capacity: before.capacity + 1 });
    expect(JSON.parse((await stats(ev, ids.agent1)).body)).toEqual({ eventId: ev, admitted: before.admitted + 1, capacity: before.capacity + 1 });
    // un billet annulé n'est pas « à contrôler »
    await mkTicket(ev, catId, { status: 'CANCELLED', reason: 'x' });
    expect(JSON.parse((await stats(ev, ids.admin)).body).capacity).toBe(before.capacity + 1);
  });

  it('droits : 401 sans jeton, 403 vendeur, 404 agent d’un autre événement ou sans événement, 403 stats pour un vendeur', async () => {
    const t = await mkTicket(ev, catId);
    expect((await post({ eventId: ev, qrToken: t.token })).statusCode).toBe(401);
    expect((await post({ eventId: ev, qrToken: t.token }, ids.seller)).statusCode).toBe(403);
    expect((await post({ eventId: ev, qrToken: t.token }, ids.otherAgent)).statusCode).toBe(404);
    expect((await post({ eventId: ev, qrToken: t.token }, ids.unassigned)).statusCode).toBe(404);
    expect((await stats(ev, ids.seller)).statusCode).toBe(403);
    expect((await stats(ev, ids.otherAgent)).statusCode).toBe(404);
    expect((await stats(ev)).statusCode).toBe(401);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('VALID'); // aucun de ces refus n'a consommé le billet
    expect((await post({ eventId: ev, qrToken: t.token }, ids.admin)).statusCode).toBe(200);
  });

  it('requête invalide : 422 (sans clé, sans jeton ni numéro, ou les deux)', async () => {
    expect((await post({ eventId: ev, qrToken: 'abc' }, ids.agent1, null)).statusCode).toBe(422);
    expect((await post({ eventId: ev }, ids.agent1)).statusCode).toBe(422);
    expect((await post({ eventId: ev, qrToken: 'abc', ticketNumber: 'JCI-2026-000001' }, ids.agent1)).statusCode).toBe(422);
    expect((await post({ eventId: 'pas-un-uuid', qrToken: 'abc' }, ids.agent1)).statusCode).toBe(422);
  });
});
