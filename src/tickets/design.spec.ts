import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAssets } from './design/assets';
import { cleanText, ellipsize, fitLines, measure, wrap } from './design/glyphs';
import { qrPath, ticketQrUrl } from './design/qr';
import { ticketSvg } from './design/ticket-svg';
import { accentPalette, fit, formatDateParts, formatPrice, formatTime, luminance, mix } from './design/tokens';
import { TicketRenderData } from './design/types';

const assets = loadAssets();
const base: TicketRenderData = {
  number: 'JCI-2026-000001', qrUrl: 'https://jcicomee.com/billet/Xk3pQ9wLm2RtY7vNb4HsDa',
  holderFirstName: 'Koffi', holderLastName: 'Ahoussou', categoryName: 'Pass simple', priceXof: 5000, conditions: null,
  event: { title: 'Passation de charge', category: 'GALA', startsAt: new Date('2026-12-19T18:19:00Z'), venueName: 'Centre des Congrès de Comé', city: 'Comé', accentColor: null, publicUrl: 'https://jcicomee.com/evenements/passation-2026' },
  posterDataUri: null,
};

describe('formats (heure du Bénin, français)', () => {
  it('heure « 19 h 19 » (UTC+1)', () => expect(formatTime(new Date('2026-12-19T18:19:00Z'))).toBe('19 h 19'));
  it('minuit local', () => expect(formatTime(new Date('2026-12-19T23:05:00Z'))).toBe('00 h 05'));
  it('date en trois parties, mois capitalisé', () => expect(formatDateParts(new Date('2026-12-19T18:19:00Z'))).toMatchObject({ day: '19', monthYear: 'Décembre 2026' }));
  it('un événement tard le soir bascule bien au jour local', () => expect(formatDateParts(new Date('2026-12-19T23:30:00Z')).day).toBe('20'));
  it('date inconnue', () => expect(formatDateParts(null).long).toBe('Date à confirmer'));
  it('prix avec espace insécable (présent dans la police)', () => expect(formatPrice(5000)).toBe('5\u00a0000\u00a0FCFA'));
  it('grands prix', () => expect(formatPrice(1250000)).toBe('1\u00a0250\u00a0000\u00a0FCFA'));
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

describe('billet SVG', () => {
  const svg = ticketSvg(base, assets);
  it('un seul QR code (la souche) ; pas de logo central, pas de « Billet d’accès »', () => {
    expect(svg.match(/crispEdges/g)).toHaveLength(1);
    expect(svg.match(/<image /g)).toHaveLength(2); // logo sur l'affiche + logo de la souche, sans affiche ni logo central
  });
  it('texte en tracés : aucun élément <text>, aucun script, aucune ressource externe', () => {
    expect(svg).not.toMatch(/<text|<script|<foreignObject/i);
    expect(svg).not.toMatch(/(href)=["']https?:/i);
    expect(svg).not.toMatch(/url\(\s*["']?https?:/i);
  });
  it('un texte saisi par un tiers ne peut produire aucun balisage', () => {
    const evil = ticketSvg({ ...base, holderFirstName: '<img src=x onerror=alert(1)>', holderLastName: '"><script>alert(2)</script>', conditions: '<b onmouseover=1>', categoryName: '</svg><script>', number: 'JCI"><script>', event: { ...base.event, title: '</style><script>x</script>', venueName: '<svg/onload=1>' } }, assets);
    expect(evil).not.toMatch(/<script|onerror|onmouseover|onload|<img/i);
    expect(evil.match(/<svg/g)).toHaveLength(1);
  });
  it('affiche intégrée quand elle existe, artwork généré sinon', () => {
    const png = `data:image/png;base64,${readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'poster.jpg')).toString('base64')}`.replace('image/png', 'image/jpeg');
    expect(ticketSvg({ ...base, posterDataUri: png }, assets).match(/<image /g)).toHaveLength(3);
    expect(svg).toContain('genBg');
    expect(ticketSvg({ ...base, posterDataUri: png }, assets)).not.toContain('url(#genBg)');
  });
  it('affiche invalide (pas une image png/jpeg) : artwork généré, pas d’erreur', () => {
    expect(ticketSvg({ ...base, posterDataUri: 'data:image/svg+xml;base64,PHN2Zy8+' }, assets)).toContain('url(#genBg)');
    expect(ticketSvg({ ...base, posterDataUri: 'data:image/jpeg;base64,AAAA' }, assets)).toContain('url(#genBg)');
  });
  it('textes extrêmes : ne lève pas d’erreur', () => {
    const long = 'Très '.repeat(60);
    expect(() => ticketSvg({ ...base, holderFirstName: long, categoryName: long, conditions: long, event: { ...base.event, title: long, venueName: long, startsAt: null } }, assets)).not.toThrow();
  });
  it('couleur d’accent appliquée', () => expect(ticketSvg({ ...base, event: { ...base.event, accentColor: '#0A7D5A' } }, assets)).toContain('#0A7D5A'));
});

describe('texte en tracés (polices)', () => {
  it('mesure : plus grand = plus large, vide = 0', () => {
    expect(measure('Dossou ANAGONOU', 'm800', 28)).toBeGreaterThan(measure('Dossou ANAGONOU', 'm800', 20));
    expect(measure('', 'm800', 20)).toBe(0);
  });
  it('accents français conservés ; emoji et lettres hors police retirés', () => {
    expect(cleanText('Élodie Françoise Œuvre', 'm800')).toBe('Élodie Françoise Œuvre');
    expect(cleanText('Koffi 😀 Ahoussou', 'm800')).toBe('Koffi Ahoussou');
  });
  it('retour à la ligne : au plus N lignes, « … » si le texte ne tient pas', () => {
    const lines = wrap('Conférence internationale sur le leadership et l’impact des jeunes entrepreneurs', 'm800', 24, 260, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.every((l) => measure(l, 'm800', 24) <= 260)).toBe(true);
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
    expect(wrap('Court', 'm800', 24, 260, 3)).toEqual(['Court']);
  });
  it('un mot plus large que la ligne est coupé, pas débordant', () => {
    const [l] = wrap('Anticonstitutionnellement', 'm800', 30, 120, 1);
    expect(measure(l, 'm800', 30)).toBeLessThanOrEqual(120);
  });
  it('fitLines : prend la plus grande taille qui tient sans abréger', () => {
    const r = fitLines('Leadership & Impact', 'm800', [36, 30, 24], 268, 3);
    expect(r.lines.join(' ')).toBe('Leadership & Impact');
    expect(r.size).toBe(36);
    expect(fitLines('x'.repeat(200), 'm800', [20, 16], 100, 2).lines.at(-1)).toMatch(/…$/);
  });
  it('ellipsize respecte la largeur', () => expect(measure(ellipsize('Un nom vraiment très très long pour ce champ', 'm800', 20, 150), 'm800', 20)).toBeLessThanOrEqual(150));
});

describe('QR code', () => {
  it('URL du QR = base + jeton (aucune donnée personnelle)', () => expect(ticketQrUrl('https://jcicomee.com/billet/', 'abc')).toBe('https://jcicomee.com/billet/abc'));
  it('tracé vectoriel : une seule commande de dessin, valeurs bornées à la zone', () => {
    const d = qrPath(base.qrUrl, 10, 20, 90);
    expect(d.startsWith('M')).toBe(true);
    expect(d.length).toBeGreaterThan(500);
    expect(d).not.toMatch(/NaN|undefined/);
  });
});
