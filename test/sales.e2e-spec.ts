/**
 * Parcours d'achat complet : réservation, paiement FedaPay (serveur simulé), webhooks signés, billets, expiration,
 * paiement tardif, doublons, remboursement, ventes physiques, annulation. Voir api.e2e-spec.ts pour les prérequis.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeStorage } from './fakes';
import { PNG } from 'pngjs';
import * as http from 'node:http';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;
const WH_SECRET = 'wh_sandbox_test_secret';

d('Ventes (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let maintenance: import('../src/sales/maintenance.service').MaintenanceService;
  let computeSignature: typeof import('../src/sales/fedapay-signature').computeSignature;
  let emailSvc: import('../src/tickets/ticket-email.service').TicketEmailService;
  let jobsSvc: import('../src/jobs/jobs.service').JobsService;

  // ── Faux Brevo + stockage ──
  const storage = fakeStorage();
  const mails: { n: number; body: any }[] = [];
  let brevoFail = false;
  let brevoSrv: http.Server;
  const BREVO_TOKEN = 'brevo_webhook_token_test_123456';

  // ── Faux FedaPay ──
  const txns = new Map<number, Record<string, any>>();
  let nextTxn = 9000;
  let outage = false;
  let mock: http.Server;
  const approve = (id: number, over: Record<string, any> = {}) => Object.assign(txns.get(id)!, { status: 'approved', mode: 'mtn', paid_at: new Date().toISOString() }, over);

  const ids = { admin: randomUUID(), organizer: randomUUID(), seller: randomUUID(), seller2: randomUUID() };
  let slug: string; let eventId: string;
  const cat: Record<string, string> = {};

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { as?: string; payload?: object; headers?: Record<string, string> } = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(opts.as ? { authorization: `Bearer ${opts.as}` } : {}), ...opts.headers }, payload: opts.payload as never });
    checkContract(method, `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);
  const key = () => `${randomUUID()}-key`;
  const holder = (categoryId: string, n = 1) => Array.from({ length: n }, (_, i) => ({ categoryId, firstName: `Prénom${i}`, lastName: 'Nom', email: `p${i}@exemple.bj` }));
  const buyer = { firstName: 'Koffi', lastName: 'Ahoussou', email: 'koffi@exemple.bj', phone: '+229 01 95 78 95 13' };

  const order = (tickets: object[], k = key(), extra: object = {}) =>
    call('POST', `/public/events/${slug}/orders`, { headers: { 'idempotency-key': k }, payload: { buyer, tickets, acceptedTerms: true, ...extra } });
  const txnOf = async (reference: string) => Number((await prisma.payment.findFirstOrThrow({ where: { order: { reference } }, orderBy: { createdAt: 'desc' } })).providerTransactionId);
  const state = async (reference: string) => prisma.order.findUniqueOrThrow({ where: { reference }, include: { payments: true, tickets: true } });
  const stock = async (name: string) => { const c = await prisma.ticketCategory.findUniqueOrThrow({ where: { id: cat[name] } }); return { sold: c.soldCount, reserved: c.reservedCount }; };

  let evtSeq = 100;
  const webhook = (txnId: number, over: { name?: string; id?: number | null; t?: number; secret?: string } = {}) => {
    const raw = JSON.stringify({ ...(over.id === null ? {} : { id: over.id ?? ++evtSeq }), object: 'event', name: over.name ?? 'transaction.approved', entity: { id: txnId, klass: 'v1/transaction' }, object_id: txnId });
    const t = over.t ?? Math.floor(Date.now() / 1000);
    return app.inject({ method: 'POST', url: '/api/v1/webhooks/fedapay', payload: raw, headers: { 'content-type': 'application/json', 'x-fedapay-signature': `t=${t},s=${computeSignature(over.secret ?? WH_SECRET, t, raw)}` } });
  };
  const waitFor = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 15000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waitFor'); await new Promise((r) => setTimeout(r, 150)); }
  };

  beforeAll(async () => {
    mock = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const send = (code: number, body: object) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.headers.authorization !== 'Bearer sk_sandbox_test_key') return send(401, { message: 'unauthorized' });
        const m = req.url!.match(/^\/v1\/transactions(?:\/(\d+))?(\/token)?$/);
        if (!m) return send(404, {});
        if (req.method === 'POST' && !m[1]) {
          if (outage) return send(503, { message: 'down' });
          const b = JSON.parse(data); const id = nextTxn++;
          txns.set(id, { id, reference: `trx_${id}`, status: 'pending', amount: b.amount, mode: null, custom_metadata: b.custom_metadata, callback_url: b.callback_url, customer: b.customer, description: b.description });
          return send(201, { 'v1/transaction': txns.get(id) });
        }
        if (req.method === 'POST' && m[2]) return txns.has(+m[1]) ? send(200, { token: `tok${m[1]}`, url: `https://sandbox-process.fedapay.com/tok${m[1]}` }) : send(404, {});
        if (req.method === 'GET' && m[1]) return txns.has(+m[1]) ? send(200, { 'v1/transaction': txns.get(+m[1]) }) : send(404, {});
        send(404, {});
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const port = (mock.address() as import('node:net').AddressInfo).port;

    brevoSrv = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const send = (code: number, body: object) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.headers['api-key'] !== 'xkeysib-test-key') return send(401, { code: 'unauthorized', message: 'Key not found' });
        if (req.method !== 'POST' || req.url !== '/v3/smtp/email') return send(404, {});
        if (brevoFail) return send(503, { code: 'service_unavailable', message: 'down' });
        const body = JSON.parse(data);
        const n = mails.length + 1;
        mails.push({ n, body });
        send(201, { messageId: `<20261107.${n}@smtp-relay.mailin.fr>` });
      });
    });
    await new Promise<void>((r) => brevoSrv.listen(0, '127.0.0.1', r));
    const brevoPort = (brevoSrv.address() as import('node:net').AddressInfo).port;

    // Chromium : CHROMIUM_PATH, sinon celui de @sparticuz/chromium (Linux)
    let chromiumPath = process.env.CHROMIUM_PATH;
    if (!chromiumPath) chromiumPath = await (await import('@sparticuz/chromium')).default.executablePath();

    Object.assign(process.env, {
      DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30),
      PUBLIC_WEB_URL: 'http://localhost:5173', ADMIN_WEB_URL: 'http://localhost:5174',
      FEDAPAY_SECRET_KEY: 'sk_sandbox_test_key', FEDAPAY_WEBHOOK_SECRET: WH_SECRET, FEDAPAY_API_BASE: `http://127.0.0.1:${port}`,
      RATE_LIMIT_DISABLED: 'true', JOBS_POLL_SECONDS: '0.5', PROCESS_ROLE: 'all',
      BREVO_API_KEY: 'xkeysib-test-key', BREVO_SENDER_EMAIL: 'billets@jci-come.bj', BREVO_API_BASE: `http://127.0.0.1:${brevoPort}`, BREVO_WEBHOOK_TOKEN: BREVO_TOKEN,
      CHROMIUM_PATH: chromiumPath, CHROMIUM_HEADLESS_SHELL: process.env.CHROMIUM_HEADLESS_SHELL ?? 'true', TICKET_QR_BASE_URL: 'https://jcicomee.com/billet',
    });
    const { Test } = await import('@nestjs/testing');
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    const { AppModule } = await import('../src/app.module');
    const { TokenVerifier } = await import('../src/auth/token-verifier.service');
    const { SupabaseAdminService } = await import('../src/supabase/supabase-admin.service');
    const { AllExceptionsFilter } = await import('../src/common/http-exception.filter');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const { MaintenanceService } = await import('../src/sales/maintenance.service');
    ({ computeSignature } = await import('../src/sales/fedapay-signature'));

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue({ verify: async (t: string) => t })
      .overrideProvider(SupabaseAdminService).useValue({ client: storage.client })
      .compile();
    app = mod.createNestApplication(new FastifyAdapter({ trustProxy: true }), { rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    maintenance = app.get(MaintenanceService);
    emailSvc = app.get((await import('../src/tickets/ticket-email.service')).TicketEmailService);
    jobsSvc = app.get((await import('../src/jobs/jobs.service')).JobsService);

    await prisma.$executeRawUnsafe('TRUNCATE audit_logs, payment_events, order_holders, ticket_categories, events, user_roles, profiles, counters, auth.users CASCADE');
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    const mk = async (id: string, email: string, role: string, scoped?: string) => {
      await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','${email}')`);
      await prisma.profile.create({ data: { id, email, firstName: email.split('@')[0], lastName: 'Test' } });
      await prisma.userRole.create({ data: { userId: id, roleId: roles[role], eventId: scoped ?? null } });
    };
    await mk(ids.admin, 'admin@t.bj', 'ADMIN');
    await mk(ids.organizer, 'orga@t.bj', 'ORGANIZER');

    const ev = await prisma.event.create({
      data: {
        slug: 'leadership-impact-2026', title: 'Leadership & Impact', description: 'Une journée pour inspirer.', status: 'PUBLISHED', publishedAt: new Date(),
        startsAt: new Date(Date.now() + 20 * 86400e3), endsAt: new Date(Date.now() + 20 * 86400e3 + 9 * 3600e3), venueName: 'Centre des Congrès', city: 'Comé',
        salesOpensAt: new Date(Date.now() - 86400e3), salesClosesAt: new Date(Date.now() + 19 * 86400e3), maxPerOrder: 5, createdById: ids.admin,
      },
    });
    eventId = ev.id; slug = ev.slug;
    for (const [i, [name, price, quota]] of ([['Standard', 3000, 100], ['VIP', 10000, 5], ['Rare', 2000, 5]] as const).entries()) {
      cat[name] = (await prisma.ticketCategory.create({ data: { eventId, name, priceXof: price, quota, position: i } })).id;
    }
    await prisma.event.create({ data: { slug: 'brouillon-secret', title: 'Secret', createdById: ids.admin } });
    // Affiche de l'événement (stockée dans le bucket public simulé)
    storage.bucket('event-posters').set(`${eventId}/affiche.jpg`, { data: readFileSync(join(__dirname, 'fixtures', 'poster.jpg')), contentType: 'image/jpeg' });
    await prisma.eventPoster.create({ data: { eventId, storagePath: `${eventId}/affiche.jpg`, mime: 'image/jpeg', sizeBytes: 23543, width: 480, height: 600, isCover: true } });
    await mk(ids.seller, 'vendeur1@t.bj', 'SELLER', eventId);
    await mk(ids.seller2, 'vendeur2@t.bj', 'SELLER', eventId);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    for (const srv of [mock, brevoSrv]) { srv?.closeAllConnections?.(); await new Promise((r) => srv?.close(r)); } // connexions keep-alive de fetch : sinon le processus ne s'arrête pas
  });

  // ───────────── Page publique ─────────────
  it('page publique : disponibilités sans exposer le stock exact ; brouillon introuvable', async () => {
    const e = json(await call('GET', `/public/events/${slug}`));
    expect(e.salesStatus).toBe('OPEN');
    const byName = Object.fromEntries(e.categories.map((c: any) => [c.name, c]));
    expect(byName.Standard.remaining).toBe(10); // plafonné
    expect(byName.VIP.remaining).toBe(5);
    expect(byName.Standard.availability).toBe('AVAILABLE');
    expect((await call('GET', '/public/events/brouillon-secret')).statusCode).toBe(404);
    expect((await call('POST', `/public/events/${slug}/views`)).statusCode).toBe(204);
    expect(await prisma.eventViewDaily.count({ where: { eventId } })).toBe(1);
  });

  // ───────────── Création de commande ─────────────
  let ref1: string; let token1: string;
  it('commande : réserve les places, crée la transaction FedaPay, idempotente', async () => {
    const k = key();
    const r = await order(holder(cat.Standard, 2), k);
    expect(r.statusCode).toBe(201);
    const o = json(r);
    ref1 = o.reference; token1 = o.accessToken;
    expect(o.reference).toMatch(/^CMD-\d{4}$/);
    expect(o.amountXof).toBe(6000);
    expect(o.checkoutUrl).toMatch(/^https:\/\/sandbox-process\.fedapay\.com\/tok\d+$/);
    expect(await stock('Standard')).toEqual({ sold: 0, reserved: 2 });

    const st = await state(ref1);
    expect(st.status).toBe('PAYMENT_IN_PROGRESS');
    expect(st.reservationHeld).toBe(true);
    const t = txns.get(await txnOf(ref1))!;
    expect(t.amount).toBe(6000);
    expect(t.custom_metadata.order_reference).toBe(ref1);
    expect(t.callback_url).toBe(`http://localhost:5173/commande/${ref1}?token=${token1}`);
    expect(t.customer).toMatchObject({ firstname: 'Koffi', lastname: 'Ahoussou', email: 'koffi@exemple.bj', phone_number: { number: '0195789513', country: 'bj' } });

    const replay = json(await order(holder(cat.Standard, 2), k)); // même clé : pas de seconde commande ni de seconde réservation
    expect(replay.reference).toBe(ref1);
    expect(await stock('Standard')).toEqual({ sold: 0, reserved: 2 });
    expect(await prisma.order.count()).toBe(1);
  });

  it('commande : validations', async () => {
    expect(json(await order(holder(cat.Standard, 6))).code).toBe('MAX_PER_ORDER_EXCEEDED');
    expect((await order([{ ...holder(cat.Standard)[0], categoryId: randomUUID() }])).statusCode).toBe(422);
    expect((await order(holder(cat.Standard), key(), { buyer: { ...buyer, phone: 'abc' } })).statusCode).toBe(422);
    expect((await order(holder(cat.Standard), key(), { acceptedTerms: false })).statusCode).toBe(422);
    expect((await call('POST', `/public/events/${slug}/orders`, { headers: { 'idempotency-key': 'court' }, payload: { buyer, tickets: holder(cat.Standard), acceptedTerms: true } })).statusCode).toBe(422);
    expect((await call('POST', `/public/events/brouillon-secret/orders`, { headers: { 'idempotency-key': key() }, payload: { buyer, tickets: holder(cat.Standard), acceptedTerms: true } })).statusCode).toBe(404);
    expect(await stock('Standard')).toEqual({ sold: 0, reserved: 2 }); // aucune fuite de réservation
  });

  it('suivi de commande : jeton obligatoire', async () => {
    expect((await call('GET', `/public/orders/${ref1}?token=${'x'.repeat(43)}`)).statusCode).toBe(404);
    expect((await call('GET', `/public/orders/CMD-9999?token=${token1}`)).statusCode).toBe(404);
    const s = json(await call('GET', `/public/orders/${ref1}?token=${token1}`));
    expect(s.status).toBe('PAYMENT_IN_PROGRESS');
    expect(s.tickets).toEqual([]);
  });

  // ───────────── Webhooks ─────────────
  it('webhook : signature invalide, expirée ou absente → 401 ; événement non transactionnel ignoré', async () => {
    const id = await txnOf(ref1);
    expect((await webhook(id, { secret: 'mauvais_secret' })).statusCode).toBe(401);
    expect((await webhook(id, { t: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/fedapay', payload: { name: 'transaction.approved' } })).statusCode).toBe(401);
    expect(json(await webhook(id, { name: 'customer.created' })).ignored).toBe(true);
    expect(await prisma.paymentEvent.count()).toBe(0); // rien n'est enregistré sur une signature invalide
  });

  it('un webhook « approved » ne suffit pas : la transaction doit être approuvée chez FedaPay', async () => {
    const id = await txnOf(ref1); // la transaction simulée est toujours « pending »
    expect((await webhook(id)).statusCode).toBe(200);
    await waitFor(async () => (await prisma.paymentEvent.findFirst({ where: { processedAt: { not: null } } })) ?? false);
    const st = await state(ref1);
    expect(st.status).toBe('PAYMENT_IN_PROGRESS');
    expect(st.tickets).toHaveLength(0);
  });

  it('paiement confirmé : billets émis une seule fois, même si le webhook est rejoué', async () => {
    const id = await txnOf(ref1);
    approve(id, { mode: 'mtn' });
    expect((await webhook(id, { id: 555 })).statusCode).toBe(200);
    const st = await waitFor(async () => { const s = await state(ref1); return s.status === 'PAID' ? s : false; });

    expect(st.reservationHeld).toBe(false);
    expect(st.tickets).toHaveLength(2);
    expect(st.tickets.map((t) => t.number).sort()).toEqual([`JCI-${new Date().getFullYear()}-000001`, `JCI-${new Date().getFullYear()}-000002`]);
    expect(new Set(st.tickets.map((t) => t.qrToken)).size).toBe(2);
    expect(st.tickets.every((t) => t.qrToken.length === 22 && t.status === 'VALID')).toBe(true);
    expect(st.payments[0]).toMatchObject({ status: 'PAID', method: 'MOBILE_MONEY_MTN', confirmedAmountXof: 6000 });
    expect(await stock('Standard')).toEqual({ sold: 2, reserved: 0 });
    await waitFor(async () => Number((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM pgboss.job WHERE name='order.fulfilled'`))[0].c) >= 1);

    const dup = json(await webhook(id, { id: 555 }));        // même événement rejoué
    expect(dup.duplicate).toBe(true);
    expect((await webhook(id, { id: 556 })).statusCode).toBe(200); // autre événement, même transaction
    await waitFor(async () => (await prisma.paymentEvent.count({ where: { processedAt: { not: null } } })) >= 3);
    expect(await prisma.ticket.count()).toBe(2);
    expect(await stock('Standard')).toEqual({ sold: 2, reserved: 0 });

    const pub = json(await call('GET', `/public/orders/${ref1}?token=${token1}`));
    expect(pub.status).toBe('PAID');
    expect(pub.tickets).toHaveLength(2);
  });


  // ───────────── Billets : fichiers, e-mail, suivi ─────────────
  const png = (b: Buffer) => PNG.sync.read(b);
  const filesOf = (ticketIds: string[]) => prisma.generatedFile.findMany({ where: { ticketId: { in: ticketIds } }, orderBy: { storagePath: 'asc' } });
  const waitFiles = (ticketIds: string[]) => waitFor(async () => { const f = await filesOf(ticketIds); return f.length === ticketIds.length * 3 ? f : false; }, 40000);

  it('billets : fichiers générés (PDF, image, visuel de partage) et enregistrés dans le stockage privé', async () => {
    const st = await state(ref1);
    const files = await waitFiles(st.tickets.map((t) => t.id));
    expect(files.map((f) => f.kind).sort()).toEqual(['SHARE_VISUAL', 'SHARE_VISUAL', 'TICKET_IMAGE', 'TICKET_IMAGE', 'TICKET_PDF', 'TICKET_PDF']);
    expect(files.every((f) => f.bucket === 'tickets' && f.templateVersion === 1 && f.sizeBytes > 1000)).toBe(true);
    const t1 = st.tickets.find((t) => t.number.endsWith('000001'))!;
    for (const f of files.filter((x) => x.ticketId === t1.id)) {
      const obj = storage.bucket('tickets').get(f.storagePath)!;
      expect(obj.data.length).toBe(f.sizeBytes);
      expect(f.storagePath).toBe(`${eventId}/${t1.id}/${t1.number}-v1.${f.kind === 'TICKET_PDF' ? 'pdf' : f.kind === 'TICKET_IMAGE' ? 'png' : 'jpg'}`);
      if (f.kind === 'TICKET_PDF') { expect(obj.data.subarray(0, 5).toString()).toBe('%PDF-'); expect(f.mime).toBe('application/pdf'); }
      if (f.kind === 'TICKET_IMAGE') { const im = png(obj.data); expect([im.width, im.height]).toEqual([2244, 752]); expect(f.mime).toBe('image/png'); }
      if (f.kind === 'SHARE_VISUAL') { expect(obj.data.subarray(0, 3).toString('hex')).toBe('ffd8ff'); expect(f.mime).toBe('image/jpeg'); }
    }
    // le contenu n'est jamais public : bucket « tickets », jamais « event-posters »
    expect([...storage.bucket('event-posters').keys()].some((k) => k.includes('JCI-'))).toBe(false);
  });

  it('e-mail de confirmation : une seule fois, avec les PDF et le visuel de partage en pièces jointes', async () => {
    const st = await state(ref1);
    const mail = await waitFor(async () => mails.find((m) => m.body.to[0].email === 'koffi@exemple.bj') ?? false, 40000);
    const b = mail.body;
    expect(b.sender).toEqual({ name: 'JCI Comé Excellence', email: 'billets@jci-come.bj' });
    expect(b.subject).toBe('Vos 2 billets — Leadership & Impact');
    const nums = st.tickets.map((t) => t.number).sort();
    expect(b.attachment.map((a: any) => a.name).sort()).toEqual([`Billet-${nums[0]}.pdf`, `Billet-${nums[1]}.pdf`, `Partage-${nums[0]}.jpg`].sort());
    for (const a of b.attachment.filter((x: any) => x.name.endsWith('.pdf'))) expect(Buffer.from(a.content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(b.htmlContent).toContain(`/commande/${ref1}?token=${token1}`);
    expect(b.htmlContent).toContain(nums[0]);
    expect(b.htmlContent).not.toMatch(/xk3p|qr_token/i);               // aucun jeton de QR dans l'e-mail

    const log = await prisma.emailLog.findFirstOrThrow({ where: { orderId: st.id } });
    expect(log).toMatchObject({ template: 'TICKET_CONFIRMATION', toEmail: 'koffi@exemple.bj', status: 'SENT', attempt: 1 });
    expect(log.brevoMessageId).toBe(`20261107.${mail.n}@smtp-relay.mailin.fr`); // stocké sans chevrons

    // Rejouer la tâche ne renvoie JAMAIS l'e-mail
    const before = mails.length;
    expect(await emailSvc.sendOrderConfirmation(st.id)).toBe('ALREADY_SENT');
    await jobsSvc.enqueue('order.fulfilled', { orderId: st.id });
    await new Promise((r) => setTimeout(r, 3500));
    expect(mails.length).toBe(before);
    expect(await prisma.emailLog.count({ where: { orderId: st.id } })).toBe(1);
  }, 60000);

  it('page de suivi de l’acheteur : liens de téléchargement signés dès que les fichiers sont prêts', async () => {
    const s = json(await call('GET', `/public/orders/${ref1}?token=${token1}`));
    expect(s.tickets).toHaveLength(2);
    for (const t of s.tickets) {
      expect(t.filesReady).toBe(true);
      expect(t.pdfUrl).toMatch(/^http:\/\/storage\.test\/tickets\/.+\.pdf\?token=.+&download=Billet-JCI-/);
      expect(t.imageUrl).toMatch(/\.png\?/); expect(t.shareVisualUrl).toMatch(/\.jpg\?/);
    }
  });

  it('suivi de livraison Brevo : jeton secret obligatoire, statuts qui n’avancent que dans un sens', async () => {
    const log = await prisma.emailLog.findFirstOrThrow({ where: { order: { reference: ref1 } } });
    const bw = async (body: object, token: string | null = BREVO_TOKEN) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/brevo', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as never });
      checkContract('POST', '/api/v1/webhooks/brevo', res.statusCode, res.body);
      return res;
    };
    const id = `<${log.brevoMessageId}>`;
    expect((await bw({ event: 'delivered', 'message-id': id }, null)).statusCode).toBe(401);
    expect((await bw({ event: 'delivered', 'message-id': id }, 'mauvais_jeton_mauvais')).statusCode).toBe(401);
    const status = async () => (await prisma.emailLog.findUniqueOrThrow({ where: { id: log.id } }));

    expect(json(await bw({ event: 'delivered', 'message-id': id, ts_event: 1_800_000_000 })).updated).toBe(1);
    expect((await status()).status).toBe('DELIVERED');
    expect((await status()).lastEventAt!.getTime()).toBe(1_800_000_000_000);
    expect(json(await bw({ event: 'request', 'message-id': id })).updated).toBe(0);        // un événement ancien n'écrase pas un statut plus avancé
    expect(json(await bw({ event: 'unique_opened', 'message-id': id })).updated).toBe(0);  // ouvertures ignorées
    expect(json(await bw({ event: 'delivered', 'message-id': '<inconnu@x>' })).updated).toBe(0);
    expect(json(await bw([{ event: 'hard_bounce', 'message-id': id, reason: 'adresse@privée.bj inconnue' }])).updated).toBe(1); // lot
    const after = await status();
    expect(after.status).toBe('HARD_BOUNCE');
    expect(after.error).toBe('hard_bounce');                                              // jamais le texte brut (peut contenir l'adresse)
    await prisma.emailLog.update({ where: { id: log.id }, data: { status: 'SENT', error: null } }); // remet l'état pour la suite
  });

  it('téléchargement d’un billet : URL signée, droits, 202 puis auto-réparation', async () => {
    const st = await state(ref1);
    const t = st.tickets.find((x) => x.number.endsWith('000001'))!;
    const pdf = json(await call('GET', `/tickets/${t.id}/files/pdf`, { as: ids.admin }));
    expect(pdf).toMatchObject({ fileName: `Billet-${t.number}.pdf`, contentType: 'application/pdf' });
    expect(pdf.url).toContain('storage.test/tickets/');
    expect(new Date(pdf.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(json(await call('GET', `/tickets/${t.id}/files/image`, { as: ids.admin })).contentType).toBe('image/png');
    expect(json(await call('GET', `/tickets/${t.id}/files/share`, { as: ids.admin })).fileName).toBe(`Partage-${t.number}.jpg`);
    expect((await call('GET', `/tickets/${t.id}/files/zip`, { as: ids.admin })).statusCode).toBe(422);
    expect((await call('GET', `/tickets/${t.id}/files/pdf`, { as: ids.organizer })).statusCode).toBe(404); // hors de son périmètre
    expect((await call('GET', `/tickets/${randomUUID()}/files/pdf`, { as: ids.admin })).statusCode).toBe(404);
    expect((await call('GET', `/tickets/${t.id}/files/pdf`)).statusCode).toBe(401);

    // Fichier manquant : 202 « en cours », la génération est relancée seule
    await prisma.generatedFile.deleteMany({ where: { ticketId: t.id, kind: 'SHARE_VISUAL' } });
    const pending = await call('GET', `/tickets/${t.id}/files/share`, { as: ids.admin });
    expect(pending.statusCode).toBe(202);
    expect(json(pending)).toEqual({ status: 'PENDING' });
    const ready = await waitFor(async () => { const r = await call('GET', `/tickets/${t.id}/files/share`, { as: ids.admin }); return r.statusCode === 200 ? json(r) : false; }, 40000);
    expect(ready.fileName).toBe(`Partage-${t.number}.jpg`);
    expect(mails.filter((m) => m.body.to[0].email === 'koffi@exemple.bj')).toHaveLength(1); // la régénération n'a pas renvoyé d'e-mail
  }, 90000);

  it('renvoi d’un billet : droits, limite horaire, adresse choisie', async () => {
    const st = await state(ref1);
    const t = st.tickets.find((x) => x.number.endsWith('000002'))!;
    const before = mails.length;
    expect((await call('POST', `/tickets/${t.id}/resend`, { as: ids.admin, payload: { toEmail: 'pas-un-email' } })).statusCode).toBe(422);
    const ok = await call('POST', `/tickets/${t.id}/resend`, { as: ids.admin, payload: { toEmail: 'Autre@Exemple.bj' } });
    expect(ok.statusCode).toBe(202);
    expect(json(ok)).toEqual({ queued: true });
    const mail = await waitFor(async () => mails.slice(before).find((m) => m.body.to[0].email === 'autre@exemple.bj') ?? false, 40000);
    expect(mail.body.subject).toBe('Votre billet — Leadership & Impact');
    expect(mail.body.attachment.filter((a: any) => a.name.endsWith('.pdf'))).toHaveLength(1);
    expect(mail.body.attachment[0].name).toBe(`Billet-${t.number}.pdf`);
    const log = await prisma.emailLog.findFirstOrThrow({ where: { ticketId: t.id, template: 'TICKET_RESEND' } });
    expect(log).toMatchObject({ status: 'SENT', toEmail: 'autre@exemple.bj', orderId: st.id });
    expect(await prisma.auditLog.count({ where: { action: 'ticket.resend', entityId: t.id } })).toBe(1);

    // sans adresse précisée : celle de l'acheteur
    const def = await call('POST', `/tickets/${t.id}/resend`, { as: ids.admin });
    expect(def.statusCode).toBe(202);
    const holderEmail = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).holderEmail!;
    const toHolder = await waitFor(async () => mails.slice(before).find((m) => m.body.to[0].email === holderEmail) ?? false, 40000); // adresse du bénéficiaire de ce billet
    expect(toHolder.body.subject).toBe('Votre billet — Leadership & Impact');

    expect((await call('POST', `/tickets/${t.id}/resend`, { as: ids.seller })).statusCode).toBe(403);       // un vendeur ne renvoie pas
    expect((await call('POST', `/tickets/${t.id}/resend`, { as: ids.organizer })).statusCode).toBe(404);    // hors de son périmètre
    // limite : 5 renvois par heure et par billet
    const n = await prisma.emailLog.count({ where: { ticketId: t.id, template: 'TICKET_RESEND', createdAt: { gt: new Date(Date.now() - 3600_000) } } });
    await prisma.emailLog.createMany({ data: Array.from({ length: Math.max(0, 5 - n) }, () => ({ orderId: st.id, ticketId: t.id, template: 'TICKET_RESEND' as const, toEmail: 'x@y.bj', status: 'SENT' as const })) });
    expect(json(await call('POST', `/tickets/${t.id}/resend`, { as: ids.admin })).code).toBe('RATE_LIMITED');
    // billet annulé : refusé
    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test' } });
    expect((await call('POST', `/tickets/${t.id}/resend`, { as: ids.admin })).statusCode).toBe(409);
    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'VALID', cancelledAt: null, cancelReason: null } });
  }, 90000);

  it('webhook sans identifiant d’événement : dédoublonné sur le contenu', async () => {
    const id = await txnOf(ref1);
    const a = await webhook(id, { id: null, t: Math.floor(Date.now() / 1000) });
    expect(a.statusCode).toBe(200);
  });

  // ───────────── Montant, refus, doublon ─────────────
  it('montant différent : aucun billet, paiement marqué « à rembourser »', async () => {
    const ref = json(await order(holder(cat.VIP))).reference;
    const id = await txnOf(ref);
    approve(id, { amount: 9000 });
    await webhook(id);
    const st = await waitFor(async () => { const s = await state(ref); return s.payments[0].status === 'REFUND_REQUIRED' ? s : false; });
    expect(st.status).not.toBe('PAID');
    expect(st.tickets).toHaveLength(0);
    expect(st.payments[0].failureReason).toBe('AMOUNT_MISMATCH');
    expect((await prisma.auditLog.count({ where: { action: 'payment.amount_mismatch' } }))).toBe(1);
  });

  it('paiement refusé puis nouvelle tentative : une seule commande, un seul billet', async () => {
    const before = await stock('Standard');
    const first = json(await order(holder(cat.Standard)));
    const ref = first.reference;
    const id1 = await txnOf(ref);
    txns.get(id1)!.status = 'declined';
    await webhook(id1, { name: 'transaction.declined' });
    await waitFor(async () => (await state(ref)).status === 'FAILED');
    expect((await state(ref)).reservationHeld).toBe(true); // places conservées pour la nouvelle tentative

    const retry = await call('POST', `/public/orders/${ref}/retry-payment?token=${first.accessToken}`);
    expect(retry.statusCode).toBe(200);
    const id2 = await txnOf(ref);
    expect(id2).not.toBe(id1);
    expect((await state(ref)).payments).toHaveLength(2);
    expect(await stock('Standard')).toEqual({ sold: before.sold, reserved: before.reserved + 1 }); // toujours 1 seule réservation

    // Relancer alors que le paiement est encore ouvert : on reprend la même transaction (pas de double débit possible)
    const again = await call('POST', `/public/orders/${ref}/retry-payment?token=${first.accessToken}`);
    expect(again.statusCode).toBe(200);
    expect(await txnOf(ref)).toBe(id2);

    approve(id2, { mode: 'moov' });
    await webhook(id2);
    const st = await waitFor(async () => { const s = await state(ref); return s.status === 'PAID' ? s : false; });
    expect(st.tickets).toHaveLength(1);
    expect(st.payments.find((p) => p.status === 'PAID')!.method).toBe('MOBILE_MONEY_MOOV');
  });

  it('deux paiements pour une même commande : le second est un doublon à rembourser', async () => {
    const o = json(await order(holder(cat.Standard)));
    const id1 = await txnOf(o.reference);
    const stOrder = await state(o.reference);
    // Simule une seconde transaction ouverte en parallèle (ancienne page de paiement restée ouverte)
    const id2 = nextTxn++;
    txns.set(id2, { id: id2, reference: `trx_${id2}`, status: 'pending', amount: 3000, custom_metadata: {} });
    await prisma.payment.create({ data: { orderId: stOrder.id, provider: 'FEDAPAY', status: 'PENDING', expectedAmountXof: 3000, providerTransactionId: String(id2) } });
    approve(id1); await webhook(id1);
    await waitFor(async () => (await state(o.reference)).status === 'PAID');
    approve(id2); await webhook(id2);
    const st = await waitFor(async () => { const s = await state(o.reference); return s.payments.some((p) => p.failureReason === 'DUPLICATE_PAYMENT') ? s : false; });
    expect(st.tickets).toHaveLength(1);
    expect(st.payments.filter((p) => p.status === 'PAID')).toHaveLength(1);
  });

  it('la page de retour interroge FedaPay : billets visibles même si le webhook est perdu', async () => {
    const o = json(await order(holder(cat.Standard)));
    approve(await txnOf(o.reference));
    const s = json(await call('GET', `/public/orders/${o.reference}?token=${o.accessToken}`));
    expect(s.status).toBe('PAID');
    expect(s.tickets).toHaveLength(1);
  });

  // ───────────── Expiration et paiement tardif ─────────────
  it('réservation expirée : places libérées ; paiement tardif honoré s’il reste du stock', async () => {
    const before = await stock('Standard');
    const o = json(await order(holder(cat.Standard)));
    expect(await stock('Standard')).toEqual({ sold: before.sold, reserved: before.reserved + 1 });
    await prisma.order.update({ where: { reference: o.reference }, data: { expiresAt: new Date(Date.now() - 10 * 60_000) } });

    const r = await maintenance.run();
    expect(r.released).toBeGreaterThanOrEqual(1);
    const st = await state(o.reference);
    expect(st.status).toBe('EXPIRED');
    expect(st.reservationHeld).toBe(false);
    expect(st.payments[0].status).toBe('EXPIRED');
    expect(await stock('Standard')).toEqual(before);
    expect((await call('POST', `/public/orders/${o.reference}/retry-payment?token=${o.accessToken}`)).statusCode).toBe(409);

    const id = await txnOf(o.reference);
    approve(id); await webhook(id); // le client a payé après l'expiration
    const paid = await waitFor(async () => { const s = await state(o.reference); return s.status === 'PAID' ? s : false; });
    expect(paid.tickets).toHaveLength(1);
    expect(await stock('Standard')).toEqual({ sold: before.sold + 1, reserved: before.reserved });
  });

  it('paiement tardif sans stock : commande « remboursement requis », pas de billet', async () => {
    const o = json(await order(holder(cat.VIP)));
    await prisma.order.update({ where: { reference: o.reference }, data: { expiresAt: new Date(Date.now() - 10 * 60_000) } });
    await maintenance.run();
    const vip = await prisma.ticketCategory.findUniqueOrThrow({ where: { id: cat.VIP } });
    await prisma.ticketCategory.update({ where: { id: cat.VIP }, data: { soldCount: vip.quota - vip.reservedCount } }); // plus aucune place VIP libre
    const id = await txnOf(o.reference);
    approve(id); await webhook(id);
    const st = await waitFor(async () => { const s = await state(o.reference); return s.status === 'REFUND_REQUIRED' ? s : false; });
    expect(st.tickets).toHaveLength(0);
    expect(st.payments[0]).toMatchObject({ status: 'REFUND_REQUIRED', failureReason: 'LATE_PAYMENT_NO_CAPACITY' });
    expect(json(await call('GET', `/public/orders/${o.reference}?token=${o.accessToken}`)).message).toMatch(/remboursement/);
    await prisma.ticketCategory.update({ where: { id: cat.VIP }, data: { soldCount: vip.soldCount } });
  });

  it('le balayage revérifie les paiements dont le webhook a été perdu', async () => {
    const o = json(await order(holder(cat.Standard)));
    const id = await txnOf(o.reference);
    approve(id);
    await prisma.payment.updateMany({ where: { providerTransactionId: String(id) }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await maintenance.run();
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect((await state(o.reference)).status).toBe('PAID');
  });

  it('remboursement chez FedaPay : billets invalidés, places remises en vente', async () => {
    const st0 = await state(ref1);
    const before = await stock('Standard');
    const id = await txnOf(ref1);
    txns.get(id)!.status = 'refunded';
    await webhook(id, { name: 'transaction.updated' });
    const st = await waitFor(async () => { const s = await state(ref1); return s.status === 'REFUNDED' ? s : false; });
    expect(st.tickets.every((t) => t.status === 'REFUNDED')).toBe(true);
    expect(st.payments[0].status).toBe('REFUNDED');
    expect(await stock('Standard')).toEqual({ sold: before.sold - st0.tickets.length, reserved: before.reserved });
  });

  // ───────────── Concurrence et panne ─────────────
  it('concurrence : 20 acheteurs simultanés pour 5 places → exactement 5 commandes', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => order(holder(cat.Rare))));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes.filter((c) => c === 409)).toHaveLength(15);
    expect(json(results.find((r) => r.statusCode === 409)!).code).toBe('QUOTA_EXCEEDED');
    expect(await stock('Rare')).toEqual({ sold: 0, reserved: 5 });
    await prisma.ticketCategory.update({ where: { id: cat.Rare }, data: { reservedCount: 0 } });
    await prisma.order.updateMany({ where: { items: { some: { categoryId: cat.Rare } } }, data: { reservationHeld: false, status: 'EXPIRED' } });
  });

  it('FedaPay indisponible : erreur claire, réservation libérée immédiatement', async () => {
    const before = await stock('Standard');
    outage = true;
    const r = await order(holder(cat.Standard));
    outage = false;
    expect(r.statusCode).toBe(502);
    expect(json(r).code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(await stock('Standard')).toEqual(before);
    const o = await prisma.order.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(o).toMatchObject({ status: 'FAILED', reservationHeld: false });
  });

  // ───────────── Ventes physiques ─────────────
  const sale = (as: string, tickets: object[], k = key(), extra: object = {}) =>
    call('POST', '/physical-sales', { as, headers: { 'idempotency-key': k }, payload: { eventId, buyer: { firstName: 'Yao', lastName: 'Gbaguidi', phone: '0197764997' }, tickets, paymentMethod: 'CASH', paymentReceivedConfirmed: true, ...extra } });
  let saleOrderId: string; let saleKey: string; let saleTicketId: string;

  it('vente physique : billets émis immédiatement, vendeur tracé, idempotente', async () => {
    const before = await stock('Standard');
    saleKey = key();
    const r = await sale(ids.seller, holder(cat.Standard, 2), saleKey);
    expect(r.statusCode).toBe(201);
    const o = json(r);
    saleOrderId = o.id; saleTicketId = o.tickets[0].ticketId;
    expect(o).toMatchObject({ channel: 'PHYSICAL', status: 'PAID', amountXof: 6000, paymentMethod: 'CASH', soldBy: 'vendeur1 Test' });
    expect(o.tickets).toHaveLength(2);
    expect(await stock('Standard')).toEqual({ sold: before.sold + 2, reserved: before.reserved });
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: saleOrderId } });
    expect(pay).toMatchObject({ provider: 'PHYSICAL', status: 'PAID', confirmedAmountXof: 6000, receivedById: ids.seller });

    const replay = await sale(ids.seller, holder(cat.Standard, 2), saleKey);
    expect(replay.statusCode).toBe(200);
    expect(json(replay).id).toBe(saleOrderId);
    expect(await stock('Standard')).toEqual({ sold: before.sold + 2, reserved: before.reserved });
    expect((await sale(ids.seller2, holder(cat.Standard, 2), saleKey)).statusCode).toBe(409); // clé réutilisée par un autre vendeur
  });

  it('vente physique : refus sans confirmation de paiement, hors quota, ou sans droit', async () => {
    expect((await sale(ids.seller, holder(cat.Standard), key(), { paymentReceivedConfirmed: false })).statusCode).toBe(422);
    expect((await sale(ids.seller, holder(cat.Standard), 'trop-court')).statusCode).toBe(422);
    await prisma.ticketCategory.update({ where: { id: cat.Rare }, data: { soldCount: 5 } });
    expect(json(await sale(ids.seller, holder(cat.Rare))).code).toBe('QUOTA_EXCEEDED');
    await prisma.ticketCategory.update({ where: { id: cat.Rare }, data: { soldCount: 0 } });
    expect((await sale(ids.organizer, holder(cat.Standard))).statusCode).toBe(403); // pas de droit de vente
    expect(await stock('Rare')).toEqual({ sold: 0, reserved: 0 });
  });

  it('un vendeur ne voit que ses ventes ; l’administrateur voit tout', async () => {
    await sale(ids.seller2, holder(cat.Standard), key(), { paymentMethod: 'MOBILE_MONEY_DIRECT', paymentReference: 'MM-123' });
    const mine = json(await call('GET', '/physical-sales', { as: ids.seller }));
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0].id).toBe(saleOrderId);
    const all = json(await call('GET', '/physical-sales', { as: ids.admin }));
    expect(all.data).toHaveLength(2);
    expect((await call('GET', `/orders/${saleOrderId}`, { as: ids.seller2 })).statusCode).toBe(404); // pas la vente d'un collègue
    expect((await call('GET', `/orders/${saleOrderId}`, { as: ids.seller })).statusCode).toBe(200);
    expect((await call('GET', '/payments', { as: ids.seller })).statusCode).toBe(403); // pas de vue financière
  });

  it('administration : commandes d’un événement et paiements', async () => {
    const list = json(await call('GET', `/events/${eventId}/orders?pageSize=50`, { as: ids.admin }));
    expect(list.meta.statusCounts.ALL).toBe(list.meta.total);
    expect(list.meta.statusCounts.PAID).toBeGreaterThanOrEqual(3);
    expect(list.meta.statusCounts.REFUND_REQUIRED).toBeGreaterThanOrEqual(1);
    const paidOnline = list.data.find((o: any) => o.channel === 'ONLINE' && o.status === 'PAID');
    expect(paidOnline.providerReference).toMatch(/^trx_/);
    expect(paidOnline.items).toMatch(/\d × Standard/);
    expect(json(await call('GET', `/events/${eventId}/orders?status=FAILED`, { as: ids.admin })).data.every((o: any) => o.status === 'FAILED')).toBe(true);
    const pending = json(await call('GET', `/events/${eventId}/orders?status=PENDING&pageSize=100`, { as: ids.admin }));
    expect(pending.data.every((o: any) => ['PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS'].includes(o.status))).toBe(true);
    expect(pending.meta.total).toBe(list.meta.statusCounts.PENDING); // la pastille « En attente » correspond au filtre
    expect(json(await call('GET', `/events/${eventId}/orders?q=${ref1}`, { as: ids.admin })).data).toHaveLength(1);
    const pay = json(await call('GET', '/payments', { as: ids.admin }));
    expect(pay.data.every((o: any) => o.channel === 'ONLINE')).toBe(true);
    expect((await call('GET', `/events/${eventId}/orders`, { as: ids.organizer })).statusCode).toBe(404); // événement hors de son périmètre
    expect((await call('GET', `/orders/${paidOnline.id}`, { as: ids.admin })).statusCode).toBe(200);
  });

  // ───────────── Annulation de billet ─────────────
  it('vente physique : fichiers générés pour la remise en main propre, aucun e-mail sans adresse', async () => {
    const tickets = await prisma.ticket.findMany({ where: { orderId: saleOrderId }, orderBy: { number: 'asc' } });
    await waitFiles(tickets.map((t) => t.id));
    expect(await prisma.emailLog.count({ where: { orderId: saleOrderId } })).toBe(0);
    const f = json(await call('GET', `/tickets/${tickets[0].id}/files/pdf`, { as: ids.seller })); // le vendeur télécharge le billet qu'il a vendu
    expect(f.fileName).toBe(`Billet-${tickets[0].number}.pdf`);
    expect((await call('GET', `/tickets/${tickets[0].id}/files/pdf`, { as: ids.seller2 })).statusCode).toBe(404); // pas celui d'un collègue
    expect((await call('GET', `/tickets/${tickets[0].id}/files/pdf`, { as: ids.admin })).statusCode).toBe(200);
  }, 60000);

  it('panne de Brevo : échec tracé puis reprise sans doublon ; rattrapage automatique des fichiers et e-mails oubliés', async () => {
    const ama = { firstName: 'Ama', lastName: 'Dossou', email: 'ama@exemple.bj', phone: '0197764997' };
    const r = await sale(ids.seller, holder(cat.Standard), key(), { buyer: ama, sendEmail: false });
    expect(r.statusCode).toBe(201);
    const o = json(r);
    await waitFiles(o.tickets.map((t: { ticketId: string }) => t.ticketId));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).sendTicketsEmail).toBe(false);
    expect(mails.some((m) => m.body.to[0].email === 'ama@exemple.bj')).toBe(false);

    // 1) Brevo en panne : l'envoi échoue, l'état est tracé, rien n'est perdu
    await prisma.order.update({ where: { id: o.id }, data: { sendTicketsEmail: true } });
    brevoFail = true;
    await expect(emailSvc.sendOrderConfirmation(o.id)).rejects.toThrow(/503/);
    let log = await prisma.emailLog.findFirstOrThrow({ where: { orderId: o.id } });
    expect(log).toMatchObject({ status: 'FAILED', attempt: 1, error: 'service_unavailable', toEmail: 'ama@exemple.bj' });
    // 2) Brevo revient : la reprise envoie exactement un e-mail, jamais deux
    brevoFail = false;
    expect(await emailSvc.sendOrderConfirmation(o.id)).toBe('SENT');
    log = await prisma.emailLog.findFirstOrThrow({ where: { orderId: o.id } });
    expect(log).toMatchObject({ status: 'SENT', attempt: 2 });
    expect(await emailSvc.sendOrderConfirmation(o.id)).toBe('ALREADY_SENT');
    expect(mails.filter((m) => m.body.to[0].email === 'ama@exemple.bj')).toHaveLength(1);
    expect(await prisma.emailLog.count({ where: { orderId: o.id } })).toBe(1);

    // 3) Rattrapage : commande payée il y a 10 min, fichiers perdus et e-mail jamais envoyé
    const r2 = await sale(ids.seller, holder(cat.Standard), key(), { buyer: { ...ama, email: 'ama2@exemple.bj' }, sendEmail: false });
    const o2 = json(r2);
    const ids2 = o2.tickets.map((t: { ticketId: string }) => t.ticketId);
    await waitFiles(ids2);
    await prisma.generatedFile.deleteMany({ where: { ticketId: { in: ids2 } } });
    await prisma.order.update({ where: { id: o2.id }, data: { sendTicketsEmail: true, paidAt: new Date(Date.now() - 10 * 60_000) } });
    const run = await maintenance.run();
    expect(run.requeued).toBeGreaterThanOrEqual(1);
    await waitFiles(ids2);
    await waitFor(async () => mails.find((m) => m.body.to[0].email === 'ama2@exemple.bj') ?? false, 40000);
    expect((await prisma.emailLog.findFirstOrThrow({ where: { orderId: o2.id } })).status).toBe('SENT');
  }, 120000);

  it('annulation : droit requis, place remise en vente, jamais un billet déjà utilisé', async () => {
    const before = await stock('Standard');
    expect((await call('POST', `/tickets/${saleTicketId}/cancel`, { as: ids.seller, payload: { reason: 'Erreur de saisie' } })).statusCode).toBe(403);
    expect((await call('POST', `/tickets/${saleTicketId}/cancel`, { as: ids.admin, payload: { reason: 'x' } })).statusCode).toBe(422);
    const ok = await call('POST', `/tickets/${saleTicketId}/cancel`, { as: ids.admin, payload: { reason: 'Erreur de saisie' } });
    expect(ok.statusCode).toBe(200);
    expect(await stock('Standard')).toEqual({ sold: before.sold - 1, reserved: before.reserved });
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: saleTicketId } });
    expect(t).toMatchObject({ status: 'CANCELLED', cancelReason: 'Erreur de saisie', cancelledById: ids.admin });
    expect((await call('POST', `/tickets/${saleTicketId}/cancel`, { as: ids.admin, payload: { reason: 'Encore' } })).statusCode).toBe(409);

    const other = (await prisma.ticket.findMany({ where: { orderId: saleOrderId, status: 'VALID' } }))[0];
    await prisma.ticket.update({ where: { id: other.id }, data: { status: 'USED', checkedInAt: new Date(), checkedInById: ids.admin } });
    expect((await call('POST', `/tickets/${other.id}/cancel`, { as: ids.admin, payload: { reason: 'Trop tard' } })).statusCode).toBe(409);
  });

  it('page publique d’un billet : nom abrégé, jamais de marquage de présence', async () => {
    const t = await prisma.ticket.findFirstOrThrow({ where: { status: 'VALID' } });
    const r = json(await call('GET', `/public/tickets/${t.qrToken}`));
    expect(r.holderShortName).toMatch(/^\S+ N\.$/);
    expect(r.status).toBe('VALID');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('VALID');
    expect((await call('GET', '/public/tickets/inconnu')).statusCode).toBe(404);
  });

  it('cohérence finale : le stock affiché correspond aux billets réellement valides', async () => {
    for (const name of ['Standard', 'VIP', 'Rare']) {
      const issued = await prisma.ticket.count({ where: { categoryId: cat[name], status: { in: ['VALID', 'USED'] } } });
      const c = await prisma.ticketCategory.findUniqueOrThrow({ where: { id: cat[name] } });
      if (name !== 'VIP') expect(c.soldCount).toBe(issued);
      const held = await prisma.orderItem.aggregate({ _sum: { quantity: true }, where: { categoryId: cat[name], order: { reservationHeld: true } } });
      expect(c.reservedCount).toBe(held._sum.quantity ?? 0);
    }
  });
});
