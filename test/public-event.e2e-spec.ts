/**
 * Page publique d'un événement : champs exposés (catégorie, couleur, textes), textes JCI par défaut et FAQ, cache, et adresse (slug) stable après publication.
 * Prérequis : voir api.e2e-spec.ts (base de test migrée, TEST_DATABASE_URL). ⚠ Vide les tables à chaque exécution.
 */
import { randomUUID } from 'node:crypto';
import { checkContract } from './contract';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Page publique d’un événement (e2e)', () => {
  let app: import('@nestjs/platform-fastify').NestFastifyApplication;
  const admin = randomUUID();

  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as?: string, payload?: object) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: as ? { authorization: `Bearer ${as}` } : {}, payload: payload as never });
    checkContract(method, `/api/v1${url}`, res.statusCode, res.body); // le contrat OpenAPI doit toujours refléter la réalité
    return res;
  };
  const json = (r: { body: string }) => JSON.parse(r.body);

  const complete = {
    title: 'Leadership & Impact', category: 'CONFERENCE', description: 'Une journée pour inspirer.',
    date: '2026-11-28', startTime: '08:00', endTime: '17:00', venueName: 'Centre des Congrès de Comé', city: 'Comé',
    accentColor: '#1D4ED8', contactPhone: '+229 01 97 00 00 00',
    organizers: [{ name: 'JCI Comé Excellence' }], programme: [{ time: '08:00', label: 'Accueil' }],
    categories: [{ name: 'Standard', priceXof: 3000, quota: 162 }],
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30),
      PUBLIC_WEB_URL: 'http://localhost:5173', ADMIN_WEB_URL: 'http://localhost:5174', RATE_LIMIT_DISABLED: 'true', JOBS_POLL_SECONDS: '0.5',
      FEDAPAY_SECRET_KEY: 'sk_sandbox_test_key', FEDAPAY_WEBHOOK_SECRET: 'wh_sandbox_test_secret', FEDAPAY_API_BASE: 'http://127.0.0.1:1',
      ORG_CONTACT_PHONE: '+22901000000',
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
    const prisma = app.get(PrismaService);

    await prisma.$executeRawUnsafe('TRUNCATE audit_logs, payment_events, order_holders, ticket_categories, events, user_roles, profiles, counters, auth.users CASCADE');
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    await prisma.$executeRawUnsafe(`INSERT INTO auth.users(id,email) VALUES ('${admin}','admin@t.bj')`);
    await prisma.profile.create({ data: { id: admin, email: 'admin@t.bj', firstName: 'Admin', lastName: 'Test' } });
    await prisma.userRole.create({ data: { userId: admin, roleId: roles.ADMIN, eventId: null } });
  }, 60000);

  afterAll(async () => { await app?.close(); });

  it('création : les 3 textes sont enregistrés (espaces retirés) et relus par l’administration', async () => {
    const r = await call('POST', '/events', admin, {
      ...complete, title: 'Soirée textes',
      practicalInfo: '  Ouverture des portes à 07h30.  ', ticketTerms: 'Billet personnel et non transférable.', refundPolicy: 'Aucun remboursement sauf annulation.',
    });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ practicalInfo: 'Ouverture des portes à 07h30.', ticketTerms: 'Billet personnel et non transférable.', refundPolicy: 'Aucun remboursement sauf annulation.' });
  });

  it('brouillon : introuvable publiquement ; publié : catégorie, couleur, textes et en-tête de cache', async () => {
    const created = json(await call('POST', '/events', admin, {
      ...complete, title: 'Gala public', practicalInfo: 'Parking sur place.', ticketTerms: 'Présenter le billet à l’entrée.', refundPolicy: 'Texte remboursement.',
    }));
    const slug = created.slug;
    expect((await call('GET', `/public/events/${slug}`)).statusCode).toBe(404);

    expect((await call('POST', `/events/${created.id}/publish`, admin)).statusCode).toBe(200);
    const res = await call('GET', `/public/events/${slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    expect(json(res)).toMatchObject({
      slug, category: 'CONFERENCE', accentColor: '#1D4ED8', contactPhone: '+229 01 97 00 00 00',
      practicalInfo: 'Parking sur place.', ticketTerms: 'Présenter le billet à l’entrée.', refundPolicy: 'Texte remboursement.',
      infoSources: { practicalInfo: 'event', ticketTerms: 'event', refundPolicy: 'event' },
    });
    const missing = await call('GET', '/public/events/slug-inexistant');
    expect(missing.statusCode).toBe(404);
    expect(String(missing.headers['cache-control'] ?? '')).not.toContain('s-maxage'); // un « introuvable » ne doit jamais rester en cache (publication imminente)
  });

  it('sections sans texte : null (le front ne les affiche pas) ; un texte vide ou blanc devient null', async () => {
    const created = json(await call('POST', '/events', admin, { ...complete, title: 'Sans textes', publish: true }));
    expect(created).toMatchObject({ practicalInfo: null, ticketTerms: null, refundPolicy: null }); // l'administration voit « rien de rédigé »
    const pub = json(await call('GET', `/public/events/${created.slug}`));
    expect(pub.practicalInfo).toContain('au moins 30 minutes avant le début'); // …et le public voit le texte général JCI
    expect(pub.ticketTerms).toContain('personnel, non transférable');
    expect(pub.refundPolicy).toContain('ni échangeables ni remboursables');
    expect(pub.infoSources).toEqual({ practicalInfo: 'default', ticketTerms: 'default', refundPolicy: 'default' });

    const set = await call('PATCH', `/events/${created.id}`, admin, { practicalInfo: 'Infos', refundPolicy: 'Rembours.' });
    expect(json(set)).toMatchObject({ practicalInfo: 'Infos', refundPolicy: 'Rembours.', ticketTerms: null });
    const mixed = json(await call('GET', `/public/events/${created.slug}`)); // le texte de l'organisateur remplace celui de JCI, section par section
    expect(mixed).toMatchObject({ practicalInfo: 'Infos', refundPolicy: 'Rembours.', infoSources: { practicalInfo: 'event', ticketTerms: 'default', refundPolicy: 'event' } });
    expect(mixed.ticketTerms).toContain('personnel, non transférable');

    const cleared = await call('PATCH', `/events/${created.id}`, admin, { practicalInfo: '   ', refundPolicy: null });
    expect(json(cleared)).toMatchObject({ practicalInfo: null, refundPolicy: null });
    const back = json(await call('GET', `/public/events/${created.slug}`)); // vider un texte rétablit le texte JCI
    expect(back.practicalInfo).toContain('au moins 30 minutes');
    expect(back.infoSources.practicalInfo).toBe('default');
  });

  it('FAQ : questions générales JCI avec les vraies valeurs (réservation, maximum par commande, justificatif seulement si une catégorie en demande)', async () => {
    const plain = json(await call('POST', '/events', admin, { ...complete, title: 'Faq simple', ticketing: { maxPerOrder: 3 }, publish: true }));
    const faq = Object.fromEntries(json(await call('GET', `/public/events/${plain.slug}`)).faq.map((f: any) => [f.question, f.answer]));
    expect(Object.keys(faq)).toHaveLength(6);
    expect(faq['Combien de temps ai-je pour payer ?']).toContain('réservées 15 minutes');
    expect(faq['Puis-je acheter plusieurs billets ?']).toBe('Oui, jusqu’à 3 par commande, avec le nom de chaque participant.');

    const cond = json(await call('POST', '/events', admin, {
      ...complete, title: 'Faq justificatif', publish: true,
      categories: [{ name: 'Étudiant', priceXof: 1500, quota: 30, conditions: 'Justificatif demandé à l’entrée' }],
    }));
    const faq2 = json(await call('GET', `/public/events/${cond.slug}`)).faq;
    expect(faq2).toHaveLength(7);
    expect(faq2[6].question).toContain('justificatif');
  });

  it('contact : numéro de l’événement, sinon celui de l’organisation (variable ORG_CONTACT_PHONE)', async () => {
    const own = json(await call('POST', '/events', admin, { ...complete, title: 'Contact propre', publish: true }));
    expect(json(await call('GET', `/public/events/${own.slug}`)).contactPhone).toBe('+229 01 97 00 00 00');

    const { contactPhone: _omit, ...withoutPhone } = complete;
    const fallback = json(await call('POST', '/events', admin, { ...withoutPhone, title: 'Contact organisation', publish: true }));
    expect(fallback.contactPhone).toBeNull(); // l'administration n'invente rien
    const pub = json(await call('GET', `/public/events/${fallback.slug}`));
    expect(pub.contactPhone).toBe('+22901000000'); // le public a toujours un numéro WhatsApp
    expect(pub.practicalInfo).toContain('contactez-nous sur WhatsApp');
  });

  it('un PATCH partiel ne touche pas aux textes absents de la requête', async () => {
    const created = json(await call('POST', '/events', admin, { ...complete, title: 'Patch partiel', ticketTerms: 'Conditions.', publish: true }));
    const r = await call('PATCH', `/events/${created.id}`, admin, { city: 'Cotonou' });
    expect(json(r)).toMatchObject({ city: 'Cotonou', ticketTerms: 'Conditions.' });
  });

  it('texte trop long (> 2000 caractères) : 422', async () => {
    const r = await call('POST', '/events', admin, { ...complete, title: 'Trop long', refundPolicy: 'x'.repeat(2001) });
    expect(r.statusCode).toBe(422);
  });

  it('l’adresse (slug) ne change jamais : ni en renommant l’événement, ni en la fournissant dans la requête', async () => {
    const created = json(await call('POST', '/events', admin, { ...complete, title: 'Adresse stable', publish: true }));
    const slug = created.slug;
    const r = await call('PATCH', `/events/${created.id}`, admin, { title: 'Titre complètement différent', slug: 'pirate' });
    expect(r.statusCode).toBe(200);
    expect(json(r).title).toBe('Titre complètement différent');
    expect(json(r).publicUrl).toBe(`http://localhost:5173/evenements/${slug}`);
    const pub = await call('GET', `/public/events/${slug}`); // le lien déjà diffusé fonctionne toujours
    expect(pub.statusCode).toBe(200);
    expect(json(pub).title).toBe('Titre complètement différent');
    expect((await call('GET', '/public/events/pirate')).statusCode).toBe(404);
  });
});
