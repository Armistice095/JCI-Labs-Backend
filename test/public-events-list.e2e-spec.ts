/**
 * Liste publique des événements (page d'accueil de la billetterie, sitemap.xml) : seuls les événements publiés, à venir / passés,
 * champs utiles aux cartes, pagination, cache. Dates relatives à « maintenant » : le test ne vieillit pas.
 * Prérequis : voir api.e2e-spec.ts. ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;
const DAY = 86400e3;
const H = 3600e3;

d('Liste publique des événements (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const owner = randomUUID();
  const id: Record<string, string> = {};

  const get = async (query = '') => {
    const url = `/api/v1/public/events${query}`;
    const res = await app.inject({ method: 'GET', url }); // aucune authentification
    checkContract('GET', url, res.statusCode, res.body);
    return res;
  };
  const list = async (query = '') => JSON.parse((await get(query)).body);
  const slugs = (r: { data: { slug: string }[] }) => r.data.map((e) => e.slug);

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
    await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${owner}','o@t.bj')`);
    await prisma.profile.create({ data: { id: owner, email: 'o@t.bj', firstName: 'Orga', lastName: 'Test' } });

    const now = Date.now();
    const base = { description: 'x', venueName: 'Centre', city: 'Comé', maxPerOrder: 5, createdById: owner, publishedAt: new Date(now - 60 * DAY), salesOpensAt: new Date(now - 30 * DAY) };
    const mkEvent = async (key: string, status: 'PUBLISHED' | 'DRAFT' | 'CLOSED' | 'CANCELLED', startsAt: number, endsAt: number | null, extra: object = {}) => {
      id[key] = (await prisma.event.create({ data: { ...base, slug: key, title: `Titre ${key}`, status, startsAt: new Date(startsAt), endsAt: endsAt === null ? null : new Date(endsAt), ...extra } })).id;
    };
    await mkEvent('en-cours', 'PUBLISHED', now - 2 * H, now + 3 * H, { accentColor: '#1D4ED8' });          // commencé, pas fini : à venir
    await mkEvent('proche', 'PUBLISHED', now + 5 * DAY, now + 5 * DAY + 9 * H);
    await mkEvent('lointain', 'PUBLISHED', now + 30 * DAY, now + 30 * DAY + 9 * H, { salesOpensAt: new Date(now + 10 * DAY) });
    await mkEvent('sans-fin', 'PUBLISHED', now + 40 * DAY, null);                                          // pas d'heure de fin : à venir tant que le début n'est pas passé
    await mkEvent('passe', 'PUBLISHED', now - 10 * DAY, now - 10 * DAY + 9 * H);
    await mkEvent('passe-ancien', 'PUBLISHED', now - 60 * DAY, now - 60 * DAY + 9 * H);
    await mkEvent('brouillon', 'DRAFT', now + 6 * DAY, now + 6 * DAY + 9 * H, { publishedAt: null });
    await mkEvent('clos', 'CLOSED', now + 7 * DAY, now + 7 * DAY + 9 * H);
    await mkEvent('annule', 'CANCELLED', now + 8 * DAY, now + 8 * DAY + 9 * H);

    const mkCat = (event: string, name: string, priceXof: number, quota: number, extra: object = {}) =>
      prisma.ticketCategory.create({ data: { eventId: id[event], name, priceXof, quota, position: 0, ...extra } });
    await mkCat('proche', 'VIP', 10000, 20);
    await mkCat('proche', 'Standard', 3000, 100);
    await mkCat('proche', 'Étudiant (désactivée)', 500, 100, { isActive: false }); // une catégorie désactivée ne compte pas dans « à partir de »
    await mkCat('lointain', 'Unique', 5000, 2, { soldCount: 2 });                  // épuisée
    await mkCat('en-cours', 'Standard', 2000, 50);
    await mkCat('en-cours', 'VIP', 8000, 5, { soldCount: 5 });                    // une catégorie épuisée sur deux : pas « épuisé »
    await prisma.eventPoster.create({ data: { eventId: id.proche, storagePath: `${id.proche}/a.jpg`, mime: 'image/jpeg', sizeBytes: 10, isCover: false, position: 1 } });
    await prisma.eventPoster.create({ data: { eventId: id.proche, storagePath: `${id.proche}/couverture.jpg`, mime: 'image/jpeg', sizeBytes: 10, isCover: true, position: 0 } });
  }, 60000);

  afterAll(async () => { await app?.close(); });

  it('par défaut : événements publiés à venir, du plus proche au plus lointain ; brouillon, clôturé, annulé et passés exclus', async () => {
    const r = await list();
    expect(slugs(r)).toEqual(['en-cours', 'proche', 'lointain', 'sans-fin']);
    expect(r.meta).toEqual({ page: 1, pageSize: 20, total: 4, totalPages: 1 });
  });

  it('champs d’une carte : couverture, prix « à partir de », statut de vente, épuisé, dernière modification', async () => {
    const r = await list();
    const proche = r.data.find((e: any) => e.slug === 'proche');
    expect(proche).toMatchObject({
      title: 'Titre proche', category: expect.any(String), venueName: 'Centre', city: 'Comé', salesStatus: 'OPEN',
      priceFromXof: 3000, soldOut: false,
    });
    expect(proche.coverUrl).toContain(`${id.proche}/couverture.jpg`); // la couverture, pas la première affiche
    const dbEvent = await prisma.event.findUniqueOrThrow({ where: { id: id.proche } });
    expect(new Date(proche.updatedAt).getTime()).toBe(dbEvent.updatedAt.getTime());
    expect(new Date(proche.startsAt).getTime()).toBe(dbEvent.startsAt!.getTime());

    const lointain = r.data.find((e: any) => e.slug === 'lointain');
    expect(lointain).toMatchObject({ salesStatus: 'NOT_OPEN', priceFromXof: 5000, soldOut: true, coverUrl: null });
    expect(r.data.find((e: any) => e.slug === 'en-cours')).toMatchObject({ accentColor: '#1D4ED8', priceFromXof: 2000, soldOut: false });
    expect(r.data.find((e: any) => e.slug === 'sans-fin')).toMatchObject({ endsAt: null, priceFromXof: null, soldOut: false }); // aucune catégorie
  });

  it('when=past : terminés, du plus récent au plus ancien ; when=all : tous les publiés', async () => {
    expect(slugs(await list('?when=past'))).toEqual(['passe', 'passe-ancien']);
    expect(slugs(await list('?when=all'))).toEqual(['sans-fin', 'lointain', 'proche', 'en-cours', 'passe', 'passe-ancien']);
  });

  it('pagination stable : pages successives sans doublon ni oubli', async () => {
    const p1 = await list('?when=all&pageSize=4&page=1');
    const p2 = await list('?when=all&pageSize=4&page=2');
    expect(p1.meta).toEqual({ page: 1, pageSize: 4, total: 6, totalPages: 2 });
    expect([...slugs(p1), ...slugs(p2)]).toEqual(['sans-fin', 'lointain', 'proche', 'en-cours', 'passe', 'passe-ancien']);
    const beyond = await list('?when=all&pageSize=4&page=3');
    expect(beyond.data).toEqual([]);
  });

  it('en-tête de cache CDN (60 s) ; accessible sans compte ; validation des paramètres (422)', async () => {
    const ok = await get();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    for (const bad of ['?when=jamais', '?pageSize=101', '?pageSize=0', '?page=0']) {
      const r = await get(bad);
      expect(r.statusCode).toBe(422);
      expect(r.headers['cache-control']).toBeUndefined(); // jamais en cache sur une erreur
    }
  });

  it('un événement publié puis clôturé quitte la liste mais sa page reste consultable', async () => {
    await prisma.event.update({ where: { id: id.proche }, data: { status: 'CLOSED' } });
    expect(slugs(await list())).not.toContain('proche');
    const page = await app.inject({ method: 'GET', url: '/api/v1/public/events/proche' });
    expect(page.statusCode).toBe(200);
    await prisma.event.update({ where: { id: id.proche }, data: { status: 'PUBLISHED' } });
    expect(slugs(await list())).toContain('proche');
  });

  it('aucun événement : liste vide, pas une erreur', async () => {
    await prisma.event.updateMany({ data: { status: 'DRAFT' } });
    const r = await list();
    expect(r.data).toEqual([]);
    expect(r.meta).toEqual({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  });
});
