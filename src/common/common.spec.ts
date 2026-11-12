import { normalizePhone } from './phone';
import { slugify } from './slug';
import { addDays, defaultSalesClose, localToUtc, utcToLocalParts } from './time';
import { missingForPublish } from '../events/publish-validation';
import { eventCreate } from '../events/events.schemas';

describe('normalizePhone', () => {
  it.each([
    ['+229 01 95 78 95 13', '+2290195789513'],
    ['0195789513', '+2290195789513'],
    ['229 0195789513', '+2290195789513'],
    ['0022901 95 78 95 13', '+2290195789513'],
    ['95789513', '+2290195789513'], // ancien format à 8 chiffres
    ['+33612345678', '+33612345678'],
  ])('%s → %s', (i, o) => expect(normalizePhone(i)).toBe(o));
  it.each(['abc', '123', ''])('refuse %p', (i) => expect(normalizePhone(i)).toBeNull());
});

describe('slugify', () => {
  it('retire accents et ponctuation', () => expect(slugify('Leadership & Impact — Édition 2026')).toBe('leadership-impact-edition-2026'));
  it('valeur de repli', () => expect(slugify('!!!')).toBe('evenement'));
});

describe('time (Africa/Porto-Novo, UTC+1)', () => {
  it('local → UTC', () => expect(localToUtc('2026-11-28', '08:00').toISOString()).toBe('2026-11-28T07:00:00.000Z'));
  it('UTC → local', () => expect(utcToLocalParts(new Date('2026-11-28T23:30:00Z'))).toEqual({ date: '2026-11-29', time: '00:30' }));
  it('addDays gère les fins de mois', () => expect(addDays('2026-12-01', -1)).toBe('2026-11-30'));
  it('clôture par défaut : la veille à 18h00 locale', () => expect(defaultSalesClose('2026-11-28').toISOString()).toBe('2026-11-27T17:00:00.000Z'));
});

describe('missingForPublish', () => {
  const ok = { title: 'Leadership', description: 'x', startsAt: new Date('2026-11-28T07:00:00Z'), endsAt: new Date('2026-11-28T16:00:00Z'), venueName: 'Centre', city: 'Comé' };
  it('événement complet', () => expect(missingForPublish(ok)).toEqual({}));
  it('brouillon vide', () => expect(Object.keys(missingForPublish({ title: 'ab', description: '', startsAt: null, endsAt: null, venueName: '', city: '' })).sort())
    .toEqual(['city', 'date', 'description', 'endTime', 'startTime', 'title', 'venueName']));
});

describe('eventCreate schema', () => {
  it('accepte un brouillon minimal', () => expect(eventCreate.parse({ title: 'Gala JCI' }).publish).toBe(false));
  it('refuse un prix à 0 (billets gratuits hors v1)', () =>
    expect(eventCreate.safeParse({ title: 'Gala JCI', categories: [{ name: 'Libre', priceXof: 0, quota: 10 }] }).success).toBe(false));
  it('refuse deux catégories de même nom', () =>
    expect(eventCreate.safeParse({ title: 'Gala JCI', categories: [{ name: 'VIP', priceXof: 5000, quota: 5 }, { name: 'vip', priceXof: 6000, quota: 5 }] }).success).toBe(false));
  it('refuse une heure invalide', () => expect(eventCreate.safeParse({ title: 'Gala JCI', startTime: '25:00' }).success).toBe(false));
});
