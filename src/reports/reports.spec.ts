import { bucketize, cssString, dateLong, dateShort, esc, eventDates, eventHours, fileSafe, hourlyBars, int, pct, phoneFr, timeFr, xof } from './report-format';
import { participantsHtml, ReportMeta } from './report-html';
import { ReportsService } from './reports.service';
import { MAX_REPORT_ROWS } from './reports.schemas';

const NB = ' ';
// Instants choisis en UTC ; le Bénin est en UTC+1 : 2026-11-13T23:30Z = 14 novembre 00h30 au Bénin.
const utc = (s: string) => new Date(`${s}Z`);

describe('formats des rapports', () => {
  it('montants et pourcentages : espaces insécables, jamais coupés en fin de ligne', () => {
    expect(xof(594000)).toBe(`594${NB}000${NB}XOF`);
    expect(xof(0)).toBe(`0${NB}XOF`);
    expect(int(1234567)).toBe(`1${NB}234${NB}567`);
    expect(pct(142, 200)).toBe(`71${NB}%`);
    expect(pct(0, 0)).toBe(`0${NB}%`); // pas de division par zéro
  });

  it('dates en heure du Bénin : le jour change à minuit local, pas à minuit UTC', () => {
    expect(dateLong(utc('2026-11-13T23:30:00'))).toBe('14 novembre 2026');
    expect(dateLong(utc('2026-11-01T10:00:00'))).toBe('1er novembre 2026');
    expect(dateShort(utc('2026-10-05T08:00:00'))).toBe('5 oct. 2026');
    expect(timeFr(utc('2026-11-13T07:06:00'))).toBe('08h06');
  });

  it('dates et horaires d’un événement : un jour, plusieurs jours, sans fin', () => {
    expect(eventDates(utc('2026-11-14T07:00:00'), utc('2026-11-14T16:00:00'))).toBe('14 novembre 2026');
    expect(eventDates(utc('2026-11-14T07:00:00'), utc('2026-11-15T16:00:00'))).toBe('14 au 15 novembre 2026');
    expect(eventDates(utc('2026-11-30T07:00:00'), utc('2026-12-02T16:00:00'))).toBe('30 novembre au 2 décembre 2026');
    expect(eventDates(utc('2026-12-30T07:00:00'), utc('2027-01-02T16:00:00'))).toBe('30 décembre 2026 au 2 janvier 2027');
    expect(eventDates(null, null)).toBe('Date à confirmer');
    expect(eventHours(utc('2026-11-14T07:00:00'), utc('2026-11-14T16:00:00'))).toBe('08h00 à 17h00');
    expect(eventHours(utc('2026-11-14T07:00:00'), null)).toBe('08h00');
  });

  it('téléphones : numéros béninois à 10 chiffres groupés par deux, le reste tel quel', () => {
    expect(phoneFr('+2290195789513')).toBe('+229 01 95 78 95 13');
    expect(phoneFr('+22961234567')).toBe('+22961234567');
    expect(phoneFr('+33612345678')).toBe('+33612345678');
    expect(phoneFr(null)).toBe('—');
  });

  it('nom de fichier : lettres, chiffres et tirets seulement', () => {
    expect(fileSafe('Leadership & Impact — Édition 2026!')).toBe('leadership-impact-edition-2026');
    expect(fileSafe('!!!')).toBe('evenement');
  });
});

describe('graphiques : tranches de dates', () => {
  it('tranches de 7 jours depuis le début des ventes, jours à zéro compris', () => {
    const dates = ['2026-10-05T10:00:00', '2026-10-06T10:00:00', '2026-10-12T10:00:00', '2026-10-30T10:00:00'].map(utc);
    const { bars, days } = bucketize(dates, utc('2026-10-05T00:00:00'), utc('2026-11-01T10:00:00'));
    expect(days).toBe(7);
    expect(bars.map((b) => b.value)).toEqual([2, 1, 0, 1]);
    expect(bars[0].label).toBe(`5–11${NB}oct.`);
    expect(bars[3].label).toBe(`26${NB}oct.–1${NB}nov.`); // tranche à cheval sur deux mois
  });

  it('une longue période passe en tranches de 14, 28 ou 56 jours : au plus 12 barres', () => {
    const start = utc('2026-01-05T10:00:00');
    const { bars, days } = bucketize([start, utc('2026-11-01T10:00:00')], start, utc('2026-11-02T10:00:00'));
    expect(days).toBe(28);
    expect(bars.length).toBeLessThanOrEqual(12);
    expect(bars.reduce((a, b) => a + b.value, 0)).toBe(2);
  });

  it('une vente avant la date d’ouverture déclarée reste comptée ; sans vente : aucune barre', () => {
    expect(bucketize([utc('2026-10-01T10:00:00')], utc('2026-10-05T00:00:00'), utc('2026-10-06T10:00:00')).bars.reduce((a, b) => a + b.value, 0)).toBe(1);
    expect(bucketize([]).bars).toEqual([]);
  });

  it('affluence : quatre heures à partir du premier scan, puis « Après Xh »', () => {
    const scans = ['07:10', '07:50', '08:05', '09:30', '12:15', '12:20'].map((h) => utc(`2026-11-14T${h}:00`)); // 08h10 … 13h20 au Bénin
    const bars = hourlyBars(scans);
    expect(bars.map((b) => b.label)).toEqual(['08h–09h', '09h–10h', '10h–11h', '11h–12h', 'Après 12h']);
    expect(bars.map((b) => b.value)).toEqual([2, 1, 1, 0, 2]);
    expect(hourlyBars([])).toEqual([]);
  });
});

describe('sécurité des documents', () => {
  const meta: ReportMeta = { org: 'JCI', editionDate: '13 novembre 2026', eventTitle: 'Soirée </style><script>alert(1)</script>"', eventDates: '14 novembre 2026', eventPlace: 'GI Mono' };

  it('esc et cssString neutralisent le balisage et les guillemets', () => {
    expect(esc(`<img src=x onerror="a()"> & 'b'`)).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;b&#39;');
    const c = cssString('a"b\\c</style>\nd');
    expect(c).not.toMatch(/[<>"]/.test(c.slice(1, -1)) ? /x^/ : /<\/style>/);
    expect(c.startsWith('"') && c.endsWith('"')).toBe(true);
    expect(c.slice(1, -1)).not.toContain('<');
    expect(c.slice(1, -1)).not.toContain('\n');
  });

  it('un nom de participant ou un titre d’événement malveillant ne peut ni injecter de balise ni sortir du CSS', () => {
    const html = participantsHtml(meta, { info: [['Événement', meta.eventTitle]], rows: [{ name: '<script>alert(2)</script>', phone: '—', email: 'x"onmouseover="y' }], excluded: 0 });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onmouseover="y');
    expect(html.match(/<\/style>/g)).toHaveLength(1); // le seul </style> est celui du modèle
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });
});

describe('garde-fou de taille', () => {
  it(`refuse un PDF de plus de ${MAX_REPORT_ROWS} lignes (422), accepte la limite`, () => {
    const svc = new ReportsService(null as never, null as never, null as never, null as never) as unknown as { tooMany(n: number): void };
    expect(() => svc.tooMany(MAX_REPORT_ROWS)).not.toThrow();
    expect(() => svc.tooMany(MAX_REPORT_ROWS + 1)).toThrow(/Trop de lignes/);
  });
});
