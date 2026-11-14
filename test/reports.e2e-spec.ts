/**
 * Rapports PDF (onglet « Documents ») : droits par rapport, périmètre, brouillon, contenu exact des chiffres, nom du fichier, journal d'audit.
 * Les chiffres sont relus dans le PDF avec `pdftotext` quand il est installé (poppler-utils) ; sinon seule la structure du fichier est vérifiée.
 * Prérequis : voir api.e2e-spec.ts (+ Chromium : CHROMIUM_PATH). ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;
const DAY = 86400e3;
const H = 3600e3;

const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;
const dt = hasPdftotext ? it : it.skip;

/** Texte du PDF, espaces et espaces insécables ramenés à une seule espace : « Recettes nettes 19 000 XOF ». */
function pdfText(buf: Buffer): string {
  const r = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 50 * 1024 * 1024 });
  return r.stdout.toString('utf8').replace(/[\s\u00a0\u202f]+/g, ' ').replace(/ ?%/g, '%');
}
/** Ligne attendue, sous la même forme que le texte relu (« 67 % » → « 67% »). */
const L = (s: string) => s.replace(/ ?%/g, '%');
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

d('Rapports PDF (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), organizer: randomUUID(), partial: randomUUID(), agent: randomUUID(), seller: randomUUID(), otherOrganizer: randomUUID() };
  let ev: string; let evDraft: string; let evOther: string;
  let seq = 0;

  const get = async (url: string, as?: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {} });
    checkContract('GET', `/api/v1${url}`, res.statusCode, res.body);
    return res;
  };
  const report = (kind: string, as?: string, event = ev) => get(`/events/${event}/reports/${kind}`, as);
  const pdf = async (kind: string, as = ids.admin) => {
    const res = await report(kind, as);
    expect(res.statusCode).toBe(200);
    return res.rawPayload;
  };
  const body = (res: { body: string }) => JSON.parse(res.body);

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

    await prisma.userRole.deleteMany({ where: { role: { code: 'PARTIAL_TEST' } } });
    await prisma.role.deleteMany({ where: { code: 'PARTIAL_TEST' } });
    await prisma.$executeRawUnsafe('TRUNCATE audit_logs, payment_events, order_holders, ticket_categories, events, user_roles, profiles, counters, auth.users CASCADE');
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    // Rôle de test : peut sortir la liste des participants, mais ni les recettes ni les entrées.
    roles.PARTIAL_TEST = (await prisma.role.create({ data: { code: 'PARTIAL_TEST', name: 'Partiel (test)', eventScope: 'ALL_EVENTS', permissions: { create: [{ permission: 'event.read' }, { permission: 'report.view' }, { permission: 'participant.export' }] } } })).id;
    const mk = async (id: string, email: string, first: string, role: string, scoped?: string) => {
      await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','${email}')`);
      await prisma.profile.create({ data: { id, email, firstName: first, lastName: 'Test' } });
      await prisma.userRole.create({ data: { userId: id, roleId: roles[role], eventId: scoped ?? null } });
    };
    await mk(ids.admin, 'admin@t.bj', 'Admin', 'ADMIN');
    await mk(ids.partial, 'partiel@t.bj', 'Partiel', 'PARTIAL_TEST');

    const now = Date.now();
    const base = { description: 'x', venueName: 'GI Mono', city: 'Comé', maxPerOrder: 5, createdById: ids.admin, publishedAt: new Date(now - 30 * DAY), salesOpensAt: new Date(now - 20 * DAY) };
    // Événement terminé il y a deux jours : les billets non scannés sont des « absents ».
    ev = (await prisma.event.create({ data: { ...base, slug: 'e-rep', title: 'Leadership & Impact', status: 'PUBLISHED', startsAt: new Date(now - 2 * DAY), endsAt: new Date(now - 2 * DAY + 9 * H) } })).id;
    evDraft = (await prisma.event.create({ data: { ...base, slug: 'e-brouillon', title: 'Brouillon', status: 'DRAFT', publishedAt: null, startsAt: new Date(now + DAY) } })).id;
    evOther = (await prisma.event.create({ data: { ...base, slug: 'e-autre', title: 'Autre', status: 'PUBLISHED', startsAt: new Date(now + DAY) } })).id;
    await mk(ids.organizer, 'orga@t.bj', 'Orga', 'ORGANIZER', ev);
    await mk(ids.otherOrganizer, 'orga2@t.bj', 'Orga2', 'ORGANIZER', evOther);
    await mk(ids.agent, 'agent@t.bj', 'Agent', 'GATE_AGENT', ev);
    await mk(ids.seller, 'vendeur@t.bj', 'Vendeur', 'SELLER', ev);
    await prisma.eventOrganizer.create({ data: { eventId: ev, name: 'JCI Comé Excellence', position: 0 } });
    await prisma.eventProgramItem.createMany({ data: [{ eventId: ev, time: '08:00', label: 'Accueil', position: 0 }, { eventId: ev, time: '09:00', label: 'Ouverture officielle', position: 1 }] });

    const mkCat = async (name: string, priceXof: number, position: number) => (await prisma.ticketCategory.create({ data: { eventId: ev, name, priceXof, quota: 100, position } })).id;
    const standard = await mkCat('Standard', 3000, 0); const vip = await mkCat('VIP', 10000, 1);

    type Pay = { provider: 'FEDAPAY' | 'PHYSICAL'; method: 'CARD' | 'MOBILE_MONEY_MTN' | 'CASH'; status: 'PAID' | 'REFUNDED' | 'FAILED' | 'PENDING' | 'REFUND_REQUIRED'; reason?: string };
    const mkOrder = async (cat: string, price: number, ref: string, last: string, first: string, orderStatus: 'PAID' | 'REFUNDED' | 'FAILED' | 'PAYMENT_IN_PROGRESS' | 'REFUND_REQUIRED',
                          pay: Pay, ticket?: 'VALID' | 'USED' | 'CANCELLED' | 'REFUNDED', phone = '+2290195789513') => {
      seq += 1;
      const channel = pay.provider === 'PHYSICAL' ? 'PHYSICAL' : 'ONLINE';
      const order = await prisma.order.create({
        data: {
          reference: ref, eventId: ev, channel, status: orderStatus, buyerFirstName: first, buyerLastName: last, buyerEmail: `${first.toLowerCase()}@exemple.bj`, totalXof: price,
          paidAt: orderStatus === 'PAID' || orderStatus === 'REFUNDED' ? new Date(now - 10 * DAY) : null,
          items: { create: [{ categoryId: cat, quantity: 1, unitPriceXof: price }] },
          payments: { create: [{
            provider: pay.provider, method: pay.method, status: pay.status, expectedAmountXof: price,
            confirmedAmountXof: ['PAID', 'REFUNDED', 'REFUND_REQUIRED'].includes(pay.status) ? price : null, failureReason: pay.reason ?? null,
            confirmedAt: ['PAID', 'REFUNDED'].includes(pay.status) ? new Date(now - 10 * DAY) : null,
          }] },
        }, include: { items: true },
      });
      if (!ticket) return null;
      return prisma.ticket.create({
        data: {
          number: `JCI-2026-${String(seq).padStart(6, '0')}`, qrToken: `tok${seq}${randomUUID().replaceAll('-', '')}`, eventId: ev, orderId: order.id, orderItemId: order.items[0].id, categoryId: cat,
          holderFirstName: first, holderLastName: last, holderEmail: `${first.toLowerCase()}@exemple.bj`, holderPhone: phone, status: ticket,
          cancelledAt: ticket === 'CANCELLED' || ticket === 'REFUNDED' ? new Date() : null,
          checkedInAt: ticket === 'USED' ? new Date(now - 2 * DAY + 90 * 60e3) : null, checkedInById: ticket === 'USED' ? ids.agent : null,
          issuedAt: new Date(now - (12 - seq) * DAY),
        },
      });
    };
    const t1 = await mkOrder(standard, 3000, 'CMD-T1', 'Adjovi', 'Ismaël', 'PAID', { provider: 'FEDAPAY', method: 'CARD', status: 'PAID' }, 'USED');
    await mkOrder(vip, 10000, 'CMD-T2', 'Soulé', 'Paul', 'PAID', { provider: 'FEDAPAY', method: 'MOBILE_MONEY_MTN', status: 'PAID' }, 'VALID', '+22961234567');
    await mkOrder(standard, 3000, 'CMD-T3', 'Dossou', 'Luc', 'PAID', { provider: 'PHYSICAL', method: 'CASH', status: 'PAID' }, 'USED');
    const t4 = await mkOrder(standard, 3000, 'CMD-T4', 'Sossou', 'Sènami', 'REFUNDED', { provider: 'FEDAPAY', method: 'CARD', status: 'REFUNDED' }, 'REFUNDED');
    await mkOrder(standard, 3000, 'CMD-T5', 'Dah', 'Aïcha', 'FAILED', { provider: 'FEDAPAY', method: 'CARD', status: 'FAILED' });
    await mkOrder(standard, 3000, 'CMD-T6', 'Bello', 'Fabrice', 'PAYMENT_IN_PROGRESS', { provider: 'FEDAPAY', method: 'MOBILE_MONEY_MTN', status: 'PENDING' });
    await mkOrder(standard, 3000, 'CMD-T7', 'Zossou', 'Carine', 'REFUND_REQUIRED', { provider: 'FEDAPAY', method: 'CARD', status: 'REFUND_REQUIRED', reason: 'LATE_PAYMENT_NO_CAPACITY' });
    await mkOrder(standard, 3000, 'CMD-T8', 'Agossou', 'Edwige', 'PAID', { provider: 'FEDAPAY', method: 'CARD', status: 'PAID' }, 'CANCELLED');
    // Entrées : un billet déjà scanné, un code inconnu, un billet remboursé présenté à l'accueil.
    const at = (m: number) => new Date(now - 2 * DAY + m * 60e3);
    await prisma.checkinAttempt.createMany({ data: [
      { eventId: ev, ticketId: t1!.id, agentId: ids.agent, result: 'VALID', scannedAt: at(90) },
      { eventId: ev, ticketId: t1!.id, agentId: ids.agent, result: 'ALREADY_USED', scannedAt: at(100) },
      { eventId: ev, ticketId: null, agentId: ids.agent, result: 'INVALID', tokenHint: 'abc123', scannedAt: at(110) },
      { eventId: ev, ticketId: t4!.id, agentId: ids.agent, result: 'REFUNDED', scannedAt: at(120) },
    ] });
  }, 90000);

  afterAll(async () => {
    await prisma?.userRole.deleteMany({ where: { role: { code: 'PARTIAL_TEST' } } });
    await prisma?.role.deleteMany({ where: { code: 'PARTIAL_TEST' } });
    await app?.close();
  }, 30000);

  /* ───────────── catalogue ───────────── */

  it('catalogue : quatre documents PDF, tous disponibles pour l’administrateur et l’organisateur de l’événement', async () => {
    for (const who of [ids.admin, ids.organizer]) {
      const r = await get(`/events/${ev}/reports`, who);
      expect(r.statusCode).toBe(200);
      expect(body(r).data.map((x: any) => [x.kind, x.available, x.formats])).toEqual([
        ['participants', true, ['pdf']], ['ticketing', true, ['pdf']], ['attendance', true, ['pdf']], ['payments', true, ['pdf']],
      ]);
    }
    expect(body(await get(`/events/${ev}/reports`, ids.admin)).data[0]).toMatchObject({ title: 'Liste des participants' });
  });

  it('catalogue : ce que l’utilisateur ne peut pas télécharger est indiqué, brouillon = rien de disponible, hors périmètre = 404', async () => {
    expect(body(await get(`/events/${ev}/reports`, ids.partial)).data.map((x: any) => [x.kind, x.available])).toEqual([['participants', true], ['ticketing', false], ['attendance', false], ['payments', false]]);
    expect(body(await get(`/events/${ev}/reports`, ids.agent)).data.every((x: any) => x.available === false)).toBe(true);
    expect(body(await get(`/events/${evDraft}/reports`, ids.admin)).data.every((x: any) => x.available === false)).toBe(true);
    expect((await get(`/events/${ev}/reports`, ids.otherOrganizer)).statusCode).toBe(404);
    expect((await get(`/events/${ev}/reports`)).statusCode).toBe(401);
  });

  /* ───────────── droits ───────────── */

  it('droits : participants avec participant.export, recettes et entrées refusées au rôle partiel ; agent et vendeur n’ont aucun rapport', async () => {
    expect((await report('participants', ids.partial)).statusCode).toBe(200);
    for (const kind of ['ticketing', 'attendance', 'payments']) {
      const r = await report(kind, ids.partial);
      expect([r.statusCode, body(r).code]).toEqual([403, 'FORBIDDEN']);
    }
    for (const who of [ids.agent, ids.seller]) for (const kind of ['participants', 'ticketing', 'attendance', 'payments']) expect((await report(kind, who)).statusCode).toBe(403);
    for (const kind of ['participants', 'payments']) expect((await report(kind, ids.otherOrganizer)).statusCode).toBe(404); // un événement hors périmètre n'existe pas
    expect((await report('payments')).statusCode).toBe(401);
  });

  it('un brouillon n’a pas de rapport (409), un type inconnu est refusé (422)', async () => {
    const draft = await report('participants', ids.admin, evDraft);
    expect([draft.statusCode, body(draft).code]).toEqual([409, 'INVALID_STATE']);
    expect((await report('inconnu', ids.admin)).statusCode).toBe(422);
  });

  /* ───────────── fichiers ───────────── */

  it('les quatre PDF : fichier valide à télécharger, nom daté, jamais mis en cache, plusieurs pages, téléchargement journalisé', async () => {
    const day = new Date(Date.now() + 3600e3).toISOString().slice(0, 10).replaceAll('-', '');
    for (const [kind, file] of [['participants', 'liste-participants'], ['ticketing', 'rapport-billetterie'], ['attendance', 'liste-presences'], ['payments', 'journal-paiements']]) {
      const res = await report(kind, ids.organizer);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${file}-e-rep-${day}\\.pdf"$`));
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pages(res.rawPayload)).toBeGreaterThanOrEqual(2); // couverture + au moins une page de contenu
    }
    const logs = await prisma.auditLog.findMany({ where: { action: 'report.export', entityId: ev, actorId: ids.organizer } });
    expect(logs.map((l) => (l.metadata as any).kind).sort()).toEqual(['attendance', 'participants', 'payments', 'ticketing']);
  });

  /* ───────────── contenu ───────────── */

  dt('liste des participants : fiche de l’événement, inscrits dans l’ordre d’émission, billets annulés ou remboursés écartés', async () => {
    const t = pdfText(await pdf('participants'));
    expect(t).toContain('Liste des participants');
    expect(t).toContain('Leadership & Impact');
    for (const line of ['Statut Clôturé'.replace('Clôturé', 'Publié, billetterie ouverte'), 'Lieu GI Mono, Comé', 'Organisateur JCI Comé Excellence', 'Participants inscrits 3', 'Programme 08h00 Accueil · 09h00 Ouverture officielle']) {
      // « Publié, billetterie ouverte » : la vente est ouverte tant que l'événement n'est pas clôturé
      expect(t).toContain(line);
    }
    expect(t.indexOf('Adjovi Ismaël')).toBeGreaterThan(-1);
    expect(t.indexOf('Adjovi Ismaël')).toBeLessThan(t.indexOf('Soulé Paul'));
    expect(t.indexOf('Soulé Paul')).toBeLessThan(t.indexOf('Dossou Luc'));
    expect(t).toContain('+229 01 95 78 95 13');
    expect(t).toContain('+22961234567'); // numéro à 8 chiffres (ancien format) : affiché tel quel
    expect(t).not.toContain('Sossou'); // remboursé
    expect(t).not.toContain('Agossou'); // annulé
    expect(t).toContain('2 billets annulés ou remboursés ne figurent pas dans cette liste.');
  });

  dt('rapport de billetterie : ventes, recettes brutes / remboursées / nettes, catégories, modes de paiement, présences, anomalies', async () => {
    const t = pdfText(await pdf('ticketing'));
    for (const line of [
      'Capacité de l’événement 200 places', 'Billets vendus 5 (dont 1 remboursé)', 'Places restantes 197', 'Taux de remplissage 2 %',
      'Recettes brutes 22 000 XOF', 'Remboursements 3 000 XOF (1 billet)', 'Recettes nettes 19 000 XOF',
      'Standard 3 000 XOF 4 1 9 000 XOF', 'VIP 10 000 XOF 1 0 10 000 XOF', 'Total 5 1 19 000 XOF',
      '1 billet annulé par l’équipe',
      'FedaPay, Mobile Money 10 000 XOF 53 %', 'FedaPay, carte 6 000 XOF 32 %', 'Espèces 3 000 XOF 16 %',
      'Participants attendus 3 (5 billets, hors 1 remboursé et 1 annulé)', 'Entrées validées 2', 'Absents 1', 'Taux de présence 67 %',
      'Billet déjà scanné 1', 'Billet non reconnu 1', 'Billet remboursé 1',
    ]) expect(t).toContain(L(line));
  });

  dt('liste des présences : bilan, présences par catégorie, affluence, scans classés par heure, anomalies avec la référence ou le début du code', async () => {
    const t = pdfText(await pdf('attendance'));
    for (const line of [
      'Entrées validées 2', 'Absents 1', 'Taux de présence 67 %', 'Anomalies constatées 3', 'Premier scan', 'Dernier scan',
      'Standard 2 2 0 100 %', 'VIP 1 0 1 0 %', 'Total 3 2 1 67 %',
      'Adjovi Ismaël', 'Dossou Luc', 'JCI-2026-000001', 'Billet déjà scanné', 'Code abc123…', 'Billet non reconnu', 'Billet remboursé',
    ]) expect(t).toContain(L(line));
    expect(t).not.toContain('Soulé Paul JCI'); // jamais entré : absent de la liste des scans valides
  });

  dt('journal des paiements : bilan FedaPay, répartition, transactions avec statut, remboursements, remboursements à effectuer', async () => {
    const t = pdfText(await pdf('payments'));
    for (const line of [
      'Commandes FedaPay 7', 'Transactions approuvées 4 (dont 1 remboursée)', 'Transactions échouées ou expirées 1', 'Transactions en attente 1',
      'À rembourser (action requise) 1 (3 000 XOF)', 'Taux de réussite 57 %', 'Montant encaissé 19 000 XOF', 'Remboursements 3 000 XOF', 'Montant net 16 000 XOF',
      'Carte bancaire 5 3 1 1 6 000 XOF', 'Mobile Money 2 1 0 0 10 000 XOF', 'Espèces 1 1 0 0 3 000 XOF',
      'CMD-T1', 'Approuvée', 'CMD-T4', 'Remboursée', 'CMD-T5', 'Échouée', 'CMD-T6', 'En attente', 'CMD-T7', 'À rembourser',
      'Remboursements à effectuer', 'Paiement tardif, plus de place',
    ]) expect(t).toContain(L(line));
    expect(t).not.toContain('CMD-T3 '); // vente à l'accueil : pas une transaction en ligne
  });

  it('un événement sans aucune vente produit quand même des rapports lisibles (listes vides, zéros)', async () => {
    const empty = (await prisma.event.create({ data: { slug: 'e-vide', title: 'Événement vide', description: 'x', status: 'PUBLISHED', publishedAt: new Date(), startsAt: new Date(Date.now() + DAY), createdById: ids.admin } })).id;
    for (const kind of ['participants', 'ticketing', 'attendance', 'payments']) {
      const res = await report(kind, ids.admin, empty);
      expect(res.statusCode).toBe(200);
      expect(pages(res.rawPayload)).toBeGreaterThanOrEqual(2);
    }
    if (hasPdftotext) {
      const t = pdfText((await report('participants', ids.admin, empty)).rawPayload);
      expect(t).toContain('Aucun participant inscrit pour le moment.');
    }
  });
});
