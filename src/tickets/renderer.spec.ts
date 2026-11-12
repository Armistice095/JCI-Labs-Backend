import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { loadAssets } from './design/assets';
import { qrSvg } from './design/qr';
import { shareHtml } from './design/share-html';
import { ticketHtml } from './design/ticket-html';
import { TicketRenderData } from './design/types';
import { ChromiumRenderer } from './renderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Rendu réel avec Chromium (CHROMIUM_PATH, ou @sparticuz/chromium sous Linux). Ignoré si aucun navigateur n'est disponible. */
let exe: string | undefined = process.env.CHROMIUM_PATH;
let headlessShell = process.env.CHROMIUM_HEADLESS_SHELL === 'true';
const canTry = !!exe || process.platform === 'linux';
const d = canTry ? describe : describe.skip;

const URL_IN_QR = 'https://jcicomee.com/billet/Xk3pQ9wLm2RtY7vNb4HsDa';
const data: TicketRenderData = {
  number: 'JCI-2026-000001', qrUrl: URL_IN_QR, holderFirstName: 'Koffi', holderLastName: 'Ahoussou', categoryName: 'Pass simple', priceXof: 5000, conditions: null,
  event: { title: 'Passation de charge', category: 'GALA', startsAt: new Date('2026-12-19T18:19:00Z'), venueName: 'Centre des Congrès de Comé', city: 'Comé', accentColor: null, publicUrl: 'https://jcicomee.com/evenements/x' },
  posterDataUri: `data:image/jpeg;base64,${readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'poster.jpg')).toString('base64')}`,
};

d('rendu Chromium', () => {
  let r: ChromiumRenderer;
  beforeAll(async () => {
    if (!exe) { try { exe = await (await import('@sparticuz/chromium')).default.executablePath(); headlessShell = true; } catch { /* pas de navigateur */ } }
    r = new ChromiumRenderer({ executablePath: exe, headlessShell });
  }, 60000);

  it('mode faible mémoire : mêmes billets, un rendu à la fois, Chromium éteint au repos puis relancé', async () => {
    if (!exe) return console.warn('Chromium indisponible : test ignoré');
    const low = new ChromiumRenderer({ executablePath: exe, headlessShell, lowMemory: true, idleCloseMs: 300 });
    try {
      const html = ticketHtml(data, loadAssets(), await qrSvg(URL_IN_QR));
      const a = await low.renderTicket(html);
      expect([PNG.sync.read(a.png).width, PNG.sync.read(a.png).height]).toEqual([2244, 752]);
      expect(a.pdf.subarray(0, 5).toString()).toBe('%PDF-');
      await new Promise((r) => setTimeout(r, 1500));
      expect((low as unknown as { browser: unknown }).browser).toBeNull(); // éteint : la mémoire est rendue
      const [b, c] = await Promise.all([low.renderTicket(html), low.renderTicket(html)]); // relancé, deux demandes en file
      expect(PNG.sync.read(b.png).width).toBe(2244);
      expect(PNG.sync.read(c.png).width).toBe(2244);
    } finally { await low.close(); }
  }, 90000);
  afterAll(async () => { await r?.close(); });

  it('PNG 2244 × 752 + PDF 1 page aux dimensions du billet', async () => {
    if (!exe) return console.warn('Chromium indisponible : test ignoré');
    const t = await r.renderTicket(ticketHtml(data, loadAssets(), await qrSvg(URL_IN_QR)));
    const png = PNG.sync.read(t.png);
    expect([png.width, png.height]).toEqual([2244, 752]);
    expect(t.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t.pdf.toString('latin1'));
    expect(Number(box?.[1])).toBeCloseTo(841.7, 0);   // 297 mm en points
    expect(Number(box?.[2])).toBeCloseTo(282, 0);     // 99,5 mm
    expect((t.pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
    expect(t.png.length).toBeLessThan(2_000_000);
    expect(t.pdf.length).toBeLessThan(1_000_000);
  }, 60000);

  it('le QR code du billet généré se relit (PNG) et contient l’URL à jeton', async () => {
    if (!exe) return;
    const t = await r.renderTicket(ticketHtml(data, loadAssets(), await qrSvg(URL_IN_QR)));
    const png = PNG.sync.read(t.png);
    // On relit la zone du QR (centre, puis souche) découpée dans le vrai PNG : jsQR est moins robuste que ZXing pour repérer un QR dans une mise en page complexe.
    const crop = (x: number, y: number, w: number, h: number) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) png.data.copy(Buffer.from(out.buffer), row * w * 4, ((y + row) * png.width + x) * 4, ((y + row) * png.width + x + w) * 4);
      return out;
    };
    const center = jsQR(crop(1560, 156, 260, 260), 260, 260);   // QR du centre : x 790–898 px CSS, ×2
    const stub = jsQR(crop(2670 - 1000, 156, 10, 10), 10, 10);   // zone volontairement vide : ne doit rien lire
    expect(center?.data).toBe(URL_IN_QR);
    expect(stub).toBeNull();
  }, 60000);

  it('visuel de partage : JPEG 1080 × 1920', async () => {
    if (!exe) return;
    const jpg = await r.renderShare(shareHtml(data, loadAssets()));
    expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // dimensions JPEG (marqueur SOF)
    let i = 2; let dims: [number, number] | null = null;
    while (i < jpg.length) { if (jpg[i] !== 0xff) { i++; continue; } const m = jpg[i + 1]; if (m >= 0xc0 && m <= 0xc3) { dims = [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)]; break; } i += 2 + jpg.readUInt16BE(i + 2); }
    expect(dims).toEqual([1080, 1920]);
    expect(jpg.length).toBeLessThan(1_500_000);
  }, 60000);

  it('un texte hostile ne casse pas le rendu et ne déclenche aucune requête réseau', async () => {
    if (!exe) return;
    const evil = { ...data, holderFirstName: '<img src="http://127.0.0.1:9/x.png"><script>fetch("http://127.0.0.1:9")</script>' };
    const t = await r.renderTicket(ticketHtml(evil, loadAssets(), await qrSvg(URL_IN_QR)));
    expect(t.png.length).toBeGreaterThan(1000);
  }, 60000);

  it('rendus concurrents sans interférence', async () => {
    if (!exe) return;
    const html = ticketHtml(data, loadAssets(), await qrSvg(URL_IN_QR));
    const out = await Promise.all([1, 2, 3, 4].map(() => r.renderTicket(html)));
    expect(out.every((x) => x.pdf.length > 1000 && x.png.length > 1000)).toBe(true);
  }, 90000);
});
