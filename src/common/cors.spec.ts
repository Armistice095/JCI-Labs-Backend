import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { corsOptions } from './cors';

@Controller('ping')
class PingController { @Get() ping() { return { ok: true }; } }

async function start(origins: string): Promise<NestFastifyApplication> {
  const app = (await Test.createTestingModule({ controllers: [PingController] }).compile()).createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableCors(corsOptions(origins));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('CORS', () => {
  const ORIGINS = 'https://billets.jcicomee.org, https://admin.jcicomee.org';
  let app: NestFastifyApplication;
  beforeAll(async () => { app = await start(ORIGINS); });
  afterAll(async () => { await app.close(); });

  it('autorise les deux adresses de production et expose Retry-After au code du navigateur', async () => {
    for (const origin of ['https://billets.jcicomee.org', 'https://admin.jcicomee.org']) {
      const r = await app.inject({ method: 'GET', url: '/ping', headers: { origin } });
      expect(r.headers['access-control-allow-origin']).toBe(origin);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
      expect(String(r.headers['access-control-expose-headers']).toLowerCase()).toContain('retry-after');
    }
  });

  it('requête préalable (preflight) d’un POST avec Idempotency-Key : acceptée pour la page publique', async () => {
    const r = await app.inject({
      method: 'OPTIONS', url: '/ping',
      headers: { origin: 'https://billets.jcicomee.org', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,idempotency-key' },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('https://billets.jcicomee.org');
    expect(String(r.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key');
  });

  it('refuse toute autre adresse (aucun en-tête CORS)', async () => {
    const r = await app.inject({ method: 'GET', url: '/ping', headers: { origin: 'https://pirate.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('liste vide : personne n’est autorisé', async () => {
    const closed = await start('');
    const r = await closed.inject({ method: 'GET', url: '/ping', headers: { origin: 'https://billets.jcicomee.org' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    await closed.close();
  });
});
