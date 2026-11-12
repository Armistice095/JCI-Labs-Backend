import { loadAssets } from './design/assets';
import { shareHtml } from './design/share-html';
import { ticketHtml } from './design/ticket-html';
import { accentPalette, escapeHtml, fit, formatDateParts, formatPrice, formatTime, luminance, mix, shortName } from './design/tokens';
import { ticketQrUrl, qrSvg } from './design/qr';
import { TicketRenderData } from './design/types';

const assets = loadAssets();
const base: TicketRenderData = {
  number: 'JCI-2026-000001', qrUrl: 'https://jcicomee.com/billet/Xk3pQ9wLm2RtY7vNb4HsDa',
  holderFirstName: 'Koffi', holderLastName: 'Ahoussou', categoryName: 'Pass simple', priceXof: 5000, conditions: null,
  event: { title: 'Passation de charge', category: 'GALA', startsAt: new Date('2026-12-19T18:19:00Z'), venueName: 'Centre des Congrès de Comé', city: 'Comé', accentColor: null, publicUrl: 'https://jcicomee.com/evenements/passation-2026' },
  posterDataUri: null,
};
const qr = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

describe('formats (heure du Bénin, français)', () => {
  it('heure « 19 h 19 » (UTC+1)', () => expect(formatTime(new Date('2026-12-19T18:19:00Z'))).toBe('19 h 19'));
  it('minuit local', () => expect(formatTime(new Date('2026-12-19T23:05:00Z'))).toBe('00 h 05'));
  it('date en trois parties, mois capitalisé', () => expect(formatDateParts(new Date('2026-12-19T18:19:00Z'))).toMatchObject({ day: '19', monthYear: 'Décembre 2026' }));
  it('un événement tard le soir bascule bien au jour local', () => expect(formatDateParts(new Date('2026-12-19T23:30:00Z')).day).toBe('20'));
  it('date inconnue', () => expect(formatDateParts(null).long).toBe('Date à confirmer'));
  it('prix avec espace insécable (présent dans la police)', () => expect(formatPrice(5000)).toBe('5\u00a0000\u00a0FCFA'));
  it('grands prix', () => expect(formatPrice(1250000)).toBe('1\u00a0250\u00a0000\u00a0FCFA'));
  it('nom abrégé du visuel de partage', () => { expect(shortName('Koffi', 'Ahoussou')).toBe('Koffi A.'); expect(shortName('Koffi', '')).toBe('Koffi'); });
  it('taille de police adaptée à la longueur', () => { expect(fit('court', [[10, 20]], 9)).toBe(20); expect(fit('x'.repeat(50), [[10, 20]], 9)).toBe(9); });
});

describe('couleur d’accent', () => {
  it('or de la maquette par défaut', () => expect(accentPalette(null).base).toBe('#F2B83A'));
  it('accent personnalisé dérivé (clair, foncé, fond doux)', () => {
    const p = accentPalette('#0A7D5A');
    expect(p.base).toBe('#0A7D5A');
    expect(luminance(p.light)).toBeGreaterThan(luminance(p.base));
    expect(luminance(p.dark)).toBeLessThan(luminance(p.base));
  });
  it('texte lisible : sombre sur accent clair, blanc sur accent foncé', () => {
    expect(accentPalette('#F2B83A').onAccent).not.toBe('#FFFFFF');
    expect(accentPalette('#14213D').onAccent).toBe('#FFFFFF');
  });
  it('couleur invalide ignorée (pas d’injection CSS)', () => expect(accentPalette('red;}</style><script>').base).toBe('#F2B83A'));
  it('mix', () => expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080'));
});

describe('billet HTML', () => {
  const html = ticketHtml(base, assets, qr);
  it('contient les informations du billet', () => {
    for (const t of ['Koffi Ahoussou', 'JCI-2026-000001', 'Pass simple', '5\u00a0000\u00a0FCFA', '19 h 19', 'Décembre 2026', 'Centre des Congrès de Comé', 'Billet d’accès', 'personnel et non transférable'])
      expect(html).toContain(t);
  });
  it('deux QR codes (centre et souche), même contenu', () => expect(html.split('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toHaveLength(3));
  it('aucun script, aucune ressource externe', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/@import/i);
  });
  it('échappe les textes saisis par des tiers (nom, titre, lieu, consigne)', () => {
    const evil = ticketHtml({ ...base, holderFirstName: '<img src=x onerror=alert(1)>', holderLastName: '"><script>alert(2)</script>', conditions: '<b onmouseover=1>', event: { ...base.event, title: '</style><script>x</script>', venueName: '<svg/onload=1>' } }, assets, qr);
    expect(evil).not.toMatch(/<img src=x/i);
    expect(evil).not.toMatch(/<script>alert/i);
    expect(evil).not.toMatch(/<svg\/onload/i);
    expect(evil).not.toMatch(/<b onmouseover/i);
    expect(evil).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('affiche intégrée en data-URI quand elle existe, artwork généré sinon', () => {
    expect(html).toContain('class="gen"');
    const withPoster = ticketHtml({ ...base, posterDataUri: 'data:image/jpeg;base64,AAAA' }, assets, qr);
    expect(withPoster).toContain('class="poster" src="data:image/jpeg;base64,AAAA"');
    expect(withPoster).not.toContain('class="gen"');
  });
  it('consigne d’accès affichée si la catégorie en a une', () => expect(ticketHtml({ ...base, conditions: 'Justificatif demandé' }, assets, qr)).toContain('Justificatif demandé'));
  it('textes extrêmes : ne lève pas d’erreur', () => {
    const long = 'Très '.repeat(60);
    expect(() => ticketHtml({ ...base, holderFirstName: long, categoryName: long, event: { ...base.event, title: long, venueName: long, startsAt: null } }, assets, qr)).not.toThrow();
  });
  it('couleur d’accent appliquée', () => expect(ticketHtml({ ...base, event: { ...base.event, accentColor: '#0A7D5A' } }, assets, qr)).toContain('#0A7D5A'));
});

describe('visuel de partage', () => {
  const html = shareHtml(base, assets);
  it('« J’y serai ! », nom abrégé, date, lieu', () => {
    for (const t of ['J’y serai !', 'Koffi A.', 'Décembre 2026', '19 h 19', 'CENTRE DES CONGRÈS DE COMÉ'.toLowerCase() === '' ? '' : 'Centre des Congrès de Comé', 'jcicomee.com/evenements/passation-2026']) expect(html).toContain(t);
  });
  it('ne contient JAMAIS le QR code, le numéro du billet ni le nom complet', () => {
    expect(html).not.toContain('JCI-2026-000001');
    expect(html).not.toContain('Ahoussou');
    expect(html).not.toContain('<svg xmlns="http://www.w3.org/2000/svg"><path');
    expect(html).not.toContain('Xk3pQ9wLm2RtY7vNb4HsDa');
  });
  it('politique de sécurité du contenu : rien d’externe', () => expect(html).toContain("default-src 'none'"));
  it('échappement', () => expect(shareHtml({ ...base, holderFirstName: '<script>x</script>' }, assets)).not.toMatch(/<script>x/));
});

describe('QR code', () => {
  it('URL du QR = base + jeton (aucune donnée personnelle)', () => expect(ticketQrUrl('https://jcicomee.com/billet/', 'abc')).toBe('https://jcicomee.com/billet/abc'));
  it('SVG vectoriel généré', async () => { const s = await qrSvg(base.qrUrl); expect(s).toContain('<svg'); expect(s).toContain('crispEdges'); });
});
