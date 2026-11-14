import jsQR from 'jsqr';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { TicketRenderData } from './design/types';
import { ChromiumRenderer } from './renderer';
import { TicketRenderer } from './ticket-renderer';

const URL_IN_QR = 'https://jcicomee.com/billet/Xk3pQ9wLm2RtY7vNb4HsDa';
const poster = `data:image/jpeg;base64,${readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'poster.jpg')).toString('base64')}`;
const data: TicketRenderData = {
  number: 'JCI-2026-000001', qrUrl: URL_IN_QR, holderFirstName: 'Koffi', holderLastName: 'Ahoussou', categoryName: 'Pass simple', priceXof: 5000, conditions: null,
  event: { title: 'Passation de charge', category: 'GALA', startsAt: new Date('2026-12-19T18:19:00Z'), venueName: 'Centre des Congrès de Comé', city: 'Comé', accentColor: null, publicUrl: 'https://jcicomee.com/evenements/x' },
  posterDataUri: poster,
};

/** Rectangle découpé dans un PNG (jsQR relit mieux un QR isolé qu'au milieu d'une mise en page). */
function crop(png: PNG, x: number, y: number, w: number, h: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) png.data.copy(Buffer.from(out.buffer), row * w * 4, ((y + row) * png.width + x) * 4, ((y + row) * png.width + x + w) * 4);
  return out;
}

describe('billet : PNG + PDF sans navigateur', () => {
  const r = new TicketRenderer();
  beforeAll(() => r.onModuleInit());

  it('PNG 2244 × 752 et PDF d’une page aux dimensions du billet (297 × 99,5 mm)', async () => {
    const t = await r.render(data);
    const png = PNG.sync.read(t.png);
    expect([png.width, png.height]).toEqual([2244, 752]);
    expect(t.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t.pdf.toString('latin1'));
    expect(Number(box?.[1])).toBeCloseTo(841.9, 0);
    expect(Number(box?.[2])).toBeCloseTo(282.1, 0);
    expect((t.pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
    expect(t.png.length).toBeLessThan(2_500_000);
    expect(t.pdf.length).toBeLessThan(1_500_000);
  });

  it('le QR code de la souche se relit dans le PNG et contient l’URL à jeton', async () => {
    const png = PNG.sync.read((await r.render(data)).png);
    // souche : carré blanc x 961–1069, y 222–330 (px du billet), ×2 dans le PNG
    const qr = jsQR(crop(png, 1914, 436, 232, 232), 232, 232);
    expect(qr?.data).toBe(URL_IN_QR);
  });

  it('le centre du billet ne contient plus de QR code (redondant)', async () => {
    const png = PNG.sync.read((await r.render(data)).png);
    expect(jsQR(crop(png, 1560, 156, 260, 260), 260, 260)).toBeNull();
  });

  it('artwork généré (sans affiche) : rendu valide, plus léger', async () => {
    const [a, b] = await Promise.all([r.render(data), r.render({ ...data, posterDataUri: null })]);
    expect(PNG.sync.read(b.png).width).toBe(2244);
    expect(b.png.length).toBeLessThan(a.png.length);
  });

  it('textes hostiles, immenses, caractères exotiques : jamais d’erreur', async () => {
    const long = 'Très '.repeat(80);
    const cases: TicketRenderData[] = [
      { ...data, holderFirstName: '<img src="http://127.0.0.1:9/x.png"><script>fetch("http://127.0.0.1:9")</script>' },
      { ...data, holderFirstName: long, holderLastName: long, categoryName: long, conditions: long, event: { ...data.event, title: long, venueName: long, startsAt: null } },
      { ...data, holderFirstName: 'Ɖossou 😀', holderLastName: '山田', event: { ...data.event, title: '🎉🎉', city: '' } },
    ];
    for (const c of cases) { const t = await r.render(c); expect(t.png.length).toBeGreaterThan(1000); expect(t.pdf.length).toBeGreaterThan(1000); }
  }, 30000);

  it('affiche corrompue : le billet est tout de même produit (artwork généré)', async () => {
    const t = await r.render({ ...data, posterDataUri: 'data:image/jpeg;base64,AAAA' });
    expect(PNG.sync.read(t.png).width).toBe(2244);
  });

  it('rendus concurrents sans interférence, rapides', async () => {
    const t0 = Date.now();
    const out = await Promise.all([1, 2, 3, 4, 5, 6].map(() => r.render(data)));
    expect(out.every((x) => x.pdf.length > 1000 && x.png.length > 1000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30000);
});

/** Chromium ne sert plus qu'aux rapports PDF de l'événement. Ignoré si aucun navigateur n'est disponible. */
const exe: string | undefined = process.env.CHROMIUM_PATH;
(exe ? describe : describe.skip)('rendu Chromium (rapports)', () => {
  it('mode faible mémoire : PDF produit, Chromium éteint au repos puis relancé', async () => {
    const low = new ChromiumRenderer({ executablePath: exe, lowMemory: true, idleCloseMs: 300 });
    try {
      const html = '<!doctype html><html><body><h1>Test</h1></body></html>';
      const a = await low.renderPdf(html);
      expect(a.subarray(0, 5).toString()).toBe('%PDF-');
      await new Promise((res) => setTimeout(res, 1500));
      expect((low as unknown as { browser: unknown }).browser).toBeNull();
      const [b, c] = await Promise.all([low.renderPdf(html), low.renderPdf(html)]);
      expect(b.length).toBeGreaterThan(500); expect(c.length).toBeGreaterThan(500);
    } finally { await low.close(); }
  }, 90000);

  it('aucune requête réseau ne sort : seules les data-URI passent', async () => {
    const r = new ChromiumRenderer({ executablePath: exe });
    try {
      const pdf = await r.renderPdf('<!doctype html><body><img src="http://127.0.0.1:9/x.png"><p>ok</p></body>');
      expect(pdf.length).toBeGreaterThan(500);
    } finally { await r.close(); }
  }, 60000);
});
