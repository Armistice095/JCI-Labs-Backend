/**
 * Tests de bout en bout (HTTP + vraie base PostgreSQL). Supabase Auth/Storage sont simulés.
 * Prérequis : base de test migrée (prisma migrate deploy + npm run db:sql), TEST_DATABASE_URL défini.
 * ⚠ Vide les tables à chaque exécution : ne JAMAIS pointer vers une base réelle.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('API (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const ids = { admin: randomUUID(), president: randomUUID(), organizer: randomUUID(), organizer2: randomUUID(), stranger: randomUUID() };
  const invited: string[] = [];

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, as?: string, payload?: object) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {}, payload: payload as never });
    checkContract(method, `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: TEST_DB, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30),
      PUBLIC_WEB_URL: 'http://localhost:5173', ADMIN_WEB_URL: 'http://localhost:5174',
      DIRECT_URL: TEST_DB, FEDAPAY_SECRET_KEY: 'sk_sandbox_test_key', FEDAPAY_WEBHOOK_SECRET: 'wh_sandbox_test_secret',
      FEDAPAY_API_BASE: 'http://127.0.0.1:1', RATE_LIMIT_DISABLED: 'true', JOBS_POLL_SECONDS: '0.5',
    });
    const { Test } = await import('@nestjs/testing');
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    const { AppModule } = await import('../src/app.module');
    const { TokenVerifier } = await import('../src/auth/token-verifier.service');
    const { SupabaseAdminService } = await import('../src/supabase/supabase-admin.service');
    const { AllExceptionsFilter } = await import('../src/common/http-exception.filter');
    const { PrismaService } = await import('../src/prisma/prisma.service');

    const fakeSupabase = {
      client: { storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) } },
      inviteUser: async () => { const id = randomUUID(); invited.push(id); await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','i@x.y')`); return id; },
      deleteUser: async () => undefined, setBanned: async () => undefined, sendPasswordReset: async () => undefined,
    };
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue({ verify: async (t: string) => t }) // le jeton = l'identifiant de l'utilisateur
      .overrideProvider(SupabaseAdminService).useValue(fakeSupabase)
      .compile();
    app = mod.createNestApplication(new FastifyAdapter(), { rawBody: true });
    await app.register((await import('@fastify/multipart')).default as never, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    await prisma.$executeRawUnsafe('TRUNCATE audit_logs, ticket_categories, events, user_roles, profiles, auth.users CASCADE');
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    const mk = async (id: string, email: string, role: string) => {
      await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${id}','${email}')`);
      await prisma.profile.create({ data: { id, email, firstName: email.split('@')[0], lastName: 'Test' } });
      await prisma.userRole.create({ data: { userId: id, roleId: roles[role] } });
    };
    await mk(ids.admin, 'admin@t.bj', 'ADMIN');
    await mk(ids.president, 'president@t.bj', 'PRESIDENT');
    await mk(ids.organizer, 'orga1@t.bj', 'ORGANIZER');
    await mk(ids.organizer2, 'orga2@t.bj', 'ORGANIZER');
  });

  afterAll(async () => { await app?.close(); });

  const complete = {
    title: 'Leadership & Impact', category: 'CONFERENCE', description: 'Une journée pour inspirer.',
    date: '2026-11-28', startTime: '08:00', endTime: '17:00', venueName: 'Centre des Congrès de Comé', city: 'Comé',
    organizers: [{ name: 'JCI Comé Excellence', description: 'Organisation de jeunes citoyens actifs' }],
    programme: [{ time: '08:00', label: 'Accueil' }, { time: '09:00', label: 'Ouverture officielle' }],
    categories: [{ name: 'Standard', priceXof: 3000, quota: 162 }, { name: 'VIP', priceXof: 10000, quota: 57 }],
  };

  it('401 sans jeton ; 403 si le compte n’est pas provisionné', async () => {
    expect((await call('GET', '/events')).statusCode).toBe(401);
    const r = await call('GET', '/me', randomUUID());
    expect(r.statusCode).toBe(403);
  });

  it('/me expose rôles et permissions', async () => {
    const me = json(await call('GET', '/me', ids.organizer));
    expect(me.permissions).toContain('event.create');
    expect(me.permissions).not.toContain('event.publish');
  });

  let eventId: string;
  it('un administrateur crée et publie directement un événement', async () => {
    const r = await call('POST', '/events', ids.admin, { ...complete, publish: true });
    expect(r.statusCode).toBe(201);
    const e = json(r);
    eventId = e.id;
    expect(e.status).toBe('PUBLISHED');
    expect(e.slug).toBe('leadership-impact-2026');
    expect(e.salesStatus).toBe('NOT_OPEN'); // publié mais billetterie pas encore ouverte
    expect(e.startsAt).toBe('2026-11-28T07:00:00.000Z'); // 08h00 heure du Bénin
    expect(e.publicUrl).toContain('/evenements/leadership-impact-2026');
    expect(e.programme).toHaveLength(2);
  });

  it('le président local peut aussi créer et publier', async () => {
    const r = await call('POST', '/events', ids.president, { ...complete, title: 'Atelier Finance Jeunes', publish: true });
    expect(r.statusCode).toBe(201);
    expect(json(r).status).toBe('PUBLISHED');
  });

  let draftId: string;
  it('un organisateur crée un brouillon mais ne peut pas publier', async () => {
    const draft = await call('POST', '/events', ids.organizer, { title: 'Gala Excellence JCI' });
    expect(draft.statusCode).toBe(201);
    draftId = json(draft).id;
    expect(json(draft).status).toBe('DRAFT');
    expect((await call('POST', '/events', ids.organizer, { ...complete, title: 'Autre', publish: true })).statusCode).toBe(403);
    expect((await call('POST', `/events/${draftId}/publish`, ids.organizer)).statusCode).toBe(403);
  });

  it('cloisonnement : chacun ne voit que ses événements (sauf admin/président)', async () => {
    const mine = json(await call('GET', '/events', ids.organizer));
    expect(mine.data.map((e: { id: string }) => e.id)).toEqual([draftId]);
    expect((await call('GET', `/events/${eventId}`, ids.organizer)).statusCode).toBe(404);
    expect((await call('GET', `/events/${draftId}`, ids.organizer2)).statusCode).toBe(404);
    const all = json(await call('GET', '/events', ids.admin));
    expect(all.meta.statusCounts).toMatchObject({ ALL: 3, DRAFT: 1, PUBLISHED: 2 });
  });

  it('liste : tri et filtre « à venir » (widget Événements proches)', async () => {
    const asc = json(await call('GET', '/events?status=PUBLISHED&sort=startsAt', ids.admin)).data.map((e: { startsAt: string }) => e.startsAt);
    expect(asc).toEqual([...asc].sort());
    const desc = json(await call('GET', '/events?status=PUBLISHED&sort=-startsAt', ids.admin)).data.map((e: { startsAt: string }) => e.startsAt);
    expect(desc).toEqual([...asc].reverse());
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 86400e3), endsAt: new Date(Date.now() - 82800e3) } });
    const upcoming = json(await call('GET', '/events?upcoming=true', ids.admin)).data.map((e: { id: string }) => e.id);
    expect(upcoming).not.toContain(eventId); // date passée : exclu
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date('2026-11-28T07:00:00Z'), endsAt: new Date('2026-11-28T16:00:00Z') } });
    expect((await call('GET', '/events?sort=nimporte', ids.admin)).statusCode).toBe(422);
  });

  it('publication refusée avec la liste des champs manquants', async () => {
    const r = await call('POST', `/events/${draftId}/publish`, ids.admin);
    expect(r.statusCode).toBe(422);
    expect(Object.keys(json(r).details.fields)).toEqual(expect.arrayContaining(['description', 'date', 'venueName', 'city']));
  });

  it('un brouillon incomplet se complète puis se publie', async () => {
    const up = await call('PATCH', `/events/${draftId}`, ids.organizer, { description: 'Soirée de gala', date: '2027-01-16', venueName: 'Hôtel Le Lac', city: 'Grand-Popo' });
    expect(up.statusCode).toBe(200);
    expect(json(up).startsAt).toBe('2027-01-16T07:00:00.000Z');
    expect((await call('POST', `/events/${draftId}/publish`, ids.president)).statusCode).toBe(200);
  });

  it('billetterie : fenêtre de vente, ouverture, fermeture manuelle', async () => {
    const t = json(await call('GET', `/events/${eventId}/ticketing`, ids.admin));
    expect(t.maxPerOrder).toBe(5);
    expect(new Date(t.salesClosesAt).toISOString()).toBe('2026-11-27T17:00:00.000Z'); // veille 18h00 locale
    expect(t.totalCapacity).toBe(219);
    expect(t.potentialRevenueXof).toBe(162 * 3000 + 57 * 10000);

    const opened = json(await call('PATCH', `/events/${eventId}/ticketing`, ids.admin, { salesOpensAt: '2026-10-01T07:00:00Z', maxPerOrder: 8 }));
    expect(opened.salesStatus === 'OPEN' || opened.salesStatus === 'CLOSED').toBe(true); // dépend de la date du jour d'exécution
    expect((await call('PATCH', `/events/${eventId}/ticketing`, ids.admin, { salesOpensAt: '2026-12-01T07:00:00Z' })).statusCode).toBe(422); // clôture avant ouverture
    expect((await call('PATCH', `/events/${eventId}/ticketing`, ids.admin, { maxPerOrder: 11 })).statusCode).toBe(422);

    const closed = json(await call('POST', `/events/${eventId}/ticketing/close`, ids.admin));
    expect(closed.salesStatus).toBe('CLOSED');
    expect(closed.manuallyClosed).toBe(true);

    // Réouverture : refusée si la clôture est dépassée, acceptée sinon
    await call('PATCH', `/events/${eventId}/ticketing`, ids.admin, { salesOpensAt: '2020-01-01T00:00:00Z', salesClosesAt: '2020-02-01T00:00:00Z' });
    expect(json(await call('POST', `/events/${eventId}/ticketing/reopen`, ids.admin)).code).toBe('INVALID_STATE');
    await call('PATCH', `/events/${eventId}/ticketing`, ids.admin, { salesClosesAt: new Date(Date.now() + 30 * 86400e3).toISOString() });
    const reopened = json(await call('POST', `/events/${eventId}/ticketing/reopen`, ids.admin));
    expect(reopened).toMatchObject({ salesStatus: 'OPEN', manuallyClosed: false });
    expect((await call('POST', `/events/${eventId}/ticketing/reopen`, ids.organizer)).statusCode).toBe(404);
  });

  it('catégories : doublon, quota sous les ventes, suppression protégée', async () => {
    expect((await call('POST', `/events/${eventId}/categories`, ids.admin, { name: 'standard', priceXof: 2000, quota: 5 })).statusCode).toBe(409);
    expect((await call('POST', `/events/${eventId}/categories`, ids.admin, { name: 'Gratuit', priceXof: 0, quota: 5 })).statusCode).toBe(422);
    const etu = json(await call('POST', `/events/${eventId}/categories`, ids.admin, { name: 'Étudiant', priceXof: 1500, quota: 31, conditions: 'Justificatif demandé' }));
    expect(etu.conditions).toBe('Justificatif demandé');
    expect(etu.remaining).toBe(31);

    await prisma.ticketCategory.update({ where: { id: etu.id }, data: { soldCount: 15, reservedCount: 2 } });
    const low = await call('PATCH', `/events/${eventId}/categories/${etu.id}`, ids.admin, { quota: 16 });
    expect(low.statusCode).toBe(409);
    expect(json(low).code).toBe('QUOTA_EXCEEDED');
    expect((await call('PATCH', `/events/${eventId}/categories/${etu.id}`, ids.admin, { quota: 17 })).statusCode).toBe(200);
    expect((await call('DELETE', `/events/${eventId}/categories/${etu.id}`, ids.admin)).statusCode).toBe(409);
    expect((await call('PATCH', `/events/${eventId}/categories/${etu.id}`, ids.admin, { isActive: false })).statusCode).toBe(200);
  });

  it('un organisateur ne gère pas la billetterie d’un événement qui n’est pas le sien', async () => {
    expect((await call('PATCH', `/events/${eventId}/ticketing`, ids.organizer, { maxPerOrder: 2 })).statusCode).toBe(404);
  });

  it('cycle de vie : clôture, annulation, suppression de brouillon', async () => {
    const e2 = json(await call('POST', '/events', ids.organizer2, { title: 'Brouillon à supprimer' }));
    expect((await call('POST', `/events/${e2.id}/close`, ids.admin)).statusCode).toBe(409); // brouillon non clôturable
    expect((await call('DELETE', `/events/${e2.id}`, ids.organizer2)).statusCode).toBe(204);
    expect((await call('DELETE', `/events/${eventId}`, ids.admin)).statusCode).toBe(409); // publié : pas supprimable
    expect((await call('POST', `/events/${draftId}/cancel`, ids.admin, { reason: 'x' })).statusCode).toBe(422); // motif trop court
    const cancelled = json(await call('POST', `/events/${draftId}/cancel`, ids.admin, { reason: 'Salle indisponible' }));
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.salesStatus).toBe('CLOSED');
    expect((await call('PATCH', `/events/${draftId}`, ids.admin, { title: 'Nouveau titre' })).statusCode).toBe(409);
  });

  it('utilisateurs : réservé à l’administrateur, compte créé avec rôles, garde-fous', async () => {
    expect((await call('GET', '/users', ids.organizer)).statusCode).toBe(403);
    expect((await call('GET', '/users', ids.president)).statusCode).toBe(403);

    const created = await call('POST', '/users', ids.admin, {
      email: 'Agent@JCI-Come.bj', firstName: 'Yao', lastName: 'Gbaguidi', phone: '0195789513',
      roles: [{ roleCode: 'GATE_AGENT', eventId }],
    });
    expect(created.statusCode).toBe(201);
    const u = json(created);
    expect(u.email).toBe('agent@jci-come.bj');
    expect(u.phone).toBe('+2290195789513');
    expect(u.roles[0]).toMatchObject({ roleCode: 'GATE_AGENT', eventId });
    expect((await call('POST', '/users', ids.admin, { email: 'agent@jci-come.bj', firstName: 'a', lastName: 'b', roles: [{ roleCode: 'SELLER' }] })).statusCode).toBe(409);
    expect((await call('POST', `/users/${u.id}/roles`, ids.admin, { roleCode: 'ADMIN', eventId })).statusCode).toBe(422); // ADMIN non limitable à un événement

    // l'agent voit uniquement l'événement auquel il est assigné
    const agentEvents = json(await call('GET', '/events', u.id));
    expect(agentEvents.data.map((e: { id: string }) => e.id)).toEqual([eventId]);
    expect((await call('POST', '/events', u.id, { title: 'Interdit' })).statusCode).toBe(403);

    expect((await call('POST', `/users/${ids.admin}/disable`, ids.admin)).statusCode).toBe(409); // pas soi-même
    expect((await call('POST', `/users/${u.id}/disable`, ids.admin)).statusCode).toBe(204);
    expect((await call('GET', '/me', u.id)).statusCode).toBe(403); // compte désactivé
    expect((await call('POST', `/users/${u.id}/enable`, ids.admin)).statusCode).toBe(204);
    expect((await call('GET', '/me', u.id)).statusCode).toBe(200); // réactivé
    expect(json(await call('GET', `/users/${u.id}`, ids.admin)).email).toBe('agent@jci-come.bj');
    const patched = json(await call('PATCH', `/users/${u.id}`, ids.admin, { lastName: 'Gbaguidi-Dossou', phone: null }));
    expect(patched).toMatchObject({ lastName: 'Gbaguidi-Dossou', phone: null });
    expect((await call('PATCH', `/users/${u.id}`, ids.admin, { phone: 'abc' })).statusCode).toBe(422);
    expect((await call('POST', `/users/${u.id}/reset-password`, ids.admin)).statusCode).toBe(204);
    const roles = json(await call('GET', '/roles', ids.admin));
    expect(roles.map((r: { code: string }) => r.code).sort()).toEqual(['ADMIN', 'GATE_AGENT', 'ORGANIZER', 'PRESIDENT', 'SELLER']);
    expect(roles.find((r: { code: string }) => r.code === 'PRESIDENT').permissions).toContain('event.publish');
    expect(roles.find((r: { code: string }) => r.code === 'ORGANIZER').permissions).not.toContain('event.publish');
    const grant = json(await call('POST', `/users/${u.id}/roles`, ids.admin, { roleCode: 'SELLER', eventId }));
    expect((await call('DELETE', `/users/${u.id}/roles/${grant.id}`, ids.admin)).statusCode).toBe(204);
    const adminGrant = (await prisma.userRole.findFirstOrThrow({ where: { userId: ids.admin } })).id;
    expect((await call('DELETE', `/users/${ids.admin}/roles/${adminGrant}`, ids.admin)).statusCode).toBe(409); // dernier administrateur
  });

  it('affiches : envoi, couverture, limites, suppression', async () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const upload = async (data: Buffer, as: string, query = '', filename = 'affiche.png') => {
      const b = `----jcitest${Math.random().toString(16).slice(2)}`;
      const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
      const url = `/api/v1/events/${eventId}/posters${query}`;
      const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${as}`, 'content-type': `multipart/form-data; boundary=${b}` }, payload });
      checkContract('POST', url, res.statusCode, res.body);
      return res;
    };
    const first = json(await upload(PNG, ids.admin));
    expect(first).toMatchObject({ isCover: true, width: 1, height: 1, position: 0 }); // la première affiche devient la couverture
    expect((await prisma.eventPoster.findUniqueOrThrow({ where: { id: first.id } })).sharePath).toBe(`${eventId}/${(await prisma.eventPoster.findUniqueOrThrow({ where: { id: first.id } })).storagePath.split('/')[1].replace(/\.png$/, '-share.jpg')}`); // variante d'aperçu créée
    const second = json(await upload(PNG, ids.admin, '?isCover=true'));
    expect(second.isCover).toBe(true);
    let ev = json(await call('GET', `/events/${eventId}`, ids.admin));
    expect(ev.posters.find((p: { id: string }) => p.id === first.id).isCover).toBe(false); // une seule couverture
    expect(ev.coverUrl).toBe(second.url);

    expect(json(await call('PATCH', `/events/${eventId}/posters/${second.id}`, ids.admin, { isCover: false })).code).toBe('INVALID_STATE');
    expect(json(await call('PATCH', `/events/${eventId}/posters/${first.id}`, ids.admin, { isCover: true })).isCover).toBe(true);

    expect((await upload(Buffer.from('ceci n’est pas une image'), ids.admin, '', 'faux.png')).statusCode).toBe(422); // le contenu est vérifié, pas le nom
    expect((await upload(Buffer.concat([PNG, Buffer.alloc(2.1 * 1024 * 1024)]), ids.admin)).statusCode).toBe(413);
    expect((await upload(PNG, ids.organizer)).statusCode).toBe(404); // événement hors de son périmètre

    expect((await call('DELETE', `/events/${eventId}/posters/${first.id}`, ids.admin)).statusCode).toBe(204);
    ev = json(await call('GET', `/events/${eventId}`, ids.admin));
    expect(ev.posters).toHaveLength(1);
    expect(ev.posters[0].isCover).toBe(true); // la couverture est reportée sur l'affiche restante
    expect((await call('DELETE', `/events/${eventId}/posters/${first.id}`, ids.admin)).statusCode).toBe(404);
  });

  it('journal d’audit alimenté', async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['event.create', 'event.publish', 'event.cancel', 'category.create', 'ticketing.close', 'user.create']));
  });
});
