/**
 * Écran « Participants » : liste, recherche, filtres, compteurs, tri, e-mails, droits, export CSV/Excel, fiche billet.
 * Les commandes et billets sont insérés directement en base (le parcours d'achat est couvert par sales.e2e-spec.ts).
 * Prérequis : voir api.e2e-spec.ts (base de test migrée, TEST_DATABASE_URL). ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Participants (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), organizer: randomUUID(), seller: randomUUID(), seller2: randomUUID() };
  let eventId: string;
  const cat: Record<string, string> = {};
  const tk: Record<string, string> = {}; // numéro → id

  const call = async (url: string, as?: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {} });
    checkContract('GET', `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);
  const list = async (qs = '', as = ids.admin) => json(await call(`/events/${eventId}/participants${qs ? `?${qs}` : ''}`, as));
  const numbers = (r: any) => r.data.map((p: any) => p.ticketNumber);

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
    await mk(ids.organizer, 'orga@t.bj', 'ORGANIZER'); // n'a créé aucun événement : ne voit pas celui de l'admin

    const ev = await prisma.event.create({
      data: {
        slug: 'participants-test', title: 'Soirée test', description: 'x', status: 'PUBLISHED', publishedAt: new Date(),
        startsAt: new Date(Date.now() + 20 * 86400e3), endsAt: new Date(Date.now() + 20 * 86400e3 + 9 * 3600e3), venueName: 'Centre', city: 'Comé',
        salesOpensAt: new Date(Date.now() - 86400e3), salesClosesAt: new Date(Date.now() + 19 * 86400e3), maxPerOrder: 5, createdById: ids.admin,
      },
    });
    eventId = ev.id;
    for (const [i, [name, price]] of ([['Standard', 3000], ['VIP', 10000]] as const).entries()) {
      cat[name] = (await prisma.ticketCategory.create({ data: { eventId, name, priceXof: price, quota: 100, position: i } })).id;
    }
    await mk(ids.seller, 'vendeur1@t.bj', 'SELLER', eventId);
    await mk(ids.seller2, 'vendeur2@t.bj', 'SELLER', eventId);

    const day = (n: number) => new Date(Date.now() - n * 86400e3);
    type H = { n: number; first: string; last: string; email?: string; phone?: string; status?: 'VALID' | 'USED' | 'REFUNDED'; checkedInAt?: Date };
    const mkOrder = async (o: { ref: string; channel: 'ONLINE' | 'PHYSICAL'; status: 'PAID' | 'REFUNDED'; category: 'Standard' | 'VIP'; created: Date; soldById?: string; sendEmail?: boolean;
                              method: 'MOBILE_MONEY_MTN' | 'CASH' | 'CARD'; holders: H[] }) => {
      const unit = o.category === 'VIP' ? 10000 : 3000;
      const order = await prisma.order.create({
        data: {
          reference: o.ref, eventId, channel: o.channel, status: o.status, buyerFirstName: 'Koffi', buyerLastName: 'Ahoussou', buyerEmail: 'koffi@exemple.bj',
          totalXof: unit * o.holders.length, paidAt: o.created, createdAt: o.created, soldById: o.soldById ?? null, sendTicketsEmail: o.sendEmail ?? true,
          items: { create: [{ categoryId: cat[o.category], quantity: o.holders.length, unitPriceXof: unit }] },
          payments: { create: [{ provider: o.channel === 'ONLINE' ? 'FEDAPAY' : 'PHYSICAL', method: o.method, status: o.status === 'PAID' ? 'PAID' : 'REFUNDED', expectedAmountXof: unit * o.holders.length }] },
        },
        include: { items: true },
      });
      for (const h of o.holders) {
        const t = await prisma.ticket.create({
          data: {
            number: `JCI-2026-${String(h.n).padStart(6, '0')}`, qrToken: randomUUID().replaceAll('-', '') + h.n, eventId, orderId: order.id, orderItemId: order.items[0].id, categoryId: cat[o.category],
            holderFirstName: h.first, holderLastName: h.last, holderEmail: h.email ?? null, holderPhone: h.phone ?? null, status: h.status ?? 'VALID', checkedInAt: h.checkedInAt ?? null,
            checkedInById: h.status === 'USED' ? ids.seller : null, cancelledAt: h.status === 'REFUNDED' ? new Date() : null, // contraintes chk_ticket_used / chk_ticket_cancelled
          },
        });
        tk[t.number] = t.id;
      }
      return order;
    };

    const a = await mkOrder({ ref: 'CMD-T1', channel: 'ONLINE', status: 'PAID', category: 'Standard', created: day(5), method: 'MOBILE_MONEY_MTN', holders: [
      { n: 1, first: 'Ismaël', last: 'Adjovi', email: 'ismael.adjovi@exemple.bj', phone: '+2290195789513' },
      { n: 2, first: 'Paul', last: 'Soulé', email: 'paul.soule@exemple.bj', phone: '+2290195517223' }] });
    await prisma.emailLog.create({ data: { orderId: a.id, template: 'TICKET_CONFIRMATION', toEmail: 'koffi@exemple.bj', status: 'DELIVERED' } });
    await mkOrder({ ref: 'CMD-T2', channel: 'PHYSICAL', status: 'PAID', category: 'VIP', created: day(4), soldById: ids.seller, sendEmail: false, method: 'CASH', holders: [
      { n: 3, first: 'Luc', last: 'Dossou', status: 'USED', checkedInAt: new Date() }] });
    await mkOrder({ ref: 'CMD-T3', channel: 'ONLINE', status: 'REFUNDED', category: 'Standard', created: day(3), method: 'CARD', holders: [
      { n: 4, first: 'Sènami', last: 'Sossou', status: 'REFUNDED' }] });
    const dOrder = await mkOrder({ ref: 'CMD-T4', channel: 'ONLINE', status: 'PAID', category: 'Standard', created: day(2), method: 'MOBILE_MONEY_MTN', holders: [
      { n: 5, first: 'Evil', last: '=HYPERLINK("http://x","Clic")' }] });
    await prisma.emailLog.create({ data: { orderId: dOrder.id, template: 'TICKET_CONFIRMATION', toEmail: 'koffi@exemple.bj', status: 'FAILED', createdAt: day(1) } });
    await prisma.emailLog.create({ data: { orderId: dOrder.id, ticketId: tk['JCI-2026-000005'], template: 'TICKET_RESEND', toEmail: 'koffi@exemple.bj', status: 'SENT', createdAt: new Date() } });
  }, 60000);

  afterAll(async () => { await app?.close(); });

  it('liste : ordre d’émission, champs de la maquette, compteurs', async () => {
    const r = await list();
    expect(numbers(r)).toEqual(['JCI-2026-000001', 'JCI-2026-000002', 'JCI-2026-000003', 'JCI-2026-000004', 'JCI-2026-000005']);
    expect(r.meta).toMatchObject({ page: 1, pageSize: 10, total: 5, totalPages: 1, counts: { ALL: 5, UPCOMING: 3, PRESENT: 1, CANCELLED: 1 } });
    expect(r.data[0]).toMatchObject({
      firstName: 'Ismaël', lastName: 'Adjovi', phone: '+2290195789513', email: 'ismael.adjovi@exemple.bj', category: 'Standard', amountXof: 3000,
      paymentStatus: 'PAID', paymentMethod: 'MOBILE_MONEY_MTN', presence: 'UPCOMING', checkedInAt: null, orderReference: 'CMD-T1', channel: 'ONLINE',
    });
    expect(r.data[2]).toMatchObject({ category: 'VIP', amountXof: 10000, paymentMethod: 'CASH', presence: 'PRESENT', channel: 'PHYSICAL' });
    expect(r.data[2].checkedInAt).not.toBeNull();
    expect(r.data[3]).toMatchObject({ paymentStatus: 'REFUNDED', paymentMethod: 'CARD', presence: 'CANCELLED', ticketStatus: 'REFUNDED' });
  });

  it('statut d’e-mail : livré, non demandé, pas encore envoyé, renvoi plus récent que l’échec', async () => {
    const byNum = Object.fromEntries((await list()).data.map((p: any) => [p.ticketNumber, p.emailStatus]));
    expect(byNum).toEqual({ 'JCI-2026-000001': 'DELIVERED', 'JCI-2026-000002': 'DELIVERED', 'JCI-2026-000003': 'NOT_REQUESTED', 'JCI-2026-000004': 'NOT_SENT', 'JCI-2026-000005': 'SENT' });
  });

  it('pagination : pages, total et rang stables', async () => {
    const p1 = await list('pageSize=2&page=1'); const p3 = await list('pageSize=2&page=3');
    expect(numbers(p1)).toEqual(['JCI-2026-000001', 'JCI-2026-000002']);
    expect(numbers(p3)).toEqual(['JCI-2026-000005']);
    expect(p1.meta).toMatchObject({ total: 5, totalPages: 3 });
    expect((await call(`/events/${eventId}/participants?pageSize=101`, ids.admin)).statusCode).toBe(422);
  });

  it('recherche : nom, mots multiples, accents/casse, téléphone, référence billet et commande', async () => {
    expect(numbers(await list('q=adjovi'))).toEqual(['JCI-2026-000001']);
    expect(numbers(await list('q=paul%20SOUL'))).toEqual(['JCI-2026-000002']);
    expect(numbers(await list('q=exemple.bj'))).toEqual(['JCI-2026-000001', 'JCI-2026-000002']);
    expect(numbers(await list('q=0195517223'))).toEqual(['JCI-2026-000002']);
    expect(numbers(await list('q=000003'))).toEqual(['JCI-2026-000003']);
    expect(numbers(await list('q=CMD-T3'))).toEqual(['JCI-2026-000004']);
    expect((await list('q=introuvable')).meta).toMatchObject({ total: 0, counts: { ALL: 0 } });
  });

  it('filtres catégorie et présence ; les compteurs ignorent la présence mais suivent la recherche', async () => {
    expect(numbers(await list(`categoryId=${cat.VIP}`))).toEqual(['JCI-2026-000003']);
    expect(numbers(await list('presence=UPCOMING'))).toEqual(['JCI-2026-000001', 'JCI-2026-000002', 'JCI-2026-000005']);
    expect(numbers(await list('presence=PRESENT'))).toEqual(['JCI-2026-000003']);
    expect(numbers(await list('presence=CANCELLED'))).toEqual(['JCI-2026-000004']);
    const r = await list('presence=PRESENT');
    expect(r.meta.total).toBe(1);
    expect(r.meta.counts).toEqual({ ALL: 5, UPCOMING: 3, PRESENT: 1, CANCELLED: 1 });
    expect((await list('q=soul')).meta.counts).toEqual({ ALL: 1, UPCOMING: 1, PRESENT: 0, CANCELLED: 0 });
    expect((await call(`/events/${eventId}/participants?presence=ABSENT`, ids.admin)).statusCode).toBe(422);
  });

  it('tri : nom (↕), date d’achat, catégorie ; direction', async () => {
    const named = async (dir: string) => numbers(await list(`sort=name&dir=${dir}`)).filter((n: string) => n !== 'JCI-2026-000005'); // 000005 : nom piégé (formule), classé selon la collation
    expect(await named('asc')).toEqual(['JCI-2026-000001', 'JCI-2026-000003', 'JCI-2026-000004', 'JCI-2026-000002']); // Adjovi, Dossou, Sossou, Soulé
    expect(await named('desc')).toEqual(['JCI-2026-000002', 'JCI-2026-000004', 'JCI-2026-000003', 'JCI-2026-000001']);
    expect(numbers(await list('sort=purchasedAt&dir=desc'))[0]).toBe('JCI-2026-000005');
    expect(numbers(await list('sort=category&dir=desc'))[0]).toBe('JCI-2026-000003'); // VIP
    expect((await call(`/events/${eventId}/participants?sort=password`, ids.admin)).statusCode).toBe(422);
  });

  it('droits : authentification, périmètre (404), permission (403)', async () => {
    expect((await call(`/events/${eventId}/participants`)).statusCode).toBe(401);
    expect((await call(`/events/${eventId}/participants`, ids.organizer)).statusCode).toBe(404); // événement d’un autre
    expect((await call(`/events/${eventId}/participants`, ids.seller)).statusCode).toBe(403); // voit l’événement, pas les participants
    expect((await call(`/events/${randomUUID()}/participants`, ids.admin)).statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/events/pas-un-uuid/participants', headers: { authorization: `Bearer ${ids.admin}` } });
    expect(bad.statusCode).toBe(400); // identifiant mal formé (comme toutes les routes `{eventId}`)
  });

  it('export CSV : fichier, BOM, séparateur « ; », formules neutralisées, filtres appliqués, journalisé', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/participants/export`, headers: { authorization: `Bearer ${ids.admin}` } });
    checkContract('GET', `/api/v1/events/${eventId}/participants/export`, res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="participants-participants-test-\d{8}\.csv"$/);
    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('"N°";"Nom";"Prénom";"Téléphone";"E-mail";"Catégorie";"Référence billet";"Montant (XOF)";"Paiement";"Mode de paiement";"Présence";"Date d\'achat";"Heure d\'arrivée";"Statut e-mail";"Commande"');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^1;"Adjovi";"Ismaël";"\+2290195789513";"ismael\.adjovi@exemple\.bj";"Standard";"JCI-2026-000001";3000;"Payée";"Mobile Money \(MTN\)";"À venir";"\d\d\/\d\d\/\d{4} \d\d:\d\d";"";"Délivré";"CMD-T1"$/);
    expect(lines[5]).toContain(`"'=HYPERLINK(""http://x"",""Clic"")"`); // jamais une formule exécutable
    expect(lines[4]).toContain('"Remboursée"');

    const filtered = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/participants/export?presence=PRESENT`, headers: { authorization: `Bearer ${ids.admin}` } });
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { action: 'participants.export', entityId: eventId } })).toBe(2);
  });

  it('export Excel : vrai classeur .xlsx', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/participants/export?format=xlsx`, headers: { authorization: `Bearer ${ids.admin}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK'); // archive zip
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.rawPayload as never);
    const ws = wb.getWorksheet('Participants')!;
    expect(ws.rowCount).toBe(6);
    expect(ws.getRow(2).getCell(2).value).toBe('Adjovi');
    expect(ws.getRow(2).getCell(8).value).toBe(3000); // montant numérique
    expect(ws.getRow(6).getCell(2).value).toBe('=HYPERLINK("http://x","Clic")'); // texte, pas formule
    expect(typeof ws.getRow(6).getCell(2).value).toBe('string');
  });

  it('export : permission `participant.export` et paramètres vérifiés', async () => {
    expect((await call(`/events/${eventId}/participants/export`, ids.seller)).statusCode).toBe(403);
    expect((await call(`/events/${eventId}/participants/export`, ids.organizer)).statusCode).toBe(404);
    expect((await call(`/events/${eventId}/participants/export?format=pdf`, ids.admin)).statusCode).toBe(422);
  });

  it('fiche billet : détail complet, historique des e-mails, fichiers pas encore prêts', async () => {
    const t = json(await call(`/tickets/${tk['JCI-2026-000005']}`, ids.admin));
    expect(t).toMatchObject({ ticketNumber: 'JCI-2026-000005', eventId, eventTitle: 'Soirée test', presence: 'UPCOMING', filesReady: false, amountXof: 3000, category: { name: 'Standard' } });
    expect(t.holder).toMatchObject({ firstName: 'Evil', email: null, phone: null });
    expect(t.order).toMatchObject({ reference: 'CMD-T4', buyerName: 'Koffi Ahoussou', paymentMethod: 'MOBILE_MONEY_MTN', soldBy: null });
    expect(t.emails.map((e: any) => `${e.template}:${e.status}`)).toEqual(['TICKET_RESEND:SENT', 'TICKET_CONFIRMATION:FAILED']);

    const used = json(await call(`/tickets/${tk['JCI-2026-000003']}`, ids.admin));
    expect(used).toMatchObject({ presence: 'PRESENT', order: { channel: 'PHYSICAL', soldBy: 'vendeur1 Test', paymentMethod: 'CASH' }, emails: [] });
    expect(used.checkedInAt).not.toBeNull();
  });

  it('fiche billet : « filesReady » dès que les 3 fichiers existent', async () => {
    const id = tk['JCI-2026-000001'];
    expect(json(await call(`/tickets/${id}`, ids.admin)).filesReady).toBe(false);
    for (const kind of ['TICKET_PDF', 'TICKET_IMAGE', 'SHARE_VISUAL'] as const) {
      await prisma.generatedFile.create({ data: { kind, ticketId: id, eventId, bucket: 'tickets', storagePath: `x/${kind}`, mime: 'application/pdf', sizeBytes: 1, templateVersion: 1 } });
    }
    expect(json(await call(`/tickets/${id}`, ids.admin)).filesReady).toBe(true);
  });

  it('fiche billet : le vendeur de la vente y accède, pas un autre vendeur ni un étranger', async () => {
    const mine = tk['JCI-2026-000003']; // vente de `seller`
    expect((await call(`/tickets/${mine}`, ids.seller)).statusCode).toBe(200);
    expect((await call(`/tickets/${mine}`, ids.seller2)).statusCode).toBe(404);
    expect((await call(`/tickets/${mine}`, ids.organizer)).statusCode).toBe(404);
    expect((await call(`/tickets/${tk['JCI-2026-000001']}`, ids.seller)).statusCode).toBe(404); // pas sa vente
    expect((await call(`/tickets/${mine}`)).statusCode).toBe(401);
    expect((await call(`/tickets/${randomUUID()}`, ids.admin)).statusCode).toBe(404);
  });
});
